/* Matcher suite. Run with: node tests/matcher.mjs

   Checks the comparison catalogue, rule semantics (AND inside a rule, OR
   across rules), the blocking a rule derives from its own equality
   comparisons, and then runs the whole thing against real generated data and
   scores it -- because the point of the matcher is to be scored. */
import { loadFaker } from '../api/faker-node.mjs';
import * as E from '../engine.js';
import * as S from '../scoring.js';
import * as M from '../matcher.js';

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.log('  FAIL:', name, extra === undefined ? '' : JSON.stringify(extra).slice(0, 300)); }
};
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re ? re.test(e.message) : true; } };
const cmp = (id, a, b, arg) => M.comparison(id).test(a, b, arg);

console.log('=== 1. comparisons ===');
check('exact is exact', cmp('exact', 'Smith', 'Smith') && !cmp('exact', 'Smith', 'smith'));
check('normalized ignores case and punctuation', cmp('normalized', "O'Brien-Smith", 'obrien smith') && !cmp('normalized', 'Smith', 'Smyth'));
check('prefix compares the first N', cmp('prefix', 'Smithson', 'Smithers', '5') && !cmp('prefix', 'Smithson', 'Smythe', '3'));
check('tokens ignore word order', cmp('tokens', 'John Smith', 'Smith, John') && !cmp('tokens', 'John Smith', 'Jon Smith'));
check('jw accepts a near miss and rejects a far one', cmp('jw', 'Smith', 'Smyth', '0.85') && !cmp('jw', 'Smith', 'Jones', '0.85'));
check('lev likewise', cmp('lev', 'Smith', 'Smiht', '0.6') && !cmp('lev', 'Smith', 'Brown', '0.6'));
check('jwTokens is fuzzy AND order-insensitive', cmp('jwTokens', 'John Smith', 'Smyth John', '0.85'));
check('numeric tolerance', cmp('numeric', '100', '101', '1') && !cmp('numeric', '100', '103', '1'));
check('numeric rejects non-numbers', !cmp('numeric', 'abc', 'abd', '5'));
check('days tolerance', cmp('days', '2024-03-01', '2024-03-02', '1') && !cmp('days', '2024-03-01', '2024-03-05', '1'));
check('days rejects unparseable dates', !cmp('days', 'never', 'whenever', '9999'));

console.log('=== 2. soundex ===');
/* the canonical published examples, including the H/W transparency rule */
for (const [a, b] of [['Robert', 'Rupert'], ['Ashcraft', 'Ashcroft'], ['Tymczak', 'Tymczak'], ['Honeyman', 'Honeyman']])
  check('soundex(' + a + ') === soundex(' + b + ')', M.soundex(a) === M.soundex(b), [M.soundex(a), M.soundex(b)]);
check('Robert is R163', M.soundex('Robert') === 'R163', M.soundex('Robert'));
check('Ashcraft is A261 (H is transparent)', M.soundex('Ashcraft') === 'A261', M.soundex('Ashcraft'));
check('Tymczak is T522', M.soundex('Tymczak') === 'T522', M.soundex('Tymczak'));
check('Pfister is P236', M.soundex('Pfister') === 'P236', M.soundex('Pfister'));
check('Honeyman is H555', M.soundex('Honeyman') === 'H555', M.soundex('Honeyman'));
check('empty in, empty out', M.soundex('') === '' && M.soundex(null) === '');
check('Smith and Smyth agree', M.soundex('Smith') === M.soundex('Smyth'));

console.log('=== 3. rule semantics ===');
const RECS = [
  { id: '1', first: 'John', last: 'Smith', dob: '1980-01-01', email: 'j.smith@x.com' },
  { id: '2', first: 'Jon', last: 'Smith', dob: '1980-01-01', email: '' },
  { id: '3', first: 'John', last: 'Smyth', dob: '1980-01-01', email: 'J.SMITH@X.COM' },
  { id: '4', first: 'Mary', last: 'Jones', dob: '1975-06-15', email: 'm@y.com' },
  { id: '5', first: 'Mary', last: 'Jones', dob: '1999-12-31', email: '' }
];
const run = (rules, opts) => M.runMatcher(RECS, rules, { idField: 'id', ...opts });
const asSet = r => new Set(r.pairs.map(p => p[0] + '-' + p[1]));

let r = run([{ name: 'exact name + dob', confidence: '1', comparisons: [
  { field: 'last', kind: 'exact' }, { field: 'first', kind: 'exact' }, { field: 'dob', kind: 'exact' }] }]);
check('AND inside a rule: only the fully-agreeing pair links', asSet(r).size === 0, [...asSet(r)]);
r = run([{ name: 'surname + dob', confidence: '1', comparisons: [
  { field: 'last', kind: 'exact' }, { field: 'dob', kind: 'exact' }] }]);
check('relaxing one comparison links 1-2', asSet(r).has('1-2') && asSet(r).size === 1, [...asSet(r)]);
r = run([
  { name: 'a', confidence: '0.9', comparisons: [{ field: 'last', kind: 'exact' }, { field: 'dob', kind: 'exact' }] },
  { name: 'b', confidence: '0.7', comparisons: [{ field: 'last', kind: 'soundex' }, { field: 'dob', kind: 'exact' }] }]);
check('OR across rules widens the result', asSet(r).size === 3 && asSet(r).has('1-3'), [...asSet(r)]);
check('a pair keeps the highest confidence among passing rules',
  r.pairs.find(p => p[0] === '1' && p[1] === '2')[2] === 0.9, r.pairs);
check('a pair only one rule reached keeps that rule\'s confidence',
  r.pairs.find(p => p[0] === '1' && p[1] === '3')[2] === 0.7, r.pairs);
check('per-rule link counts are reported', r.perRule[0].linked === 1 && r.perRule[1].linked === 3, r.perRule);
check('pairRules records which rules produced each pair',
  r.pairRules.length === r.pairs.length && r.pairRules.some(x => x.length === 2), r.pairRules);

console.log('=== 4. blanks ===');
const emailOnly = blankAgrees => [{ name: 'email', confidence: '1', blankAgrees, comparisons: [{ field: 'email', kind: 'normalized' }] }];
r = run(emailOnly(false));
check('a blank fails its comparison by default', asSet(r).has('1-3') && asSet(r).size === 1, [...asSet(r)]);
check('normalized email matches across case', asSet(r).has('1-3'));
/* The guard that matters: a lone comparison skipped as blank must NOT pass the
   rule vacuously, or a record with no email would link to the whole file. */
r = run(emailOnly(true));
check('blankAgrees never passes a rule with nothing left to evaluate', asSet(r).size === 1 && asSet(r).has('1-3'), [...asSet(r)]);
/* Where it does help: another comparison is still carrying the rule. */
const nameAndEmail = blankAgrees => [{ name: 'surname + email', confidence: '1', blankAgrees,
  comparisons: [{ field: 'last', kind: 'exact' }, { field: 'email', kind: 'normalized' }] }];
r = run(nameAndEmail(false));
check('a blank optional field sinks the rule by default', asSet(r).size === 0, [...asSet(r)]);
r = run(nameAndEmail(true));
check('blankAgrees rescues it via the comparison that remains', asSet(r).has('1-2') && asSet(r).has('4-5'), [...asSet(r)]);
check('...and still does not link records that disagree', !asSet(r).has('1-4'), [...asSet(r)]);

console.log('=== 5. blocking derived from the rule ===');
r = run([{ name: 'blocked', confidence: '1', comparisons: [{ field: 'dob', kind: 'exact' }, { field: 'last', kind: 'jw', arg: '0.8' }] }]);
check('a rule with an equality comparison is blocked', r.perRule[0].blocked === true);
check('...and compares far fewer than every pair', r.comparisons < r.totalPossible, [r.comparisons, r.totalPossible]);
check('...and no unblocked rules are reported', r.unblockedRules.length === 0);
const fuzzyOnly = [{ name: 'all fuzzy', confidence: '1', comparisons: [{ field: 'last', kind: 'jw', arg: '0.8' }] }];
r = run(fuzzyOnly);
check('a purely fuzzy rule compares every pair', r.comparisons === r.totalPossible && r.unblockedRules.length === 1, [r.comparisons, r.totalPossible]);
check('blocking does not change the answer, only the cost', (() => {
  const blocked = run([{ name: 'x', confidence: '1', comparisons: [{ field: 'dob', kind: 'exact' }, { field: 'last', kind: 'jw', arg: '0.8' }] }]);
  /* the same rule evaluated with no key: compare every pair, filter by hand */
  const brute = new Set();
  for (let i = 0; i < RECS.length; i++) for (let j = i + 1; j < RECS.length; j++)
    if (RECS[i].dob === RECS[j].dob && E.jaroWinkler(RECS[i].last, RECS[j].last) >= 0.8) brute.add(RECS[i].id + '-' + RECS[j].id);
  return JSON.stringify([...asSet(blocked)].sort()) === JSON.stringify([...brute].sort());
})());
check('candidates are the pairs actually compared', r.candidates.length === r.comparisons, [r.candidates.length, r.comparisons]);

console.log('=== 6. validation ===');
check('no rules at all is refused', throws(() => run([]), /at least one match rule/));
check('a rule with no comparisons is refused', throws(() => run([{ name: 'empty', comparisons: [] }]), /no comparisons/));
check('an unknown field is named in the error', throws(() => run([{ comparisons: [{ field: 'nope', kind: 'exact' }] }]), /no field named "nope"/));
check('a threshold outside 0..1 is refused', throws(() => run([{ comparisons: [{ field: 'last', kind: 'jw', arg: '5' }] }]), /similarity between 0 and 1/));
check('a bad confidence is refused', throws(() => run([{ confidence: '7', comparisons: [{ field: 'last', kind: 'exact' }] }]), /confidence must be/));
check('a missing id field is refused', throws(() => M.runMatcher(RECS, fuzzyOnly, { idField: '' }), /idField/));
check('an over-budget run is refused before it starts, and says why',
  throws(() => run(fuzzyOnly, { maxComparisons: 3 }), /every pair because it has no exact, prefix or Soundex/));

console.log('=== 7. suggested rules ===');
const suggested = M.suggestRules(['patient_id', 'first_name', 'last_name', 'birth_date', 'email', 'ssn_last4', 'address.zip']);
check('rules are proposed from the field names', suggested.length >= 3, suggested.map(x => x.name));
check('...and they reference real fields', suggested.every(rl => rl.comparisons.every(c => c.field)), suggested);
check('...and they validate', !throws(() => M.runMatcher(
  [{ patient_id: '1', first_name: 'A', last_name: 'B', birth_date: '2000-01-01', email: 'a@b.c', ssn_last4: '1234', 'address.zip': '10001' },
   { patient_id: '2', first_name: 'A', last_name: 'B', birth_date: '2000-01-01', email: 'a@b.c', ssn_last4: '1234', 'address.zip': '10001' }],
  suggested, { idField: 'patient_id' })));
check('an unrecognisable schema still gets one starter rule', M.suggestRules(['alpha', 'beta']).length === 1);

console.log('=== 8. against generated data, then scored ===');
E.useFaker(loadFaker().faker);
const en = E.newEntity('Patients');
en.rows = '150'; en.dupLevel = 'targeted'; en.dupPct = '30'; en.dupMax = '3';
const f = (name, type, opts, sim) => { const x = E.newField(name, type, opts); if (sim) x.sim = sim; return x; };
en.fields = [
  f('seq', 'Row Number'),
  f('first_name', 'First Name', {}, { algo: 'jw', target: '0.90' }),
  f('last_name', 'Last Name', {}, { algo: 'jw', target: '0.88' }),
  f('birth_date', 'Date', { from: '1940-01-01', to: '2005-12-31', dateFormat: 'YYYY-MM-DD' }),
  f('email', 'Email', {}, { algo: 'jw', target: '0.92' }),
  f('zip', 'Zip Code')
];
const rows = E.runAll([en], E.entRowCount, 42).results[0].rows;
const recs = rows.map(x => x.flat);
const truth = S.truthFromRecords(recs, 'seq', 'match_id');
const summary = S.truthSummary(truth);
check('generated data has duplicates to find', summary.true_pairs > 20, summary);

/* birth_date and zip carry no sim, so they survive intact and make good anchors */
const rules = [
  { name: 'Exact birth date and fuzzy surname', confidence: '0.95', blankAgrees: false,
    comparisons: [{ field: 'birth_date', kind: 'exact' }, { field: 'last_name', kind: 'jw', arg: '0.85' }] },
  { name: 'Zip and fuzzy full name', confidence: '0.85', blankAgrees: false,
    comparisons: [{ field: 'zip', kind: 'exact' }, { field: 'last_name', kind: 'jw', arg: '0.80' }, { field: 'first_name', kind: 'jw', arg: '0.80' }] }
];
const out = M.runMatcher(recs, rules, { idField: 'seq' });
const scored = S.scoreAll(truth, out.pairs, { candidates: out.candidates });
console.log('  linked ' + out.pairs.length + ' pairs from ' + out.comparisons + ' comparisons (of ' + out.totalPossible + ' possible)');
console.log('  precision ' + scored.evaluation.precision + '  recall ' + scored.evaluation.recall +
  '  over-matches ' + scored.evaluation.fp + '  under-matches ' + scored.evaluation.fn);
check('the matcher finds real duplicates', scored.evaluation.tp > 10, scored.evaluation);
check('precision is high on these rules', scored.evaluation.precision > 0.8, scored.evaluation.precision);
check('every linked id exists in the truth', scored.evaluation.unknown_id_count === 0);
check('blocking cost far less than all pairs', out.comparisons < out.totalPossible / 5, [out.comparisons, out.totalPossible]);
check('per-rule counts sum to at least the linked total', out.perRule.reduce((n, x) => n + x.linked, 0) >= out.pairs.length, out.perRule);
check('the run is reproducible', JSON.stringify(M.runMatcher(recs, rules, { idField: 'seq' }).pairs) === JSON.stringify(out.pairs));

/* a deliberately loose rule should over-match, which is the whole point */
const loose = [{ name: 'Surname only', confidence: '0.5', blankAgrees: false,
  comparisons: [{ field: 'last_name', kind: 'soundex' }] }];
const looseOut = M.runMatcher(recs, loose, { idField: 'seq' });
const looseScored = S.scoreAll(truth, looseOut.pairs, {});
console.log('  loose rule: over-matches ' + looseScored.evaluation.fp + ', under-matches ' + looseScored.evaluation.fn);
check('a loose rule over-matches badly', looseScored.evaluation.fp > scored.evaluation.fp, [looseScored.evaluation.fp, scored.evaluation.fp]);
check('...and its precision is worse', looseScored.evaluation.precision < scored.evaluation.precision);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
