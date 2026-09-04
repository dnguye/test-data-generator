/* Workbook suite. Run with: node tests/xlsx.mjs

   Every workbook is opened by openpyxl -- an independent reader -- so the
   parts, the sheet names, the cell values and types, the header style and the
   frozen pane are checked by something other than the code that wrote them. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { xlsxFiles, sheetName, colLetters } from '../xlsx.js';

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.log('  FAIL:', name, extra === undefined ? '' : String(extra).slice(0, 300)); }
};
const throws = async (fn, re) => { try { await fn(); return false; } catch (e) { return re ? re.test(e.message) : true; } };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdg-xlsx-'));
function inspect(bytes, label) {
  const file = path.join(dir, label + '.xlsx');
  fs.writeFileSync(file, bytes);
  const py = `
import json, openpyxl
wb = openpyxl.load_workbook(${JSON.stringify(file)})
out = {"sheets": wb.sheetnames, "data": {}, "bold": {}, "frozen": {}, "fmt": {}, "font": {}, "widths": {}}
for ws in wb.worksheets:
    out["data"][ws.title] = [[c.value for c in row] for row in ws.iter_rows()]
    out["bold"][ws.title] = [bool(c.font.bold) for c in ws[1]]
    out["frozen"][ws.title] = ws.freeze_panes
    out["fmt"][ws.title] = [[c.number_format for c in row] for row in ws.iter_rows()]
    out["font"][ws.title] = ws["A1"].font.name
    out["widths"][ws.title] = {k: v.width for k, v in ws.column_dimensions.items()}
print(json.dumps(out, default=str))`;
  return JSON.parse(execFileSync('python3', ['-c', py], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
}

console.log('=== 1. helpers ===');
check('column letters', colLetters(0) === 'A' && colLetters(25) === 'Z' && colLetters(26) === 'AA' && colLetters(701) === 'ZZ' && colLetters(702) === 'AAA');
const taken = new Set();
check('sheet names are cleaned of forbidden characters', sheetName('By rule: [over/under]?*', taken, 0) === 'By rule over under');
check('a duplicate name (any case) gets a suffix', sheetName('by RULE over under', taken, 1) === 'by RULE over under (2)');
check('an empty name falls back to a numbered one', sheetName('', new Set(), 4) === 'Sheet5');
check('a long name is cut to 31', sheetName('a'.repeat(50), new Set(), 0).length === 31);

console.log('=== 2. a workbook read back by openpyxl ===');
const sheets = [
  { name: 'Summary', rows: [['metric', 'value'], ['records', 146], ['precision', { v: 0.9559, pct: true }], ['closed transitively', true], ['note', 'seed 42 · Patients']] },
  { name: 'Missed matches', rows: [['record a', 'record b', 'failed on'], ['101', '130', 'last_name (0.833 < 0.88)'], ['2', '93', '']] },
  { name: 'Empty', rows: [] }
];
let got = inspect(await xlsxFiles(sheets), 'basic');
check('three sheets in order', JSON.stringify(got.sheets) === JSON.stringify(['Summary', 'Missed matches', 'Empty']), got.sheets);
const sm = got.data['Summary'];
check('strings round trip', sm[0][0] === 'metric' && sm[4][1] === 'seed 42 · Patients', sm);
check('numbers are numbers', sm[1][1] === 146 && typeof sm[1][1] === 'number', sm[1]);
check('a fraction flagged pct keeps its value and gets a percent format', sm[2][1] === 0.9559 && got.fmt['Summary'][2][1] === '0.00%', [sm[2], got.fmt['Summary'][2]]);
check('booleans are booleans', sm[3][1] === true, sm[3]);
check('header row is bold', got.bold['Summary'].every(Boolean), got.bold);
check('font is a professional face', got.font['Summary'] === 'Arial', got.font);
check('header row is frozen', got.frozen['Summary'] === 'A2', got.frozen);
check('ids that look numeric stay text when passed as strings', got.data['Missed matches'][1][0] === '101' && typeof got.data['Missed matches'][1][0] === 'string');
check('an empty string is an empty cell', got.data['Missed matches'][2][2] === null, got.data['Missed matches'][2]);
check('an empty sheet still opens', got.data['Empty'][0][0] === '(empty)');
check('column widths are set from content', Object.keys(got.widths['Missed matches']).length >= 3, got.widths);

console.log('=== 3. awkward content ===');
/* control characters written as escapes: XML 1.0 forbids them and the dirty
   generators emit a few on purpose, so the writer has to drop them */
const bell = 'zero\u200Bwidth\u0007bell\u0000nul';
got = inspect(await xlsxFiles([{ name: 'Odd', rows: [['h'], ['<b>&"quotes"</b>'], ['tab\there'], [bell], ['Björk 日本語'], [Number.NaN], [Infinity], [null], [undefined], [new Date('2026-09-04T00:00:00Z')]] }]), 'odd');
const odd = got.data['Odd'].map(r => r[0]);
check('markup is escaped, not interpreted', odd[1] === '<b>&"quotes"</b>', odd[1]);
check('a tab survives', odd[2] === 'tab\there', JSON.stringify(odd[2]));
check('illegal control characters are dropped, zero-width space (legal) is kept', odd[3] === 'zero\u200Bwidthbellnul', JSON.stringify(odd[3]));
check('unicode survives', odd[4] === 'Björk 日本語', odd[4]);
check('NaN and Infinity become text rather than a broken number cell', odd[5] === 'NaN' && odd[6] === 'Infinity', [odd[5], odd[6]]);
check('null and undefined are empty cells', odd[7] === null && odd[8] === null);
check('a Date is written as an ISO string', odd[9] === '2026-09-04T00:00:00.000Z', odd[9]);

console.log('=== 4. shape and limits ===');
check('no sheets is refused', await throws(() => xlsxFiles([]), /at least one sheet/));
const wide = [{ name: 'Wide', rows: [Array.from({ length: 30 }, (_, i) => 'c' + i), Array.from({ length: 30 }, (_, i) => i)] }];
got = inspect(await xlsxFiles(wide), 'wide');
check('30 columns land in AD', got.data['Wide'][0][29] === 'c29' && got.data['Wide'][1][29] === 29);
const tall = [{ name: 'Tall', rows: [['n'], ...Array.from({ length: 5000 }, (_, i) => [i])] }];
got = inspect(await xlsxFiles(tall), 'tall');
check('5,000 rows round trip', got.data['Tall'].length === 5001 && got.data['Tall'][5000][0] === 4999);
const a = await xlsxFiles(sheets, { date: new Date(2026, 8, 4) }), b = await xlsxFiles(sheets, { date: new Date(2026, 8, 4) });
check('same sheets and date give a byte-identical file', Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0);
check('duplicate sheet names are made unique rather than refused', JSON.stringify(inspect(await xlsxFiles([{ name: 'x', rows: [[1]] }, { name: 'X', rows: [[2]] }]), 'dup').sheets) === JSON.stringify(['x', 'X (2)']));

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
