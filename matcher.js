/* ---------------------------------------------------------------------------
   matcher.js -- a configurable record matcher, for simulating one against the
   data this tool generates.

   The model is the one MDM products use, because it is the one people already
   think in:

     a RULE is a set of field comparisons, ALL of which must pass (AND)
     a pair MATCHES if ANY rule passes (OR)

   So "exact SSN and date of birth" sits beside "fuzzy surname, fuzzy forename
   and exact date of birth", and a pair linked by either is linked. Each rule
   carries a confidence, and a pair's score is the highest confidence among the
   rules that passed it -- which is what lets a strict rule auto-merge while a
   loose one only earns a place in a review queue.

   Blocking is derived rather than configured. A rule that contains an equality
   comparison (exact, normalized, prefix, soundex) can only ever match records
   that agree on it, so those comparisons compose into a key and the rule is
   evaluated within key groups instead of over all pairs. A rule made only of
   fuzzy comparisons has no such key and costs the full n^2, which is why the
   comparison budget below exists and why the UI says which rules are unblocked.

   No DOM and no dependencies, like engine.js and scoring.js: the page, the
   tests and anything in Node run this same implementation.
--------------------------------------------------------------------------- */
"use strict";

import { jaroWinkler, levSim } from "./engine.js";
import { getPath } from "./scoring.js";

/* Comparing every pair of 14,000 records is 98 million comparisons and a
   locked-up tab. Rules with an equality component never come near this; a rule
   built only of fuzzy comparisons hits it immediately, which is the honest
   moment to say so rather than to freeze. */
export const MAX_COMPARISONS = 3000000;

/* ---------- helpers ---------- */
const norm = s => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const isBlank = v => v === null || v === undefined || String(v).trim() === "";

/* Soundex: the classic surname coder. Keeps the first letter, codes the rest
   by articulation, drops repeats. H and W are transparent -- they do not
   separate two consonants that would otherwise collapse -- which is the rule
   most naive implementations miss (Ashcraft is A261, not A226). */
export function soundex(value) {
  const s = String(value ?? "").toUpperCase().replace(/[^A-Z]/g, "");
  if (!s) return "";
  const code = c =>
    "BFPV".includes(c) ? "1" :
    "CGJKQSXZ".includes(c) ? "2" :
    "DT".includes(c) ? "3" :
    c === "L" ? "4" :
    "MN".includes(c) ? "5" :
    c === "R" ? "6" : "";
  let out = s[0], prev = code(s[0]);
  for (let i = 1; i < s.length && out.length < 4; i++) {
    const c = s[i], d = code(c);
    if (d && d !== prev) out += d;
    if (c !== "H" && c !== "W") prev = d;
  }
  return (out + "000").slice(0, 4);
}

/* Same words in any order: "Smith John" and "John Smith" are the same name
   entered by two systems that disagree about which field comes first. */
function tokenKey(value) {
  return String(value ?? "").toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean).sort().join(" ");
}

const days = (a, b) => {
  const x = Date.parse(a), y = Date.parse(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return Math.abs(x - y) / 86400000;
};

/* ---------- the comparison catalogue ----------
   `key` is what makes a comparison blockable: a function of ONE value that two
   records must agree on for the comparison to pass. Where that exists, the
   rule can be narrowed to groups sharing the key instead of scanning pairs. */
export const COMPARISONS = [
  { id: "exact", label: "is exactly", arg: null,
    key: v => String(v ?? ""), test: (a, b) => String(a) === String(b) },
  { id: "normalized", label: "matches ignoring case and punctuation", arg: null,
    key: v => norm(v), test: (a, b) => norm(a) === norm(b) },
  { id: "prefix", label: "first N characters match", arg: "n", argLabel: "characters", argDefault: "3",
    key: (v, n) => norm(v).slice(0, Math.max(1, parseInt(n) || 3)),
    test: (a, b, n) => { const k = Math.max(1, parseInt(n) || 3); return norm(a).slice(0, k) === norm(b).slice(0, k); } },
  { id: "soundex", label: "sounds alike (Soundex)", arg: null,
    key: v => soundex(v), test: (a, b) => soundex(a) === soundex(b) },
  { id: "tokens", label: "same words in any order", arg: null,
    key: v => tokenKey(v), test: (a, b) => tokenKey(a) === tokenKey(b) },
  { id: "jw", label: "Jaro-Winkler at least", arg: "threshold", argLabel: "similarity", argDefault: "0.90",
    key: null, measure: (a, b) => jaroWinkler(String(a), String(b)), unit: "similarity",
    test: (a, b, t) => jaroWinkler(String(a), String(b)) >= (parseFloat(t) || 0.9) },
  { id: "lev", label: "Levenshtein at least", arg: "threshold", argLabel: "similarity", argDefault: "0.85",
    key: null, measure: (a, b) => levSim(String(a), String(b)), unit: "similarity",
    test: (a, b, t) => levSim(String(a), String(b)) >= (parseFloat(t) || 0.85) },
  { id: "jwTokens", label: "Jaro-Winkler on sorted words at least", arg: "threshold", argLabel: "similarity", argDefault: "0.90",
    key: null, measure: (a, b) => jaroWinkler(tokenKey(a), tokenKey(b)), unit: "similarity",
    test: (a, b, t) => jaroWinkler(tokenKey(a), tokenKey(b)) >= (parseFloat(t) || 0.9) },
  { id: "numeric", label: "numbers within", arg: "n", argLabel: "±", argDefault: "1",
    key: null, unit: "difference",
    measure: (a, b) => { const x = parseFloat(a), y = parseFloat(b); return Number.isFinite(x) && Number.isFinite(y) ? Math.abs(x - y) : null; },
    test: (a, b, n) => {
      const x = parseFloat(a), y = parseFloat(b);
      return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) <= (parseFloat(n) || 0);
    } },
  { id: "days", label: "dates within", arg: "n", argLabel: "days", argDefault: "1",
    key: null, unit: "days", measure: (a, b) => days(a, b),
    test: (a, b, n) => { const d = days(a, b); return d !== null && d <= (parseFloat(n) || 0); } }
];
const BY_ID = new Map(COMPARISONS.map(c => [c.id, c]));
export function comparison(id) { return BY_ID.get(id) || null; }

/* ---------- rules ---------- */
/**
 * A rule:
 *   { name, confidence, blankAgrees, comparisons: [{ field, kind, arg }] }
 * blankAgrees decides what a missing value means. Off (the default) a blank
 * fails its comparison, which is the safe reading: absence of evidence is not
 * agreement. On, a blank on either side is treated as agreeing, which is how
 * some hubs treat sparse optional fields.
 */
export function newRule(name) {
  return { name: name || "Rule", confidence: "0.95", blankAgrees: false, comparisons: [] };
}
export function newComparison(field, kind = "exact") {
  const c = comparison(kind) || COMPARISONS[0];
  return { field: field || "", kind: c.id, arg: c.arg ? c.argDefault : "" };
}

function validateRule(rule, index, fieldNames) {
  const where = "rule " + (index + 1) + (rule.name ? ' "' + rule.name + '"' : "");
  if (!rule.comparisons || !rule.comparisons.length)
    throw new Error(where + " has no comparisons -- a rule with nothing to compare would link every record to every other.");
  for (const c of rule.comparisons) {
    if (!c.field) throw new Error(where + ": a comparison has no field selected.");
    if (fieldNames && !fieldNames.has(c.field))
      throw new Error(where + ': no field named "' + c.field + '" in this entity.');
    const def = comparison(c.kind);
    if (!def) throw new Error(where + ': unknown comparison "' + c.kind + '".');
    if (def.arg === "threshold") {
      const t = parseFloat(c.arg);
      if (!Number.isFinite(t) || t <= 0 || t > 1)
        throw new Error(where + ": " + def.label + " needs a similarity between 0 and 1.");
    }
    if (def.arg === "n") {
      const n = parseFloat(c.arg);
      if (!Number.isFinite(n) || n < 0) throw new Error(where + ": " + def.label + " needs a number of 0 or more.");
    }
  }
  const conf = parseFloat(rule.confidence);
  if (rule.confidence !== undefined && rule.confidence !== "" && (!Number.isFinite(conf) || conf < 0 || conf > 1))
    throw new Error(where + ": confidence must be between 0 and 1.");
}

function ruleConfidence(rule) {
  const c = parseFloat(rule.confidence);
  return Number.isFinite(c) ? Math.min(Math.max(c, 0), 1) : 1;
}

/* The equality comparisons of a rule, composed into one key. Null when the
   rule has none, which means it has to be evaluated against every pair. */
function ruleKey(rule, record) {
  const parts = [];
  for (const c of rule.comparisons) {
    const def = comparison(c.kind);
    if (!def || !def.key) continue;
    const v = getPath(record, c.field);
    if (isBlank(v)) return null;              // a blank cannot anchor a block
    parts.push(def.key(v, c.arg));
  }
  return parts.length ? parts.join("") : null;
}
function ruleIsBlocked(rule) {
  return rule.comparisons.some(c => { const d = comparison(c.kind); return d && d.key; });
}

/* One pair against one rule: every comparison has to pass.

   At least one comparison must actually have been evaluated. Without that
   guard a rule under blankAgrees whose every field is blank on one side would
   pass vacuously and link that record to the entire file -- so blankAgrees
   only ever rescues a rule that still has some other comparison carrying it,
   which is the case it exists for (an optional middle initial should not sink
   an otherwise convincing name match). */
function rulePasses(rule, a, b) {
  let evaluated = 0;
  for (const c of rule.comparisons) {
    const def = comparison(c.kind);
    if (!def) return false;
    const va = getPath(a, c.field), vb = getPath(b, c.field);
    if (isBlank(va) || isBlank(vb)) {
      if (rule.blankAgrees) continue;
      return false;
    }
    if (!def.test(va, vb, c.arg)) return false;
    evaluated++;
  }
  return evaluated > 0;
}

/* ---------- running the matcher ---------- */
/**
 * @param {object[]} records  the generated rows
 * @param {object[]} rules
 * @param {{idField: string, maxComparisons?: number}} options
 * @returns {{
 *   pairs: Array<[string,string,number]>,   linked pairs with their score
 *   candidates: Array<[string,string]>,     every pair actually compared
 *   perRule: Array<{name,linked,compared,blocked}>,
 *   comparisons: number, unblockedRules: string[]
 * }}
 */
export function runMatcher(records, rules, options = {}) {
  const idField = options.idField;
  if (!idField) throw new Error("runMatcher needs an idField");
  if (!Array.isArray(records) || !records.length) throw new Error("no records to match");
  if (!Array.isArray(rules) || !rules.length) throw new Error("Add at least one match rule.");

  const fieldNames = new Set();
  for (const r of records.slice(0, 5)) for (const k of Object.keys(r)) fieldNames.add(k);
  rules.forEach((r, i) => validateRule(r, i, fieldNames.size ? fieldNames : null));

  const ids = records.map(r => {
    const v = getPath(r, idField);
    if (isBlank(v)) throw new Error('a record has no value in the id field "' + idField + '"');
    return String(v);
  });

  /* Cost first, so an unblocked rule refuses rather than freezes. */
  const n = records.length;
  const allPairs = n * (n - 1) / 2;
  const budget = options.maxComparisons || MAX_COMPARISONS;
  const groupsPerRule = rules.map(rule => {
    if (!ruleIsBlocked(rule)) return null;
    const m = new Map();
    const wild = [];
    records.forEach((rec, i) => {
      const k = ruleKey(rule, rec);
      if (k === null) {
        /* No usable key because a field the key is built from is blank. With
           blanks failing, this record can never pass the rule, so it sits out.
           With blankAgrees it still might -- another comparison could carry
           it -- so it has to be compared against everything. */
        if (rule.blankAgrees) wild.push(i);
        return;
      }
      let g = m.get(k); if (!g) m.set(k, g = []);
      g.push(i);
    });
    return { groups: m, wild };
  });
  let cost = 0;
  const unblocked = [];
  groupsPerRule.forEach((b, i) => {
    if (b === null) { cost += allPairs; unblocked.push(rules[i].name || "rule " + (i + 1)); return; }
    for (const g of b.groups.values()) cost += g.length * (g.length - 1) / 2;
    cost += b.wild.length * (n - 1);          // a keyless record is compared with all
  });
  if (cost > budget)
    throw new Error(
      "These rules would need " + Math.round(cost).toLocaleString() + " comparisons, over the " +
      budget.toLocaleString() + " limit." +
      (unblocked.length
        ? " " + unblocked.map(x => '"' + x + '"').join(", ") + (unblocked.length === 1 ? " compares" : " compare") +
          " every pair because " + (unblocked.length === 1 ? "it has" : "they have") +
          " no exact, prefix or Soundex comparison to narrow on. Add one, or generate fewer rows."
        : " Generate fewer rows.")
    );

  /* Evaluate. A pair can be reached by several rules; it keeps the highest
     confidence among those that passed, and remembers which rules those were
     so the report can say which rule produced which mistake. */
  const linked = new Map();                   // "i,j" -> {i, j, score, by:Set}
  const candidates = new Map();
  let compared = 0;
  const perRule = rules.map(r => ({ name: r.name || "", linked: 0, compared: 0, blocked: ruleIsBlocked(r) }));

  const seenPerRule = rules.map(() => new Set());
  const consider = (ri, i, j) => {
    if (i === j) return;
    const a = i < j ? i : j, b = i < j ? j : i;
    const pk = a + "," + b;
    if (seenPerRule[ri].has(pk)) return;      // a wildcard record can reach a pair its group already did
    seenPerRule[ri].add(pk);
    candidates.set(pk, [a, b]);
    compared++;
    perRule[ri].compared++;
    if (!rulePasses(rules[ri], records[a], records[b])) return;
    perRule[ri].linked++;
    let hit = linked.get(pk);
    if (!hit) linked.set(pk, hit = { i: a, j: b, score: 0, by: new Set() });
    hit.by.add(ri);
    hit.score = Math.max(hit.score, ruleConfidence(rules[ri]));
  };

  rules.forEach((rule, ri) => {
    const b = groupsPerRule[ri];
    if (b === null) {
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) consider(ri, i, j);
    } else {
      for (const g of b.groups.values())
        for (let x = 0; x < g.length; x++) for (let y = x + 1; y < g.length; y++) consider(ri, g[x], g[y]);
      for (const w of b.wild) for (let j = 0; j < n; j++) consider(ri, w, j);
    }
  });

  const pairs = [...linked.values()].map(h => [ids[h.i], ids[h.j], Math.round(h.score * 1000) / 1000]);
  const pairRules = [...linked.values()].map(h => [...h.by].sort());
  return {
    pairs,
    pairRules,
    candidates: [...candidates.values()].map(([a, b]) => [ids[a], ids[b]]),
    perRule,
    comparisons: compared,
    totalPossible: allPairs,
    unblockedRules: unblocked
  };
}

/* ---------- explaining one pair ----------
   The report says HOW MANY pairs a rule got wrong; this says WHY, for one pair:
   every rule, every comparison, the two values, the number that was measured
   and the verdict. It is what turns "recall 0.22" into "rule 2 keeps failing
   on birth_date because the dates are mangled" -- the diagnosis that decides
   which threshold to move. */
export function explainPair(rules, a, b) {
  return rules.map((rule, ri) => {
    let evaluated = 0, passed = true;
    const comparisons = rule.comparisons.map(c => {
      const def = comparison(c.kind);
      const va = getPath(a, c.field), vb = getPath(b, c.field);
      const row = { field: c.field, kind: c.kind, label: def ? def.label : c.kind, arg: c.arg,
        a: va === undefined || va === null ? "" : String(va), b: vb === undefined || vb === null ? "" : String(vb),
        measured: null, unit: def && def.unit || null, skipped: false, passed: false };
      if (!def) { passed = false; return row; }
      if (isBlank(va) || isBlank(vb)) {
        if (rule.blankAgrees) { row.skipped = true; row.passed = true; return row; }
        passed = false; return row;
      }
      if (def.measure) { const m = def.measure(va, vb); row.measured = m === null || m === undefined ? null : Math.round(m * 1000) / 1000; }
      row.passed = !!def.test(va, vb, c.arg);
      evaluated++;
      if (!row.passed) passed = false;
      return row;
    });
    if (evaluated === 0) passed = false;      // nothing actually compared: the vacuous-pass guard
    return { index: ri, name: rule.name || ("Rule " + (ri + 1)), passed, evaluatedNothing: evaluated === 0, comparisons };
  });
}

/* Which comparison sank each missed pair, tallied per rule. A miss can fail
   several comparisons of the same rule; every one is counted, because every one
   would have to be loosened for that rule to catch it. Also counts the misses a
   rule was ONE comparison away from, which is where a threshold nudge pays. */
export function attributeMisses(rules, byId, missedPairs) {
  const out = rules.map((r, i) => ({
    index: i, name: r.name || ("Rule " + (i + 1)), misses: missedPairs.length, nearMisses: 0, blankOnly: 0,
    failedOn: r.comparisons.map(c => ({ field: c.field, kind: c.kind, label: (comparison(c.kind) || {}).label || c.kind, count: 0 }))
  }));
  let inspected = 0;
  for (const [ia, ib] of missedPairs) {
    const a = byId.get(String(ia)), b = byId.get(String(ib));
    if (!a || !b) continue;
    inspected++;
    const ex = explainPair(rules, a, b);
    ex.forEach((rx, ri) => {
      if (rx.passed) return;
      const failing = rx.comparisons.filter(c => !c.passed);
      failing.forEach(c => { const slot = out[ri].failedOn.find(f => f.field === c.field && f.kind === c.kind); if (slot) slot.count++; });
      if (failing.length === 1) out[ri].nearMisses++;
      if (rx.evaluatedNothing) out[ri].blankOnly++;
    });
  }
  return { rules: out, inspected };
}

/* ---------- starting points ----------
   Rules proposed from the field names a schema actually has. Not clever, and
   not meant to be: a first configuration to edit, so nobody faces an empty
   rule builder wondering what a rule looks like. */
const ROLES = [
  { role: "first", re: /^(first[_ ]?name|given[_ ]?name|forename|fname)$/i },
  { role: "last", re: /^(last[_ ]?name|surname|family[_ ]?name|lname)$/i },
  { role: "dob", re: /(birth[_ ]?date|date[_ ]?of[_ ]?birth|dob|birthdate)$/i },
  { role: "email", re: /e[-_ ]?mail/i },
  { role: "phone", re: /phone|mobile|tel/i },
  { role: "ssn", re: /ssn|social|national[_ ]?id/i },
  { role: "zip", re: /(zip|postal)(_?code)?$/i },
  { role: "street", re: /street|address(\.|_)?(line|1)?$/i },
  { role: "company", re: /company|organi[sz]ation|employer/i }
];
export function suggestRules(fieldNames) {
  const found = {};
  for (const role of ROLES) {
    const hit = fieldNames.find(f => role.re.test(f) || role.re.test(f.split(".").pop()));
    if (hit) found[role.role] = hit;
  }
  const rules = [];
  const cmp = (field, kind, arg) => ({ field, kind, arg: arg === undefined ? (comparison(kind).arg ? comparison(kind).argDefault : "") : String(arg) });

  if (found.ssn && found.dob)
    rules.push({ name: "Identifier and birth date", confidence: "0.99", blankAgrees: false,
      comparisons: [cmp(found.ssn, "exact"), cmp(found.dob, "exact")] });
  if (found.email)
    rules.push({ name: "Same email", confidence: "0.95", blankAgrees: false,
      comparisons: [cmp(found.email, "normalized")] });
  if (found.last && found.first && found.dob)
    rules.push({ name: "Fuzzy name and exact birth date", confidence: "0.90", blankAgrees: false,
      comparisons: [cmp(found.last, "jw", "0.85"), cmp(found.first, "jw", "0.80"), cmp(found.dob, "exact")] });
  if (found.last && found.first && found.zip)
    rules.push({ name: "Fuzzy name and postal code", confidence: "0.82", blankAgrees: false,
      comparisons: [cmp(found.last, "soundex"), cmp(found.first, "jw", "0.85"), cmp(found.zip, "exact")] });
  if (!rules.length && fieldNames.length)
    rules.push({ name: "Rule 1", confidence: "0.95", blankAgrees: false, comparisons: [cmp(fieldNames[0], "exact")] });
  return rules;
}
