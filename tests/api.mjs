/* API suite. Run with: node tests/api.mjs
   Starts the real server on an ephemeral port against an in-memory store. */
import { createServer } from '../api/server.mjs';
import { MemoryStore } from '../api/store.mjs';
import { loadFaker } from '../api/faker-node.mjs';
import * as E from '../engine.js';

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.log('  FAIL:', name, extra === undefined ? '' : JSON.stringify(extra).slice(0, 300)); }
};

const store = new MemoryStore();
const { server, api } = createServer({ store });
await api.pool.start();
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port;

const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })
  .then(async r => [r.status, await r.json()]);
const get = p => fetch(base + p).then(async r => [r.status, await r.json()]);

const PEOPLE = { version: 2, entities: [{ name: 'People', rows: '25', fields: [
  { name: 'id', type: 'Row Number' }, { name: 'name', type: 'Full Name' },
  { name: 'email', type: 'Email' }, { name: 'score', type: 'Number', opts: { min: '1', max: '999' } }] }] };

const LINKED = { version: 2, active: 1, entities: [
  { name: 'Accounts', rows: '5', fields: [{ name: 'id', type: 'UUID' }, { name: 'nm', type: 'Company' }] },
  { name: 'Contacts', rows: '12', fields: [{ name: 'n', type: 'Full Name' }, { name: 'acc', type: 'Reference', opts: { entity: 'Accounts', field: 'id' } }] }] };

console.log('=== 1. register and generate ===');
let [s, reg] = await post('/v1/schemas', PEOPLE);
check('register returns 201', s === 201, [s, reg]);
check('id is 32 chars', /^[0-9A-HJKMNP-TV-Z]{32}$/.test(reg.schemaId || ''), reg.schemaId);
const ID = reg.schemaId;

let [gs, g] = await post('/v1/generate', { schemaId: ID, count: 10, seed: 4242 });
check('generate returns 200', gs === 200, [gs, g]);
check('returns exactly count rows', g.entities[0].records.length === 10, g.entities && g.entities[0].rows);
check('echoes the resolved count', g.count.People === 10, g.count);
check('echoes the seed', g.seed === 4242, g.seed);
check('reports it was seeded', g.seeded === true);
check('no warnings for a clean schema', g.warnings.length === 0, g.warnings);

console.log('=== 2. reproducibility: the whole point ===');
const [, again] = await post('/v1/generate', { schemaId: ID, count: 10, seed: 4242 });
check('same (schemaId,count,seed) gives the same fingerprint', g.fingerprint === again.fingerprint);
check('same (schemaId,count,seed) gives byte-identical rows',
  JSON.stringify(g.entities) === JSON.stringify(again.entities));

const [, otherSeed] = await post('/v1/generate', { schemaId: ID, count: 10, seed: 4243 });
check('a different seed gives different data', otherSeed.fingerprint !== g.fingerprint);

/* The rule the API documents: a seed alone does not pin the output -- the row
   count is half of the identity, so changing it changes every row. */
const [, otherCount] = await post('/v1/generate', { schemaId: ID, count: 11, seed: 4242 });
check('same seed with a different count is a different result', otherCount.fingerprint !== g.fingerprint);
check('...but is itself reproducible',
  otherCount.fingerprint === (await post('/v1/generate', { schemaId: ID, count: 11, seed: 4242 }))[1].fingerprint);

const [, unseeded1] = await post('/v1/generate', { schemaId: ID, count: 5 });
const [, unseeded2] = await post('/v1/generate', { schemaId: ID, count: 5 });
check('omitting the seed gives a fresh run each time', unseeded1.fingerprint !== unseeded2.fingerprint);
check('the generated seed is reported back', Number.isInteger(unseeded1.seed) && unseeded1.seeded === false, unseeded1.seed);
const [, replay] = await post('/v1/generate', { schemaId: ID, count: 5, seed: unseeded1.seed });
check('replaying the reported seed reproduces the unseeded run', replay.fingerprint === unseeded1.fingerprint);

console.log('=== 3. the API adds no divergence over engine.js ===');
E.useFaker(loadFaker().faker);
const stored = (await get('/v1/schemas/' + ID))[1].schema;
const direct = E.runAll(stored.entities, () => 10, 4242);
check('direct engine run matches the API row for row',
  JSON.stringify(E.rowsToObjects(direct.results[0].rows)) === JSON.stringify(g.entities[0].records));

console.log('=== 4. seed validation ===');
for (const [label, seed] of [['a decimal', 1.5], ['a negative', -1], ['past int32', 2147483648], ['a word', 'abc']]) {
  const [st, body] = await post('/v1/generate', { schemaId: ID, count: 2, seed });
  check('rejects ' + label + ' seed', st === 400 && body.error.code === 'invalid_seed', [st, body.error && body.error.code]);
}
check('seed 0 is allowed', (await post('/v1/generate', { schemaId: ID, count: 2, seed: 0 }))[0] === 200);

console.log('=== 5. count validation ===');
for (const [label, count, code] of [
  ['missing count', undefined, 'invalid_count'],
  ['zero', 0, 'invalid_count'],
  ['over the ceiling', 10001, 'invalid_count'],
  ['a decimal', 2.5, 'invalid_count']]) {
  const [st, body] = await post('/v1/generate', { schemaId: ID, count, seed: 1 });
  check('rejects ' + label, st === 400 && body.error.code === code, [st, body.error]);
}

console.log('=== 6. multi-entity schemas ===');
const [ls, lreg] = await post('/v1/schemas', LINKED);
check('linked schema registers', ls === 201, [ls, lreg]);
const [bs, bbody] = await post('/v1/generate', { schemaId: lreg.schemaId, count: 10, seed: 1 });
check('a bare number is refused when several entities could mean it', bs === 400 && bbody.error.code === 'invalid_count', bbody.error);
check('...and the message names the entities', /Accounts/.test(bbody.error.message), bbody.error.message);

const [ms, mg] = await post('/v1/generate', { schemaId: lreg.schemaId, count: { Accounts: 4, Contacts: 9 }, seed: 1 });
check('per-entity counts are accepted', ms === 200, [ms, mg.error]);
check('each entity honours its own count', mg.entities[0].rows === 4 && mg.entities[1].rows === 9, mg.entities.map(e => e.rows));
check('references resolved (no #REF)', !JSON.stringify(mg.entities[1].records).includes('#REF'));
check('every contact points at a real account', (() => {
  const ids = new Set(mg.entities[0].records.map(r => r.id));
  return mg.entities[1].records.every(r => ids.has(r.acc));
})());
const [, partial] = await post('/v1/generate', { schemaId: lreg.schemaId, count: { Contacts: 3 }, seed: 1 });
check('unmentioned entities fall back to the stored row count', partial.count.Accounts === 5, partial.count);
const [us, ub] = await post('/v1/generate', { schemaId: lreg.schemaId, count: { Nope: 3 }, seed: 1 });
check('an unknown entity name is rejected', us === 400 && /Nope/.test(ub.error.message), ub.error);

console.log('=== 7. schema validation at registration ===');
const cases = [
  ['forward reference', { entities: [
    { name: 'A', fields: [{ name: 'x', type: 'Reference', opts: { entity: 'B', field: 'y' } }] },
    { name: 'B', fields: [{ name: 'y', type: 'UUID' }] }] }],
  ['unknown type', { entities: [{ name: 'A', fields: [{ name: 'x', type: 'Nope' }] }] }],
  ['unparseable formula', { entities: [{ name: 'A', fields: [{ name: 'x', type: 'Formula (JS)', opts: { expr: '1 +' } }] }] }],
  ['unknown faker method', { entities: [{ name: 'A', fields: [{ name: 'x', type: 'Faker (any)', opts: { method: 'no.such.method' } }] }] }],
  ['no entities', { entities: [] }],
  ['duplicate entity names', { entities: [
    { name: 'A', fields: [{ name: 'x', type: 'UUID' }] }, { name: 'A', fields: [{ name: 'y', type: 'UUID' }] }] }]
];
for (const [label, doc] of cases) {
  const [st, body] = await post('/v1/schemas', doc);
  check('rejects ' + label, st === 400 && body.error.code === 'invalid_schema', [st, body.error]);
  check('...names the offending field for ' + label, typeof (body.error || {}).field === 'string', body.error);
}

console.log('=== 8. unknown and malformed ids ===');
check('unknown id is 404', (await post('/v1/generate', { schemaId: 'Z'.repeat(32), count: 1 }))[0] === 404);
check('malformed id is 400', (await post('/v1/generate', { schemaId: 'nope', count: 1 }))[0] === 400);
check('missing id is 400', (await post('/v1/generate', { count: 1 }))[0] === 400);
check('ids survive a sloppy copy/paste',
  (await post('/v1/generate', { schemaId: ID.toLowerCase().slice(0, 8) + '-' + ID.slice(8), count: 2, seed: 1 }))[0] === 200);

console.log('=== 9. formulas run without reach into the host ===');
const [, secret] = await post('/v1/schemas', { entities: [{ name: 'S', rows: '1', fields: [
  { name: 'env', type: 'Formula (JS)', opts: { expr: 'JSON.stringify(process.env)' } },
  { name: 'esc', type: 'Formula (JS)', opts: { expr: "String((function(){}).constructor('return typeof process.env.TDG_TEST_SECRET')())" } }] }] });
const [, leaked] = await post('/v1/generate', { schemaId: secret.schemaId, count: 1, seed: 1 });
check('process.env is empty inside a formula', leaked.entities[0].records[0].env === '{}', leaked.entities[0].records[0]);
check('a constructor escape still finds nothing', leaked.entities[0].records[0].esc === 'undefined', leaked.entities[0].records[0]);

console.log('=== 10. duplicate-injecting schemas are flagged ===');
const [, dup] = await post('/v1/schemas', { entities: [{ name: 'D', rows: '10', dupLevel: 'medium', dupPct: '40',
  fields: [{ name: 'n', type: 'Full Name' }, { name: 'e', type: 'Email' }] }] });
check('registration reports hasDuplicates', dup.hasDuplicates === true, dup);
const [, dg] = await post('/v1/generate', { schemaId: dup.schemaId, count: 10, seed: 5 });
check('more rows come back than were requested', dg.entities[0].rows > 10, dg.entities[0]);
check('the caller is warned about it', dg.warnings.some(w => /duplicate/i.test(w)), dg.warnings);
check('still reproducible', dg.fingerprint === (await post('/v1/generate', { schemaId: dup.schemaId, count: 10, seed: 5 }))[1].fingerprint);

console.log('=== 11. formats ===');
for (const fmt of ['csv', 'xml']) {
  const [st, body] = await post('/v1/generate', { schemaId: ID, count: 3, seed: 9, format: fmt });
  check(fmt + ' returns a body string', st === 200 && typeof body.entities[0].body === 'string', [st, body.error]);
  check(fmt + ' fingerprint matches the json run for the same seed',
    body.fingerprint === (await post('/v1/generate', { schemaId: ID, count: 3, seed: 9 }))[1].fingerprint);
}
check('csv has a header row plus 3 records',
  (await post('/v1/generate', { schemaId: ID, count: 3, seed: 9, format: 'csv' }))[1].entities[0].body.trim().split('\n').length === 4);
check('bad format is rejected', (await post('/v1/generate', { schemaId: ID, count: 1, format: 'yaml' }))[0] === 400);

console.log('=== 12. immutability and retrieval ===');
const [rs, rbody] = await get('/v1/schemas/' + ID);
check('a holder can read the schema back', rs === 200 && rbody.schema.entities[0].fields.length === 4, [rs, rbody]);
check('reading an unknown id is 404', (await get('/v1/schemas/' + 'Y'.repeat(32)))[0] === 404);
const [, reg2] = await post('/v1/schemas', PEOPLE);
check('registering the same schema twice gives a different id', reg2.schemaId !== ID, [ID, reg2.schemaId]);

console.log('=== 13. transport ===');
check('unknown route is 404', (await get('/v1/nope'))[0] === 404);
check('GET on generate is 405', (await get('/v1/generate'))[0] === 405);
const badJson = await fetch(base + '/v1/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
check('malformed JSON is 400', badJson.status === 400);
const preflight = await fetch(base + '/v1/generate', { method: 'OPTIONS' });
check('CORS preflight answers', preflight.status === 204 && preflight.headers.get('access-control-allow-origin') === '*');
const big = await fetch(base + '/v1/schemas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(300 * 1024) });
check('an oversized body is refused', big.status === 413, big.status);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
api.pool.stop();
server.close();
process.exit(fail ? 1 : 0);
