// The first sheet of an Excel file (.xlsx) or a CSV, as rows of text. An .xlsx is a zip of XML files: the zip is read
// here with Node's zlib, so the app needs no spreadsheet library. Cells keep the text Excel stores (a number as
// written, a date as its serial number); empty cells are ''.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_ROWS = 5000;

// The files of a zip, by name: { name -> Buffer }, only the ones wanted (the rest are not inflated).
function unzip(buf, wanted) {
  // the end of the central directory: its signature, searched from the end (a comment may follow it)
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end === -1) throw new Error('This is not an .xlsx file (it is not a zip)');
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const files = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error('The .xlsx file is damaged');
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    at += 46 + nameLen + extraLen + commentLen;
    if (!wanted(name)) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    files[name] = method === 0 ? data : method === 8 ? zlib.inflateRawSync(data) : null;
  }
  return files;
}

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const unescapeXml = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
  return ENTITIES[e.toLowerCase()];
});
// the text of an element with runs (<t>...</t>, maybe several), as a shared string or an inline string has
const runsText = (xml) => [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unescapeXml(m[1])).join('');
// "AB12" -> 27 (0-based column)
const columnOf = (ref) => [...ref.replace(/\d+/g, '').toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

function readXlsx(buf) {
  const files = unzip(buf, (n) => /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/.test(n));
  const text = (n) => (files[n] ? files[n].toString('utf8') : '');
  // the first sheet of the workbook, through its relationship; else sheet1
  let sheet = 'xl/worksheets/sheet1.xml';
  const first = text('xl/workbook.xml').match(/<sheet\b[^>]*\br:id="([^"]+)"/);
  if (first) {
    const rel = [...text('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0]).find((r) => r.includes(`Id="${first[1]}"`));
    const target = rel && rel.match(/Target="([^"]+)"/);
    if (target) sheet = target[1].startsWith('/') ? target[1].slice(1) : `xl/${target[1]}`;
  }
  if (!files[sheet]) throw new Error('The workbook has no sheet to read');
  const shared = [...text('xl/sharedStrings.xml').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => runsText(m[1]));
  const rows = [];
  for (const row of text(sheet).matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const cells = [];
    for (const c of (row[1] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1];
      const ref = (attrs.match(/\br="([A-Z]+\d+)"/) || [])[1];
      const col = ref ? columnOf(ref) : cells.length;
      const type = (attrs.match(/\bt="([^"]+)"/) || [])[1] || 'n';
      const body = c[2] || '';
      const v = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      let value = '';
      if (type === 's') value = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') value = runsText(body);
      else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
      else if (v !== undefined) value = unescapeXml(v);
      while (cells.length < col) cells.push('');
      cells[col] = value;
    }
    rows.push(cells);
    if (rows.length > MAX_ROWS) throw new Error(`The sheet has more than ${MAX_ROWS} rows`);
  }
  return rows;
}

// A CSV with commas or semicolons (the one used most on the first line), and quotes around a value that has them.
function readCsv(textIn) {
  const text = textIn.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0];
  const sep = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      if (rows.length > MAX_ROWS) throw new Error(`The file has more than ${MAX_ROWS} rows`);
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

// The rows of the file, each cell trimmed; rows with nothing in them are left out.
function readTable(file) {
  const ext = path.extname(String(file)).toLowerCase();
  if (ext === '.xls') throw new Error('Old .xls files cannot be read: save it as .xlsx (Excel Workbook) or as CSV');
  if (ext !== '.xlsx' && ext !== '.csv') throw new Error('Choose an .xlsx or a .csv file');
  const stat = fs.statSync(file);
  if (stat.size > MAX_BYTES) throw new Error('The file is too big (more than 20 MB)');
  const buf = fs.readFileSync(file);
  const rows = ext === '.csv' ? readCsv(buf.toString('utf8')) : readXlsx(buf);
  return rows.map((r) => r.map((c) => String(c ?? '').trim())).filter((r) => r.some(Boolean));
}

module.exports = { readTable, readXlsx, readCsv, columnOf };
