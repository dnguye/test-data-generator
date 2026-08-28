# Schema JSON specification (v2)

This document fully specifies the import/export file format of **Test Data
Generator** (https://dnguye.github.io/Test-data-generator/). It is written so
that a person — or an AI given an XSD, sample XML, or a plain description —
can author an importable `schema.json` without seeing the app.

## Top level

```json
{
  "version": 2,
  "seed": "42",            // optional; string or number; same seed => identical data
  "format": "xml",         // optional; "xml" | "json" | "csv"
  "active": 0,             // optional; index of the entity tab to open
  "entities": [ ... ]      // required; one entry per record type, ORDER MATTERS
}
```

Entities generate **in array order**. A `Reference` field may only point to an
entity that appears **earlier** in the array.

## Entity

```json
{
  "name": "Contacts",      // unique display name; Reference fields address it by this
  "rows": "100",           // base record count, 1..10000 (string or number)
  "root": "contacts",      // XML only: root element name
  "record": "contact",     // XML only: per-record element name
  "dupLevel": "off",       // "off" | "light" | "medium" | "heavy" | "targeted"
  "dupPct": "20",          // % of records that get duplicate variants (dups only)
  "dupMax": "2",           // max variants per duplicated record, 1..5 (dups only)
  "fields": [ ... ]
}
```

Duplicate variants exist to test matching/dedup engines: originals and their
variants share an auto-added `match_id` column (ground truth). `light/medium/
heavy` apply preset, field-type-aware damage; `targeted` uses per-field
similarity targets (see `sim` below).

## Field

```json
{ "name": "<field path>", "type": "<type name>", "opts": { ... } }
```

Optional, only meaningful when the entity's `dupLevel` is `"targeted"`:

```json
"sim": { "algo": "jw", "target": "0.90" }   // "jw" = Jaro-Winkler, "lev" = Levenshtein
```

A variant's value for this field is fuzzed until its similarity to the
original lands as close as possible to `target` (0.5–1.0). Fields without
`sim` are copied unchanged in targeted mode.

### Field path notation (`name`)

Structure is encoded in the field name using dotted paths:

| Syntax | Meaning | XML result |
|---|---|---|
| `address.city` | dots nest elements | `<address><city>…</city></address>` |
| `order.@id` | `@` on the LAST segment makes an XML attribute | `<order id="…">` |
| `friend[3]` | repeat exactly 3× | three `<friend>` elements |
| `item[2-5]` | repeat a random 2–5× per record | 2–5 `<item>` elements |

Rules: at most **one repeating segment per path**; sibling fields sharing the
same repeating prefix (e.g. `orders.order[1-3].sku` and
`orders.order[1-3].qty`) share one count per record so their parts line up.
In JSON output, nesting becomes objects and repeats become arrays; in CSV the
full path is the column header and repeated values join with `|`.

### Type names and their `opts`

Type names must match EXACTLY (case and spacing). Omitted opts use defaults.

| `type` | `opts` | Generates |
|---|---|---|
| `Row Number` | — | 1, 2, 3, … |
| `First Name` / `Last Name` / `Full Name` | — | person names |
| `Email` / `Phone` | — | contact fields |
| `Street Address` / `City` / `State` / `State Abbr` / `Zip Code` / `Country` | — | address parts |
| `Company` / `Job Title` | — | org fields |
| `UUID` | — | v4 UUID |
| `Boolean` | — | true/false |
| `Number` | `{"min":"1","max":"100","decimals":"0"}` | random number |
| `Date` | `{"from":"2024-01-01","to":"2026-08-27","dateFormat":"YYYY-MM-DD"}` | random date; tokens `YYYY MM DD HH mm ss` |
| `Custom List` | `{"values":"red, green, blue"}` | one value from the comma-separated list |
| `Static Value` | `{"value":"fixed"}` | the same value every record |
| `Lorem Words` | `{"count":"3"}` | placeholder words |
| `Faker (any)` | `{"method":"finance.iban"}` | any no-argument @faker-js/faker v9 method by path (e.g. `commerce.isbn`, `vehicle.vin`, `internet.username`) |
| `Reference` | `{"entity":"Accounts","field":"id","unique":""}` | a value already generated for an EARLIER entity; `"unique":"1"` uses each value at most once (one-to-one) |
| `Formula (JS)` | `{"expr":"<JavaScript expression>"}` | computed per record — see below |

### Formula (JS) expressions

`expr` is a **single JavaScript expression** (not statements) evaluated per
record after all non-formula fields, in field order (a formula may reference
an earlier formula). Environment:

- `field('name')` — another field's value (current repeat index if repeated)
- `fields('name')` — the full array for a repeated field (use the full path
  as the name, e.g. `fields('orders.order[1-3].qty')`)
- `i` — current repeat index (0-based) when the formula field itself repeats
- `row` — the whole record so far, keyed by field name
- Helpers: `normalize(s)` (lowercase, strip non-alphanumerics),
  `concat(...)`, `pad(v, len, ch?)`, `rand(min, max)` (seeded integer)
- Plus ordinary JavaScript: string methods, `Math`, ternaries, IIFEs.

Examples: `(field('first_name')+'.'+field('last_name')).toLowerCase()`,
`'CUST-' + pad(field('id'), 6)`, `rand(2000,40000)/100`.

## Mapping an XSD to this format

- Each top-level repeating element type → one **entity** (`record` = the
  element name, `root` = its container).
- Leaf `xs:element` → a field; nested complex types become dotted paths.
- `xs:attribute` → `@name` on the last path segment.
- `minOccurs`/`maxOccurs` → `[min-max]` on the repeating segment
  (`maxOccurs="unbounded"` → pick a sensible cap, e.g. `[1-5]`).
- `xs:string` → a semantically matching type (`First Name`, `City`,
  `Faker (any)`, or `Custom List` for enumerations); `xs:int`/`xs:decimal` →
  `Number`; `xs:date`/`xs:dateTime` → `Date`; `xs:boolean` → `Boolean`;
  keyref/foreign-key relationships → `Reference`.
- `xs:enumeration` values → `Custom List` with those values.

## Validation

Import the file in the app (Import schema). Malformed files are rejected with
a message; unknown type names fall back to `First Name` (so type strings must
be exact); files containing `Formula (JS)` fields load with the preview held
until the formulas are reviewed. Generated-data files (arrays of records) are
rejected — this format describes rules, not data.
