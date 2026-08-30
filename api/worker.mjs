/* The generation sandbox.

   Schemas may contain Formula (JS) fields, and the engine evaluates those with
   new Function -- which on a public endpoint means running a stranger's
   JavaScript. Inside the API process that would be catastrophic: a one-line
   formula could read the storage credentials out of process.env and hand them
   back as a generated column.

   So generation happens here, in a child process forked with an empty
   environment. The parent keeps the credentials and the socket; this process
   knows only how to turn a schema into rows. Escaping the "sandbox" gets an
   attacker a process with no secrets, no inherited handles, and a parent
   holding a kill timer.

   That is the boundary. Everything else here is defence in depth. */
import { createHash } from "node:crypto";
import { loadFaker } from "./faker-node.mjs";
import * as E from "../engine.js";

/* Nothing below needs the environment, and it should already be empty because
   the parent forked with env:{} -- clear it anyway so a change to how this is
   launched cannot silently reopen the hole. */
process.env = {};

E.useFaker(loadFaker().faker);
const CATALOG = E.getCatalog();

/* Stable JSON: object keys in insertion order are already deterministic for
   rows the engine built, so a plain stringify is a sound fingerprint input. */
function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}

function generate({ schema, counts, seed, format }) {
  const entities = schema.entities;
  const countFor = en => counts[en.name];

  const { results, errors, seed: usedSeed } = E.runAll(entities, countFor, seed);

  /* The fingerprint is taken over the data, never over the encoding, so the
     same run reports the same fingerprint whether it was asked for as JSON,
     CSV or XML. */
  const asObjects = results.map(r => ({ name: r.en.name, records: E.rowsToObjects(r.rows) }));
  const digest = fingerprint(asObjects);

  const out = results.map((r, i) => {
    const base = { name: r.en.name, rows: r.rows.length, requested: counts[r.en.name] };
    if (format === "json") return { ...base, records: asObjects[i].records };
    const { out: body, mime, ext } = E.serializeRows(r.rows, r.en, format);
    return { ...base, body, mime, ext };
  });

  return { seed: usedSeed, fingerprint: digest, entities: out, warnings: errors };
}

process.on("message", msg => {
  if (!msg || typeof msg !== "object") return;
  const { id, op } = msg;
  try {
    if (op === "generate") process.send({ id, ok: true, result: generate(msg) });
    else process.send({ id, ok: false, error: "Unknown op: " + op });
  } catch (e) {
    process.send({ id, ok: false, error: String((e && e.message) || e) });
  }
});

process.send({ ready: true, catalog: CATALOG });
