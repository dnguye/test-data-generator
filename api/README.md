# Test Data Generator — HTTP API

Generate the same data the browser tool generates, from a `curl` call or an agent.

```
POST /v1/generate
{ "schemaId": "4K67JYE06R6J2VJFE1MST8ZX4WTK1RZ9", "count": 100, "seed": 4242 }
```

`schemaId` and `count` are required, `seed` is optional. Same three values in,
same rows out — verified against the browser page itself, not just against
itself (`tests/api.mjs` and the parity check in the repo notes).

---

## Run it

```bash
npm run api          # http://localhost:8787, no configuration, no dependencies
```

Storage defaults to JSON files under `.data/schemas/`. Nothing else is needed to
try it. See **Deploying** below for a real host.

---

## The two calls

### 1. Register a schema — `POST /v1/schemas`

Build the schema in the browser tool, press **Export schema**, and post that
file as the body. Nothing has to be hand-authored.

```bash
curl -X POST http://localhost:8787/v1/schemas \
     -H 'Content-Type: application/json' \
     --data-binary @schema.json
```

```json
{
  "schemaId": "4K67JYE06R6J2VJFE1MST8ZX4WTK1RZ9",
  "entities": [{ "name": "Accounts", "rows": 20, "fields": 4 }],
  "hasDuplicates": false,
  "note": "Save this id. It cannot be listed or recovered, and anyone holding it can generate from this schema."
}
```

Schemas are **immutable**. Editing one means registering again and getting a new
id — the old id keeps generating exactly what it always did. That is what makes
an id worth writing down.

`GET /v1/schemas/{id}` returns the stored schema to whoever holds the id.

### 2. Generate — `POST /v1/generate`

| field | required | type | notes |
|---|---|---|---|
| `schemaId` | yes | string | 32 characters. Case and dashes are forgiven. |
| `count` | yes | number, or object | rows to generate. 1–10000. |
| `seed` | no | integer | 0–2147483647. Omit for a fresh random run. |
| `format` | no | `json` \| `csv` \| `xml` | default `json`. |

```json
{
  "schemaId": "4K67JYE06R6J2VJFE1MST8ZX4WTK1RZ9",
  "seed": 4242,
  "seeded": true,
  "count": { "People": 3 },
  "format": "json",
  "fingerprint": "6c273ccd1ba912c87fa6daa4a01cd217",
  "entities": [
    { "name": "People", "requested": 3, "rows": 3, "records": [ { "first": "Era", "em": "Tatyana_Sauer@yahoo.com" } ] }
  ],
  "warnings": []
}
```

For `csv` and `xml` each entity carries `body` (a string) and `mime` instead of
`records`. The envelope is the same either way, so one response shape parses for
all three formats.

---

## Reproducibility, precisely

**The identity of a result is the triple `(schemaId, count, seed)` — not the
seed alone.** Change any one of them and every row changes.

That is worth being blunt about, because the intuition "same seed, same data" is
half a rule. The generator draws from one seeded stream: row 7 depends on
everything drawn for rows 1–6, so asking for 11 rows instead of 10 does not
append a row, it shifts the whole run. Pin all three or pin nothing.

Two things in the API exist to keep that honest:

- **`fingerprint`** — a digest of the generated data, taken before formatting.
  Two calls that return the same fingerprint returned the same data. Assert on
  it in a test rather than trusting that nothing moved.
- **`count` is echoed back resolved.** For a schema with several entities a bare
  number is *rejected*, because it would leave the other entities' row counts
  implicit and hide half the tuple from whoever tries to reproduce the run later:

  ```json
  { "schemaId": "…", "count": { "Accounts": 20, "Contacts": 100 }, "seed": 4242 }
  ```

  Entities you leave out fall back to the row count stored in the schema — which
  is fixed forever, so the result stays reproducible either way.

Omit `seed` and you get a random one, reported back in `seed`. Passing that value
to a later call replays the run exactly.

**One exception, and the API warns you about it:** a schema with duplicate
injection turned on emits *more* rows than requested, and the injected rows shift
the ones after them. Such a run is still perfectly reproducible for that exact
count — it just is not a prefix of a larger one. `hasDuplicates` on registration
and a `warnings` entry on every seeded generate both flag it.

---

## Access

There is no auth. **A schema id is the capability**: anyone holding one can
generate from that schema, and anyone without one cannot reach it.

That model rests on ids being unguessable, so they are 160 bits from the OS
CSPRNG — not a hash of the schema. A content hash would be the same value for
everyone who builds the same obvious schema, which would make common schemas
enumerable. Ids are also never listed, and an unknown id and a real-but-not-yours
id return the identical 404.

Treat an id like an unlisted link. It is the right amount of protection for test
data and the wrong amount for anything you would mind a stranger reading.

Rate limits are per instance: 60 generates and 10 registrations per minute per
IP, tunable via `TDG_RATE_GENERATE` / `TDG_RATE_REGISTER`. They reset when the
process does and do not coordinate across instances — real abuse protection
belongs at the edge, which is also the only layer that sees the true client
address. Set `TDG_TRUST_PROXY=1` only when something in front is actually
rewriting `X-Forwarded-For`.

---

## Running a stranger's JavaScript

Schemas may contain `Formula (JS)` fields, and generating them means evaluating
JavaScript that someone else wrote. Inside the API process that would be
catastrophic: one formula could read the storage credentials out of `process.env`
and return them as a generated column.

So generation happens in a **child process forked with an empty environment**
(`api/worker.mjs`). The parent holds the credentials and the socket; the child
knows only how to turn a schema into rows. Escaping that sandbox gets an attacker
a process with no secrets, no inherited handles, and a parent holding a kill
timer — a formula that never returns is killed at `TDG_TIMEOUT_MS` (default 15s)
and the request gets a `504`, not a wedged server.

`tests/api.mjs` asserts both `process.env` and the classic
`(function(){}).constructor` escape come back empty.

The worker is long-lived and single-threaded: parsing the faker bundle costs
~0.4s, which would dominate every response if paid per call. One consequence is
that a large request queues the ones behind it.

---

## Storage

| driver | when | configuration |
|---|---|---|
| `file` | default; local and single-host | `TDG_DATA_DIR` (default `.data/schemas`) |
| `memory` | tests | `TDG_STORE=memory` |
| `supabase` | anything that redeploys | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |

Supabase is auto-selected when both variables are present. Apply
[`api/schema.sql`](./schema.sql) first — and note what it does *not* contain:

> The table has RLS enabled and **no policies**. That is the access control. With
> RLS on and no policy, the anon and authenticated roles can do nothing, while
> the service role key — which lives only in the API's environment — bypasses RLS
> entirely. Add a policy for `anon` and Supabase's public key will happily return
> every schema id in one request, and the unguessable-id model is worth nothing.

Schemas are immutable, so the in-process cache never needs invalidating, and the
migration adds a trigger that rejects `UPDATE` and `DELETE` outright — a bug in
the API cannot rewrite a schema that callers have already pinned an id to.

---

## Deploying

`api/handlers.mjs` is transport-agnostic. Two hosts ship with it:

- `api/server.mjs` — plain `node:http`. Works on Fly.io, Render, Railway, a VPS,
  or a container anywhere. `PORT` is read from the environment.
- `api/handler-web.mjs` — a `(Request) => Response` default export for Netlify
  Functions v2, Vercel, Deno and Bun.

The forked worker needs a real process, so hosts that only run edge/V8 isolates
(Cloudflare Workers, Vercel Edge) will not work as-is. On serverless hosts the
worker is re-created on cold start and the rate limiter resets with it.

---

## Errors

Every failure is `{ "error": { "code", "message", "field"? } }`.

| status | codes |
|---|---|
| 400 | `invalid_schema_id`, `invalid_seed`, `invalid_count`, `invalid_format`, `invalid_schema`, `invalid_json` |
| 404 | `unknown_schema`, `not_found` |
| 405 | `method_not_allowed` |
| 413 | `body_too_large` |
| 429 | `rate_limited` |
| 500 | `generation_failed`, `internal` |
| 503 | `storage_unavailable` |
| 504 | `generation_timeout` |

Registration validates the whole schema up front and points at the offending
field: unknown types, unparseable formulas, unknown faker methods, and
`Reference` fields pointing at an entity that is not generated *before* them —
which would otherwise silently fill a column with `#REF`.

---

## Configuration

| variable | default | meaning |
|---|---|---|
| `PORT` | `8787` | `server.mjs` listen port |
| `TDG_STORE` | auto | `file`, `memory` or `supabase` |
| `TDG_DATA_DIR` | `.data/schemas` | file store location |
| `TDG_TABLE` | `schemas` | Supabase table |
| `TDG_TIMEOUT_MS` | `15000` | generation kill timer |
| `TDG_RATE_GENERATE` | `60` | generates per minute per IP |
| `TDG_RATE_REGISTER` | `10` | registrations per minute per IP |
| `TDG_TRUST_PROXY` | off | honour `X-Forwarded-For` |
