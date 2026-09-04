/* ---------------------------------------------------------------------------
   xlsx.js -- a minimal Excel workbook writer, so scoring results can leave the
   page as a spreadsheet.

   An .xlsx file is a zip of XML parts, and zip.js already exists, so this is
   the handful of parts Excel needs and nothing it does not: a content-types
   manifest, the package relationships, a workbook listing its sheets, a
   styles part with a bold face for header rows and a percent format, and one
   worksheet part per sheet. Strings are written inline rather than through a
   shared-strings table, which costs a little size and saves a whole part.

   No dependencies, no build step, same as the rest of the repo.

   Cells: a number is a number, a boolean a boolean, null/undefined an empty
   cell, anything else a string. Pass { v: 0.75, pct: true } to store a
   fraction that Excel shows as 75.00%. Dates are best written as ISO strings;
   Excel's serial-date arithmetic is a footgun this writer stays out of.
--------------------------------------------------------------------------- */
"use strict";

import { zipFiles } from "./zip.js";

const FONT = "Arial";
const MAX_SHEET_NAME = 31;

/* XML 1.0 forbids most control characters outright; a value carrying one
   (the dirty-data generators emit a few on purpose) would make the file
   unreadable, so they are dropped rather than escaped. */
const esc = s => String(s)
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/* A1-style column letters: 0 -> A, 25 -> Z, 26 -> AA. */
function colLetters(i) {
  let s = "";
  i = i + 1;
  while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
  return s;
}

/* Excel refuses []:*?/\ in a sheet name, anything over 31 characters, an
   empty name, and two sheets with the same name (case-insensitively). */
function sheetName(raw, taken, index) {
  let s = String(raw ?? "").replace(/[\[\]:*?/\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_SHEET_NAME);
  if (!s) s = "Sheet" + (index + 1);
  let base = s, n = 2;
  while (taken.has(s.toLowerCase())) { const suffix = " (" + (n++) + ")"; s = base.slice(0, MAX_SHEET_NAME - suffix.length) + suffix; }
  taken.add(s.toLowerCase());
  return s;
}

function cellXml(ref, value, headerRow) {
  let pct = false;
  if (value && typeof value === "object" && !(value instanceof Date) && "v" in value) { pct = !!value.pct; value = value.v; }
  if (value === null || value === undefined || value === "") return "";   // an empty cell, not a cell holding ""
  const style = headerRow ? ' s="1"' : pct ? ' s="2"' : "";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return `<c r="${ref}" t="inlineStr"${style}><is><t>${esc(String(value))}</t></is></c>`;
    return `<c r="${ref}"${style}><v>${value}</v></c>`;
  }
  if (typeof value === "boolean") return `<c r="${ref}" t="b"${style}><v>${value ? 1 : 0}</v></c>`;
  if (value instanceof Date) value = isNaN(value) ? "" : value.toISOString();
  return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
}

function sheetXml(rows, widths) {
  const cols = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("");
  let data = "";
  rows.forEach((row, r) => {
    const cells = (row || []).map((v, c) => cellXml(colLetters(c) + (r + 1), v, r === 0)).join("");
    data += `<row r="${r + 1}">${cells}</row>`;
  });
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView workbookViewId="0"${rows.length > 1 ? "" : ""}><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
${cols ? "<cols>" + cols + "</cols>" : ""}
<sheetData>${data}</sheetData>
</worksheet>`;
}

/* Widths from content: the longest value in each column, in characters,
   padded and capped so a long free-text cell does not stretch the sheet. */
function columnWidths(rows) {
  const w = [];
  for (const row of rows) (row || []).forEach((v, i) => {
    let s = v && typeof v === "object" && "v" in v ? v.v : v;
    if (s === null || s === undefined) s = "";
    const len = String(s).split("\n").reduce((m, line) => Math.max(m, line.length), 0);
    w[i] = Math.max(w[i] || 0, len);
  });
  return w.map(n => Math.min(60, Math.max(8, n + 2)));
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="10"/><name val="${FONT}"/></font><font><b/><sz val="10"/><name val="${FONT}"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="3">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

/**
 * Build a workbook.
 * @param {Array<{name: string, rows: any[][]}>} sheets  first row of each is the header
 * @param {{date?: Date}} [options]  stamped on the archive entries
 * @returns {Promise<Uint8Array>}
 */
export async function xlsxFiles(sheets, options = {}) {
  if (!Array.isArray(sheets) || !sheets.length) throw new Error("xlsx: a workbook needs at least one sheet");
  const taken = new Set();
  const parts = sheets.map((sh, i) => {
    const rows = Array.isArray(sh.rows) && sh.rows.length ? sh.rows : [["(empty)"]];
    return { name: sheetName(sh.name, taken, i), xml: sheetXml(rows, columnWidths(rows)) };
  });
  const files = [
    { name: "[Content_Types].xml", text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${parts.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("\n")}
</Types>` },
    { name: "_rels/.rels", text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>` },
    { name: "xl/workbook.xml", text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${parts.map((p, i) => `<sheet name="${esc(p.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets>
</workbook>` },
    { name: "xl/_rels/workbook.xml.rels", text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${parts.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("\n")}
<Relationship Id="rId${parts.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>` },
    { name: "xl/styles.xml", text: STYLES },
    ...parts.map((p, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, text: p.xml }))
  ];
  return zipFiles(files, { date: options.date });
}

export { sheetName, colLetters };
