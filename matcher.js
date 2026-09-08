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

/* How close two records are under a rule that passed, 0..1: an equality
   comparison that agreed counts 1, a similarity comparison its measured
   value, a tolerance comparison 1/(1+difference), a skipped blank nothing.
   Confidence says how much a rule is trusted; this says how convincingly a
   particular pair met it, which is what separates two candidates the same
   rule accepted. */
function ruleStrength(rule, a, b) {
  let sum = 0, n = 0;
  for (const c of rule.comparisons) {
    const def = comparison(c.kind);
    if (!def) continue;
    const va = getPath(a, c.field), vb = getPath(b, c.field);
    if (isBlank(va) || isBlank(vb)) continue;
    let v = 1;
    if (def.measure) {
      const m = def.measure(va, vb);
      if (m === null || m === undefined) continue;
      v = def.unit === "similarity" ? m : 1 / (1 + m);
    }
    sum += v; n++;
  }
  return n ? sum / n : 0;
}

/* Candidate order for one record: the higher score first, then the pair more
   rules agreed on, then the closer one, then the lower id so the choice is
   reproducible. Exported so the tie-break is tested, not assumed. */
export function rankLink(x, y) {
  return (y.score - x.score) || (y.rules.length - x.rules.length) || (y.strength - x.strength) || (x.other < y.other ? -1 : x.other > y.other ? 1 : 0);
}
export const LINK_POLICIES = ["all", "best"];

/* ---------- running the matcher ---------- */
/**
 * @param {object[]} records  the generated rows
 * @param {object[]} rules
 * @param {{idField: string, maxComparisons?: number, linkPolicy?: "all"|"best"}} options
 *   linkPolicy "all" (default) links every pair some rule passed. "best"
 *   matches each record to its single highest-ranked candidate, the way a
 *   hub matches an incoming record to one master: a pair survives when it
 *   is the best candidate of at least one of its two records.
 * @returns {{
 *   pairs: Array<[string,string,number]>,   linked pairs with their score, after the policy
 *   links: Array<{a,b,score,strength,rules:number[],chosen:boolean}>,  every pair some rule passed
 *   matchedTo: Object<string,string>,       each record's best candidate, whichever the policy
 *   droppedByPolicy: number, linkPolicy: string,
 *   candidates: Array<[string,string]>,     every pair actually compared
 *   perRule: Array<{name,linked,compared,blocked}>,
 *   comparisons: number, unblockedRules: string[]
 * }}
 */
export function runMatcher(records, rules, options = {}) {
  const idField = options.idField;
  if (!idField) throw new Error("runMatcher needs an idField");
  const linkPolicy = options.linkPolicy || "all";
  if (!LINK_POLICIES.includes(linkPolicy)) throw new Error('unknown link policy "' + linkPolicy + '"; use "all" or "best"');
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
    if (!hit) linked.set(pk, hit = { i: a, j: b, score: 0, strength: 0, by: new Set() });
    hit.by.add(ri);
    hit.score = Math.max(hit.score, ruleConfidence(rules[ri]));
    hit.strength = Math.max(hit.strength, ruleStrength(rules[ri], records[a], records[b]));
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

  const links = [...linked.values()].map(h => ({
    a: ids[h.i], b: ids[h.j], score: Math.round(h.score * 1000) / 1000, strength: Math.round(h.strength * 1000) / 1000,
    rules: [...h.by].sort((x, y) => x - y), chosen: true
  }));

  /* Each record's pick: the best of the candidates it was linked to. Under
     "best" that pick is the only link the record keeps; under "all" it is
     still reported, as the answer to "which record would this match to". */
  const byRecord = new Map();
  for (const l of links) {
    const push = (me, other) => { let x = byRecord.get(me); if (!x) byRecord.set(me, x = []); x.push({ link: l, other, score: l.score, rules: l.rules, strength: l.strength }); };
    push(l.a, l.b); push(l.b, l.a);
  }
  const matchedTo = {};
  const keep = new Set();
  for (const [me, cands] of byRecord) {
    cands.sort(rankLink);
    matchedTo[me] = cands[0].other;
    keep.add(cands[0].link);
  }
  let droppedByPolicy = 0;
  if (linkPolicy === "best") for (const l of links) if (!keep.has(l)) { l.chosen = false; droppedByPolicy++; }
  const kept = links.filter(l => l.chosen);
  const pairs = kept.map(l => [l.a, l.b, l.score]);
  const pairRules = kept.map(l => l.rules);
  return {
    pairs,
    pairRules,
    links,
    matchedTo,
    droppedByPolicy,
    linkPolicy,
    candidates: [...candidates.values()].map(([a, b]) => [ids[a], ids[b]]),
    perRule,
    comparisons: compared,
    totalPossible: allPairs,
    unblockedRules: unblocked
  };
}

/* The candidates one record was linked to, best first, with the one the
   matcher picked flagged. Under "best" the others were dropped; under "all"
   they were all linked, and the flag says which one a hub would have chosen. */
export function candidatesOf(result, id) {
  const me = String(id);
  const out = [];
  for (const l of result.links || []) {
    if (l.a !== me && l.b !== me) continue;
    const other = l.a === me ? l.b : l.a;
    out.push({ to: other, other, score: l.score, strength: l.strength, rules: l.rules, linked: l.chosen, picked: result.matchedTo[me] === other });
  }
  out.sort(rankLink);
  return out.map(({ other, ...rest }) => rest);
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

/* ---------- what changed in a variant, and what each rule made of it ----------
   The generator keeps every variant's original, so a variant is not just a
   pair that should match: it is a record with a known list of damaged fields.
   Labelling each change lets the report say "this rule loses every typo'd
   surname and survives every case change", which is the sentence that decides
   whether to swap an exact comparison for a fuzzy one. */
export const CHANGE_KINDS = [
  { id: "case", label: "case only" },
  { id: "spacing", label: "spacing only" },
  { id: "typo", label: "typo (1–2 edits)" },
  { id: "fuzzed", label: "fuzzed (several edits)" },
  { id: "digits", label: "digits changed" },
  { id: "date", label: "date shifted" },
  { id: "format", label: "reformatted" },
  { id: "blanked", label: "blanked" },
  { id: "filled", label: "filled in" },
  { id: "regenerated", label: "id regenerated" },
  { id: "derived", label: "derived (formula)" },
  { id: "other", label: "rewritten" }
];
const KIND_LABEL = new Map(CHANGE_KINDS.map(k => [k.id, k.label]));
export function changeLabel(id) { return KIND_LABEL.get(id) || id; }
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}/;
function levDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
/**
 * @param {unknown} from the original's value
 * @param {unknown} to the variant's value
 * @param {{type?: string}} [hint] the field's type, when known
 * @returns {string|null} a CHANGE_KINDS id, or null when nothing changed
 */
export function classifyChange(from, to, hint = {}) {
  const a = from === null || from === undefined ? "" : String(from), b = to === null || to === undefined ? "" : String(to);
  if (a === b) return null;
  if (/^formula/i.test(hint.type || "")) return "derived";
  if (a.trim() && !b.trim()) return "blanked";
  if (!a.trim() && b.trim()) return "filled";
  if (UUID_RE.test(a) && UUID_RE.test(b)) return "regenerated";
  if (a.toLowerCase() === b.toLowerCase()) return "case";
  const squash = x => x.replace(/\s+/g, "").toLowerCase();
  if (squash(a) === squash(b)) return "spacing";
  if (DATE_RE.test(a) && DATE_RE.test(b)) return "date";
  const da = a.replace(/\D/g, ""), db = b.replace(/\D/g, "");
  if (da.length >= 4 && da === db) return "format";                     // same digits, different dressing: a phone
  if (a.includes("@") && b.includes("@") && squash(a.replace(/\./g, "")) === squash(b.replace(/\./g, ""))) return "format";
  if (da.length >= 3 && da.length === db.length && da !== db && a.replace(/\d/g, "#") === b.replace(/\d/g, "#")) return "digits";
  const d = levDistance(a.toLowerCase(), b.toLowerCase());
  if (d <= 2) return "typo";
  if (levSim(a.toLowerCase(), b.toLowerCase()) >= 0.5) return "fuzzed";
  return "other";
}

/**
 * Every variant against every rule.
 * @param {object[]} rules
 * @param {Map<string,object>} byId records by id
 * @param {Array<{id:string, originalId:string, changes:Array<{field:string,from:any,to:any,kind:string}>}>} variants
 */
export function auditVariants(rules, byId, variants) {
  const byRule = rules.map((r, i) => ({ index: i, name: r.name || ("Rule " + (i + 1)), caught: 0, lost: 0, byKind: {}, byField: {} }));
  const kinds = new Set(), fields = new Set();
  const out = [];
  const bump = (slot, key, caught) => { const x = slot[key] || (slot[key] = { caught: 0, lost: 0 }); if (caught) x.caught++; else x.lost++; };
  for (const v of variants) {
    const a = byId.get(String(v.originalId)), b = byId.get(String(v.id));
    if (!a || !b) continue;
    const ex = explainPair(rules, a, b);
    const changed = new Set((v.changes || []).map(c => c.field));
    const rr = ex.map(rx => {
      const failedOn = rx.comparisons.filter(c => !c.passed).map(c => ({ field: c.field, kind: c.kind, label: c.label, arg: c.arg, measured: c.measured, unit: c.unit }));
      return { index: rx.index, passed: rx.passed, evaluatedNothing: rx.evaluatedNothing, failedOn, sunkBy: failedOn.map(f => f.field).filter(f => changed.has(f)) };
    });
    const caughtBy = rr.filter(x => x.passed).map(x => x.index);
    out.push({ id: String(v.id), originalId: String(v.originalId), changes: v.changes || [], rules: rr, caughtBy, caught: caughtBy.length > 0 });
    /* a variant counts once per kind it carries, however many fields took
       that kind of damage, so a column's total never exceeds the variants */
    const kindSet = new Set((v.changes || []).map(c => c.kind)), fieldSet = new Set((v.changes || []).map(c => c.field));
    rr.forEach(x => {
      const slot = byRule[x.index];
      if (x.passed) slot.caught++; else slot.lost++;
      for (const k of kindSet) { kinds.add(k); bump(slot.byKind, k, x.passed); }
      for (const f of fieldSet) { fields.add(f); bump(slot.byField, f, x.passed); }
    });
  }
  const order = new Map(CHANGE_KINDS.map((k, i) => [k.id, i]));
  return { variants: out, byRule, kinds: [...kinds].sort((x, y) => (order.get(x) ?? 99) - (order.get(y) ?? 99)), fields: [...fields].sort(), inspected: out.length,
    caught: out.filter(v => v.caught).length, lost: out.filter(v => !v.caught).length };
}

/* ---------- what if: every damage the generator could do to one field ----------
   The variant browser shows the damage this run happened to produce. This
   asks the other question: for one record and one field, if the generator's
   own dup settings hit that field, which of the values it can produce would
   each rule still accept? The damage function is supplied by the caller
   (the page hands in the engine's own operations, seeded from the run), so
   this stays testable with a deterministic stand-in. */
/**
 * @param {object[]} rules
 * @param {object} record the original
 * @param {string} field the field to damage
 * @param {(value:any)=>any} damage one draw of the generator's damage for this field
 * @param {{samples?:number, derive?:(rec:object)=>object, type?:string}} [opts]
 *   derive recomputes formula fields on the damaged copy, so a rule on a
 *   derived key sees what the key would become
 */
export function whatIf(rules, record, field, damage, opts = {}) {
  const samples = Math.max(1, opts.samples || 25);
  const original = getPath(record, field);
  const seen = new Map();                                   // produced value -> count
  for (let i = 0; i < samples; i++) {
    const v = damage(original);
    const key = v === null || v === undefined ? "" : String(v);
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  const outcomes = [...seen.entries()].map(([value, count]) => {
    let variant = { ...record, [field]: value };
    if (opts.derive) variant = opts.derive(variant);
    const ex = explainPair(rules, record, variant);
    return {
      value, count, kind: classifyChange(original, value, { type: opts.type }),
      rules: ex.map(rx => ({ index: rx.index, passed: rx.passed, evaluatedNothing: rx.evaluatedNothing,
        failedOn: rx.comparisons.filter(c => !c.passed).map(c => ({ field: c.field, kind: c.kind, label: c.label, arg: c.arg, measured: c.measured, unit: c.unit })) }))
    };
  }).sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : 1));
  const byRule = rules.map((r, i) => {
    const survived = outcomes.reduce((n, o) => n + (o.rules[i].passed ? o.count : 0), 0);
    return { index: i, name: r.name || ("Rule " + (i + 1)), survived, samples, rate: survived / samples };
  });
  return { field, original: original === null || original === undefined ? "" : String(original), samples, distinct: outcomes.length, outcomes, byRule };
}

/* ---------- a scorer as a file ----------
   Everything the dialog needs to score again later, in one document: the
   rules, which field identifies a record, what to block on, how transitivity
   and the bands are set. Same idea as the schema file -- build it once in the
   UI, export, import into another session or hand to a colleague. Validation
   is here rather than in the page so it is tested, and so a stranger's file
   is normalised on the way in instead of trusted. */
export const SCORER_VERSION = 1;
export const MATCHER_VERSION = 1;

/* The rules as they are stored in a file: strings for confidence and args,
   because that is what the rule builder keeps and edits. */
function rulesDocument(rules) {
  return (rules || []).map(r => ({
    name: String(r.name || ""), confidence: String(r.confidence ?? "0.95"), blankAgrees: !!r.blankAgrees,
    comparisons: (r.comparisons || []).map(c => ({ field: String(c.field || ""), kind: String(c.kind || "exact"), arg: c.arg === undefined || c.arg === null ? "" : String(c.arg) }))
  }));
}
/* Rules read back from a file. Unknown comparison kinds are fatal (the rule
   could not mean what its author meant); fields the entity lacks are a
   warning, so a matcher written for one schema still opens on another. */
function normalizeRules(rules, fieldNames, warnings) {
  const known = new Set(fieldNames);
  return rules.map((r, i) => {
    const where = "rule " + (i + 1) + (r && r.name ? ' "' + r.name + '"' : "");
    if (!r || typeof r !== "object") throw new Error(where + " is not an object.");
    if (!Array.isArray(r.comparisons)) throw new Error(where + " has no comparisons array.");
    const conf = parseFloat(r.confidence);
    const comparisons = r.comparisons.map((c, ci) => {
      if (!c || typeof c !== "object") throw new Error(where + ", comparison " + (ci + 1) + " is not an object.");
      const def = comparison(String(c.kind || ""));
      if (!def) throw new Error(where + ': unknown comparison "' + c.kind + '".');
      const field = String(c.field || "");
      if (known.size && field && !known.has(field)) warnings.push(where + ' compares "' + field + '", which this entity does not have.');
      const arg = c.arg === undefined || c.arg === null || c.arg === "" ? (def.arg ? def.argDefault : "") : String(c.arg);
      return { field, kind: def.id, arg };
    });
    return { name: String(r.name || ("Rule " + (i + 1))), confidence: Number.isFinite(conf) ? String(Math.min(Math.max(conf, 0), 1)) : "0.95",
      blankAgrees: !!r.blankAgrees, comparisons };
  });
}
/* What a file is, before anything is read from it. */
function fileKind(input, want) {
  const bad = error => ({ ok: false, error });
  const made = want === "scorer" ? "Export scorer" : "Save matcher";
  if (!input || typeof input !== "object" || Array.isArray(input)) return bad("Expected a " + want + " file: a JSON object written by " + made + ".");
  if (Array.isArray(input.entities) && !input.rules) return bad("This is a schema file. Use Import schema for it; Import " + want + " wants the file written by " + made + ".");
  if (input.kind !== undefined && input.kind !== "scorer" && input.kind !== "matcher") return bad('This is a "' + input.kind + '" file, not a ' + want + ". Use " + made + " to make one.");
  if (!Array.isArray(input.rules)) return bad("A " + want + " file needs a rules array (it may be empty).");
  return { ok: true, kind: input.kind || want };
}

/* ---------- a scorer as a file ----------
   Everything the Score matcher dialog needs to score again: the rules, the
   id and blocking fields, the mode, the transitivity switch and the bands. */
export function scorerDocument(state) {
  return {
    kind: "scorer",
    version: SCORER_VERSION,
    entity: state.entity || "",
    idField: state.idField || "",
    blockField: state.blockField || "",
    mode: state.mode === "simulate" ? "simulate" : "paste",
    closeTransitively: state.closeTransitively !== false,
    autoMerge: Number.isFinite(Number(state.autoMerge)) ? Number(state.autoMerge) : 0.92,
    reviewFloor: Number.isFinite(Number(state.reviewFloor)) ? Number(state.reviewFloor) : 0.78,
    linkPolicy: LINK_POLICIES.includes(state.linkPolicy) ? state.linkPolicy : "all",
    rules: rulesDocument(state.rules)
  };
}
function readPolicy(input, warnings) {
  if (input.linkPolicy === undefined || input.linkPolicy === null || input.linkPolicy === "") return "all";
  if (LINK_POLICIES.includes(input.linkPolicy)) return input.linkPolicy;
  warnings.push('unknown link policy "' + input.linkPolicy + '"; "all" was used.');
  return "all";
}
/**
 * @param {unknown} input parsed JSON: a scorer file, or a matcher file (its rules are taken and the rest defaults)
 * @param {string[]} [fieldNames] the fields available now; rules naming others are kept but warned about
 * @returns {{ok:true, scorer:object, warnings:string[]}|{ok:false, error:string}}
 */
export function normalizeScorer(input, fieldNames = []) {
  const what = fileKind(input, "scorer");
  if (!what.ok) return what;
  const warnings = [];
  const rules = normalizeRules(input.rules, fieldNames, warnings);
  const known = new Set(fieldNames);
  if (what.kind === "matcher") warnings.push("this is a matcher file, so only the rules and link policy came from it; the fields and bands here are defaults.");
  const num = (v, dflt) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= 1 ? n : dflt; };
  let autoMerge = num(input.autoMerge, 0.92), reviewFloor = num(input.reviewFloor, 0.78);
  if (reviewFloor > autoMerge) { warnings.push("review floor was above auto-merge; both reset to defaults."); autoMerge = 0.92; reviewFloor = 0.78; }
  const idField = String(input.idField || "");
  if (known.size && idField && !known.has(idField)) warnings.push('record id field "' + idField + '" is not in this entity; the default was kept.');
  const blockField = String(input.blockField || "");
  if (known.size && blockField && !known.has(blockField)) warnings.push('blocking field "' + blockField + '" is not in this entity; set to none.');
  return {
    ok: true, warnings, kind: what.kind,
    scorer: {
      kind: "scorer", version: SCORER_VERSION, entity: String(input.entity || ""),
      idField: known.size && idField && !known.has(idField) ? "" : idField,
      blockField: known.size && blockField && !known.has(blockField) ? "" : blockField,
      mode: input.mode === "simulate" || (input.mode === undefined && rules.length) ? "simulate" : "paste",
      closeTransitively: input.closeTransitively !== false, autoMerge, reviewFloor, linkPolicy: readPolicy(input, warnings), rules
    }
  };
}

/* ---------- a matcher as a file ----------
   Just the rules: the thing a team iterates on, independent of which entity,
   seed or bands it is scored against. A scorer file also opens here, since
   it carries the same rules plus settings this reader ignores. */
export function matcherDocument(state) {
  return { kind: "matcher", version: MATCHER_VERSION, entity: state.entity || "",
    linkPolicy: LINK_POLICIES.includes(state.linkPolicy) ? state.linkPolicy : "all", rules: rulesDocument(state.rules) };
}
/**
 * @param {unknown} input parsed JSON: a matcher file, or a scorer file (only its rules are read)
 * @param {string[]} [fieldNames]
 * @returns {{ok:true, matcher:{kind:"matcher",version:number,entity:string,rules:object[]}, kind:string, warnings:string[]}|{ok:false, error:string}}
 */
export function normalizeMatcher(input, fieldNames = []) {
  const what = fileKind(input, "matcher");
  if (!what.ok) return what;
  const warnings = [];
  const rules = normalizeRules(input.rules, fieldNames, warnings);
  if (what.kind === "scorer") warnings.push("this is a scorer file; only its rules and link policy were taken.");
  return { ok: true, warnings, kind: what.kind, matcher: { kind: "matcher", version: MATCHER_VERSION, entity: String(input.entity || ""), linkPolicy: readPolicy(input, warnings), rules } };
}

/* ---------- a prompt for an AI ----------
   The matcher file is a contract an assistant can write to. This composes
   everything it needs in one paste: the entity's fields and what a duplicate
   variant does to each, the file shape, the rule semantics, and the
   comparison kinds generated from COMPARISONS so the two cannot drift. The
   long-form version for people is MATCHER.md. */
const KIND_HELP = {
  exact: "the two values are identical as strings",
  normalized: "equal after lower-casing and dropping everything but letters and digits",
  prefix: "the first N characters agree after that same normalisation (arg = N, default 3)",
  soundex: "the Soundex codes agree; for names that sound alike (Smith / Smyth)",
  tokens: "the same words in any order (\"Mary Ann\" / \"Ann Mary\")",
  jw: "Jaro-Winkler similarity is at least arg (0..1, default 0.90); best for names and short strings",
  lev: "Levenshtein similarity is at least arg (0..1, default 0.85); best for codes, dates and numbers written as text",
  jwTokens: "Jaro-Winkler on the words sorted, at least arg (default 0.90); for addresses and multi-word names",
  numeric: "the numbers differ by at most arg (default 1)",
  days: "the dates differ by at most arg days (default 1); unparseable dates fail"
};
export function comparisonHelp() {
  return COMPARISONS.map(c => "- " + c.id + " — " + (c.arg ? "arg: " + c.argLabel + " (default \"" + c.argDefault + "\")" : "no arg, leave \"\"") + " — " + KIND_HELP[c.id] +
    (c.key ? "" : " — similarity only: gives no blocking key"));
}
function variantNote(f, dupLevel) {
  const t = String(f.type || "");
  if (/^row number$/i.test(t)) return "unique per row: a record and its duplicate never agree, do not compare";
  if (/^uuid$/i.test(t)) return "regenerated for every duplicate variant, do not compare";
  if (/^formula/i.test(t)) return "recomputed for every duplicate from that record's own values, so it follows whatever damage its source fields took; never damaged on its own";
  if (dupLevel === "targeted") {
    if (f.sim && f.sim.algo) return "fuzzed in duplicates until " + (f.sim.algo === "lev" ? "Levenshtein" : "Jaro-Winkler") + " similarity to the original is about " + f.sim.target;
    return "copied unchanged into duplicates";
  }
  if (dupLevel && dupLevel !== "off") return "gets preset " + dupLevel + " damage in duplicates (typos, case, spacing, format), by field type";
  return "";
}
/**
 * @param {{entity:string, fields:Array<{name:string,type?:string,sim?:{algo:string,target:string}}>, dupLevel?:string, dupPct?:string|number, dupMax?:string|number, idField?:string}} info
 * @returns {string} text to paste into an assistant; the reply is a matcher file
 */
export function matcherPrompt(info) {
  const entity = info.entity || "Records";
  const dupLevel = info.dupLevel || "off";
  const dups = dupLevel === "off" ? "duplicates are off; turn them on before scoring"
    : dupLevel + (info.dupPct ? ", " + info.dupPct + "% of records get up to " + (info.dupMax || 2) + " variant(s)" : "");
  const fieldLines = (info.fields || []).map(f => {
    const note = variantNote(f, dupLevel);
    return "- " + f.name + (f.type ? " (" + f.type + ")" : "") + (note ? " — " + note : "");
  });
  return [
    "Write a matcher file for the Score matcher in Test Data Generator (https://dnguye.github.io/test-data-generator/).",
    "Reply with ONE JSON object and nothing else; I will load it with the Import matcher button. The full specification is MATCHER.md in https://github.com/dnguye/test-data-generator.",
    "",
    "## Entity: " + entity + " (" + dups + ")",
    "Fields a rule may compare (name, type, what a duplicate variant does to it):",
    ...(fieldLines.length ? fieldLines : ["- (no fields yet)"]),
    ...(info.idField ? ["Record id field for scoring: " + info.idField + " (never compare it)."] : []),
    "",
    "## File shape",
    JSON.stringify({ kind: "matcher", version: MATCHER_VERSION, entity, linkPolicy: "best", rules: [
      { name: "Fuzzy surname and exact birth date", confidence: "1", blankAgrees: false,
        comparisons: [{ field: "last_name", kind: "jw", arg: "0.85" }, { field: "birth_date", kind: "exact", arg: "" }] }
    ] }, null, 2),
    "",
    "## Semantics",
    "- A rule links two records when EVERY comparison in it passes (AND). Two records match when ANY rule passes (OR).",
    "- confidence is a string from \"0\" to \"1\". A pair's score is the highest confidence among the rules that passed; \"1\" for rules safe to auto-merge on, lower for rules meant for human review.",
    "- blankAgrees false (the default): a blank value fails its comparison. true: a blank on either side counts as agreeing, but a rule never passes on blanks alone.",
    "- field is the name exactly as listed above; nested fields use dot paths such as address.zip. Values are compared as strings.",
    "- Blocking is derived from the rule: a rule with at least one equality comparison (exact, normalized, prefix, soundex, tokens) only compares records that share that key, which keeps it fast. A rule made only of similarity comparisons compares every pair.",
    "- linkPolicy, at the top level: \"all\" links every candidate some rule passed; \"best\" matches each record to its single best candidate (highest score, then most rules passed, then closest values), the way a hub matches an incoming record to one master. Use \"best\" when a record should never merge into more than one other.",
    "",
    "## Comparison kinds (kind, then its arg)",
    ...comparisonHelp(),
    "",
    "## Guidance",
    "- Two to four rules, each with two to four comparisons, each with a short descriptive name.",
    "- Give every rule at least one equality comparison on a field that is copied unchanged or rarely fuzzed, so it has a blocking key.",
    "- Set a similarity threshold a little below the field's fuzz target (a field fuzzed to about 0.84 wants jw 0.80), and use lev rather than jw for dates, codes and numbers.",
    "- Never compare row numbers, UUIDs, or fields that are unique per row, nor a formula built from one of them.",
    "- Prefer strict rules: the scorer reports over-matches (false merges) and under-matches (missed pairs) separately, and a false merge is the worse error in master data."
  ].join("\n");
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
