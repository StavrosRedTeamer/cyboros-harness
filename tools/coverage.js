#!/usr/bin/env node
// Coverage matrix for the Cyboros harness: vulnerability-class × status per host.
//   node tools/coverage.js <host>            # matrix to stdout
//   node tools/coverage.js <host> --json     # machine-readable
//   node tools/coverage.js <host> --write    # write reports/coverage-matrix.md (report gate input)
//
// Pattern adapted from SeaOf0/dsh-redteam-model (MIT) — coverage-matrix semantics.
// A class that was tested without findings is "tested" (a negative result is a result), never
// blank; a class not touched is "missed" and blocks the report gate (P3).
//
// Sources: reports/<host>-map.json (candidates per class) + reports/findings.jsonl.
//
// F4 (Ondata 4): le superfici coperte possono derivare anche da entità TIPIZZATE (Vuln/Finding
// della tassonomia docs/entity-taxonomy.yaml, tools/entity-taxonomy.js). buildMatrix accetta
// opts.entities (ADDITIVO): una classe coperta da un'entità Vuln/Finding tipizzata passa a
// 'tested', e a 'confirmed' se l'entità Finding dichiara uno status di realtà (confirmed/
// verified). Senza opts.entities il comportamento resta byte-identico al pre-F4.

'use strict';
const fs = require('fs');
const path = require('path');

const REPORTS = path.join(__dirname, '..', 'reports');
const FINDINGS = path.join(REPORTS, 'findings.jsonl');

// Vulnerability classes tracked by the harness (matches knowledge.md methodology).
const CLASSES = [
  'sqli', 'xss', 'ssrf', 'injection', 'authn', 'authz', 'csrf', 'idor', 'file-upload',
  'path-traversal', 'deserialization', 'info-disclosure', 'config', 'crypto', 'logic',
  'chain', 'cloud', 'network', 'wireless', 'postex',
];

// Superfici introdotte dal piano servizi che NON sono classi web (container/K8s, mobile) e che
// entrano nella matrice SOLO dove la superficie esiste davvero: candidato esplicito nella map,
// finding registrato, entità tipizzata o (container) porta aperta passata in opts.ports.
// Così un host web resta byte-identico (le classi extra non aggiungono righe 'missed' finte) e
// la matrice non dichiara copertura di una superficie mai testata. ADDITIVO per costruzione.
const EXTRA_CLASSES = ['container', 'mobile'];
const CONTAINER_PORTS = [2375, 2376, 10250, 10255];

function hasContainerSurface(ports) {
  return (ports || []).some((p) => CONTAINER_PORTS.includes(Number(p && typeof p === 'object' ? p.port : p)));
}

function loadJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

// Parse one candidate entry: legacy numeric count OR {candidates, skip_reason} object
// (Ondata 2/B2: the skip_reason documents WHY a class was not tested — surfaced in the
// report's "Copertura & accuratezza" section).
function parseCandidateEntry(v) {
  if (typeof v === 'number') return { candidates: v, skip_reason: null };
  if (v && typeof v === 'object') return { candidates: typeof v.candidates === 'number' ? v.candidates : 0, skip_reason: v.skip_reason || null };
  return { candidates: 0, skip_reason: null };
}

function classOf(f) {
  // F4 (Ondata 4): preferisce il testo umano (title/type) al solo ID CWE — un titolo
  // "SQL injection" con cwe "CWE-89" deve classificarsi sqli, non 'other'. Fallback al cwe
  // solo quando non c'è testo. Miglioramento puro: nulla di corretto prima diventa errato.
  // Il campo `class` esplicito (già validato contro la tassonomia da record-finding.js) vince
  // sull'euristica testuale: un finding registrato come authz non deve finire in 'logic' solo
  // perché il titolo contiene "business logic". Classi fuori tassonomia (es. 'info') proseguono.
  if (typeof f.class === 'string' && CLASSES.includes(f.class)) return f.class;
  const t = String(f.title || f.type || f.cwe || '').toLowerCase();
  if (/sql|sqli/.test(t)) return 'sqli';
  if (/xss/.test(t)) return 'xss';
  if (/ssrf/.test(t)) return 'ssrf';
  if (/injection|command/.test(t)) return 'injection';
  if (/auth.*(bypass|reset|otp|session|jwt)|login/i.test(t)) return 'authn';
  if (/idor|bola/.test(t)) return 'idor';
  if (/authz|broken access|privilege/.test(t)) return 'authz';
  if (/csrf/.test(t)) return 'csrf';
  if (/upload/.test(t)) return 'file-upload';
  if (/travers|lfi/.test(t)) return 'path-traversal';
  if (/deserial/.test(t)) return 'deserialization';
  if (/disclos|leak|expos|directory listing/.test(t)) return 'info-disclosure';
  if (/config|misconfig|default cred/.test(t)) return 'config';
  if (/crypto|jwt|hash|weak key/.test(t)) return 'crypto';
  if (/logic|race|state|business/.test(t)) return 'logic';
  if (/chain/.test(t)) return 'chain';
  if (/cloud|aws|azure|gcp/.test(t)) return 'cloud';
  if (/network|port|smb|nfs/.test(t)) return 'network';
  if (/wireless|wifi|wpa/.test(t)) return 'wireless';
  if (/post|exfil|lateral|persist/.test(t)) return 'postex';
  // Extra surfaces (P1.4/M.4) — after every web/host class so existing classifications are
  // untouched; a title that already matched an earlier class keeps it.
  if (/container|docker|kubelet|kubernetes|k8s/.test(t)) return 'container';
  if (/deeplink|\bexported\b|\bandroid\b|\bapk\b|\bfrida\b/.test(t)) return 'mobile';
  return 'other';
}

/** Build the matrix for one host. Ondata 2: opts.{reportsDir,findingsFile} are additive
 * injection points so tests (and multi-engagement rollups) never touch the live reports/. */
function buildMatrix(host, opts) {
  opts = opts || {};
  const reportsDir = opts.reportsDir || REPORTS;
  const findingsFile = opts.findingsFile || FINDINGS;
  const mapFile = path.join(reportsDir, `${host}-map.json`);
  let candidates = {};
  try { candidates = JSON.parse(fs.readFileSync(mapFile, 'utf8')); } catch {}
  const findings = loadJsonl(findingsFile).filter((f) => !host || f.host === host || String(f.host || '').includes(host));
  const byClass = {};
  for (const f of findings) {
    const c = classOf(f);
    byClass[c] = byClass[c] || [];
    byClass[c].push(f);
  }
  // F4: entità tipizzate come sorgente ADDITIVA di copertura (Vuln/Finding della tassonomia).
  // Per classe: 'confirmed' se esiste un'entità Finding con status di realtà, altrimenti
  // 'tested' se esiste un'entità Vuln/Finding che la copre.
  const entByClass = {};
  for (const e of opts.entities || []) {
    if (!e || typeof e !== 'object') continue;
    let cls = null;
    if (e.entityType === 'Vuln' && typeof e.class === 'string') {
      if (CLASSES.includes(e.class)) cls = e.class;
      else {
        const mapped = classOf({ cwe: e.class, title: e.class, type: e.class });
        if (mapped !== 'other') cls = mapped;
      }
    } else if (e.entityType === 'Finding') {
      const c = classOf(e);
      if (c !== 'other') cls = c;
    }
    if (cls) entByClass[cls] = entByClass[cls] || { confirmed: false, present: false };
    if (cls) {
      entByClass[cls].present = true;
      if (e.entityType === 'Finding' && ['confirmed', 'verified'].includes(e.status)) entByClass[cls].confirmed = true;
    }
  }
  // Classi extra incluse solo quando rilevanti (vedi EXTRA_CLASSES): map/finding/entità/
  // porta container/mobile esplicito. Senza opts, `classes` coincide con CLASSES.
  const extra = EXTRA_CLASSES.filter((c) =>
    candidates[c] !== undefined
    || (byClass[c] && byClass[c].length)
    || (entByClass[c] && entByClass[c].present)
    || (c === 'container' && hasContainerSurface(opts.ports))
    || (c === 'mobile' && !!opts.mobile));
  const classes = CLASSES.concat(extra);
  const rows = classes.map((cls) => {
    const raw = candidates[cls] ?? candidates[cls + 's'];
    const parsed = raw === undefined ? { candidates: 0, skip_reason: null } : parseCandidateEntry(raw);
    const cand = parsed.candidates;
    const found = byClass[cls] || [];
    let status = 'missed';
    if (found.length) status = 'confirmed';
    else if (entByClass[cls] && entByClass[cls].confirmed) status = 'confirmed';
    else if (cand > 0 || found.some((f) => f.status === 'inconclusive')) status = 'tested';
    else if (entByClass[cls] && entByClass[cls].present) status = 'tested';
    else if (cand === 0 && Object.keys(candidates).length > 0) status = 'n-a'; // no candidates → N/A
    return { class: cls, candidates: cand, findings: found.length, status, skip_reason: parsed.skip_reason };
  });
  const other = byClass['other'] || [];
  return { host, rows, otherFindings: other.length };
}

function matrixTable(m) {
  const lines = ['# Coverage Matrix', '', `Host: ${m.host}`, '',
    '| Class | Candidates | Findings | Status |', '|---|---|---|---|'];
  for (const r of m.rows) {
    lines.push(`| ${r.class} | ${r.candidates} | ${r.findings} | ${r.status} |`);
  }
  lines.push('', `Other/uncategorized findings: ${m.otherFindings}`, '',
    `Status legend: tested = class probed (negative result counts) · confirmed = finding(s) · n-a = no candidate surface · missed = NOT tested (blocks report gate)`);
  return lines.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const host = args[0];
  if (!host) {
    console.error('usage: node tools/coverage.js <host> [--json|--write]');
    process.exit(2);
  }
  const m = buildMatrix(host);
  if (args.includes('--json')) {
    console.log(JSON.stringify(m, null, 2));
  } else {
    console.log(matrixTable(m));
  }
  if (args.includes('--write')) {
    const out = path.join(REPORTS, 'coverage-matrix.md');
    fs.writeFileSync(out, matrixTable(m) + '\n');
    console.log(`\nwrote ${out}`);
  }
  const missed = m.rows.filter((r) => r.status === 'missed').length;
  process.exit(missed ? 1 : 0);
}

if (require.main === module) main();

module.exports = { CLASSES, EXTRA_CLASSES, CONTAINER_PORTS, hasContainerSurface, buildMatrix, classOf, matrixTable };