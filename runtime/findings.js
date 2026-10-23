// runtime/findings.js — what a findings ledger is: one JSON object per line, and a verdict
// for the ways a file can fail to be one. The terminal (/findings, /gate) and the CLI report
// both read through this file; a second parser would be a second definition of the ledger.
'use strict';

const fs = require('node:fs');

// Every outcome has one shape — { ok, kind, rows, line, error, detail } — so a caller cannot
// ask for a field only one verdict carries. Corruption keeps the rows read before the bad
// line: they are evidence, but never the whole ledger.
function verdict(kind, fields) {
  return Object.assign({ ok: kind === 'ok', kind, rows: [], line: null, error: null, detail: null }, fields);
}

function readFindings(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return verdict(e && e.code === 'ENOENT' ? 'absent' : 'unreadable', { error: (e && e.message) || String(e) });
  }
  const rows = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].trim()) continue;
    let row;
    try {
      row = JSON.parse(lines[i]);
    } catch {
      return verdict('corrupt', { rows, line: i + 1, detail: 'is not JSON' });
    }
    // JSON.parse also accepts scalars and arrays: `null`, `124`, `"str"`, `[]` are not
    // findings, and rendering one as if it were threw on the first property read.
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      return verdict('corrupt', { rows, line: i + 1, detail: 'is not a finding object' });
    }
    rows.push(row);
  }
  return verdict('ok', { rows });
}

module.exports = { readFindings };
