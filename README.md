# Test Data Forge

A zero-dependency, browser-based test data generator. Define a schema (or import one), add field logic with JavaScript formulas, and generate nested XML, JSON, or CSV — powered by the modern [@faker-js/faker](https://fakerjs.dev) library.

Everything runs client-side. No server, no build step, no accounts, and no data leaves the browser.

## Deploy on GitHub Pages

1. Create a repo and push these files (`index.html`, `faker.iife.js`, `README.md`).
2. In the repo: **Settings → Pages → Source: Deploy from a branch → main / root**.
3. Open `https://<your-username>.github.io/<repo-name>/`

That's it. You can also just open `index.html` directly from disk — it works as a local file too.

## How Faker is loaded

The app tries, in order:

1. **Vendored copy** — `./faker.iife.js` (full modern library, offline-capable, works from `file://`)
2. **CDN** — `@faker-js/faker` v9 from jsdelivr, only if the vendored file is missing
3. **Built-in pools** — small fallback word lists so the tool never breaks

To rebuild the vendored bundle with a newer version:

```bash
npm i @faker-js/faker && npx esbuild node_modules/@faker-js/faker/dist/index.js \
  --bundle --format=iife --global-name=FakerLib --minify --outfile=faker.iife.js
```

## Schema format

Export/import uses this JSON shape:

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

## Field naming

| Syntax | Meaning | Output |
|---|---|---|
| `address.city` | Nesting | `<address><city>…</city></address>` |
| `order.@id` | XML attribute | `<order id="…">` |
| `friend[3]` | Repeat exactly 3× | three `<friend>` elements |
| `item[2-5]` | Repeat random 2–5× | shared count across sibling fields |

## Field types

- **Built-ins:** names, email, phone, address parts, company, job title, UUID, boolean, number (min/max/decimals), date (range + format), custom list, static value, lorem words
- **Faker (any):** call any method in the Faker library by path — `finance.iban`, `vehicle.vin`, `internet.username`, `commerce.productName`, `git.commitSha`, etc. Click the method box and type to search: the field autocompletes against every method the loaded Faker build exposes (244 across 26 modules), so you don't need to know a path in advance. The catalog is read from Faker itself at page load, and methods that require arguments are left out because this tool calls them with none. See [fakerjs.dev/api](https://fakerjs.dev/api/) for what each one returns.

  The type dropdown lists all of it: the built-ins first, then every Faker method grouped by module (`faker · finance`, `faker · vehicle`, …). Picking one is the same as choosing **Faker (any)** and typing that path by hand, so schemas exported before and after this change stay compatible.
- **Formula (JS):** JavaScript expression with access to other fields:
  - `field('name')` — value of another field (current repeat index if repeated)
  - `fields('name')` — full array for repeated fields
  - `normalize(s)` — lowercase, strip non-alphanumerics
  - `concat(...)`, `pad(v, len)`, `rand(min, max)`, `i` (repeat index), `row` (whole record)

Formulas run after all other fields, in field order, so a formula can also reference an earlier formula.

## Reproducible data

Set a **seed** and the same schema + seed always produces identical output — useful for repeatable test suites.

## Limits

- 10,000 rows per download (browser memory guardrail)
- One repeating segment per field path
- Formulas are plain JS evaluated in-page; this is a test-data tool, so only paste expressions you trust
