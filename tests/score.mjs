/* Ground-truth scoring suite. Run with: node tests/score.mjs
   Exercises scoring.js directly, then through engine.js output, then through
   the HTTP API on an ephemeral port with an in-memory store. */
import { createServer } from '../api/server.mjs';
import { MemoryStore } from '../api/store.mjs';
import { loadFaker } from '../api/faker-node.mjs';
import * as E from '../engine.js';
import * as S from '../scoring.js';

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.log('  FAIL:', name, extra === undefined ? '' : JSON.stringify(extra).slice(0, 300)); }
};
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re ? re.test(e.message) : true; } };

/* The worked example from the design notes, with its verified output. */
const TRUTH = {
  'PAT-0000001': 'M1', 'PAT-0000002': 'M1', 'PAT-0000003': 'M1',
  'PAT-0000004': 'M2', 'PAT-0000005': 'M2',
  'PAT-0000006': 'M3',
  'PAT-0000007': 'M4'
};
const PRED = [['PAT-0000001', 'PAT-0000002'], ['PAT-0000002', 'PAT-0000003'], ['PAT-0000006', 'PAT-0000007']];

console.log('=== 1. evaluate: the reference example ===');
let r = S.evaluate(TRUTH, PRED);
check('4 true pairs (a 3-cluster yields 3, a 2-cluster 1)', r.true_pairs === 4, r);
check('4 predicted pairs after transitive closure', r.predicted_pairs === 4, r);
check('tp 3 / fp 1 / fn 1', r.tp === 3 && r.fp === 1 && r.fn === 1, r);
check('precision, recall, f1 all 0.75', r.precision === 0.75 && r.recall === 0.75 && r.f1 === 0.75, r);
check('false merge is 6-7', JSON.stringify(r.false_merges) === JSON.stringify([['PAT-0000006', 'PAT-0000007']]), r.false_merges);
check('missed match is 4-5', JSON.stringify(r.missed_matches) === JSON.stringify([['PAT-0000004', 'PAT-0000005']]), r.missed_matches);
check('records counted', r.records === 7);
check('nothing truncated, no unknown ids', !r.false_merges_truncated && !r.missed_matches_truncated && r.unknown_id_count === 0);

console.log('=== 2. transitivity ===');
const noClose = S.evaluate(TRUTH, PRED, { closeTransitively: false });
check('without closure the implied 1-3 pair is a miss', noClose.tp === 2 && noClose.fn === 2 && noClose.predicted_pairs === 3, noClose);
check('closure credits A-C when only A-B and B-C were emitted', r.tp === 3);
const comp = S.transitiveClosure([['a', 'b'], ['b', 'c'], ['x', 'y']]);
check('closure puts a, b, c in one component and x, y in another',
  comp.get('a') === comp.get('b') && comp.get('b') === comp.get('c') && comp.get('x') === comp.get('y') && comp.get('a') !== comp.get('x'));
check('unlinked records are not in the closure', !comp.has('z'));
/* object-shaped pairs, reversed order, duplicates and scores are all one link */
const shapes = S.evaluate(TRUTH, [{ a: 'PAT-0000002', b: 'PAT-0000001', score: 0.9 }, ['PAT-0000001', 'PAT-0000002'], { left: 'PAT-0000003', right: 'PAT-0000002' }]);
check('pair shape, order and repeats do not change the count', shapes.tp === 3 && shapes.fp === 0 && shapes.predicted_pairs === 3, shapes);

console.log('=== 3. edge cases ===');
r = S.evaluate(TRUTH, []);
check('no links: precision 0, recall 0, fn = true pairs', r.precision === 0 && r.recall === 0 && r.fn === 4 && r.fp === 0);
r = S.evaluate(TRUTH, [['PAT-0000001', 'PAT-0000001'], ['PAT-0000001', 'PAT-0000002']]);
check('self pairs are ignored and reported', r.self_pairs_ignored === 1 && r.tp === 1);
r = S.evaluate(TRUTH, [['PAT-0000001', 'ZZZ']]);
check('an id not in the truth is a false merge AND flagged', r.fp === 1 && r.unknown_id_count === 1 && r.unknown_ids[0] === 'ZZZ', r);
check('perfect matcher scores 1.0', (() => { const p = [...S.pairsFromClusters(TRUTH)].map(S.splitPair); const e = S.evaluate(TRUTH, p); return e.precision === 1 && e.recall === 1 && e.f1 === 1; })());
/* a matcher that links everything into one blob must not enumerate n^2 pairs */
const many = {}; for (let i = 0; i < 20000; i++) many['R' + i] = 'M' + Math.floor(i / 2);
const chain = []; for (let i = 1; i < 20000; i++) chain.push(['R' + (i - 1), 'R' + i]);
let t0 = Date.now();
r = S.evaluate(many, chain, { maxListed: 50 });
check('one 20k-record component: exact counts without enumeration', r.predicted_pairs === 20000 * 19999 / 2 && r.tp === 10000 && r.fp === r.predicted_pairs - 10000, [r.predicted_pairs, r.tp, r.fp]);
check('...listing is capped and marked truncated', r.false_merges.length === 50 && r.false_merges_truncated === true);
check('...and finishes quickly (' + (Date.now() - t0) + ' ms)', Date.now() - t0 < 3000);
check('a degenerate truth (one cluster of everything) is refused, not attempted',
  throws(() => S.evaluate(Object.fromEntries(Array.from({ length: 3000 }, (_, i) => ['R' + i, 'SAME'])), []), /enumerated/));
check('bad pair shapes are rejected with the index', throws(() => S.evaluate(TRUTH, [['only-one']]), /pairs\[0\]/) && throws(() => S.evaluate(TRUTH, [{ foo: 1 }]), /pairs\[0\]/));
check('a non-numeric score is rejected', throws(() => S.evaluate(TRUTH, [['PAT-0000001', 'PAT-0000002', 'high']]), /not a number/));

console.log('=== 4. blocking: pair completeness and reduction ratio ===');
const blocks = { 'PAT-0000001': 'b1', 'PAT-0000002': 'b1', 'PAT-0000003': 'b2', 'PAT-0000004': 'b3', 'PAT-0000005': 'b3', 'PAT-0000006': 'b4', 'PAT-0000007': 'b4' };
let pc = S.pairCompleteness(TRUTH, blocks);
check('block labels: 2 of 4 true pairs survive', pc.surviving_blocking === 2 && pc.pair_completeness === 0.5, pc);
check('candidate pairs counted from block sizes (1+1+1)', pc.candidate_pairs === 3);
check('reduction ratio 1 - 3/21', pc.reduction_ratio === 0.8571 && pc.total_possible_pairs === 21, pc);
check('lost pairs are listed', pc.lost_to_blocking.length === 2 && pc.lost_to_blocking[0][1] === 'PAT-0000003');
const cand = [['PAT-0000001', 'PAT-0000002'], ['PAT-0000002', 'PAT-0000003'], ['PAT-0000001', 'PAT-0000003'], ['PAT-0000004', 'PAT-0000005'], ['PAT-0000006', 'PAT-0000007']];
pc = S.pairCompleteness(TRUTH, cand);
check('explicit candidate pairs: all 4 true pairs survive', pc.pair_completeness === 1 && pc.candidate_pairs === 5, pc);

console.log('=== 5. sweep and banded report ===');
const SCORED = [['PAT-0000001', 'PAT-0000002', 0.97], ['PAT-0000002', 'PAT-0000003', 0.85], ['PAT-0000006', 'PAT-0000007', 0.93], ['PAT-0000004', 'PAT-0000005', 0.6]];
const sw = S.sweep(TRUTH, SCORED, [0.5, 0.8, 0.9, 0.95]);
check('sweep has one row per threshold, ascending', sw.length === 4 && sw[0].threshold === 0.5 && sw[3].threshold === 0.95);
check('at 0.5 everything links: recall 1, one false merge', sw[0].recall === 1 && sw[0].fp === 1 && sw[0].precision === 0.8, sw[0]);
check('at 0.95 only the top pair links: precision 1, recall 0.25', sw[3].precision === 1 && sw[3].recall === 0.25, sw[3]);
check('default thresholds are 0.5..1.0 by 0.05', S.defaultThresholds().length === 11 && S.defaultThresholds()[0] === 0.5);
check('sweep refuses unscored pairs', throws(() => S.sweep(TRUTH, PRED), /score/));
const band = S.bandedReport(TRUTH, SCORED);
check('auto band (>=0.92): 2 links, 1 true -> precision 0.5, recall 0.25', band.auto_merge_precision === 0.5 && band.auto_merge_recall === 0.25 && band.false_merges === 1, band);
check('review band [0.78, 0.92): the 0.85 pair, which is true', band.review_queue_size === 1 && band.true_pairs_in_review === 1 && band.review_precision === 1, band);
check('recall after a perfect review = (1 + 1) / 4', band.recall_after_perfect_review === 0.5);
check('the 0.6 pair is below review and counted as missed', band.missed_below_review === 2);
check('bands with floor above auto are refused', throws(() => S.bandedReport(TRUTH, SCORED, { autoMerge: 0.8, reviewFloor: 0.9 }), /reviewFloor/));

console.log('=== 6. parsing pasted text ===');
let p = S.parsePairsText('id_a,id_b,score\nA,B,0.9\nC,D,0.8\n');
check('csv with header: header detected, scores parsed', p.header && p.scored && p.pairs.length === 2 && p.pairs[0][2] === 0.9, p);
p = S.parsePairsText('A,B\nC,D');
check('csv without header: nothing dropped', !p.header && p.pairs.length === 2 && !p.scored, p);
p = S.parsePairsText('1\t2\t0.5\n3\t4\t0.7');
check('tab delimited, numeric ids', p.pairs.length === 2 && p.pairs[1][0] === '3' && p.scored);
p = S.parsePairsText('[["A","B"],{"a":"C","b":"D","score":0.7}]');
check('json array of mixed shapes', p.pairs.length === 2 && p.partiallyScored && !p.scored);
p = S.parsePairsText('{"pairs":[["A","B",0.5]]}');
check('json {pairs:[...]} wrapper', p.pairs.length === 1 && p.scored);
p = S.parsePairsText('a,b\nX,Y', true);
check('explicit hasHeader wins over the heuristic', p.header && p.pairs.length === 1 && p.pairs[0][0] === 'X');
check('csv quoting: embedded delimiter and doubled quotes', JSON.stringify(S.parseCsv('a,"b,""q""",c\r\n1,2,3\n')) === JSON.stringify([['a', 'b,"q"', 'c'], ['1', '2', '3']]));
const recs = S.parseRecordsText('id,name,match_id\n1,Ann,M1\n2,"Ann, Jr",M1\n3,Bob,M2\n');
check('records from csv keep columns and rows', recs.columns.length === 3 && recs.records.length === 3 && recs.records[1].name === 'Ann, Jr');
const labels = S.truthFromRecords(recs.records, 'id');
check('truth from records defaults to match_id', labels.size === 3 && labels.get('1') === 'M1' && labels.get('3') === 'M2');
check('non-unique id field is refused with the offending id', throws(() => S.truthFromRecords([{ id: 1, match_id: 'a' }, { id: 1, match_id: 'b' }], 'id'), /not unique.*"1"/));
check('missing match column is explained', throws(() => S.truthFromRecords([{ id: 1 }], 'id'), /dups on/));
check('nested json record: dotted path and @attribute resolve', S.getPath({ order: { id: 'X', line: [{ sku: 1 }] } }, 'order.@id') === 'X' && S.getPath({ a: { b: { _value: 'v', c: 1 } } }, 'a.b') === 'v');
const lab = S.parseLabelsText('id,block\nA,k1\nB,k1\nC,k2');
check('labels from csv', lab.size === 3 && lab.get('B') === 'k1' && lab.get('C') === 'k2');
const summary = S.truthSummary(TRUTH);
check('truth summary: 7 records, 4 clusters, 2 singletons, 4 pairs', summary.records === 7 && summary.clusters === 4 && summary.singletons === 2 && summary.true_pairs === 4, summary);

console.log('=== 7. scoreAll bundles the lot ===');
let all = S.scoreAll(TRUTH, SCORED, { candidates: blocks, thresholds: [0.5, 0.9] });
check('evaluation, sweep, banded and blocking all present when scored', all.scored && all.evaluation && all.sweep.length === 2 && all.banded && all.blocking);
check('blocking loss produces a warning that names the direct-recall cap and the closure caveat', all.warnings.some(w => /never compared/.test(w) && /0\.5/.test(w) && /transitive closure/.test(w)), all.warnings);
all = S.scoreAll(TRUTH, PRED);
check('unscored links: sweep and banded are null, no blocking without candidates', !all.scored && all.sweep === null && all.banded === null && all.blocking === null);
all = S.scoreAll(TRUTH, [['PAT-0000001', 'PAT-0000002', 0.9], ['PAT-0000002', 'PAT-0000003']]);
check('partially scored links are flagged and not swept', all.warnings.some(w => /Only some pairs/.test(w)) && all.sweep === null);
all = S.scoreAll({ a: 'x', b: 'y' }, []);
check('a truth with no pairs is called out', all.warnings.some(w => /no pairs at all/.test(w)));

console.log('=== 8. against engine.js output ===');
E.useFaker(loadFaker().faker);
const people = E.newEntity('People'); people.rows = '200'; people.dupLevel = 'medium'; people.dupPct = '30'; people.dupMax = '3';
people.fields = [E.newField('id', 'UUID'), E.newField('first', 'First Name'), E.newField('last', 'Last Name'), E.newField('email', 'Email'), E.newField('zip', 'Zip Code')];
const run = E.runAll([people], E.entRowCount, 7);
const rows = run.results[0].rows;
const mkey = rows[0].parsed.find(x => !people.fields.includes(x.f)).f.name;
check('the engine added a match column', mkey === 'match_id' && rows.length > 200, [mkey, rows.length]);
const flatRecs = rows.map(x => x.flat);
const truth = S.truthFromRecords(flatRecs, 'id', mkey);
check('every generated row has a unique UUID id', truth.size === rows.length);
const ts = S.truthSummary(truth);
check('clusters: singletons plus groups of 2-4', ts.singletons > 0 && Object.keys(ts.cluster_sizes).every(k => Number(k) >= 1 && Number(k) <= 4), ts);
/* a perfect oracle */
const oracle = [...S.pairsFromClusters(truth)].map(S.splitPair);
let e = S.evaluate(truth, oracle);
check('oracle matcher: precision 1, recall 1', e.precision === 1 && e.recall === 1, e);
/* a naive matcher: exact lower-cased email. Medium dups fuzz 1-2 fields, so
   many variants keep the email intact -> high precision, partial recall */
const byEmail = new Map();
for (const rec of flatRecs) { const k = String(rec.email).toLowerCase(); if (!byEmail.has(k)) byEmail.set(k, []); byEmail.get(k).push(rec.id); }
const naive = [];
for (const ids of byEmail.values()) for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) naive.push([ids[i], ids[j]]);
e = S.evaluate(truth, naive);
check('exact-email matcher: high precision, recall well below 1 (' + e.precision + ' / ' + e.recall + ')', e.precision >= 0.9 && e.recall > 0.2 && e.recall < 1, e);
check('...its misses are listed as id pairs from the data', e.missed_matches.length === e.fn && truth.has(e.missed_matches[0][0]));
/* nested output: truth can be read back from the shaped JSON records too */
const shaped = E.rowsToObjects(rows);
check('truth from the shaped JSON records matches truth from flat rows', S.truthFromRecords(shaped, 'id', mkey).size === truth.size);
/* blocking on the zip code, as a labelling from the data */
const zipBlocks = new Map(flatRecs.map(rec => [String(rec.id), String(rec.zip)]));
pc = S.pairCompleteness(truth, zipBlocks);
check('zip blocking: completeness below 1 (zip gets fuzzed), reduction ratio high', pc.pair_completeness < 1 && pc.pair_completeness > 0.3 && pc.reduction_ratio > 0.9, pc);
/* a user field literally named match_id: the engine's key moves to _match_id */
const clash = E.newEntity('C'); clash.rows = '10'; clash.dupLevel = 'light'; clash.dupPct = '100';
clash.fields = [E.newField('id', 'UUID'), E.newField('match_id', 'Row Number'), E.newField('n', 'First Name')];
const crun = E.runAll([clash], E.entRowCount, 1).results[0].rows;
const ckey = crun[0].parsed.find(x => !clash.fields.includes(x.f)).f.name;
check('engine match column moves aside for a user match_id field', ckey === '_match_id' && S.truthFromRecords(crun.map(x => x.flat), 'id', ckey).size === crun.length);

console.log('=== 9. POST /v1/score over HTTP ===');
const store = new MemoryStore();
const { server, api } = createServer({ store });
await api.pool.start();
await new Promise(res => server.listen(0, '127.0.0.1', res));
const base = 'http://127.0.0.1:' + server.address().port;
const post = (path, b) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(async x => [x.status, await x.json()]);
const get = path => fetch(base + path).then(async x => [x.status, await x.json()]);

let [st, body] = await post('/v1/score', { truth: TRUTH, predicted: PRED });
check('bare labelling truth: 200 with the reference numbers', st === 200 && body.evaluation.tp === 3 && body.evaluation.fp === 1 && body.evaluation.fn === 1 && body.evaluation.f1 === 0.75, [st, body.error || body.evaluation]);
check('truth summary and source in the response', body.truth.true_pairs === 4 && body.truth.source.labels === 7, body.truth);
check('unscored: sweep and banded are null', body.sweep === null && body.banded === null && body.scored === false);

[st, body] = await post('/v1/score', { truth: TRUTH, predicted: SCORED, candidates: blocks, thresholds: [0.5, 0.9, 0.95], autoMerge: 0.9, reviewFloor: 0.7, maxListed: 10 });
check('scored links with options: sweep, banded and blocking present', st === 200 && body.sweep.length === 3 && body.banded.auto_merge_threshold === 0.9 && body.blocking.pair_completeness === 0.5, [st, body.error]);

[st, body] = await post('/v1/score', { truth: { records: [{ id: 1, match_id: 'a' }, { id: 2, match_id: 'a' }, { id: 3, match_id: 'b' }], idField: 'id' }, predicted: [[1, 2]] });
check('records truth: numeric ids are coerced and scored', st === 200 && body.evaluation.tp === 1 && body.evaluation.precision === 1, [st, body]);
[st, body] = await post('/v1/score', { truth: { records: [{ id: 1, match_id: 'a' }, { id: 1, match_id: 'b' }], idField: 'id' }, predicted: [] });
check('records truth with a non-unique id is 400 invalid_truth', st === 400 && body.error.code === 'invalid_truth' && /not unique/.test(body.error.message), body.error);

console.log('=== 10. truth regenerated from (schemaId, count, seed) ===');
const SCHEMA = { version: 2, entities: [
  { name: 'Accounts', rows: '10', fields: [{ name: 'id', type: 'UUID' }, { name: 'nm', type: 'Company' }] },
  { name: 'People', rows: '200', dupLevel: 'medium', dupPct: '30', dupMax: '3', fields: [
    { name: 'id', type: 'UUID' }, { name: 'first', type: 'First Name' }, { name: 'last', type: 'Last Name' },
    { name: 'email', type: 'Email' }, { name: 'zip', type: 'Zip Code' },
    { name: 'acct', type: 'Reference', opts: { entity: 'Accounts', field: 'id' } }] }] };
const [rs, reg] = await post('/v1/schemas', SCHEMA);
check('schema with dups registers', rs === 201 && reg.hasDuplicates === true, [rs, reg]);
const ID = reg.schemaId;
const [gs, gen] = await post('/v1/generate', { schemaId: ID, count: { People: 200 }, seed: 7 });
check('generate returns People with a match_id column', gs === 200 && gen.entities[1].records[0].match_id !== undefined, [gs, gen.error]);
const genRecs = gen.entities[1].records;
const genTruth = S.truthFromRecords(genRecs, 'id', 'match_id');
const genOracle = [...S.pairsFromClusters(genTruth)].map(S.splitPair);
/* build the naive matcher's links from the generated file the way a caller would */
const em = new Map();
for (const rec of genRecs) { const k = String(rec.email).toLowerCase(); if (!em.has(k)) em.set(k, []); em.get(k).push(rec.id); }
const genNaive = [];
for (const ids of em.values()) for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) genNaive.push([ids[i], ids[j]]);

[st, body] = await post('/v1/score', { truth: { schemaId: ID, count: { People: 200 }, seed: 7, entity: 'People', idField: 'id' }, predicted: genOracle });
check('regenerated truth scores the oracle at 1.0', st === 200 && body.evaluation.precision === 1 && body.evaluation.recall === 1, [st, body.error || body.evaluation]);
check('...and reports where it came from', body.truth.source.schemaId === ID && body.truth.source.seed === 7 && body.truth.source.matchField === 'match_id' && body.truth.source.count.Accounts === 10, body.truth.source);
check('...with as many records as the generate call returned', body.truth.records === genRecs.length, [body.truth.records, genRecs.length]);
const [, viaRegen] = await post('/v1/score', { truth: { schemaId: ID, count: { People: 200 }, seed: 7, entity: 'People', idField: 'id' }, predicted: genNaive });
const [, viaRecords] = await post('/v1/score', { truth: { records: genRecs, idField: 'id' }, predicted: genNaive });
check('regenerated truth and the shipped file give identical scores', JSON.stringify(viaRegen.evaluation) === JSON.stringify(viaRecords.evaluation), [viaRegen.evaluation && viaRegen.evaluation.f1, viaRecords.evaluation && viaRecords.evaluation.f1]);
const [, otherSeed] = await post('/v1/score', { truth: { schemaId: ID, count: { People: 200 }, seed: 8, entity: 'People', idField: 'id' }, predicted: genOracle });
check('a different seed is a different answer key (ids no longer line up)', otherSeed.evaluation.unknown_id_count > 0 && otherSeed.evaluation.recall < 1, otherSeed.evaluation && otherSeed.evaluation.unknown_id_count);

const badTruths = [
  ['missing seed', { schemaId: ID, count: { People: 200 }, entity: 'People', idField: 'id' }, 'invalid_seed'],
  ['unknown schema', { schemaId: 'Z'.repeat(32), count: 1, seed: 1, idField: 'id' }, 'unknown_schema'],
  ['missing entity on a multi-entity schema', { schemaId: ID, count: { People: 200 }, seed: 7, idField: 'id' }, 'invalid_truth'],
  ['entity without dups', { schemaId: ID, count: { People: 200 }, seed: 7, entity: 'Accounts', idField: 'id' }, 'invalid_truth'],
  ['idField not in the entity', { schemaId: ID, count: { People: 200 }, seed: 7, entity: 'People', idField: 'nope' }, 'invalid_truth'],
  ['bare count on a multi-entity schema', { schemaId: ID, count: 200, seed: 7, entity: 'People', idField: 'id' }, 'invalid_count'],
  ['no truth at all', undefined, 'invalid_truth'],
  ['empty labelling', {}, 'invalid_truth']
];
for (const [label, truthBody, code] of badTruths) {
  const [s2, b2] = await post('/v1/score', { truth: truthBody, predicted: [] });
  check('rejects ' + label + ' (' + code + ')', s2 === 400 && b2.error.code === code && typeof b2.error.field === 'string', [s2, b2.error]);
}

console.log('=== 11. request validation and transport ===');
[st, body] = await post('/v1/score', { truth: TRUTH });
check('missing predicted is 400 invalid_pairs', st === 400 && body.error.code === 'invalid_pairs', body.error);
[st, body] = await post('/v1/score', { truth: TRUTH, predicted: [['x']] });
check('malformed pair is 400 invalid_pairs naming the index', st === 400 && body.error.code === 'invalid_pairs' && /pairs\[0\]/.test(body.error.message), body.error);
[st, body] = await post('/v1/score', { truth: TRUTH, predicted: PRED, thresholds: [2] });
check('threshold outside 0..1 is 400 invalid_option', st === 400 && body.error.code === 'invalid_option' && body.error.field === 'thresholds', body.error);
[st, body] = await post('/v1/score', { truth: TRUTH, predicted: SCORED, autoMerge: 0.7, reviewFloor: 0.9 });
check('review floor above auto-merge is 400', st === 400 && body.error.field === 'reviewFloor', body.error);
[st, body] = await post('/v1/score', { truth: TRUTH, predicted: PRED, maxListed: 999999 });
check('oversized maxListed is 400', st === 400 && body.error.field === 'maxListed', body.error);
[st, body] = await post('/v1/score', { truth: TRUTH, predicted: PRED, candidates: 'zip' });
check('candidates of the wrong shape is 400 invalid_candidates', st === 400 && body.error.code === 'invalid_candidates', body.error);
check('GET /v1/score is 405', (await get('/v1/score'))[0] === 405);
/* a matcher's full output is far bigger than a schema: the score route has its own cap */
const bigPairs = []; for (let i = 0; i < 30000; i++) bigPairs.push(['PAT-0000001', 'X' + i, 0.5]);
[st, body] = await post('/v1/score', { truth: TRUTH, predicted: bigPairs });
check('a ~700 KB score body is accepted (would be 413 on the schema route)', st === 200 && body.evaluation.fp > 0, [st, body.error]);
const huge = await fetch(base + '/v1/score', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(9 * 1024 * 1024) });
check('a body over the score cap is still 413', huge.status === 413, huge.status);
const schemaBig = await fetch(base + '/v1/schemas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(300 * 1024) });
check('the schema route keeps its smaller cap', schemaBig.status === 413, schemaBig.status);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
api.pool.stop();
server.close();
process.exit(fail ? 1 : 0);
