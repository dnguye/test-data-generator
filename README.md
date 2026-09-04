# Test Data Generator

A zero-dependency, browser-based test data generator. Define a schema (or import one), add field logic with JavaScript formulas, and generate nested XML, JSON, or CSV — powered by the modern [@faker-js/faker](https://fakerjs.dev) library.

Everything runs client-side. No server, no build step, no accounts, and no data leaves the browser.

There is also an optional [HTTP API](./api/README.md) for generating the same
data from a script or an agent — `POST /v1/generate` with a schema id, a row
count and a seed — and for scoring a matcher's output against the generated
ground truth (`POST /v1/score`). It is not needed to use the tool.

## Files

| file | what it is |
|---|---|
| `index.html` | the whole app — markup, styles and UI |
| `engine.js` | the generation core: types, seeding, formulas, references, duplicates, serializers |
| `scoring.js` | ground-truth scoring: pairwise precision / recall against `match_id`, blocking completeness, threshold sweep, review bands |
| `faker.iife.js` | the vendored [@faker-js/faker](https://fakerjs.dev) bundle |
| `faker-ext.js` | the extra generator modules (see below) |
| `api/` | the optional HTTP API |

`engine.js` is the single implementation. The browser page imports it, the API
generates from it, and the test suites exercise it — which is why a schema and
seed produce the same rows through the API as they do on the page.

## Tests

`npm test` runs all three suites. Individually:

`node tests/ext.mjs` runs a 4,056-check audit of the extra generator modules: catalog discovery, scalar-only output, checksum validity, region/postal agreement, locale output, weighting, and seed reproducibility.

`node tests/audit.mjs` runs a 41-check audit of `engine.js`: schema edge cases, escaping, formula failures, reference guardrails, duplicate/targeted-similarity behavior, reproducibility, and a 10k-row performance guard.

`node tests/score.mjs` runs a 97-check audit of `scoring.js` and `POST /v1/score`: the worked example from the design notes, transitive closure, blocking completeness, threshold sweep and review bands, pasted-file parsing, an oracle and a naive matcher scored against real engine output, and truth regenerated from `(schemaId, count, seed)`.

`node tests/api.mjs` runs a 71-check audit of the HTTP API: the reproducibility contract, schema validation, multi-entity row counts, sandbox isolation, and transport behaviour.

## Deploy on GitHub Pages

1. Create a repo and push these files (`index.html`, `engine.js`, `scoring.js`, `docs.html`, `faker.iife.js`, `faker-ext.js`, `README.md`).
2. In the repo: **Settings → Pages → Source: Deploy from a branch → main / root**.
3. Open `https://<your-username>.github.io/<repo-name>/`

That's it. Note that opening `index.html` straight from disk does not work — browsers block the page's script loads over `file://`. To run it locally, serve the folder (`python3 -m http.server`) and open `localhost`.

## How Faker is loaded

The app tries, in order:

1. **Vendored copy** — `./faker.iife.js` (the full modern library, including all 72 locales, served from this repo — no runtime dependency on any external host)
2. **CDN** — `@faker-js/faker` v9 from jsdelivr, only if the vendored file is missing
3. **Built-in pools** — small fallback word lists so the tool never breaks

`./faker-ext.js` loads next and adds this build's own generator modules (see below). Keeping them in a separate file means the vendored bundle stays a pristine artifact you can re-bundle without re-applying edits.

To rebuild the vendored bundle with a newer version:

```bash
npm i @faker-js/faker && npx esbuild node_modules/@faker-js/faker/dist/index.js \
  --bundle --format=iife --global-name=FakerLib --minify --outfile=faker.iife.js
```

## Schema format

Export/import uses this JSON shape:

```json
{
  "version": 2,
  "entities": [{ "name": "Records", "rows": "100", "root": "records", "record": "record", "fields": [ ... ] }]
}
```

Older single-entity files still import:

```json
{
  "root": "records",
  "record": "record",
  "fields": [
    { "name": "name", "type": "First Name", "opts": {} },
    { "name": "nick", "type": "Custom List", "opts": { "values": "billy, bud, ace" } },
    { "name": "combine.normalize", "type": "Formula (JS)",
      "opts": { "expr": "normalize(field('name') + field('nick'))" } },
    { "name": "orders.order[1-3].sku", "type": "Faker (any)",
      "opts": { "method": "commerce.isbn" } }
  ]
}
```

Keep one schema file per data model and import whichever you need.

## Using the app

Structural edits — adding, removing, duplicating, reordering a field, switching entity — animate through the browser's View Transitions API, keyed on each field's id so a reorder reads as a move rather than a rewrite. No library, and it falls back to a plain redraw where the API is missing or the reader prefers reduced motion.

Each field is a card: name on top, type picker right below (click it and type to search), and options underneath. Cards can be dragged to reorder and duplicated in one click, and each shows a live sample value. The preview updates as you edit (Ctrl/Cmd+Enter refreshes on demand) and has a copy button.

Need linked record types — Contacts pointing at real Account ids? Add an **entity tab** per record type; tabs generate left-to-right in one run, and a **Reference** field on the child picks from the values a parent entity actually produced (random many-to-one, or `unique` for one-to-one). *Download all* saves one file per entity from a single run, so IDs line up across files, and a seed reproduces the whole linked dataset.

Testing a matching or dedup engine? The **dups** control emits fuzzed duplicate variants of a chosen share of records (three intensity presets, damage picked by field type — typos in names, reformatted phones, shifted dates) with a **match_id** ground-truth column: originals and their variants share a value, so scoring a matcher is a group-by. UUIDs regenerate per variant; references stay intact. A fourth level, **targeted**, sets a per-field similarity threshold instead: pick Jaro-Winkler or Levenshtein and a value like 0.90, and variants are fuzzed until they land at that similarity to the original (achieved averages are reported live).

**Score matcher** closes the loop. Generate with dups on and a seed set, download, hold back the `match_id` column, run your matcher, and paste the pairs it linked into the dialog. It rebuilds the answer key from the same seed and reports **pairwise precision, recall and F1** — never accuracy, which a matcher that links nothing would ace — with the links closed under transitivity so an implied A–C is credited. Paste scored pairs and you also get a **threshold sweep** and the three numbers an MDM team actually decides on: auto-merge precision, auto-merge recall, and how much landed in the review queue. Pick a blocking key field (or paste your candidate pairs) and it reports **pair completeness**, the recall ceiling blocking imposes, alongside the reduction ratio. Every false merge and missed match is listed by record id so a recall gap can be traced to a name, a date or a block. The same scorer is exposed as `POST /v1/score` in the API and lives in `scoring.js` for use from Node.

A **Recipes** button inserts common dependent-field groups in one click — derived and corporate emails, consistent US and international geography with format-valid postal codes, phones/faxes tied to the record's city, ordered dates, age from birth date, CRM-style IDs, and a cross-entity link that keeps a parent's id and name paired. Recipes bind to fields you already have and insert plain, editable fields.

The full guide — every field type, structure syntax, linked entities, matching/dedup datasets, and ready-made formula recipes — ships with the app as [docs.html](docs.html).

## Field naming

| Syntax | Meaning | Output |
|---|---|---|
| `address.city` | Nesting | `<address><city>…</city></address>` |
| `order.@id` | XML attribute | `<order id="…">` |
| `friend[3]` | Repeat exactly 3× | three `<friend>` elements |
| `item[2-5]` | Repeat random 2–5× | shared count across sibling fields |

## Field types

- **Built-ins:** names, email, phone, address parts, company, job title, UUID, boolean, number (min/max/decimals), date (range + format), custom list, static value, lorem words
- **Faker (any):** call any method in the Faker library by path — `finance.iban`, `vehicle.vin`, `internet.username`, `commerce.productName`, `git.commitSha`, etc. Click the method box and type to search: the field autocompletes against every method the loaded build exposes (425 across 49 modules), so you don't need to know a path in advance. The catalog is read from Faker itself at page load, and methods that require arguments are left out because this tool calls them with none. See [fakerjs.dev/api](https://fakerjs.dev/api/) for what each one returns.

  The type picker lists all of it: click it and type to search the built-ins plus every Faker method, grouped by module. Picking a method is the same as choosing **Faker (any)** with that path, so schemas stay compatible either way.
- **Formula (JS):** JavaScript expression with access to other fields:
  - `field('name')` — value of another field (current repeat index if repeated)
  - `fields('name')` — full array for repeated fields
  - `normalize(s)` — lowercase, strip non-alphanumerics
  - `concat(...)`, `pad(v, len)`, `rand(min, max)`, `i` (repeat index), `row` (whole record)

Formulas run after all other fields, in field order, so a formula can also reference an earlier formula.

## Extra generator modules

`faker-ext.js` adds 181 methods on top of Faker's own catalog. They show up in the type picker as ordinary categories and honour the seed like everything else:

| Module | For |
|---|---|
| `dirty` | The values real source systems contain — `nullish`, `leadingZeroNumber`, `unicodeConfusable`, `zeroWidth`, `emailTypo`, `phoneMessy`, `dateMessy`, `csvBreaker`. Built for ingestion and matching tests. |
| `weighted` | Realistic skew instead of uniform picks — `customerTier` (70/20/10), `accountStatus`, `leadSource`, `industry`, `country`, `usState`, `emailDomain`. |
| `ident` | Identifiers with verifiable check digits — `npi`, `abaRouting`, `isin`, `gtin13`, `upc12`, `vin`, `nhsNumber`, `sinCanada`, `ssn`, `ein`. |
| `ids` | CRM/ERP-shaped ids — `salesforceAccount` (valid 18-char checksum), `sapCustomer`, `netsuiteInternal`, `dynamicsGuid`, `hubspotObjectId`, `jiraIssueKey`. |
| `geo…` | Country pools scoped to a region with each country's real postal format — `geoNorthAmerica`, `geoLatinAmerica`, `geoEurope`, `geoAsiaPacific`, `geoMiddleEastAfrica`. |
| `intl…` | Genuinely localised data from twelve locales in the bundle — `intlJapan`, `intlGermany`, `intlBrazil`, `intlKorea` and more, plus `intlAny` for a different country every row. |
| `unwrap` | Flat accessors for the Faker methods that return objects or arrays (they render as `[object Object]` in CSV/XML) — `airportName`, `currencyCode`, `elementSymbol`, `colorHsl`. |

Each method is an independent draw. When country, city and postal code must agree on a row, use the module's `place()` method — it returns one JSON object — and split it with formulas (`JSON.parse(field('_src')).city`).

To add your own, edit `faker-ext.js`: modules must be flat (`faker.acme.productCode`), methods take no arguments, must return something defined, and must draw randomness from `faker.*` rather than `Math.random()` so the seed still holds. [docs.html](docs.html#modules) has the full guide.

## Reproducible data

Set a **seed** and the same schema, row count and seed always produce identical
output — useful for repeatable test suites.

The row count is part of that, not a separate knob. The generator draws from one
seeded stream, so row 7 depends on everything drawn for rows 1-6: asking for 11
rows instead of 10 does not append a row, it shifts the whole run. Pin the schema,
the count and the seed together, or pin none of them.

(Duplicate injection is the one exception: it emits more rows than requested, and
the injected rows shift the ones after them. Such a run still reproduces exactly
for that same count.)

## Limits

- 10,000 rows per download (browser memory guardrail)
- One repeating segment per field path
- Formulas are plain JS evaluated in-page; this is a test-data tool, so only paste expressions you trust. (The API, which cannot trust its callers, runs them in a separate process instead — see [api/README.md](./api/README.md).)
