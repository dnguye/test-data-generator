/* Archive suite. Run with: node tests/zip.mjs

   The archives are checked by Python's zipfile module rather than by the
   writer that produced them -- an independent implementation verifying the
   CRCs, the central directory and the extracted bytes. A zip that only its
   own author can read is not a zip. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipFiles, crc32, uniqueEntryName, cleanName } from '../zip.js';

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.log('  FAIL:', name, extra === undefined ? '' : String(extra).slice(0, 300)); }
};
const throws = async (fn, re) => { try { await fn(); return false; } catch (e) { return re ? re.test(e.message) : true; } };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdg-zip-'));
/* Hand the archive to Python and get back what it makes of it. testzip()
   returns the first entry whose CRC does not match its data, or None. */
function inspect(bytes, label) {
  const file = path.join(dir, label + '.zip');
  fs.writeFileSync(file, bytes);
  const py = `
import json, zipfile
z = zipfile.ZipFile(${JSON.stringify(file)})
bad = z.testzip()
print(json.dumps({
  "bad": bad,
  "names": z.namelist(),
  "methods": sorted({i.compress_type for i in z.infolist()}),
  "contents": {i.filename: z.read(i.filename).decode("utf-8") for i in z.infolist()},
  "sizes": {i.filename: [i.file_size, i.compress_size] for i in z.infolist()},
  "dates": {i.filename: list(i.date_time) for i in z.infolist()},
}))`;
  return JSON.parse(execFileSync('python3', ['-c', py], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
}

console.log('=== 1. CRC-32 ===');
check('the standard check value ("123456789" is 0xCBF43926)', crc32(new TextEncoder().encode('123456789')) === 0xCBF43926, crc32(new TextEncoder().encode('123456789')).toString(16));
check('empty input is 0', crc32(new Uint8Array(0)) === 0);

console.log('=== 2. a plain archive, read back by Python ===');
const FILES = [
  { name: 'accounts.csv', text: 'id,name\n1,Acme\n2,Globex\n' },
  { name: 'contacts.csv', text: 'id,account_id,name\n7,1,"Ann, Jr"\n8,2,Bob\n' },
  { name: 'schema.json', text: JSON.stringify({ version: 2, entities: [{ name: 'Accounts' }] }, null, 2) }
];
let z = await zipFiles(FILES);
let got = inspect(z, 'plain');
check('every CRC checks out', got.bad === null, got.bad);
check('all three entries are present, in order', JSON.stringify(got.names) === JSON.stringify(['accounts.csv', 'contacts.csv', 'schema.json']), got.names);
for (const f of FILES) check('"' + f.name + '" extracts byte for byte', got.contents[f.name] === f.text, JSON.stringify(got.contents[f.name]));
check('the archive starts with the local header signature "PK\\x03\\x04"', z[0] === 0x50 && z[1] === 0x4B && z[2] === 0x03 && z[3] === 0x04);

console.log('=== 3. compression ===');
/* Short, incompressible-ish entries are stored; a long repetitive one is
   deflated. Both have to come back identical either way. */
const BIG = 'first_name,last_name,email\n' + 'Ann,Smith,ann.smith@example.com\n'.repeat(4000);
z = await zipFiles([{ name: 'big.csv', text: BIG }]);
got = inspect(z, 'big');
check('a repetitive entry is deflated (method 8)', got.methods.includes(8), got.methods);
check('...and still extracts identically', got.contents['big.csv'] === BIG);
check('...and the archive is far smaller than the input', z.length < BIG.length / 5, [z.length, BIG.length]);
const stored = await zipFiles([{ name: 'big.csv', text: BIG }], { compress: false });
got = inspect(stored, 'stored');
check('compress:false stores instead (method 0)', JSON.stringify(got.methods) === '[0]', got.methods);
check('...and is still a valid archive with the same bytes', got.bad === null && got.contents['big.csv'] === BIG);
check('...and is bigger than the deflated one', stored.length > z.length, [stored.length, z.length]);

console.log('=== 4. names and encodings ===');
z = await zipFiles([
  { name: 'Björk Guðmundsdóttir.csv', text: 'naïve,café\n' },
  { name: '日本語.json', text: '{"c":"日本語テスト"}' },
  { name: 'nested/dir/file.txt', text: 'deep' }
]);
got = inspect(z, 'unicode');
check('non-Latin entry names survive', got.names.includes('Björk Guðmundsdóttir.csv') && got.names.includes('日本語.json'), got.names);
check('non-Latin content survives', got.contents['日本語.json'] === '{"c":"日本語テスト"}');
check('a nested path is kept as a path', got.names.includes('nested/dir/file.txt'));
check('backslashes become forward slashes', cleanName('a\\b\\c.txt') === 'a/b/c.txt');
check('a leading slash is stripped', cleanName('/etc/passwd') === 'etc/passwd');
check('parent-directory hops are defused', cleanName('../../secret') === '_/_/secret');
check('an empty name is refused', await throws(() => zipFiles([{ name: '', text: 'x' }]), /needs a name/));
check('duplicate names are refused', await throws(() => zipFiles([{ name: 'a.csv', text: '1' }, { name: 'a.csv', text: '2' }]), /both named/));
check('an empty file list is refused', await throws(() => zipFiles([]), /nothing to archive/));

console.log('=== 5. edge content ===');
z = await zipFiles([{ name: 'empty.txt', text: '' }, { name: 'one.txt', text: 'x' }]);
got = inspect(z, 'edges');
check('a zero-byte entry is valid and empty', got.bad === null && got.contents['empty.txt'] === '' && got.sizes['empty.txt'][0] === 0, got.sizes);
check('a one-byte entry round trips', got.contents['one.txt'] === 'x');
z = await zipFiles([{ name: 'raw.bin', bytes: new Uint8Array([104, 105]) }]);
check('raw bytes can be passed instead of text', inspect(z, 'raw').contents['raw.bin'] === 'hi');

console.log('=== 6. timestamps and determinism ===');
const when = new Date(2026, 8, 4, 13, 45, 30);       // 2026-09-04 13:45:30 local
got = inspect(await zipFiles(FILES, { date: when }), 'dated');
check('the entry date is the one given (two-second resolution)',
  JSON.stringify(got.dates['accounts.csv']) === JSON.stringify([2026, 9, 4, 13, 45, 30]), got.dates['accounts.csv']);
const a = await zipFiles(FILES, { date: when }), b = await zipFiles(FILES, { date: when });
check('the same files and date give a byte-identical archive', Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0);
got = inspect(await zipFiles(FILES, { date: new Date(1970, 0, 1) }), 'old');
check('a pre-1980 date is clamped rather than written as garbage', got.bad === null && got.dates['accounts.csv'][0] === 1980, got.dates['accounts.csv']);

console.log('=== 7. entry naming helper ===');
const taken = new Set();
check('first use keeps the plain name', uniqueEntryName('people', 'csv', taken) === 'people.csv');
check('a collision is suffixed', uniqueEntryName('people', 'csv', taken) === 'people-2.csv');
check('and again', uniqueEntryName('people', 'csv', taken) === 'people-3.csv');
check('a different extension does not collide', uniqueEntryName('people', 'json', taken) === 'people.json');

console.log('=== 8. a realistic run: several entities plus the schema ===');
const entities = ['Facilities', 'Payers', 'Providers', 'Patients', 'Encounters'];
const bundle = entities.map(n => ({ name: n.toLowerCase() + '.csv', text: 'id,name\n' + Array.from({ length: 500 }, (_, i) => i + ',' + n + '-' + i).join('\n') + '\n' }));
bundle.push({ name: 'schema.json', text: JSON.stringify({ version: 2, entities: entities.map(n => ({ name: n })) }, null, 2) });
got = inspect(await zipFiles(bundle), 'bundle');
check('six entries, all valid', got.bad === null && got.names.length === 6, got.names);
check('each entity file kept its rows', entities.every(n => got.contents[n.toLowerCase() + '.csv'].trim().split('\n').length === 501));
check('the schema rides along', JSON.parse(got.contents['schema.json']).entities.length === 5);

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
