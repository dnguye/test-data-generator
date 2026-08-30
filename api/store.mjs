/* Schema storage.

   Stored schemas are immutable: a schema is written once under a fresh id and
   never updated or deleted. Editing means registering again and getting a new
   id. That is what lets every layer above cache without invalidation, and what
   makes "same schemaId means same recipe, forever" a property rather than a
   promise.

   Three drivers, one interface. The file driver is the default so the API runs
   with no setup at all; Supabase is for a deployment that has to survive the
   container it started in. */
import fs from "node:fs/promises";
import path from "node:path";

class BaseStore {
  constructor() { this.cache = new Map(); }
  /* Safe precisely because schemas never change once written. */
  remember(id, schema) {
    this.cache.set(id, schema);
    if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value);
    return schema;
  }
}

export class MemoryStore extends BaseStore {
  constructor() { super(); this.rows = new Map(); }
  async get(id) { return this.rows.get(id) || null; }
  async put(id, schema) { this.rows.set(id, schema); return id; }
  get name() { return "memory"; }
}

export class FileStore extends BaseStore {
  constructor(dir) { super(); this.dir = dir; }
  file(id) { return path.join(this.dir, id + ".json"); }
  async get(id) {
    if (this.cache.has(id)) return this.cache.get(id);
    try {
      const raw = await fs.readFile(this.file(id), "utf8");
      return this.remember(id, JSON.parse(raw));
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  }
  async put(id, schema) {
    await fs.mkdir(this.dir, { recursive: true });
    /* wx: never clobber. An id collision would silently rewrite somebody
       else's schema, so it has to be an error rather than a last-write-wins. */
    await fs.writeFile(this.file(id), JSON.stringify(schema), { flag: "wx" });
    this.remember(id, schema);
    return id;
  }
  get name() { return "file:" + this.dir; }
}

/* PostgREST over fetch -- no client library, so the API keeps its zero
   dependencies.

   This uses the SERVICE ROLE key, which bypasses row level security. That is
   correct here and dangerous anywhere else: the table must have RLS enabled
   with no policy for the anon role, or Supabase's public anon key would let
   anyone list every schema id in the table and the unguessable-id model would
   be worth nothing. See api/schema.sql. */
export class SupabaseStore extends BaseStore {
  constructor({ url, key, table = "schemas" }) {
    super();
    this.base = url.replace(/\/+$/, "") + "/rest/v1/" + table;
    this.headers = {
      apikey: key,
      Authorization: "Bearer " + key,
      "Content-Type": "application/json"
    };
  }
  async get(id) {
    if (this.cache.has(id)) return this.cache.get(id);
    const r = await fetch(this.base + "?id=eq." + encodeURIComponent(id) + "&select=definition&limit=1", { headers: this.headers });
    if (!r.ok) throw new Error("storage read failed (" + r.status + ")");
    const rows = await r.json();
    if (!rows.length) return null;
    return this.remember(id, rows[0].definition);
  }
  async put(id, schema) {
    const r = await fetch(this.base, {
      method: "POST",
      headers: { ...this.headers, Prefer: "return=minimal" },
      body: JSON.stringify({ id, definition: schema })
    });
    if (!r.ok) throw new Error("storage write failed (" + r.status + " " + (await r.text()).slice(0, 200) + ")");
    this.remember(id, schema);
    return id;
  }
  get name() { return "supabase"; }
}

export function storeFromEnv(env = process.env) {
  const kind = env.TDG_STORE || (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY ? "supabase" : "file");
  if (kind === "memory") return new MemoryStore();
  if (kind === "supabase") {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY)
      throw new Error("TDG_STORE=supabase needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
    return new SupabaseStore({ url: env.SUPABASE_URL, key: env.SUPABASE_SERVICE_ROLE_KEY, table: env.TDG_TABLE || "schemas" });
  }
  return new FileStore(env.TDG_DATA_DIR || path.join(process.cwd(), ".data", "schemas"));
}
