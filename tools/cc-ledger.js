#!/usr/bin/env node
// WP6 — Ledger: la verità dell'engagement in una timeline, con la hash-chain verificata.
//
// Unisce le fonti append-only che l'harness già produce — transizioni opstate, gate-log,
// audit-trail, artifact-ledger, approvazioni — e riporta il verdetto della chain dei finding
// chiamando lo STESSO check di gate.js (quindi i due non possono divergere).
//
// Read-only, tranne i due comandi di output: `evidence` (bundle tar.gz + manifest con hash)
// e `export-pdf` (delega a tools/app/pdf-export.py, printToPdf di QtWebEngine).
//
// CLI:
//   node tools/cc-ledger.js show [--json] [--tail N]
//   node tools/cc-ledger.js chain
//   node tools/cc-ledger.js evidence [--out <file.tar.gz>] [--json]
//   node tools/cc-ledger.js export-pdf <report.html> [--out <file.pdf>]
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const u = require('./cc-util');

const root = () => process.env.CC_ROOT || u.ROOT;
const reports = () => path.join(root(), 'reports');
const opstateFile = () => process.env.CC_OPSTATE_FILE || process.env.OPSTATE_FILE || path.join(root(), 'operation-state.json');
const gateLogFile = () => process.env.GATE_LOG_FILE || path.join(reports(), 'gate-log.md');
const auditDir = () => process.env.AUDIT_DIR || path.join(root(), 'artifacts', 'audit');

function readText(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } }

// ── sources ─────────────────────────────────────────────────────────────────
function transitions() {
  try {
    const st = require('./opstate').loadOpState(opstateFile());
    return (st.transitions || []).map((t) => ({
      ts: t.ts, kind: 'transition', owner: t.owner, action: t.action,
      detail: t.detail ? JSON.stringify(t.detail) : null, seq: t.seq,
    }));
  } catch { return []; }
}

function gateRows() {
  const rows = [];
  for (const line of readText(gateLogFile()).split('\n')) {
    if (!line.includes('|')) continue;
    const c = line.split('|').map((x) => x.trim()).filter(Boolean);
    if (c.length < 3 || !/^\d{4}-/.test(c[0])) continue;
    rows.push({ ts: c[0], kind: 'gate', gate: c[1], verdict: c[2], detail: c.slice(3).join(' | ') });
  }
  return rows;
}

function auditRows() {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(auditDir()).filter((f) => f.endsWith('.jsonl')).sort(); } catch { return out; }
  for (const name of names) {
    const rows = u.readJsonl(path.join(auditDir(), name));
    for (const r of rows) out.push({ ts: r.ts, kind: 'audit', tool: r.tool || 'run', entry: r.entry || r });
  }
  return out;
}

function artifactRows() {
  try {
    const al = require('./artifact-ledger');
    return al.readEntries(al.resolveLedgerFile({})).map((e) => ({
      ts: e.ts, kind: 'artifact', action: e.action_id, producer: e.producer,
      artifact: e.artifact, sha256: e.sha256, bytes: e.bytes,
    }));
  } catch { return []; }
}

function approvalRows() {
  try {
    return require('./cc-approvals').list({ all: true }).map((t) => ({
      ts: t.decision_ts || t.consumed_at || t.created_at, kind: 'approval', id: t.id,
      status: t.status, host: t.host, action_class: t.action_class, granted_by: t.granted_by,
    }));
  } catch { return []; }
}

// Chain verdict: the SAME function gate.js uses, so the reports agree by construction.
function chain(file) {
  try { return require('./gate').checkChain(file); }
  catch (e) { return { ok: false, detail: 'chain check unavailable: ' + String((e && e.message) || e) }; }
}

function timeline(limit) {
  const all = [].concat(transitions(), gateRows(), auditRows(), artifactRows(), approvalRows())
    .filter((r) => r.ts)
    .sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  const capped = limit ? all.slice(0, limit) : all;
  return { total: all.length, rows: capped };
}

function build(opts) {
  const o = opts || {};
  return {
    generated_at: u.nowIso(),
    chain: chain(o.findingsFile),
    counts: {
      transitions: transitions().length, gates: gateRows().length, audit: auditRows().length,
      artifacts: artifactRows().length, approvals: approvalRows().length,
    },
    timeline: timeline(o.tail || 200),
  };
}

// ── evidence bundle ─────────────────────────────────────────────────────────
function evidenceCandidates() {
  const list = [
    'operation-state.json',
    'reports/findings.jsonl',
    'reports/gate-log.md',
    'reports/approvals.jsonl',
    'reports/campaign-history.jsonl',
    'reports/tmp/artifact-ledger.jsonl',
  ];
  try {
    for (const f of fs.readdirSync(auditDir()).filter((x) => x.endsWith('.jsonl')).sort())
      list.push(path.relative(root(), path.join(auditDir(), f)));
  } catch { /* none */ }
  return list;
}

function sha256File(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }

function evidenceBundle(opts) {
  const o = opts || {};
  const base = root();
  const files = [];
  for (const rel of evidenceCandidates()) {
    const abs = path.join(base, rel);
    try {
      const st = fs.statSync(abs);
      if (st.isFile()) files.push({ path: rel, sha256: sha256File(abs), bytes: st.size });
    } catch { /* missing source is skipped, not fatal */ }
  }
  const stamp = u.nowIso().replace(/[-:]/g, '').slice(0, 15);
  const outDir = o.outDir || path.join(base, 'reports', 'evidence');
  fs.mkdirSync(outDir, { recursive: true });
  const manifestPath = path.join(outDir, 'manifest-' + stamp + '.json');
  const manifest = {
    kind: 'stavros-evidence-bundle', version: 1, generated_at: u.nowIso(),
    chain: chain(), files,
  };
  u.atomicWriteJson(manifestPath, manifest);

  const tarFile = o.outFile || path.join(outDir, 'evidence-' + stamp + '.tar.gz');
  const rels = files.map((f) => f.path).concat([path.relative(base, manifestPath)]);
  const r = spawnSync('tar', ['-czf', tarFile, '-C', base].concat(rels), { encoding: 'utf8' });
  return {
    ok: r.status === 0, tar: tarFile, manifest: manifestPath, files: files.length,
    chain: manifest.chain, error: r.status === 0 ? null : String(r.stderr || r.error || 'tar failed'),
  };
}

function exportPdf(src, out) {
  if (!src) return { ok: false, error: 'missing source html' };
  const script = path.join(__dirname, 'app', 'pdf-export.py');
  if (!fs.existsSync(script)) return { ok: false, error: 'pdf-export.py not found (WP2 shell)' };
  const outFile = out || path.join(reports(), 'export-' + Date.now() + '.pdf');
  const r = spawnSync('python3', [script, path.resolve(src), path.resolve(outFile)], { encoding: 'utf8', timeout: 60000 });
  return { ok: r.status === 0, out: outFile, error: r.status === 0 ? null : String(r.stderr || r.error || 'pdf export failed') };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--tail') o.tail = parseInt(argv[++i], 10) || 200;
    else if (a === '--out') o.out = argv[++i];
    else o._.push(a);
  }
  return o;
}

function main(argv) {
  const cli = parseArgs(argv);
  const cmd = cli._[0] || 'show';
  if (cmd === 'show') { console.log(JSON.stringify(build({ tail: cli.tail }), null, 2)); return 0; }
  if (cmd === 'chain') { const c = chain(); console.log(JSON.stringify(c, null, 2)); return c.ok ? 0 : 1; }
  if (cmd === 'evidence') { console.log(JSON.stringify(evidenceBundle({ outFile: cli.out }), null, 2)); return 0; }
  if (cmd === 'export-pdf') { const r = exportPdf(cli._[1], cli.out); console.log(JSON.stringify(r, null, 2)); return r.ok ? 0 : 1; }
  console.error('usage: node tools/cc-ledger.js show|chain|evidence|export-pdf <html> [--out f]');
  return 2;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { build, timeline, chain, evidenceBundle, exportPdf, evidenceCandidates, gateRows, auditRows, artifactRows, approvalRows };
