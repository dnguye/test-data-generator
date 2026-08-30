/* Validation and normalization of a stored schema document.

   The wire format is exactly what the browser tool's "Export schema" button
   produces, so the round trip is: build it in the UI, export, register, get an
   id back. Nothing has to be hand-authored.

   Normalizing on the way IN is what makes the reproducibility promise keepable.
   A stored schema is frozen and never edited, so the generator can only ever
   see fields it understands, in a fixed order, with defaults already resolved.
   Anything unrecognized is dropped here rather than carried around forever. */
import { TYPE_NAMES, TYPES } from "../engine.js";

export const LIMITS = {
  maxBytes: 256 * 1024,
  maxEntities: 10,
  maxFieldsPerEntity: 200,
  maxExprLength: 2000,
  maxRows: 10000            // matches engine.js entRowCount()'s own ceiling
};

class Invalid extends Error {
  constructor(msg, field) { super(msg); this.field = field; }
}
const bad = (msg, field) => { throw new Invalid(msg, field); };

const str = (v, dflt = "") => (v === undefined || v === null ? dflt : String(v));
const intIn = (v, dflt, lo, hi) => {
  const n = parseInt(str(v, ""), 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(n, lo), hi);
};
/* XML element names come straight from the schema, so they have to be legal
   element names or toXml() would emit a document that will not parse. */
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const elName = (v, dflt) => { const s = str(v, "").trim(); return NAME_RE.test(s) ? s : dflt; };

/* v1 exports were a bare field list; the tool's own importer still accepts them,
   so the API does too rather than making people re-export an old schema. */
function liftV1(doc) {
  const list = Array.isArray(doc) ? doc : doc.fields;
  if (!Array.isArray(list)) return null;
  return {
    version: 2,
    entities: [{ name: "Records", rows: "100", root: str(doc.root, "records"), record: str(doc.record, "record"), fields: list }]
  };
}

/**
 * Validate and canonicalize a schema document.
 * @param {unknown} input   parsed JSON, as exported by the tool
 * @param {string[]} catalog  faker method paths the worker actually has; pass
 *                            an empty array to skip that check
 * @returns {{ok:true,schema:object}|{ok:false,error:string,field?:string}}
 */
export function normalizeSchema(input, catalog = []) {
  try {
    if (!input || typeof input !== "object") bad("Body must be a JSON object holding a schema");
    let doc = input;
    if (!Array.isArray(doc.entities)) {
      const lifted = liftV1(doc);
      if (!lifted) bad('Expected {"entities":[...]} as written by "Export schema"', "entities");
      doc = lifted;
    }
    if (!doc.entities.length) bad("A schema needs at least one entity", "entities");
    if (doc.entities.length > LIMITS.maxEntities)
      bad(`At most ${LIMITS.maxEntities} entities per schema`, "entities");

    const known = new Set(catalog);
    const seenNames = new Set();
    const done = [];                       // entity names already normalized
    /* Field names of each entity normalized so far, so a Reference is checked
       against the real thing rather than against the caller's raw input. */
    const entitiesSoFar = new Map();

    const entities = doc.entities.map((raw, ei) => {
      if (!raw || typeof raw !== "object") bad("Entity must be an object", `entities[${ei}]`);
      const name = str(raw.name, "").trim();
      if (!name) bad("Entity needs a name", `entities[${ei}].name`);
      if (seenNames.has(name)) bad(`Duplicate entity name "${name}"`, `entities[${ei}].name`);
      seenNames.add(name);

      if (!Array.isArray(raw.fields) || !raw.fields.length)
        bad(`Entity "${name}" has no fields`, `entities[${ei}].fields`);
      if (raw.fields.length > LIMITS.maxFieldsPerEntity)
        bad(`Entity "${name}": at most ${LIMITS.maxFieldsPerEntity} fields`, `entities[${ei}].fields`);

      const fieldNames = new Set();
      const fields = raw.fields.map((f, fi) => {
        const where = `entities[${ei}].fields[${fi}]`;
        if (!f || typeof f !== "object") bad("Field must be an object", where);
        const fname = str(f.name, "").trim();
        if (!fname) bad("Field needs a name", where + ".name");
        const type = str(f.type, "");
        if (!TYPE_NAMES.includes(type))
          bad(`Unknown field type "${type}" for "${fname}"`, where + ".type");

        /* Start from the type's own defaults so a schema that omits an option
           still generates the same values the UI would show for it. */
        const defaults = TYPES[type].opts || {};
        const opts = {};
        for (const k of Object.keys(defaults)) opts[k] = str(f.opts && f.opts[k], defaults[k]);

        if (type === "Faker (any)") {
          const method = str(opts.method, "").trim();
          if (!method) bad(`"${fname}": Faker (any) needs opts.method`, where + ".opts.method");
          if (known.size && !known.has(method))
            bad(`"${fname}": unknown faker method "${method}"`, where + ".opts.method");
          opts.method = method;
        }
        if (type === "Formula (JS)") {
          const expr = str(opts.expr, "").trim();
          if (!expr) bad(`"${fname}": Formula (JS) needs opts.expr`, where + ".opts.expr");
          if (expr.length > LIMITS.maxExprLength)
            bad(`"${fname}": formula longer than ${LIMITS.maxExprLength} characters`, where + ".opts.expr");
          /* Compiling proves it parses. Compiling does not run it -- the actual
             evaluation only ever happens in the sandboxed worker. */
          try { new Function('"use strict"; return (' + expr + ");"); }
          catch (e) { bad(`"${fname}": formula does not parse -- ${e.message}`, where + ".opts.expr"); }
          opts.expr = expr;
        }
        if (type === "Reference") {
          const target = str(opts.entity, "").trim();
          if (!target) bad(`"${fname}": Reference needs opts.entity`, where + ".opts.entity");
          /* Entities generate left to right, so a reference can only point at
             one already generated. Catching this now beats shipping rows full
             of "#REF" to whoever calls the API later. */
          if (!done.includes(target))
            bad(`"${fname}": Reference to "${target}", which is not an entity listed before "${name}"`, where + ".opts.entity");
          const src = entitiesSoFar.get(target);
          if (!src.has(str(opts.field, "").trim()))
            bad(`"${fname}": "${target}" has no field "${str(opts.field, "")}"`, where + ".opts.field");
          opts.entity = target;
          opts.field = str(opts.field, "").trim();
          opts.unique = opts.unique === "1" ? "1" : "";
        }

        const out = { name: fname, type, opts };
        if (f.sim && (f.sim.algo === "jw" || f.sim.algo === "lev"))
          out.sim = { algo: f.sim.algo, target: str(f.sim.target, "0.90") };
        fieldNames.add(fname);
        return out;
      });

      entitiesSoFar.set(name, fieldNames);
      done.push(name);

      return {
        name,
        rows: String(intIn(raw.rows, 100, 1, LIMITS.maxRows)),
        root: elName(raw.root, "records"),
        record: elName(raw.record, "record"),
        dupLevel: ["light", "medium", "heavy", "targeted"].includes(raw.dupLevel) ? raw.dupLevel : "off",
        dupPct: String(intIn(raw.dupPct, 20, 0, 100)),
        dupMax: String(intIn(raw.dupMax, 2, 1, 10)),
        fields
      };
    });

    const active = Math.min(Math.max(parseInt(doc.active, 10) || 0, 0), entities.length - 1);
    return {
      ok: true,
      schema: {
        version: 2,
        format: ["json", "csv", "xml"].includes(doc.format) ? doc.format : "json",
        active,
        entities
      }
    };
  } catch (e) {
    if (e instanceof Invalid) return { ok: false, error: e.message, field: e.field };
    throw e;
  }
}

/* A schema with duplicate injection turned on emits a different number of rows
   than it was asked for, and the extra rows shift every row after them. Callers
   need to know that before they build a diff against a previous run. */
export function hasDuplicates(schema) {
  return schema.entities.some(e => e.dupLevel && e.dupLevel !== "off");
}
