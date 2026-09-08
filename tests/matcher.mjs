/* Matcher suite. Run with: node tests/matcher.mjs

   Checks the comparison catalogue, rule semantics (AND inside a rule, OR
   across rules), the blocking a rule derives from its own equality
   comparisons, and then runs the whole thing against real generated data and
   scores it -- because the point of the matcher is to be scored. */
import fs from 'node:fs';
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

console.log('=== 7b. explaining a pair, attributing the misses ===');
{
  const a = RECS[0], b = RECS[2];                      // Smith / Smyth, same dob, emails differ only in case
  const rules = [
    { name: 'strict', confidence: '1', comparisons: [{ field: 'last', kind: 'exact' }, { field: 'dob', kind: 'exact' }] },
    { name: 'fuzzy', confidence: '0.8', blankAgrees: true, comparisons: [{ field: 'last', kind: 'jw', arg: '0.85' }, { field: 'dob', kind: 'days', arg: '1' }, { field: 'email', kind: 'normalized' }] }
  ];
  const ex = M.explainPair(rules, a, b);
  check('one entry per rule, in order', ex.length === 2 && ex[0].name === 'strict' && ex[1].name === 'fuzzy');
  check('strict fails, and says which comparison', !ex[0].passed && !ex[0].comparisons[0].passed && ex[0].comparisons[1].passed, ex[0]);
  check('fuzzy passes with every comparison marked passed', ex[1].passed && ex[1].comparisons.every(c => c.passed), ex[1]);
  check('a fuzzy comparison carries the measured similarity', ex[1].comparisons[0].measured > 0.85 && ex[1].comparisons[0].unit === 'similarity', ex[1].comparisons[0]);
  check('a date comparison carries the measured day gap', ex[1].comparisons[1].measured === 0 && ex[1].comparisons[1].unit === 'days', ex[1].comparisons[1]);
  check('both values are shown as strings', ex[0].comparisons[0].a === 'Smith' && ex[0].comparisons[0].b === 'Smyth');
  const blankEx = M.explainPair([{ name: 'r', blankAgrees: true, comparisons: [{ field: 'email', kind: 'exact' }] }], RECS[0], RECS[1]);
  check('a skipped blank is marked skipped, and a rule with nothing evaluated fails', blankEx[0].comparisons[0].skipped && blankEx[0].evaluatedNothing && !blankEx[0].passed, blankEx[0]);
  const byId = new Map(RECS.map(r => [r.id, r]));
  const att = M.attributeMisses(rules, byId, [['1', '3'], ['4', '5']]);
  check('every miss inspected', att.inspected === 2);
  check('strict failed 1-3 on surname and 4-5 on dob: counted per comparison',
    att.rules[0].failedOn[0].count === 1 && att.rules[0].failedOn[1].count === 1, att.rules[0]);
  check('fuzzy was one comparison away on 4-5: surname agrees, blank email skipped, only the dates fail', att.rules[1].nearMisses === 1 && att.rules[1].failedOn[1].count === 1, att.rules[1]);
  check('unknown ids are skipped, not fatal', M.attributeMisses(rules, byId, [['1', 'nope']]).inspected === 0);
}

console.log('=== 7f. which record to match to ===');
{
  /* four records in one block: two Smiths, two Smyths. Exact surname is the
     strong rule, Soundex the weak one, so every cross pair passes weakly */
  const R = [{ id: 'A', k: '1', name: 'smith' }, { id: 'B', k: '1', name: 'smith' }, { id: 'C', k: '1', name: 'smyth' }, { id: 'D', k: '1', name: 'smyth' }];
  const rules = [
    { name: 'Exact', confidence: '1', blankAgrees: false, comparisons: [{ field: 'k', kind: 'exact', arg: '' }, { field: 'name', kind: 'exact', arg: '' }] },
    { name: 'Sounds alike', confidence: '0.8', blankAgrees: false, comparisons: [{ field: 'k', kind: 'exact', arg: '' }, { field: 'name', kind: 'soundex', arg: '' }] }
  ];
  const all = M.runMatcher(R, rules, { idField: 'id' });
  check('"all" is the default and links every passing pair', all.linkPolicy === 'all' && all.pairs.length === 6 && all.droppedByPolicy === 0 && all.links.every(l => l.chosen), all.pairs);
  check('...yet still says which record each would match to', all.matchedTo.A === 'B' && all.matchedTo.B === 'A' && all.matchedTo.C === 'D' && all.matchedTo.D === 'C', all.matchedTo);
  const best = M.runMatcher(R, rules, { idField: 'id', linkPolicy: 'best' });
  check('"best" keeps only each record\'s pick', best.pairs.length === 2 && best.droppedByPolicy === 4 && asSet(best).has('A-B') && asSet(best).has('C-D'), best.pairs);
  check('every passing pair is still reported, with the dropped ones flagged', best.links.length === 6 && best.links.filter(l => !l.chosen).length === 4);
  check('per-rule counts describe what the rules did, before the policy', best.perRule[1].linked === 6 && best.perRule[0].linked === 2, best.perRule);
  check('the pair list carries the kept pairs\' rules', best.pairRules.length === 2 && best.pairRules.every(r => r.length === 2));
  const cands = M.candidatesOf(best, 'A');
  check('candidatesOf ranks a record\'s candidates best first and flags the pick', cands.length === 3 && cands[0].to === 'B' && cands[0].picked && cands[0].linked && cands[0].rules.length === 2
    && !cands[1].picked && !cands[1].linked && cands[1].score === 0.8, cands);
  check('a record nobody matched has no candidates', M.candidatesOf(best, 'Z').length === 0);
  check('an unknown policy is refused', throws(() => M.runMatcher(R, rules, { idField: 'id', linkPolicy: 'mutual' }), /unknown link policy "mutual"/));

  /* the tie-break: same score, same rules, closer values win, then the lower id */
  const R2 = [{ id: 'X', k: '1', name: 'johnathan' }, { id: 'Y', k: '1', name: 'johnathon' }, { id: 'Z', k: '1', name: 'johnatan' }];
  const fuzzy = [{ name: 'Fuzzy', confidence: '0.9', blankAgrees: false, comparisons: [{ field: 'k', kind: 'exact', arg: '' }, { field: 'name', kind: 'jw', arg: '0.8' }] }];
  const r2 = M.runMatcher(R2, fuzzy, { idField: 'id', linkPolicy: 'best' });
  const cx = M.candidatesOf(r2, 'X');
  check('closeness breaks a tie between candidates the same rule accepted', cx[0].strength > cx[1].strength && cx[0].picked, cx);
  check('the ranking is the exported comparator', JSON.stringify(cx.map(c => c.to)) === JSON.stringify([...cx].map(c => ({ ...c, other: c.to })).sort(M.rankLink).map(c => c.to)));
  check('a pair survives when it is the pick of either record', r2.pairs.length >= 2 && r2.pairs.length <= 3, r2.pairs);
  check('the order is reproducible', JSON.stringify(M.runMatcher(R2, fuzzy, { idField: 'id', linkPolicy: 'best' }).pairs) === JSON.stringify(r2.pairs));
  check('equal candidates fall back to the lower id', (() => {
    const T = [{ id: 'P', k: '1', n: 'a' }, { id: 'Q', k: '1', n: 'a' }, { id: 'R', k: '1', n: 'a' }];
    const r = M.runMatcher(T, [{ name: 'e', confidence: '1', blankAgrees: false, comparisons: [{ field: 'n', kind: 'exact', arg: '' }] }], { idField: 'id', linkPolicy: 'best' });
    return r.matchedTo.P === 'Q' && r.matchedTo.Q === 'P' && r.matchedTo.R === 'P';
  })());
}

console.log('=== 7g. what changed in a variant, and what each rule made of it ===');
{
  const C = M.classifyChange;
  check('no change is null', C('Smith', 'Smith') === null && C('', '') === null && C(null, '') === null);
  check('case', C('Smith', 'SMITH') === 'case' && C('smith', 'Smith') === 'case');
  check('spacing', C('Mary Ann', 'Mary  Ann') === 'spacing' && C('Smith', 'Smith ') === 'spacing');
  check('typo', C('Durgan', 'Duqan') === 'typo' && C('Smith', 'Smiht') === 'typo' && C('Smith', 'Smth') === 'typo');
  check('fuzzed', C('Johnathan', 'Jonatn') === 'fuzzed');
  check('digits', C('64093', '64098') === 'digits' && C('1234', '1235') === 'digits');
  check('date', C('1972-04-09', '1972-04-10') === 'date' && C('1972-04-09', '1972-09-04') === 'date');
  check('format: same digits, different dressing', C('(303) 735-1748', '303-735-1748') === 'format' && C('3037351748', '(303) 735-1748') === 'format');
  check('format: email dots and case', C('mary.ann@x.com', 'maryann@x.com') === 'format' && C('Mary.Ann@X.com', 'mary.ann@x.com') === 'case');
  check('blanked and filled', C('Smith', '') === 'blanked' && C('', 'Smith') === 'filled' && C('Smith', '  ') === 'blanked');
  check('regenerated uuid', C('86aa983c-c52b-445a-a9ed-070d70f95779', 'd320aec2-ce04-4786-be7c-254019032aee') === 'regenerated');
  check('a formula is derived whatever the values', C('ABC', 'XYZ', { type: 'Formula (JS)' }) === 'derived');
  check('anything else is rewritten', C('Smith', 'Rodriguez') === 'other');
  check('every kind has a label', M.CHANGE_KINDS.every(k => typeof M.changeLabel(k.id) === 'string' && M.changeLabel(k.id).length) && M.changeLabel('zzz') === 'zzz');

  const byId = new Map([
    ['1', { id: '1', last: 'Durgan', dob: '1972-04-09', zip: '64093' }],
    ['1a', { id: '1a', last: 'Duqan', dob: '1972-04-09', zip: '64093' }],
    ['1b', { id: '1b', last: 'DURGAN', dob: '1972-04-10', zip: '64093' }],
    ['2', { id: '2', last: 'Lee', dob: '1980-01-01', zip: '10001' }],
    ['2a', { id: '2a', last: 'Lee', dob: '1980-01-01', zip: '' }]
  ]);
  const variants = [
    { id: '1a', originalId: '1', changes: [{ field: 'last', from: 'Durgan', to: 'Duqan', kind: 'typo' }] },
    { id: '1b', originalId: '1', changes: [{ field: 'last', from: 'Durgan', to: 'DURGAN', kind: 'case' }, { field: 'dob', from: '1972-04-09', to: '1972-04-10', kind: 'date' }] },
    { id: '2a', originalId: '2', changes: [{ field: 'zip', from: '10001', to: '', kind: 'blanked' }] },
    { id: 'ghost', originalId: '2', changes: [] }
  ];
  const rules = [
    { name: 'Exact surname and dob', confidence: '1', blankAgrees: false, comparisons: [{ field: 'last', kind: 'exact', arg: '' }, { field: 'dob', kind: 'exact', arg: '' }] },
    { name: 'Fuzzy surname and zip', confidence: '0.9', blankAgrees: false, comparisons: [{ field: 'last', kind: 'jw', arg: '0.85' }, { field: 'zip', kind: 'exact', arg: '' }] }
  ];
  const au = M.auditVariants(rules, byId, variants);
  check('unknown ids are skipped', au.inspected === 3 && au.variants.length === 3);
  const v1a = au.variants.find(v => v.id === '1a'), v1b = au.variants.find(v => v.id === '1b'), v2a = au.variants.find(v => v.id === '2a');
  check('a typo loses the exact rule and is caught by the fuzzy one', !v1a.rules[0].passed && v1a.rules[1].passed && v1a.caughtBy.length === 1 && v1a.caughtBy[0] === 1, v1a);
  check('the failing comparison is named and attributed to the changed field', v1a.rules[0].failedOn.length === 1 && v1a.rules[0].failedOn[0].field === 'last' && v1a.rules[0].sunkBy.length === 1 && v1a.rules[0].sunkBy[0] === 'last', v1a.rules[0]);
  check('a case change plus a date shift loses both comparisons of the exact rule, and the case change loses Jaro-Winkler too', !v1b.rules[0].passed && v1b.rules[0].failedOn.length === 2 && v1b.rules[0].sunkBy.length === 2 && !v1b.rules[1].passed && !v1b.caught, v1b);
  check('a blanked zip loses the fuzzy rule and is lost altogether', !v2a.rules[1].passed && v2a.rules[0].passed === true && v2a.caught === true, v2a);
  check('per-rule totals', au.byRule[0].caught === 1 && au.byRule[0].lost === 2 && au.byRule[1].caught === 1 && au.byRule[1].lost === 2, au.byRule);
  check('rollup by kind', au.byRule[0].byKind.typo.lost === 1 && au.byRule[1].byKind.typo.caught === 1 && au.byRule[1].byKind.case.lost === 1 && au.byRule[1].byKind.blanked.lost === 1, au.byRule.map(r => r.byKind));
  check('rollup by field', au.byRule[0].byField.last.lost === 2 && au.byRule[0].byField.dob.lost === 1 && au.byRule[1].byField.zip.lost === 1, au.byRule.map(r => r.byField));
  check('kinds and fields present are listed in a stable order', JSON.stringify(au.kinds) === JSON.stringify(['case', 'typo', 'date', 'blanked']) && JSON.stringify(au.fields) === JSON.stringify(['dob', 'last', 'zip']), [au.kinds, au.fields]);
  check('caught and lost counts over variants', au.caught === 2 && au.lost === 1);
  check('a variant with two changes of one kind counts once in that column', (() => {
    const by = new Map([['o', { id: 'o', last: 'Durgan', dob: '1972-04-09', zip: '64093' }], ['v', { id: 'v', last: 'Duqan', dob: '1972-04-09', zip: '64098' }]]);
    const a = M.auditVariants(rules, by, [{ id: 'v', originalId: 'o', changes: [{ field: 'last', from: 'Durgan', to: 'Duqan', kind: 'typo' }, { field: 'zip', from: '64093', to: '64098', kind: 'typo' }] }]);
    return a.byRule[0].byKind.typo.lost === 1 && a.byRule[0].byField.last.lost === 1 && a.byRule[0].byField.zip.lost === 1;
  })());
}

console.log('=== 7h. what if the generator hit this field ===');
{
  const rec = { id: '1', last: 'Durgan', dob: '1972-04-09', key: 'DURGAN19720409' };
  const rules = [
    { name: 'Exact surname and dob', confidence: '1', blankAgrees: false, comparisons: [{ field: 'last', kind: 'exact', arg: '' }, { field: 'dob', kind: 'exact', arg: '' }] },
    { name: 'Fuzzy surname', confidence: '0.9', blankAgrees: false, comparisons: [{ field: 'last', kind: 'jw', arg: '0.85' }, { field: 'dob', kind: 'exact', arg: '' }] },
    { name: 'Derived key', confidence: '0.8', blankAgrees: false, comparisons: [{ field: 'key', kind: 'exact', arg: '' }] }
  ];
  /* a deterministic stand-in for the generator: cycles through four outcomes */
  const cycle = ['DURGAN', 'Duqan', 'Durgan', 'Dxrgxn'];
  let n = 0;
  const damage = () => cycle[n++ % cycle.length];
  const derive = r => ({ ...r, key: String(r.last).toUpperCase() + String(r.dob).replace(/-/g, '') });
  const w = M.whatIf(rules, rec, 'last', damage, { samples: 8, derive });
  check('outcomes are grouped and counted', w.samples === 8 && w.distinct === 4 && w.outcomes.every(o => o.count === 2), w.outcomes.map(o => [o.value, o.count]));
  const by = Object.fromEntries(w.outcomes.map(o => [o.value, o]));
  check('each outcome is labelled', by.DURGAN.kind === 'case' && by.Duqan.kind === 'typo' && by.Durgan.kind === null && by.Dxrgxn.kind === 'typo', w.outcomes.map(o => [o.value, o.kind]));
  check('the exact rule survives only the unchanged draw', by.Durgan.rules[0].passed && !by.DURGAN.rules[0].passed && !by.Duqan.rules[0].passed);
  check('the failing comparison is reported with what it measured', by.Duqan.rules[1].failedOn.length === 0 && by.DURGAN.rules[1].failedOn[0].field === 'last' && typeof by.DURGAN.rules[1].failedOn[0].measured === 'number', by.DURGAN.rules[1]);
  check('derive lets a rule on a formula key see the key it would become', !by.Duqan.rules[2].passed && by.Durgan.rules[2].passed);
  check('per-rule survival is summed over draws', w.byRule[0].survived === 2 && w.byRule[0].rate === 0.25 && w.byRule[1].survived === 4 && w.byRule[2].survived === 4, w.byRule);
  check('outcomes come most frequent first', (() => { n = 0; const w2 = M.whatIf(rules, rec, 'last', () => (n++ % 3 ? 'Durgan' : 'Duqan'), { samples: 9 }); return w2.outcomes[0].value === 'Durgan' && w2.outcomes[0].count === 6; })());
  check('a blank draw is an outcome too', (() => { const w3 = M.whatIf(rules, rec, 'last', () => '', { samples: 3 }); return w3.outcomes[0].value === '' && w3.outcomes[0].kind === 'blanked' && !w3.outcomes[0].rules[0].passed; })());
  check('nested fields work through dot paths', (() => { const r2 = { id: '1', address: { zip: '64093' } }; const w4 = M.whatIf([{ name: 'z', confidence: '1', blankAgrees: false, comparisons: [{ field: 'address.zip', kind: 'exact', arg: '' }] }], r2, 'address.zip', () => '64098', { samples: 2 }); return w4.original === '64093' && w4.outcomes[0].kind === 'digits' && !w4.outcomes[0].rules[0].passed; })());
}

console.log('=== 7c. a scorer as a file ===');
{
  const state = { entity: 'Patients', idField: 'seq', blockField: 'zip', mode: 'simulate', closeTransitively: false, autoMerge: 0.9, reviewFloor: 0.7,
    rules: [{ name: 'A', confidence: 0.99, blankAgrees: true, comparisons: [{ field: 'last', kind: 'jw', arg: 0.85 }, { field: 'dob', kind: 'exact' }] }] };
  const doc = M.scorerDocument(state);
  check('the document is marked as a scorer with a version', doc.kind === 'scorer' && doc.version === M.SCORER_VERSION);
  check('numbers become the strings the rule builder stores', doc.rules[0].confidence === '0.99' && doc.rules[0].comparisons[0].arg === '0.85', doc.rules[0]);
  const back = M.normalizeScorer(JSON.parse(JSON.stringify(doc)), ['seq', 'last', 'dob', 'zip']);
  check('a round trip is clean', back.ok && back.warnings.length === 0 && back.scorer.rules.length === 1 && back.scorer.blockField === 'zip' && back.scorer.closeTransitively === false, back);
  check('bands survive', back.scorer.autoMerge === 0.9 && back.scorer.reviewFloor === 0.7);
  const other = M.normalizeScorer(doc, ['id', 'surname']);
  check('fields the target entity lacks are warned about, not fatal', other.ok && other.warnings.length >= 3 && other.scorer.idField === '' && other.scorer.blockField === '', other.warnings);
  check('a missing arg falls back to the comparison default', M.normalizeScorer({ rules: [{ comparisons: [{ field: 'x', kind: 'jw' }] }] }).scorer.rules[0].comparisons[0].arg === '0.90');
  check('a mode is inferred from the rules when absent', M.normalizeScorer({ rules: [{ comparisons: [{ field: 'x', kind: 'exact' }] }] }).scorer.mode === 'simulate' && M.normalizeScorer({ rules: [] }).scorer.mode === 'paste');
  check('a review floor above auto-merge is reset with a warning', (() => { const r = M.normalizeScorer({ rules: [], autoMerge: 0.5, reviewFloor: 0.9 }); return r.ok && r.scorer.autoMerge === 0.92 && r.warnings.length === 1; })());
  check('a schema file is refused with a pointer to Import schema', /Import schema/.test(M.normalizeScorer({ version: 2, entities: [] }).error));
  check('the wrong kind is refused', /not a scorer/.test(M.normalizeScorer({ kind: 'schema', rules: [] }).error));
  check('an array is refused', !M.normalizeScorer([1, 2]).ok);
  check('an unknown comparison kind is fatal and named', throws(() => M.normalizeScorer({ rules: [{ name: 'q', comparisons: [{ field: 'x', kind: 'nope' }] }] }), /rule 1 "q".*unknown comparison "nope"/));
}

console.log('=== 7d. a matcher as a file ===');
{
  const rules = [{ name: 'Name and dob', confidence: 1, blankAgrees: false, comparisons: [{ field: 'last', kind: 'jw', arg: 0.85 }, { field: 'dob', kind: 'exact' }] },
    { name: 'Email', confidence: '0.95', blankAgrees: false, comparisons: [{ field: 'email', kind: 'normalized' }] }];
  const doc = M.matcherDocument({ entity: 'Patients', rules });
  check('the document is marked as a matcher with a version and carries only the rules', doc.kind === 'matcher' && doc.version === M.MATCHER_VERSION && doc.entity === 'Patients' && doc.rules.length === 2 && !('autoMerge' in doc) && !('idField' in doc), doc);
  const back = M.normalizeMatcher(JSON.parse(JSON.stringify(doc)), ['last', 'dob', 'email']);
  check('a round trip is clean', back.ok && back.kind === 'matcher' && back.warnings.length === 0 && back.matcher.rules.length === 2 && back.matcher.rules[0].confidence === '1' && back.matcher.rules[0].comparisons[0].arg === '0.85', back);
  check('the link policy travels in a matcher file and defaults to "all"', back.matcher.linkPolicy === 'all' && M.matcherDocument({ entity: 'P', rules, linkPolicy: 'best' }).linkPolicy === 'best'
    && M.normalizeMatcher({ kind: 'matcher', rules: [], linkPolicy: 'best' }).matcher.linkPolicy === 'best');
  check('an unknown link policy is a warning, not a refusal', (() => { const r = M.normalizeMatcher({ kind: 'matcher', rules: [], linkPolicy: 'mutual' }); return r.ok && r.matcher.linkPolicy === 'all' && /unknown link policy/.test(r.warnings.join(' ')); })());
  check('the link policy travels in a scorer file too', M.normalizeScorer(M.scorerDocument({ entity: 'P', rules, linkPolicy: 'best' })).scorer.linkPolicy === 'best');
  check('the rules run as they did before the trip', (() => {
    const a = M.runMatcher(RECS, rules, { idField: 'id' }), b = M.runMatcher(RECS, back.matcher.rules, { idField: 'id' });
    return JSON.stringify(a.pairs) === JSON.stringify(b.pairs);
  })());
  const other = M.normalizeMatcher(doc, ['surname', 'birth']);
  check('fields the entity lacks are warned about, not fatal', other.ok && other.warnings.length === 3, other.warnings);
  const fromScorer = M.normalizeMatcher(M.scorerDocument({ entity: 'P', idField: 'seq', rules }), ['last', 'dob', 'email']);
  check('a scorer file opens as a matcher: its rules, with a note', fromScorer.ok && fromScorer.kind === 'scorer' && fromScorer.matcher.rules.length === 2 && /scorer file/.test(fromScorer.warnings.join(' ')), fromScorer);
  const asScorer = M.normalizeScorer(doc, ['last', 'dob', 'email']);
  check('a matcher file opens as a scorer: its rules, defaults elsewhere, with a note', asScorer.ok && asScorer.kind === 'matcher' && asScorer.scorer.rules.length === 2 && asScorer.scorer.mode === 'simulate' && asScorer.scorer.autoMerge === 0.92 && /matcher file/.test(asScorer.warnings.join(' ')), asScorer);
  check('a schema file is refused with a pointer to Import schema', /Import schema/.test(M.normalizeMatcher({ version: 2, entities: [] }).error));
  check('the wrong kind is refused and names Save matcher', /not a matcher.*Save matcher/.test(M.normalizeMatcher({ kind: 'schema', rules: [] }).error));
  check('no rules array is refused', /rules array/.test(M.normalizeMatcher({ kind: 'matcher' }).error));
  check('an unknown comparison kind is fatal and named', throws(() => M.normalizeMatcher({ kind: 'matcher', rules: [{ comparisons: [{ field: 'x', kind: 'nope' }] }] }), /rule 1: unknown comparison "nope"/));
}

console.log('=== 7e. the prompt for an AI, and MATCHER.md ===');
{
  const info = { entity: 'Patients', dupLevel: 'targeted', dupPct: '25', dupMax: '3', idField: 'seq',
    fields: [{ name: 'seq', type: 'Row Number' }, { name: 'patient_id', type: 'UUID' }, { name: 'last_name', type: 'Last Name', sim: { algo: 'jw', target: '0.84' } },
      { name: 'birth_date', type: 'Date', sim: { algo: 'lev', target: '0.90' } }, { name: 'address.state', type: 'State Abbr' }, { name: 'full_name', type: 'Formula (JS)' }] };
  const prompt = M.matcherPrompt(info);
  check('the prompt names the entity and its duplicate settings', /Entity: Patients \(targeted, 25% of records get up to 3/.test(prompt));
  check('every field is listed with what a duplicate does to it', /seq \(Row Number\) — unique per row/.test(prompt) && /patient_id \(UUID\) — regenerated/.test(prompt)
    && /last_name \(Last Name\) — fuzzed in duplicates until Jaro-Winkler similarity to the original is about 0\.84/.test(prompt)
    && /birth_date \(Date\) — fuzzed in duplicates until Levenshtein/.test(prompt) && /address\.state \(State Abbr\) — copied unchanged/.test(prompt) && /full_name \(Formula \(JS\)\) — recomputed for every duplicate/.test(prompt), prompt);
  check('every comparison kind is documented in the prompt', M.COMPARISONS.every(c => prompt.includes('- ' + c.id + ' — ')));
  check('the prompt explains the link policy', /linkPolicy.*"best" matches each record to its single best candidate/.test(prompt));
  check('the kinds that take an arg state its default', M.COMPARISONS.filter(c => c.arg).every(c => prompt.includes('- ' + c.id + ' — arg: ' + c.argLabel + ' (default "' + c.argDefault + '")')));
  check('the example in the prompt is itself a valid matcher file', (() => { const j = prompt.slice(prompt.indexOf('{'), prompt.indexOf('\n## Semantics')); const r = M.normalizeMatcher(JSON.parse(j), ['last_name', 'birth_date']); return r.ok && r.warnings.length === 0; })());
  check('a kept field is described as the thing variants agree on', /last_name \(Last Name\) — marked keep in dups/.test(M.matcherPrompt({ entity: 'x', dupLevel: 'heavy', fields: [{ name: 'last_name', type: 'Last Name', keep: true }] })));
  check('preset modes and pasted columns get sensible notes', /preset heavy damage/.test(M.matcherPrompt({ entity: 'x', dupLevel: 'heavy', fields: [{ name: 'a', type: 'City' }] }))
    && /^- col$/m.test(M.matcherPrompt({ entity: 'x', dupLevel: '', fields: [{ name: 'col' }] })) && /duplicates are off/.test(M.matcherPrompt({ entity: 'x', fields: [] })));
  const md = fs.readFileSync(new URL('../MATCHER.md', import.meta.url), 'utf8');
  check('MATCHER.md documents every comparison kind with its default', M.COMPARISONS.every(c => md.includes('| `' + c.id + '` |') && (!c.arg || md.includes('default `"' + c.argDefault + '"`'))));
  check('MATCHER.md documents the link policy', /## Which record a record matches to/.test(md) && /"linkPolicy": "best"/.test(md));
  const blocks = [...md.matchAll(/```json\n([\s\S]*?)```/g)].map(m => m[1]).filter(b => /"kind": "matcher"/.test(b) && !/\/\//.test(b));
  check('the complete example in MATCHER.md imports cleanly against the fields it names', blocks.length === 1 && (() => {
    const r = M.normalizeMatcher(JSON.parse(blocks[0]), ['address.state', 'last_name', 'birth_date', 'email', 'first_name', 'address.zip']);
    return r.ok && r.warnings.length === 0 && r.matcher.rules.length === 3;
  })());
}

{
  const md = fs.readFileSync(new URL('../MATCHER.md', import.meta.url), 'utf8');
  const docs = fs.readFileSync(new URL('../docs.html', import.meta.url), 'utf8');
  const unescape = h => h.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const block = id => { const m = docs.match(new RegExp('<pre id="' + id + '"[^>]*><code>([\\s\\S]*?)</code></pre>')); return m ? unescape(m[1]) : null; };
  check('docs.html carries MATCHER.md verbatim', block('matcher-spec-block') === md.replace(/\n+$/, ''), (block('matcher-spec-block') || '').slice(0, 80));
  const promptInMd = (md.match(/```text\n([\s\S]*?)```/) || [])[1];
  check('docs.html carries the prompt from MATCHER.md', promptInMd && block('matcher-prompt-block') === promptInMd.replace(/\n+$/, ''));
  check('the docs page links the card from its navigation', /href="#matcher-spec">Matcher spec</.test(docs));
}

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
