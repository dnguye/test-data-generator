/* The API itself: routing, validation and the reproducibility contract.

   Transport agnostic on purpose -- it takes a plain request description and
   returns a plain response, so server.mjs (node:http) and handler-web.mjs
   (fetch-style, for serverless hosts) are both thin wrappers rather than
   forks of this logic. */
import { normalizeSchema, hasDuplicates, LIMITS } from "./schema.mjs";
import { newSchemaId, normalizeSchemaId } from "./ids.mjs";
import { GeneratorPool } from "./pool.mjs";
import { storeFromEnv } from "./store.mjs";

export const MAX_SEED = 2147483647;        // mulberry32 folds the seed to int32
export const MAX_BODY_BYTES = LIMITS.maxBytes;
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

    if (path === "/v1/generate" || path === "/v1/schemas")
      return err(405, "method_not_allowed", "Use POST");
    return err(404, "not_found", "No such route. Try POST /v1/generate or POST /v1/schemas.");
  }

  return { handle, store, pool };
}
