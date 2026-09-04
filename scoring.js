/* ---------------------------------------------------------------------------
   scoring.js -- ground-truth scoring for matching and dedup engines.

   When duplicate injection is on, the generator adds a match_id column that an
   original record shares with every fuzzed variant of it. That column is the
   answer key. The workflow this module supports: hold match_id back, run a
   matcher on everything else, then compare what the matcher linked against
   what match_id says should have been linked.

   Like engine.js this has no DOM, no globals and no dependencies, so the
   browser page, the HTTP API and the test suites all run one implementation.

   The metric is PAIRWISE precision and recall, never accuracy. With 100
   records there are 4,950 possible pairs and maybe 40 true matches, so a
   matcher that links nothing would score 99% "accuracy". Both partitions --
   truth and prediction -- are turned into sets of record pairs and compared:

     true pairs      every pair of records sharing a match_id
     predicted pairs every pair the matcher linked (closed under transitivity,
                     because A-B plus B-C logically implies A-C)
     TP in both      FP predicted only      FN true only

   Counts never require enumerating the predicted pairs: a component of n
   records implies n(n-1)/2 pairs, and TP is the number of TRUE pairs whose
   two ends share a component. So a matcher that links all 10,000 records into
   one blob is scored in linear time instead of materialising 50 million pairs.
   Only the LISTED false merges are enumerated, and those are capped.
--------------------------------------------------------------------------- */
"use strict";

/* ---------- pairs ----------
   A pair is an unordered set of two ids, stored as one string so it can live
   in a Set. The separator is a control character that cannot appear in a
   sensible record id, and the smaller id always goes first. */
const SEP = "\u001f";
function pairKey(a, b) { a = String(a); b = String(b); return a < b ? a + SEP + b : b + SEP + a; }
function splitPair(k) { return k.split(SEP); }

/* Enumerating pairs within clusters is only needed for the truth side (small
   clusters) and for LISTING mistakes (capped). This cap stops a degenerate
   truth set -- every record with the same label -- from taking the process
   down while trying to list the pairs it implies. */
const MAX_ENUMERATED_PAIRS = 2000000;

/* ---------- labels ----------
   A labelling is {record_id: cluster_key}: match_id for the truth, a block key
   for blocking, a component id for a closed prediction. Accepted as a Map, a
   plain object, or an array of [id, key] entries; keys and ids are strings. */
function toLabelMap(labels) {
  if (labels instanceof Map) return labels;
  const m = new Map();
  if (Array.isArray(labels)) {
    for (const e of labels) {
      if (!Array.isArray(e) || e.length < 2) throw new Error("labels: each entry must be [id, key]");
      m.set(String(e[0]), String(e[1]));
    }
  } else if (labels && typeof labels === "object") {
    for (const id of Object.keys(labels)) m.set(id, String(labels[id]));
  } else {
    throw new Error("labels must be a map of record id to cluster key");
  }
  return m;
}
/* Map of cluster key -> [ids], ids in insertion order. */
function clustersOf(labels) {
  const c = new Map();
  for (const [id, key] of toLabelMap(labels)) {
    let arr = c.get(key);
    if (!arr) c.set(key, arr = []);
    arr.push(id);
  }
  return c;
}
/* Sum of n(n-1)/2 over clusters: how many pairs a labelling implies, without
   building them. */
function impliedPairCount(clusters) {
  let n = 0;
  for (const members of clusters.values()) n += members.length * (members.length - 1) / 2;
  return n;
}
/* Set of pair keys implied by a labelling. Truth sets are small (clusters of
   2-6), so this is cheap there; it is guarded for anything else. */
function pairsFromClusters(labels) {
  const clusters = clustersOf(labels);
  const total = impliedPairCount(clusters);
  if (total > MAX_ENUMERATED_PAIRS)
    throw new Error("labelling implies " + total + " pairs, which is more than can be enumerated -- is every record carrying the same key?");
  const out = new Set();
  for (const members of clusters.values()) {
    if (members.length < 2) continue;
    const s = members.slice().sort();
    for (let i = 0; i < s.length; i++)
      for (let j = i + 1; j < s.length; j++) out.add(s[i] + SEP + s[j]);
  }
  return out;
}

/* ---------- predicted pairs ----------
   Matchers emit links in every shape imaginable. Accept the common ones and
   canonicalise to [a, b, score?]:
     [a, b]  [a, b, score]  {a, b, score}  {left, right}  {id_a, id_b}
     {id1, id2}  {source, target}  {from, to}  {record_a, record_b}
   Scores are optional; a list is "scored" only when EVERY pair carries one,
   since a threshold sweep over a half-scored list would silently drop pairs. */
const PAIR_KEYS = [["a", "b"], ["left", "right"], ["id_a", "id_b"], ["id1", "id2"], ["idA", "idB"],
  ["source", "target"], ["from", "to"], ["record_a", "record_b"], ["first", "second"], ["x", "y"]];
const SCORE_KEYS = ["score", "similarity", "sim", "weight", "probability", "prob", "confidence"];
function normalizePairs(list) {
  if (list && typeof list === "object" && !Array.isArray(list) && Array.isArray(list.pairs)) list = list.pairs;
  if (!Array.isArray(list)) throw new Error("pairs must be an array");
  const pairs = [];
  let scored = 0;
  list.forEach((p, i) => {
    let a, b, s;
    if (Array.isArray(p)) {
      if (p.length < 2) throw new Error("pairs[" + i + "]: needs two record ids");
      [a, b, s] = p;
    } else if (p && typeof p === "object") {
      const k = PAIR_KEYS.find(([ka, kb]) => p[ka] !== undefined && p[kb] !== undefined);
      if (!k) throw new Error("pairs[" + i + "]: could not find the two record ids (use {a, b} or [a, b])");
      a = p[k[0]]; b = p[k[1]];
      const sk = SCORE_KEYS.find(x => p[x] !== undefined);
      if (sk) s = p[sk];
    } else {
      throw new Error("pairs[" + i + "]: expected [a, b] or {a, b}");
    }
    if (a === null || a === undefined || b === null || b === undefined || String(a) === "" || String(b) === "")
      throw new Error("pairs[" + i + "]: empty record id");
    if (s !== undefined && s !== null && s !== "") {
      const n = Number(s);
      if (!Number.isFinite(n)) throw new Error("pairs[" + i + "]: score \"" + s + "\" is not a number");
      scored++;
      pairs.push([String(a), String(b), n]);
    } else {
      pairs.push([String(a), String(b), undefined]);
    }
  });
  return { pairs, scored: pairs.length > 0 && scored === pairs.length, partiallyScored: scored > 0 && scored < pairs.length };
}

/* ---------- transitive closure ----------
   Union-find over the linked pairs. Returns Map id -> component root, for the
   ids that appear in at least one pair. Records the matcher never linked are
   not in the map, which is the right answer: they are singletons. */
function transitiveClosure(pairs) {
  const parent = new Map();
  const find = x => {
    if (!parent.has(x)) parent.set(x, x);
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    while (parent.get(x) !== r) { const nx = parent.get(x); parent.set(x, r); x = nx; }   // path compression
    return r;
  };
  for (const p of pairs) {
    const a = String(p[0]), b = String(p[1]);
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  const out = new Map();
  for (const id of parent.keys()) out.set(id, find(id));
  return out;
}

/* ---------- the scorer ---------- */
const r4 = x => Math.round(x * 10000) / 10000;
const prf = (tp, fp, fn) => {
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const f1 = precision + recall ? 2 * precision * recall / (precision + recall) : 0;
  return { precision: r4(precision), recall: r4(recall), f1: r4(f1) };
};

/* Pairwise precision / recall / F1.

     truthLabels    {record_id: match_id} for ALL records, singletons included
     predictedPairs the pairs the matcher linked, in any shape normalizePairs takes
     options.closeTransitively  default true -- credit the pairs the links imply
     options.maxListed          how many false merges / missed matches to list
                                (counts are always exact; the lists are samples)

   Pairs whose ids are not in the truth set still count as false merges, as
   they would in any honest scoring, but they are also reported separately
   under unknown_ids because the usual cause is a wrong id column. */
function evaluate(truthLabels, predictedPairs, options = {}) {
  const closeTransitively = options.closeTransitively !== false;
  const maxListed = Math.max(0, options.maxListed === undefined ? 200 : options.maxListed);

  const truth = toLabelMap(truthLabels);
  const truePairs = pairsFromClusters(truth);
  const { pairs } = normalizePairs(predictedPairs);

  const unknown = new Set();
  let selfPairs = 0;
  const links = [];
  for (const [a, b] of pairs) {
    if (a === b) { selfPairs++; continue; }
    if (!truth.has(a)) unknown.add(a);
    if (!truth.has(b)) unknown.add(b);
    links.push([a, b]);
  }

  let predictedCount, tp, falseMerges = [], missed, fpTotal;
  if (closeTransitively) {
    const comp = transitiveClosure(links);
    const members = new Map();
    for (const [id, root] of comp) { let arr = members.get(root); if (!arr) members.set(root, arr = []); arr.push(id); }
    predictedCount = impliedPairCount(members);
    const hit = new Set();
    for (const k of truePairs) {
      const [a, b] = splitPair(k);
      const ra = comp.get(a);
      if (ra !== undefined && ra === comp.get(b)) hit.add(k);
    }
    tp = hit.size;
    fpTotal = predictedCount - tp;
    missed = [...truePairs].filter(k => !hit.has(k));
    /* list a sample of the false merges: walk components smallest-first-id so
       the sample is deterministic, stop as soon as the cap is reached */
    if (maxListed > 0 && fpTotal > 0) {
      const groups = [...members.values()].map(g => g.slice().sort()).sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
      outer: for (const g of groups) {
        for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
          if (truePairs.has(g[i] + SEP + g[j])) continue;
          falseMerges.push([g[i], g[j]]);
          if (falseMerges.length >= maxListed) break outer;
        }
      }
    }
  } else {
    const pred = new Set(links.map(([a, b]) => pairKey(a, b)));
    predictedCount = pred.size;
    tp = 0;
    for (const k of pred) {
      if (truePairs.has(k)) tp++;
      else if (falseMerges.length < maxListed) falseMerges.push(splitPair(k));
    }
    fpTotal = predictedCount - tp;
    missed = [...truePairs].filter(k => !pred.has(k));
  }
  const fn = missed.length;
  falseMerges.sort(cmpPair);
  const missedListed = missed.map(splitPair).sort(cmpPair).slice(0, maxListed);

  const out = {
    records: truth.size,
    true_pairs: truePairs.size,
    predicted_pairs: predictedCount,
    tp, fp: fpTotal, fn,
    ...prf(tp, fpTotal, fn),
    false_merges: falseMerges,
    missed_matches: missedListed,
    false_merges_truncated: falseMerges.length < fpTotal,
    missed_matches_truncated: missedListed.length < fn,
    closed_transitively: closeTransitively,
    unknown_ids: [...unknown].sort().slice(0, maxListed),
    unknown_id_count: unknown.size,
    self_pairs_ignored: selfPairs
  };
  return out;
}
function cmpPair(p, q) { return p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : p[1] < q[1] ? -1 : p[1] > q[1] ? 1 : 0; }

/* ---------- blocking ----------
   Any true pair whose two records land in different blocks is never compared,
   so no threshold can find it DIRECTLY. PAIR COMPLETENESS is the fraction of
   true pairs that survive blocking: the ceiling on recall from direct matches.
   It is not a ceiling on final recall, because transitive closure can recover a
   pair blocking never offered when both its records link to a third -- A-B and
   B-C imply A-C even if A and C sat in different blocks. REDUCTION RATIO is how
   much of the full pair space blocking cut. The two trade off against each other.

     candidates  either the candidate pairs blocking produced (any pair shape),
                 or a labelling {record_id: block_key} -- in which case every
                 pair within a block is a candidate. Pass the labelling when
                 you have it: it is scored from block sizes without building
                 a single pair. */
function pairCompleteness(truthLabels, candidates) {
  const truth = toLabelMap(truthLabels);
  const truePairs = pairsFromClusters(truth);
  const n = truth.size;
  const totalPossible = n * (n - 1) / 2;
  let candidateCount, survived = 0, missedListed;

  if (Array.isArray(candidates) || (candidates && Array.isArray(candidates.pairs))) {
    const { pairs } = normalizePairs(candidates);
    const cand = new Set();
    for (const [a, b] of pairs) if (a !== b) cand.add(pairKey(a, b));
    candidateCount = cand.size;
    const lost = [];
    for (const k of truePairs) { if (cand.has(k)) survived++; else lost.push(k); }
    missedListed = lost;
  } else {
    const blocks = toLabelMap(candidates);
    const clusters = clustersOf(blocks);
    candidateCount = impliedPairCount(clusters);
    const lost = [];
    for (const k of truePairs) {
      const [a, b] = splitPair(k);
      const ba = blocks.get(a);
      if (ba !== undefined && ba === blocks.get(b)) survived++; else lost.push(k);
    }
    missedListed = lost;
  }
  return {
    records: n,
    true_pairs: truePairs.size,
    surviving_blocking: survived,
    pair_completeness: truePairs.size ? r4(survived / truePairs.size) : 0,
    candidate_pairs: candidateCount,
    total_possible_pairs: totalPossible,
    reduction_ratio: totalPossible ? r4(1 - candidateCount / totalPossible) : 0,
    lost_to_blocking: missedListed.map(splitPair).sort(cmpPair).slice(0, 200)
  };
}

/* ---------- threshold sweep ----------
   Precision / recall at each cutoff, for scored pairs [a, b, score]. */
function defaultThresholds() { const t = []; for (let i = 10; i <= 20; i++) t.push(i / 20); return t; }
function sweep(truthLabels, scoredPairs, thresholds, options = {}) {
  const { pairs, scored } = normalizePairs(scoredPairs);
  if (!scored) throw new Error("sweep needs a score on every pair");
  const ts = (Array.isArray(thresholds) && thresholds.length ? thresholds : defaultThresholds())
    .map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  return ts.map(t => {
    const linked = pairs.filter(p => p[2] >= t);
    const r = evaluate(truthLabels, linked, { closeTransitively: options.closeTransitively, maxListed: 0 });
    return { threshold: Math.round(t * 1000) / 1000, linked: linked.length, tp: r.tp, fp: r.fp, fn: r.fn,
      precision: r.precision, recall: r.recall, f1: r.f1 };
  });
}

/* ---------- the three numbers that matter ----------
   In patient matching a false merge (two people's charts combined) is far
   worse than a false split, so production runs a high-precision auto-merge
   band and sends the middle band to a stewardship queue. Report what each
   band did rather than one F1 that hides the trade-off.

     score >= autoMerge                merged without a human
     reviewFloor <= score < autoMerge  stewardship queue
     below                             left alone */
function bandedReport(truthLabels, scoredPairs, options = {}) {
  const autoMerge = options.autoMerge === undefined ? 0.92 : Number(options.autoMerge);
  const reviewFloor = options.reviewFloor === undefined ? 0.78 : Number(options.reviewFloor);
  if (!Number.isFinite(autoMerge) || !Number.isFinite(reviewFloor) || reviewFloor > autoMerge)
    throw new Error("bands: reviewFloor must be a number no greater than autoMerge");
  const { pairs, scored } = normalizePairs(scoredPairs);
  if (!scored) throw new Error("bandedReport needs a score on every pair");
  const truth = toLabelMap(truthLabels);
  const truePairs = pairsFromClusters(truth);
  const auto = pairs.filter(p => p[2] >= autoMerge);
  const review = pairs.filter(p => p[2] >= reviewFloor && p[2] < autoMerge);
  const autoResult = evaluate(truth, auto, { closeTransitively: options.closeTransitively, maxListed: options.maxListed });
  const reviewSet = new Set();
  for (const [a, b] of review) if (a !== b) reviewSet.add(pairKey(a, b));
  let trueInReview = 0;
  for (const k of reviewSet) if (truePairs.has(k)) trueInReview++;
  const T = truePairs.size;
  return {
    auto_merge_threshold: autoMerge,
    review_floor: reviewFloor,
    auto_merge_precision: autoResult.precision,
    auto_merge_recall: autoResult.recall,
    false_merges: autoResult.fp,
    review_queue_size: reviewSet.size,
    true_pairs_in_review: trueInReview,
    review_precision: reviewSet.size ? r4(trueInReview / reviewSet.size) : 0,
    recall_after_perfect_review: T ? r4((autoResult.tp + trueInReview) / T) : 0,
    missed_below_review: Math.max(0, T - autoResult.tp - trueInReview),
    false_merge_pairs: autoResult.false_merges
  };
}

/* ---------- building truth from generated records ----------
   The generated file carries the id column the schema defined and the
   match_id column the dups feature added. Pull both out of a list of flat or
   nested records. Dotted paths resolve into nested JSON output; "@" and
   "[..]" are stripped because nodeToObj() emits attributes as plain keys and
   repeats as arrays -- and an id living inside a repeat is not a record id. */
function getPath(obj, path) {
  if (obj === null || obj === undefined) return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, path)) return obj[path];
  let cur = obj;
  for (const raw of String(path).split(".")) {
    const key = raw.replace(/\[.*\]$/, "").replace(/^@/, "");
    if (cur === null || typeof cur !== "object") return undefined;
    cur = cur[key];
  }
  if (cur && typeof cur === "object" && !Array.isArray(cur) && cur._value !== undefined) return cur._value;
  return cur;
}
function truthFromRecords(records, idField, matchField = "match_id") {
  if (!Array.isArray(records)) throw new Error("records must be an array");
  if (!idField) throw new Error("idField is required: the column that identifies one record");
  const labels = new Map();
  const dupIds = new Set();
  records.forEach((rec, i) => {
    const id = getPath(rec, idField), m = getPath(rec, matchField);
    if (id === undefined || id === null || id === "" || (typeof id === "object"))
      throw new Error("records[" + i + "]: no usable value in id field \"" + idField + "\"");
    if (m === undefined || m === null || m === "" || (typeof m === "object"))
      throw new Error("records[" + i + "]: no usable value in match field \"" + matchField + "\" -- was the data generated with dups on?");
    const sid = String(id);
    if (labels.has(sid)) dupIds.add(sid);
    labels.set(sid, String(m));
  });
  if (dupIds.size)
    throw new Error("id field \"" + idField + "\" is not unique: " + dupIds.size + " id" + (dupIds.size === 1 ? "" : "s") +
      " appear more than once (e.g. \"" + [...dupIds][0] + "\"). Duplicates need their own ids -- a UUID or Row Number field regenerates per variant.");
  return labels;
}
/* Cluster summary of a truth labelling, for reporting. */
function truthSummary(labels) {
  const clusters = clustersOf(labels);
  const sizes = {};
  let singletons = 0;
  for (const m of clusters.values()) { if (m.length === 1) singletons++; sizes[m.length] = (sizes[m.length] || 0) + 1; }
  return { records: toLabelMap(labels).size, clusters: clusters.size, singletons, cluster_sizes: sizes, true_pairs: impliedPairCount(clusters) };
}

/* ---------- text parsing (for pasted files) ---------- */
/* RFC 4180-ish CSV: quoted fields, doubled quotes, CRLF. Delimiter is
   detected from the first line among comma, tab, semicolon and pipe. */
function detectDelimiter(line) {
  const cands = [",", "\t", ";", "|"];
  let best = ",", bestN = -1;
  for (const d of cands) { const n = line.split(d).length - 1; if (n > bestN) { best = d; bestN = n; } }
  return best;
}
function parseCsv(text, delimiter) {
  text = String(text).replace(/^\uFEFF/, "");
  const d = delimiter || detectDelimiter(text.split(/\r?\n/, 1)[0] || "");
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === d) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.length > 1 || (r.length === 1 && r[0].trim() !== ""));
}
/* Does this first row read like a header? True when no cell is numeric and
   at least one cell is a word matchers commonly use for its columns. */
/* Single letters are deliberately absent: "a,b" is a header to a scorer but a
   perfectly good first data row to a matcher that numbers its records. */
const HEADERISH = /^(id|ids?[_ ]?[ab12]|record[_ ]?[ab12]?|rec[_ ]?[ab12]|left|right|source|target|from|to|first|second|score|sim|similarity|weight|prob|probability|confidence|match_id|_match_id|block|block_key|key|cluster|label)$/i;
function looksLikeHeader(row) {
  if (!row || row.length < 2) return false;
  if (row.some(c => /^-?\d+(\.\d+)?$/.test(String(c).trim()))) return false;
  return row.some(c => HEADERISH.test(String(c).trim()));
}
/* Pairs from pasted text: JSON (array of pairs, or {pairs:[...]}) or delimited
   lines "a,b" / "a,b,score". `hasHeader` overrides the heuristic. */
function parsePairsText(text, hasHeader) {
  const t = String(text).trim();
  if (!t) return { pairs: [], scored: false, partiallyScored: false, header: false };
  if (t[0] === "[" || t[0] === "{") {
    const j = JSON.parse(t);
    return { ...normalizePairs(j), header: false };
  }
  const rows = parseCsv(t);
  const header = hasHeader === undefined ? looksLikeHeader(rows[0]) : !!hasHeader;
  const body = header ? rows.slice(1) : rows;
  const list = body.map(r => r.slice(0, 3).map(c => c.trim()));
  return { ...normalizePairs(list), header };
}
/* Records from pasted text: JSON array of records, or CSV with a header row.
   Returns {records, columns}. */
function parseRecordsText(text) {
  const t = String(text).trim();
  if (!t) return { records: [], columns: [] };
  if (t[0] === "[" || t[0] === "{") {
    let j = JSON.parse(t);
    if (j && !Array.isArray(j)) {
      const arr = Object.values(j).find(Array.isArray);
      if (!arr) throw new Error("JSON must be an array of records");
      j = arr;
    }
    const cols = new Set();
    for (const r of j) if (r && typeof r === "object") for (const k of Object.keys(r)) cols.add(k);
    return { records: j, columns: [...cols] };
  }
  const rows = parseCsv(t);
  if (rows.length < 2) throw new Error("CSV needs a header row and at least one record");
  const cols = rows[0].map(c => c.trim());
  const records = rows.slice(1).map(r => { const o = {}; cols.forEach((c, i) => { o[c] = r[i] === undefined ? "" : r[i]; }); return o; });
  return { records, columns: cols };
}
/* Labels (id -> key) from pasted text: JSON object/array, or delimited "id,key". */
function parseLabelsText(text, hasHeader) {
  const t = String(text).trim();
  if (!t) return new Map();
  if (t[0] === "{" ) return toLabelMap(JSON.parse(t));
  if (t[0] === "[") { const j = JSON.parse(t); return toLabelMap(j.map(e => Array.isArray(e) ? e : [getPath(e, "id"), getPath(e, "key") ?? getPath(e, "block") ?? getPath(e, "match_id")])); }
  const rows = parseCsv(t);
  const header = hasHeader === undefined ? looksLikeHeader(rows[0]) : !!hasHeader;
  const body = header ? rows.slice(1) : rows;
  return toLabelMap(body.map(r => [r[0].trim(), (r[1] ?? "").trim()]));
}

/* ---------- one call that does the lot ----------
   What the API endpoint and the browser dialog both run. */
function scoreAll(truthLabels, predictedPairs, options = {}) {
  const truth = toLabelMap(truthLabels);
  const norm = normalizePairs(predictedPairs);
  const out = {
    truth: truthSummary(truth),
    scored: norm.scored,
    evaluation: evaluate(truth, norm.pairs, options),
    warnings: []
  };
  if (norm.partiallyScored) out.warnings.push("Only some pairs carry a score, so the threshold sweep and the banded report were skipped. Score every pair or none.");
  if (out.evaluation.unknown_id_count)
    out.warnings.push(out.evaluation.unknown_id_count + " id" + (out.evaluation.unknown_id_count === 1 ? "" : "s") +
      " in the matcher output are not in the truth set (e.g. \"" + out.evaluation.unknown_ids[0] + "\"). They count as false merges. Usually this means a different id column was used on each side.");
  if (out.evaluation.self_pairs_ignored)
    out.warnings.push(out.evaluation.self_pairs_ignored + " pair" + (out.evaluation.self_pairs_ignored === 1 ? "" : "s") + " linked a record to itself and were ignored.");
  if (!out.truth.true_pairs)
    out.warnings.push("The truth set has no pairs at all: no two records share a match_id. Was the data generated with dups on?");
  if (norm.scored) {
    out.sweep = sweep(truth, norm.pairs, options.thresholds, options);
    out.banded = bandedReport(truth, norm.pairs, options);
  } else {
    out.sweep = null;
    out.banded = null;
  }
  if (options.candidates !== undefined && options.candidates !== null) {
    out.blocking = pairCompleteness(truth, options.candidates);
    if (out.blocking.pair_completeness < 1)
      out.warnings.push("Blocking loses " + (out.blocking.true_pairs - out.blocking.surviving_blocking) + " true pair" +
        (out.blocking.true_pairs - out.blocking.surviving_blocking === 1 ? "" : "s") + ": they are never compared, so no threshold can find them directly. " +
        "Pair completeness " + out.blocking.pair_completeness + " caps recall from direct matches; only transitive closure through other linked records can lift it higher.");
  } else {
    out.blocking = null;
  }
  return out;
}

export {
  pairKey, splitPair, toLabelMap, clustersOf, pairsFromClusters, impliedPairCount,
  normalizePairs, transitiveClosure,
  evaluate, pairCompleteness, sweep, bandedReport, defaultThresholds, scoreAll,
  getPath, truthFromRecords, truthSummary,
  parseCsv, looksLikeHeader, parsePairsText, parseRecordsText, parseLabelsText,
  MAX_ENUMERATED_PAIRS
};
