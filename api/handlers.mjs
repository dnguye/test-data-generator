/* The API itself: routing, validation and the reproducibility contract.

   Transport agnostic on purpose -- it takes a plain request description and
   returns a plain response, so server.mjs (node:http) and handler-web.mjs
   (fetch-style, for serverless hosts) are both thin wrappers rather than
   forks of this logic. */
import { normalizeSchema, hasDuplicates, LIMITS } from "./schema.mjs";
import { newSchemaId, normalizeSchemaId } from "./ids.mjs";
import { GeneratorPool } from "./pool.mjs";
import { storeFromEnv } from "./store.mjs";
import { scoreAll, toLabelMap, truthFromRecords } from "../scoring.js";

export const MAX_SEED = 2147483647;        // mulberry32 folds the seed to int32
export const MAX_BODY_BYTES = LIMITS.maxBytes;
export const MAX_SCORE_BODY_BYTES = LIMITS.maxScoreBytes;
/* Which cap applies is decided from the path alone, before the body is read,
   so the transports can stop buffering a runaway upload early. */
export function bodyLimitFor(path) { return path === "/v1/score" ? MAX_SCORE_BODY_BYTES : MAX_BODY_BYTES; }
const FORMATS = ["json", "csv", "xml"];

const err = (status, code, message, extra) => ({ status, body: { error: { code, message, ...extra } } });
const ok = (body, status = 200) => ({ status, body });

/* Per-instance sliding window. Honest about what it is: a speed bump that
   resets when the process does and does not coordinate across instances. Real
   abuse protection belongs at the edge (Cloudflare, Netlify, a load balancer),
   which is also the only layer that sees the true client address. */
class RateLimiter {
  constructor(limit, windowMs) { this.limit = limit; this.windowMs = windowMs; this.hits = new Map(); }
  allow(key) {
    const now = Date.now();
    const seen = (this.hits.get(key) || []).filter(t => now - t < this.windowMs);
    if (seen.length >= this.limit) { this.hits.set(key, seen); return false; }
    seen.push(now);
    this.hits.set(key, seen);
    if (this.hits.size > 10000) this.hits.clear();   // crude, bounded
    return true;
  }
}

export function createApi(opts = {}) {
  const store = opts.store || storeFromEnv();
  const pool = opts.pool || new GeneratorPool({ timeoutMs: Number(process.env.TDG_TIMEOUT_MS) || 15000 });
  const limits = {
    generate: new RateLimiter(Number(process.env.TDG_RATE_GENERATE) || 60, 60000),
    register: new RateLimiter(Number(process.env.TDG_RATE_REGISTER) || 10, 60000)
  };

  /* Turn the request's `count` into an explicit per-entity map.

     A bare number is only unambiguous when there is one entity to apply it to.
     With several, the caller has to name them -- because a seeded run is only
     reproducible against the exact row counts it was produced with, and a
     number that silently leaves the other entities on their stored defaults
     hides half of that tuple from whoever tries to reproduce it later. */
  function resolveCounts(schema, count) {
    const names = schema.entities.map(e => e.name);
    const out = {};

    if (typeof count === "number" || (typeof count === "string" && count.trim() !== "")) {
      const n = Number(count);
      if (!Number.isInteger(n)) return { error: "count must be a whole number", field: "count" };
      if (n < 1 || n > LIMITS.maxRows)
        return { error: `count must be between 1 and ${LIMITS.maxRows}`, field: "count" };
      if (names.length > 1) {
        return {
          error: `This schema has ${names.length} entities (${names.join(", ")}), so count must name each one it applies to, ` +
                 `for example {"count":{"${names[0]}":${n}}}. Entities left out keep the row count stored in the schema.`,
          field: "count"
        };
      }
      out[names[0]] = n;
      return { counts: out };
    }

    if (count && typeof count === "object" && !Array.isArray(count)) {
      for (const [k, v] of Object.entries(count)) {
        if (!names.includes(k))
          return { error: `count names "${k}", which is not an entity in this schema (${names.join(", ")})`, field: "count" };
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1 || n > LIMITS.maxRows)
          return { error: `count.${k} must be a whole number between 1 and ${LIMITS.maxRows}`, field: "count." + k };
        out[k] = n;
      }
      if (!Object.keys(out).length) return { error: "count is empty", field: "count" };
      /* Entities the caller did not mention fall back to the schema's own
         stored row count, which is fixed for the life of the id. */
      for (const e of schema.entities) if (out[e.name] === undefined) out[e.name] = Number(e.rows);
      return { counts: out };
    }

    return { error: "count is required: a whole number, or an object of entity name to row count", field: "count" };
  }

  async function generate(body, ip) {
    if (!limits.generate.allow(ip)) return err(429, "rate_limited", "Too many requests. Try again in a minute.");

    const id = normalizeSchemaId(body.schemaId);
    if (!id) return err(400, "invalid_schema_id", "schemaId is required and must be a 32-character schema id", { field: "schemaId" });

    let seed;
    if (body.seed !== undefined && body.seed !== null && body.seed !== "") {
      const n = Number(body.seed);
      if (!Number.isInteger(n) || n < 0 || n > MAX_SEED)
        return err(400, "invalid_seed", `seed must be a whole number between 0 and ${MAX_SEED}`, { field: "seed" });
      seed = n;
    }

    const format = body.format === undefined ? "json" : String(body.format).toLowerCase();
    if (!FORMATS.includes(format))
      return err(400, "invalid_format", `format must be one of ${FORMATS.join(", ")}`, { field: "format" });

    let schema;
    try { schema = await store.get(id); }
    catch (e) { return err(503, "storage_unavailable", "Could not read the schema store: " + e.message); }
    /* Same answer for "never existed" and "not yours", because there is no
       "yours" -- and a distinguishable 403 would confirm that an id is real. */
    if (!schema) return err(404, "unknown_schema", "No schema with that id", { field: "schemaId" });

    const resolved = resolveCounts(schema, body.count);
    if (resolved.error) return err(400, "invalid_count", resolved.error, { field: resolved.field });

    let result;
    try {
      result = await pool.run({ schema, counts: resolved.counts, seed, format });
    } catch (e) {
      if (e.kind === "timeout")
        return err(504, "generation_timeout", "Generation took too long and was stopped. Try a smaller count, or simplify the schema's formulas.");
      return err(500, "generation_failed", "Generation failed: " + e.message);
    }

    const warnings = [...(result.warnings || [])];
    if (seed !== undefined && hasDuplicates(schema)) {
      warnings.push(
        "This schema injects duplicate rows, so it returns more rows than requested and the extra rows shift the ones after them. " +
        "The result is still reproducible for this exact count, but rows are not a prefix of a larger run."
      );
    }

    return ok({
      schemaId: id,
      seed: result.seed,
      seeded: seed !== undefined,
      count: resolved.counts,
      format,
      fingerprint: result.fingerprint,
      entities: result.entities,
      warnings
    });
  }

  async function register(body, ip) {
    if (!limits.register.allow(ip)) return err(429, "rate_limited", "Too many schema registrations. Try again in a minute.");

    await pool.start().catch(() => {});
    const v = normalizeSchema(body, pool.catalog);
    if (!v.ok) return err(400, "invalid_schema", v.error, v.field ? { field: v.field } : undefined);

    const id = newSchemaId();
    try { await store.put(id, v.schema); }
    catch (e) { return err(503, "storage_unavailable", "Could not write to the schema store: " + e.message); }

    return ok({
      schemaId: id,
      entities: v.schema.entities.map(e => ({ name: e.name, rows: Number(e.rows), fields: e.fields.length })),
      hasDuplicates: hasDuplicates(v.schema),
      note: "Save this id. It cannot be listed or recovered, and anyone holding it can generate from this schema."
    }, 201);
  }

  /* ---------- ground-truth scoring ----------
     The other half of duplicate injection. The generator adds match_id; this
     takes the matcher's links and scores them against it -- pairwise
     precision and recall, closed under transitivity, plus a threshold sweep
     and the operational auto-merge / review bands when the links carry
     scores, and pair completeness when blocking output is supplied.

     Scoring runs no caller-supplied code, so unlike generation it runs in
     the API process itself. The counts are computed from cluster sizes, so a
     matcher that links every record to every other is cheap to score. */
  const seedOf = v => {
    if (v === undefined || v === null || v === "") return { seed: undefined };
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > MAX_SEED) return { error: `seed must be a whole number between 0 and ${MAX_SEED}` };
    return { seed: n };
  };

  /* truth comes in one of three shapes, and the answer is always {id: match_id}:
       { "PAT-1": "M1", ... }                                a labelling, as is
       { records: [...], idField, matchField? }              the generated file
       { schemaId, count, seed, entity?, idField, matchField? }  regenerate it */
  async function resolveTruth(t) {
    const bad = (message, field, code = "invalid_truth") => ({ error: err(400, code, message, { field }) });
    if (!t || typeof t !== "object" || Array.isArray(t))
      return bad("truth is required: a map of record id to match_id, {records, idField}, or {schemaId, count, seed, idField}", "truth");

    if (t.schemaId !== undefined) {
      const id = normalizeSchemaId(t.schemaId);
      if (!id) return bad("truth.schemaId must be a 32-character schema id", "truth.schemaId", "invalid_schema_id");
      const s = seedOf(t.seed);
      if (s.error) return bad("truth." + s.error, "truth.seed", "invalid_seed");
      if (s.seed === undefined) return bad("truth.seed is required: an unseeded run cannot be reproduced, so there is nothing to score against", "truth.seed", "invalid_seed");
      let schema;
      try { schema = await store.get(id); }
      catch (e) { return { error: err(503, "storage_unavailable", "Could not read the schema store: " + e.message) }; }
      if (!schema) return bad("No schema with that id", "truth.schemaId", "unknown_schema");
      const resolved = resolveCounts(schema, t.count);
      if (resolved.error) return bad("truth." + resolved.error, "truth." + resolved.field, "invalid_count");
      const names = schema.entities.map(e => e.name);
      let entity = t.entity;
      if (entity === undefined || entity === null || entity === "") {
        if (names.length !== 1) return bad(`truth.entity is required: this schema has ${names.length} entities (${names.join(", ")})`, "truth.entity");
        entity = names[0];
      }
      const en = schema.entities.find(e => e.name === String(entity));
      if (!en) return bad(`truth.entity "${entity}" is not an entity in this schema (${names.join(", ")})`, "truth.entity");
      if (!en.dupLevel || en.dupLevel === "off")
        return bad(`Entity "${en.name}" has duplicate injection off, so its output has no match_id column to score against`, "truth.entity");
      const idField = t.idField === undefined || t.idField === null ? "" : String(t.idField).trim();
      const f = en.fields.find(x => x.name === idField);
      if (!f) return bad(`truth.idField is required and must name a field of "${en.name}" (${en.fields.map(x => x.name).join(", ")})`, "truth.idField");
      if (/\[.*\]/.test(idField)) return bad(`truth.idField "${idField}" repeats, so it holds a list per record, not one id`, "truth.idField");
      let gen;
      try { gen = await pool.truth({ schema, counts: resolved.counts, seed: s.seed, entity: en.name, idField }); }
      catch (e) {
        if (e.kind === "timeout") return { error: err(504, "generation_timeout", "Regenerating the ground truth took too long and was stopped.") };
        return { error: err(500, "generation_failed", "Regenerating the ground truth failed: " + e.message) };
      }
      try {
        const records = gen.ids.map((rid, i) => ({ [idField]: rid, [gen.matchField]: gen.matchIds[i] }));
        const labels = truthFromRecords(records, idField, gen.matchField);
        return { labels, source: { schemaId: id, seed: gen.seed, count: resolved.counts, entity: gen.entity, idField, matchField: gen.matchField, rows: gen.rows } };
      } catch (e) { return bad(e.message, "truth.idField"); }
    }

    if (Array.isArray(t.records)) {
      const idField = t.idField === undefined || t.idField === null ? "" : String(t.idField).trim();
      const matchField = t.matchField === undefined || t.matchField === null || t.matchField === "" ? "match_id" : String(t.matchField).trim();
      if (!idField) return bad("truth.idField is required: the column that identifies one record", "truth.idField");
      if (!t.records.length) return bad("truth.records is empty", "truth.records");
      try { return { labels: truthFromRecords(t.records, idField, matchField), source: { records: t.records.length, idField, matchField } }; }
      catch (e) { return bad(e.message, "truth.records"); }
    }

    /* a bare labelling -- accept {labels:{...}} too, for symmetry */
    const map = t.labels && typeof t.labels === "object" && !Array.isArray(t.labels) ? t.labels : t;
    const keys = Object.keys(map);
    if (!keys.length) return bad("truth is empty", "truth");
    for (const k of keys) {
      const v = map[k];
      if (v === null || v === undefined || (typeof v !== "string" && typeof v !== "number") || String(v) === "")
        return bad(`truth["${k}"] must be a match_id string`, "truth." + k);
    }
    return { labels: toLabelMap(map), source: { labels: keys.length } };
  }

  async function score(body, ip) {
    if (!limits.generate.allow(ip)) return err(429, "rate_limited", "Too many requests. Try again in a minute.");

    const truth = await resolveTruth(body.truth);
    if (truth.error) return truth.error;

    if (!Array.isArray(body.predicted) && !(body.predicted && Array.isArray(body.predicted.pairs)))
      return err(400, "invalid_pairs", "predicted is required: an array of the pairs the matcher linked, [a, b] or [a, b, score] or {a, b, score}", { field: "predicted" });

    const options = {};
    if (body.closeTransitively !== undefined) options.closeTransitively = body.closeTransitively !== false;
    if (body.maxListed !== undefined) {
      const n = Number(body.maxListed);
      if (!Number.isInteger(n) || n < 0 || n > LIMITS.maxListed)
        return err(400, "invalid_option", `maxListed must be a whole number between 0 and ${LIMITS.maxListed}`, { field: "maxListed" });
      options.maxListed = n;
    }
    if (body.thresholds !== undefined) {
      if (!Array.isArray(body.thresholds) || !body.thresholds.length || body.thresholds.length > 101 ||
          body.thresholds.some(x => !Number.isFinite(Number(x)) || Number(x) < 0 || Number(x) > 1))
        return err(400, "invalid_option", "thresholds must be 1 to 101 numbers between 0 and 1", { field: "thresholds" });
      options.thresholds = body.thresholds.map(Number);
    }
    for (const k of ["autoMerge", "reviewFloor"]) {
      if (body[k] === undefined) continue;
      const n = Number(body[k]);
      if (!Number.isFinite(n) || n < 0 || n > 1) return err(400, "invalid_option", `${k} must be a number between 0 and 1`, { field: k });
      options[k] = n;
    }
    if (options.autoMerge !== undefined || options.reviewFloor !== undefined) {
      const am = options.autoMerge === undefined ? 0.92 : options.autoMerge, rf = options.reviewFloor === undefined ? 0.78 : options.reviewFloor;
      if (rf > am) return err(400, "invalid_option", "reviewFloor must not exceed autoMerge", { field: "reviewFloor" });
    }
    if (body.candidates !== undefined && body.candidates !== null) {
      const c = body.candidates;
      const ok = Array.isArray(c) || (c && typeof c === "object" && (Array.isArray(c.pairs) || Object.keys(c).length));
      if (!ok) return err(400, "invalid_candidates", "candidates must be an array of the pairs blocking produced, or a map of record id to block key", { field: "candidates" });
      options.candidates = c;
    }

    let result;
    try { result = scoreAll(truth.labels, body.predicted, options); }
    catch (e) {
      const field = /^pairs\[/.test(e.message) || /^pairs /.test(e.message) ? "predicted" : options.candidates !== undefined && /label/.test(e.message) ? "candidates" : "predicted";
      return err(400, field === "candidates" ? "invalid_candidates" : "invalid_pairs", e.message, { field });
    }
    result.truth.source = truth.source;
    return ok(result);
  }

  async function handle({ method, path, body, ip }) {
    if (method === "OPTIONS") return { status: 204, body: null };

    if (method === "GET" && (path === "/v1/health" || path === "/health"))
      return ok({ ok: true, store: store.name, catalog: pool.catalog.length, maxRows: LIMITS.maxRows });

    const show = path.match(/^\/v1\/schemas\/([^/]+)$/);
    if (method === "GET" && show) {
      const id = normalizeSchemaId(show[1]);
      if (!id) return err(400, "invalid_schema_id", "Not a schema id");
      let schema;
      try { schema = await store.get(id); }
      catch (e) { return err(503, "storage_unavailable", e.message); }
      if (!schema) return err(404, "unknown_schema", "No schema with that id");
      return ok({ schemaId: id, schema });
    }

    if (method === "POST" && path === "/v1/generate") return generate(body || {}, ip);
    if (method === "POST" && path === "/v1/schemas") return register(body || {}, ip);
    if (method === "POST" && path === "/v1/score") return score(body || {}, ip);

    if (path === "/v1/generate" || path === "/v1/schemas" || path === "/v1/score")
      return err(405, "method_not_allowed", "Use POST");
    return err(404, "not_found", "No such route. Try POST /v1/generate, POST /v1/schemas or POST /v1/score.");
  }

  return { handle, store, pool };
}
