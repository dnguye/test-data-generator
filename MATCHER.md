# Matcher file specification (v1)

This document specifies the **matcher file** that the *Score matcher* dialog of
**Test Data Generator** (https://dnguye.github.io/test-data-generator/) saves
with *Save matcher* and loads with *Import matcher*. It is written so that a
person, or an AI given a schema or a list of field names, can author one
without seeing the app.

The page also writes this whole document, with the fields of the entity you
are looking at filled in, to the clipboard: *Score matcher → Simulate a
matcher → Copy prompt for an AI*. Paste that into an assistant, save its
reply as a `.json` file, and load the file with *Import matcher*.

## What a matcher is

A matcher is a list of **rules**. Each rule is a list of **comparisons**
between one field of record A and the same field of record B.

- A rule **links** two records when **every** comparison in it passes (AND).
- Two records are a **match** when **any** rule links them (OR).
- Each rule carries a **confidence**. A linked pair's score is the highest
  confidence among the rules that passed. The scorer bands pairs by that score
  into auto-merge, review and no-link, and reports precision and recall against
  the ground truth in the generated data's `match_id` column.

## Top level

```json
{
  "kind": "matcher",       // required: exactly "matcher"
  "version": 1,            // required: 1
  "entity": "Patients",    // optional: the entity it was written for
  "linkPolicy": "all",     // optional: "all" (default) or "best"; see below
  "rules": [ ... ]         // required: one entry per rule; may be empty
}
```

`entity` is informational. Importing a matcher never switches entities; if the
name differs from the entity on screen, the rules are applied there and a note
says so.

## Rule

```json
{
  "name": "Fuzzy surname and exact birth date",   // shown in the report; keep it short
  "confidence": "1",                               // "0".."1" as a string; see below
  "blankAgrees": false,                            // what a blank value means; see below
  "comparisons": [ ... ]                           // one or more; all must pass
}
```

**confidence** becomes the score of every pair this rule links. Use `"1"` for
rules strict enough to merge on automatically, and something lower for rules
meant to feed a human review queue. If every rule is `"1"` the sweep and the
bands are flat, which is fine when you only want the over- and under-match
counts. Numbers are accepted and converted to strings on import; out-of-range
values are clamped to 0..1.

**blankAgrees** decides what a missing value means. `false`, the default, is
the safe reading: a blank fails its comparison, because absence of evidence is
not agreement. `true` treats a blank on either side as agreeing, the way some
hubs handle sparse optional fields. A rule under `blankAgrees` never passes on
blanks alone: at least one comparison must have been evaluated on real values.

## Comparison

```json
{ "field": "last_name", "kind": "jw", "arg": "0.85" }
```

- **field** is the field name exactly as it appears in the schema. Nested
  fields use dot paths (`address.zip`); XML attributes keep their `@`
  (`address.@use`). Repeating fields (`coverage[1-2].payer_id`) cannot be
  compared. Values are compared as strings.
- **kind** is one of the ids below.
- **arg** is the kind's parameter as a string, or `""` for kinds that take
  none. A missing or empty arg for a kind that needs one falls back to the
  default listed.

| kind | arg | passes when | blocking key |
|---|---|---|---|
| `exact` | none | the two values are identical as strings | yes |
| `normalized` | none | equal after lower-casing and dropping everything but letters and digits | yes |
| `prefix` | N characters, default `"3"` | the first N characters agree after that same normalisation | yes |
| `soundex` | none | the Soundex codes agree (Smith / Smyth, Robert / Rupert) | yes |
| `tokens` | none | the same words in any order ("Mary Ann" / "Ann Mary") | yes |
| `jw` | similarity 0..1, default `"0.90"` | Jaro-Winkler similarity is at least arg; best for names and short strings | no |
| `lev` | similarity 0..1, default `"0.85"` | Levenshtein similarity (1 − edits ÷ longer length) is at least arg; best for codes, dates and numbers written as text | no |
| `jwTokens` | similarity 0..1, default `"0.90"` | Jaro-Winkler on the words sorted, at least arg; for addresses and multi-word names | no |
| `numeric` | ± difference, default `"1"` | both parse as numbers and differ by at most arg | no |
| `days` | days, default `"1"` | both parse as dates and differ by at most arg days | no |

An unknown `kind` makes the import fail with the rule and kind named. A field
the current entity does not have is kept and warned about, so a matcher
written for one schema still opens against another.

## Blocking is derived from the rule

The simulator does not ask for a blocking key. Every comparison marked
*blocking key: yes* above produces one: a rule that contains at least one of
them only compares records that share that key, so it costs a fraction of the
full pair space. A rule made only of similarity comparisons (`jw`, `lev`,
`jwTokens`, `numeric`, `days`) has no key and compares every pair. The dialog
says so before it runs, and refuses beyond three million comparisons.

Give every rule one equality comparison on a field the duplicates rarely
damage: a state, a postal code, a birth year, a Soundex of the surname.

## Which record a record matches to

When several candidates pass a rule for the same record, `linkPolicy` decides
what the matcher does with them.

- `"all"`, the default, links every pair some rule passed. Every candidate
  becomes a link; the scorer's transitive closure then folds them into one
  cluster. This is what a pairwise scorer usually sees.
- `"best"` matches each record to its **single best candidate**, the way a
  hub matches an incoming record to one master. A pair survives only when it
  is the best candidate of at least one of its two records; the rest are
  dropped and counted. Use it when a record must never merge into more than
  one other, and to see how much of the over-matching a best-of choice would
  remove on its own.

The best candidate is the one with the highest score (the confidence of the
strongest rule that passed), then the one more rules agreed on, then the one
whose values were closest (an equality comparison that agreed counts 1, a
similarity comparison its measured value, a tolerance comparison
1 ÷ (1 + difference), averaged over the rule), then the lower id, so the
choice is reproducible. Whatever the policy, the run reports each record's
pick, and the page's *Match targets* lookup lists every candidate a record
had, best first, with the one it would match to marked.

```json
{ "kind": "matcher", "version": 1, "entity": "Patients", "linkPolicy": "best", "rules": [ ... ] }   // one target per record
```

## Choosing fields and thresholds

The generator's duplicate variants are the ground truth, so what it does to
each field decides what a rule can rely on. *Copy prompt for an AI* lists this
per field; the rules of thumb are:

- **Row Number** fields are unique per row and **UUID** fields regenerate for
  every variant. Never compare them; they are what the scorer uses as the
  record id.
- **Formula** fields are recomputed for every record, original or variant,
  from that record's own values, and are never damaged on their own. A match
  key built from a fuzzed surname is the key of the fuzzed surname, exactly
  as a hub would compute it, so a rule on it behaves like a rule on its
  sources. A formula of a row number or a UUID is as unique as they are: do
  not compare it.
- A field marked **keep in dups** is copied unchanged into every variant
  whatever the mode. It is what the duplicates agree on, so it is the
  natural exact comparison and blocking key for a rule.
- In **targeted** duplicate mode a field with a `sim` setting is fuzzed until
  its similarity to the original is about the target; every other field is
  copied unchanged. Set a similarity threshold a little below the target: a
  surname fuzzed to Jaro-Winkler 0.84 wants `jw` at `"0.80"`.
- In **light / medium / heavy** modes each field gets preset, type-aware
  damage (typos, case, spacing, format), so favour `normalized`, `soundex`
  and `jw` over `exact` on text.
- Use `lev` rather than `jw` for dates, codes and numbers written as text;
  Jaro-Winkler rewards a shared prefix, which digits do not deserve.
- Prefer strict rules. The scorer reports over-matches (false merges) and
  under-matches (missed pairs) separately, and in master data a false merge
  is the worse error.

## A complete example

For a Patients entity where `last_name` is fuzzed to Jaro-Winkler 0.84,
`birth_date` to Levenshtein 0.90, `email` to Jaro-Winkler 0.88 and
`address.state` is copied unchanged:

```json
{
  "kind": "matcher",
  "version": 1,
  "entity": "Patients",
  "linkPolicy": "best",
  "rules": [
    {
      "name": "State, fuzzy surname, fuzzy birth date",
      "confidence": "1",
      "blankAgrees": false,
      "comparisons": [
        { "field": "address.state", "kind": "exact", "arg": "" },
        { "field": "last_name", "kind": "jw", "arg": "0.80" },
        { "field": "birth_date", "kind": "lev", "arg": "0.85" }
      ]
    },
    {
      "name": "Same email",
      "confidence": "0.95",
      "blankAgrees": false,
      "comparisons": [
        { "field": "email", "kind": "normalized", "arg": "" }
      ]
    },
    {
      "name": "Sounds-alike surname, first name, postal code",
      "confidence": "0.85",
      "blankAgrees": true,
      "comparisons": [
        { "field": "last_name", "kind": "soundex", "arg": "" },
        { "field": "first_name", "kind": "jw", "arg": "0.85" },
        { "field": "address.zip", "kind": "lev", "arg": "0.80" }
      ]
    }
  ]
}
```

## Prompt to give an AI

*Copy prompt for an AI* writes this with the fields filled in. Without the
app, paste the following and replace the field list:

```text
Write a matcher file for the Score matcher in Test Data Generator
(https://dnguye.github.io/test-data-generator/). Reply with ONE JSON object
and nothing else; I will load it with the Import matcher button. The format
is specified in MATCHER.md at https://github.com/dnguye/test-data-generator.

Entity: Patients (targeted duplicates, 25% of records get up to 3 variants)
Fields a rule may compare (name, type, what a duplicate variant does to it):
- seq (Row Number) — unique per row, never compare
- first_name (First Name) — fuzzed to Jaro-Winkler about 0.90
- last_name (Last Name) — fuzzed to Jaro-Winkler about 0.84
- birth_date (Date) — fuzzed to Levenshtein about 0.90
- email (Email) — fuzzed to Jaro-Winkler about 0.88
- address.state (State Abbr) — copied unchanged
- address.zip (Zip Code) — fuzzed to Levenshtein about 0.88
- full_name (Formula) — recomputed from the record's own fuzzed fields

Rules: two to four, each with two to four comparisons and a short name.
Every rule needs one equality comparison (exact, normalized, prefix, soundex,
tokens) for blocking. A rule links when every comparison passes; records
match when any rule links them. confidence "1" for auto-merge rules, lower
for review. Set "linkPolicy": "best" so each record matches its single best
candidate. Never compare row numbers, UUIDs or formula fields alone. Kinds:
exact, normalized, prefix(arg N), soundex, tokens, jw(arg 0..1), lev(arg
0..1), jwTokens(arg 0..1), numeric(arg ±), days(arg days).
```

## Scorer files

*Export scorer* writes a superset of this format with `"kind": "scorer"`,
plus `idField`, `blockField`, `mode`, `closeTransitively`, `autoMerge`,
`reviewFloor` and the same `linkPolicy`. Either file opens in either importer: a scorer file on *Import
matcher* gives up its rules only; a matcher file on *Import scorer* fills the
rules and leaves every other setting as it was.
