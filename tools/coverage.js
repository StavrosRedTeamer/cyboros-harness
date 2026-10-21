#!/usr/bin/env node
// Coverage matrix for the Cyboros harness: vulnerability-class × status per host.
//   node tools/coverage.js <host>            # matrix to stdout
//   node tools/coverage.js <host> --json     # machine-readable
//   node tools/coverage.js <host> --write    # write reports/coverage-<host>.md (report gate input)
//   node tools/coverage.js --help            # usage
//
// PER-HOST OUTPUT: prima ogni `--write` sovrascriveva reports/coverage-matrix.md, quindi la
// matrice di un ingaggio veniva distrutta dal successivo e il gate del report leggeva (e
// bocciava) dati di un altro host. Ora il file è per-host e il gate risolve lo stesso nome.
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
const { env } = require('./env');

const { dataPaths } = require('./config');
const REPORTS = dataPaths().reports;
// Override per i test (fixture in mkdtemp): la produzione resta reports/.
const reportsDir = () => process.env.COVERAGE_REPORTS_DIR || REPORTS;
const FINDINGS = dataPaths().findings;
const REGISTRY_FILE = () => env('TEST_REGISTRY') || path.join(__dirname, 'test-registry.json');

// Vulnerability classes tracked by the harness. FONTE UNICA: tools/test-registry.json — lo stesso
// file che validano record-finding.js, map.js e attack-coverage.js. Prima questa lista era
// hardcoded a 20 nomi e 32 classi del registry non comparivano MAI in matrice (jwt, cors,
// graphql, race, cache-poison, smuggling, ssti, xxe, llm, mcp, privesc…): il gate P3 dichiarava
// copertura su meno della metà della tassonomia. Ora le classi derivate si aggiungono a CORE.
//
// I cinque nomi storici restano il display name della matrice (mappe, finding e report esistenti
// continuano a risolvere): sono alias di chiavi del registry, non classi separate.
const LEGACY_ALIASES = Object.freeze({
  'file-upload': 'upload',
  'path-traversal': 'lfi',
  'deserialization': 'deser',
  'info-disclosure': 'info',
  'logic': 'business-logic',
});

// Superfici/esiti dell'harness senza chiave di registry: non sono classi testabili del registry
// (una chain è la conseguenza di più classi; rete e post-exploitation non hanno una entry).
const HARNESS_ONLY = Object.freeze(['chain', 'network', 'postex']);

// Classi web di base: sempre presenti, in questo ordine (l'ordine è parte dell'output
// diffabile della matrice).
const CORE_CLASSES = Object.freeze([
  'sqli', 'xss', 'ssrf', 'injection', 'authn', 'authz', 'csrf', 'idor', 'file-upload',
  'path-traversal', 'deserialization', 'info-disclosure', 'config', 'crypto', 'logic',
  'chain', 'cloud', 'network', 'wireless', 'postex',
]);

// Chiave di registry -> display name della matrice (solo i cinque alias differiscono).
function displayName(key) {
  for (const [disp, k] of Object.entries(LEGACY_ALIASES)) if (k === key) return disp;
  return key;
}

function loadRegistryClasses() {
  try {
    const reg = JSON.parse(fs.readFileSync(REGISTRY_FILE(), 'utf8'));
    return (reg && reg.classes) || {};
  } catch { return {}; }
}

// CORE first, then the registry classes not already covered, sorted: deterministic output.
// 'other' è il bucket di fallback del registry, non una classe testabile: resta fuori dalle
// righe e vive in otherFindings. Registry assente/corrotto -> solo CORE (fallback pre-ondata).
function classList(registry) {
  const reg = registry || loadRegistryClasses();
  const derived = Object.keys(reg)
    .filter((k) => !k.startsWith('_'))
    .map(displayName)
    .filter((c) => c !== 'other' && !CORE_CLASSES.includes(c));
  return [...CORE_CLASSES, ...new Set(derived.sort())];
}

const CLASSES = classList();

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

// Normalizza le TRE forme di reports/<host>-map.json che esistono nel repo in un unico
// {classe: conteggio | {candidates, skip_reason}}:
//   1. {classe: n} oppure {classe: [candidati]}      — forma storica attesa da questa matrice;
//   2. {candidates: {classe: [...]}}                  — forma letta da planner.js;
//   3. {endpoints: [{candidates: {classe: [...]}}]}   — quella che map.js SCRIVE davvero.
// Prima la matrice leggeva il top-level e sulla forma reale (3) vedeva zero candidati: ogni
// classe risultava n-a anche su una mappa piena. I conteggi si sommano per classe (un candidato
// per endpoint è un candidato da testare), il skip_reason dell'handoff viene preservato.
function normalizeCandidates(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return {};
  const counts = new Map();
  const skip = new Map();
  const bump = (k, n, reason) => {
    counts.set(k, (counts.get(k) || 0) + n);
    if (reason) skip.set(k, reason);
  };
  const eat = (obj) => {
    for (const [k, v] of Object.entries(obj || {})) {
      if (k === 'candidates' || k === 'endpoints' || k === 'host' || k.startsWith('_')) continue;
      if (Array.isArray(v)) bump(k, v.length);
      else if (typeof v === 'number') bump(k, v);
      else if (v && typeof v === 'object') bump(k, typeof v.candidates === 'number' ? v.candidates : 0, v.skip_reason);
    }
  };
  eat(doc);
  if (doc.candidates && typeof doc.candidates === 'object') eat(doc.candidates);
  for (const e of Array.isArray(doc.endpoints) ? doc.endpoints : []) eat(e && e.candidates);
  const out = {};
  for (const [k, n] of counts) out[k] = skip.has(k) ? { candidates: n, skip_reason: skip.get(k) } : n;
  return out;
}

// Parse one candidate entry: legacy numeric count OR {candidates, skip_reason} object
// (Ondata 2/B2: the skip_reason documents WHY a class was not tested — surfaced in the
// report's "Copertura & accuratezza" section).
function parseCandidateEntry(v) {
  if (typeof v === 'number') return { candidates: v, skip_reason: null };
  if (v && typeof v === 'object') return { candidates: typeof v.candidates === 'number' ? v.candidates : 0, skip_reason: v.skip_reason || null };
  return { candidates: 0, skip_reason: null };
}

// Una mappa può chiavare i candidati per display name o per chiave di registry (map.js valida
// sulle chiavi): accetta entrambi, più il plurale storico, così le righe alias non perdono
// segnale quando la map è scritta con la chiave canonica.
function candidatesFor(candidates, cls) {
  const keys = [cls, cls + 's', LEGACY_ALIASES[cls]];
  for (const k of keys) {
    if (k && Object.prototype.hasOwnProperty.call(candidates, k) && candidates[k] !== undefined) return candidates[k];
  }
  return undefined;
}

function classOf(f) {
  // F4 (Ondata 4): preferisce il testo umano (title/type) al solo ID CWE — un titolo
  // "SQL injection" con cwe "CWE-89" deve classificarsi sqli, non 'other'. Fallback al cwe
  // solo quando non c'è testo. Miglioramento puro: nulla di corretto prima diventa errato.
  // Il campo `class` esplicito (già validato contro la tassonomia da record-finding.js) vince
  // sull'euristica testuale: un finding registrato come authz non deve finire in 'logic' solo
  // perché il titolo contiene "business logic". record-finding valida le CHIAVI del registry:
  // 'upload'/'lfi'/'deser'/'info'/'business-logic' vengono riportate al display name della
  // matrice, così un solo finding produce una sola riga. Classi sconosciute proseguono.
  if (typeof f.class === 'string' && f.class) {
    if (CLASSES.includes(f.class)) return f.class;
    const disp = displayName(f.class);
    if (CLASSES.includes(disp)) return disp;
  }
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
  try { candidates = normalizeCandidates(JSON.parse(fs.readFileSync(mapFile, 'utf8'))); } catch {}
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
    const raw = candidatesFor(candidates, cls);
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

// Stesso schema di nome del gate (tools/gate.js normalizeHost + safeHost): i due lati devono
// coincidere o il gate cerca un file che il tool non scrive. L'host è normalizzato come nel gate
// (schema, path e porta rimossi) prima di essere reso un nome di file.
function normalizeHost(h) {
  return String(h == null ? '' : h).trim().toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^.*@/, '')
    .replace(/:\d+$/, '')
    .replace(/\.$/, '');
}

function coverageFile(host) {
  return `coverage-${normalizeHost(host).replace(/[^a-z0-9._-]+/g, '-')}.md`;
}

const USAGE = [
  'usage: node tools/coverage.js <host> [--json|--write]',
  '       node tools/coverage.js --help',
  '',
  '  <host>    target host/host:port (map: reports/<host>-map.json, findings: reports/findings.jsonl)',
  '  --json    machine-readable matrix on stdout',
  '  --write   write reports/coverage-<host>.md (input of the report/test stage gate)',
  '',
  'Exit: 0 = no class missed, 1 = at least one class missed, 2 = bad invocation.',
].join('\n');

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    console.log(USAGE);
    process.exit(0);
  }
  const host = args[0];
  if (!host || host.startsWith('-')) {
    console.error(USAGE);
    process.exit(2);
  }
  const m = buildMatrix(host, process.env.COVERAGE_REPORTS_DIR
    ? { reportsDir: reportsDir(), findingsFile: path.join(reportsDir(), 'findings.jsonl') }
    : {});
  if (args.includes('--json')) {
    console.log(JSON.stringify(m, null, 2));
  } else {
    console.log(matrixTable(m));
  }
  if (args.includes('--write')) {
    const out = path.join(reportsDir(), coverageFile(host));
    const mapFile = path.join(reportsDir(), `${host}-map.json`);
    if (!fs.existsSync(mapFile)) {
      console.error(`[coverage] no map at ${mapFile}: every class has 0 candidates and the matrix WILL be all-missed.`);
      console.error(`[coverage] run: node tools/map.js ${host}   (or node tools/target-model.js ${host})`);
    }
    fs.writeFileSync(out, matrixTable(m) + '\n');
    console.log(`\nwrote ${out}`);
  }
  const missed = m.rows.filter((r) => r.status === 'missed').length;
  process.exit(missed ? 1 : 0);
}

if (require.main === module) main();

module.exports = {
  CLASSES, CORE_CLASSES, HARNESS_ONLY, LEGACY_ALIASES, EXTRA_CLASSES, CONTAINER_PORTS,
  hasContainerSurface, buildMatrix, classOf, matrixTable, coverageFile, normalizeHost,
  displayName, classList, loadRegistryClasses, candidatesFor, normalizeCandidates, REGISTRY_FILE,
};