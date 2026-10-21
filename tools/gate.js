#!/usr/bin/env node
// Stage-gate structural validation for the Cyboros harness.
//   node tools/gate.js status <host>          # show passed/missing gates per phase
//   node tools/gate.js pass <phase> [host]    # validate criteria and write pass to gate-log.md
//   node tools/gate.js check <phase> [host]   # check if a gate is passed (exit 0/1)
//   ... [--workflow <file.yaml>]  (o env GATE_WORKFLOW_FILE)
//
// HOST SCOPING (fail-closed per ingaggio): pass e check accettano un host. Con l'host, il
// verdetto vale SOLO per quell'host — findings, pending, verify, oracle, evidenceQuote, pocReplay
// e coverage vengono filtrati su di lui, e i file con `{host}` nel percorso (mappa, matrice)
// sono risolti. Senza host il comportamento resta quello storico (globale), ma un pass globale
// NON soddisfa `check <fase> <host>`: un ingaggio chiuso non può più sbloccarne un altro.
//
// E3 (Ondata 4): i file attesi dalle fasi possono essere DICHIARATIVI — sezione `reports:`
// del dialetto workflow (tools/workflow.js), consumata qui con --workflow/GATE_WORKFLOW_FILE.
// Se la fase dichiara reports:, i check kind 'file' hardcoded della fase vengono SOSTITUITI
// dai report dichiarati (fail-closed: report dichiarato ma mancante → FAIL). Fasi senza
// reports: → comportamento legacy (elenco hardcoded). I check chain/oracle/evidenceQuote di
// SA1 NON vengono mai toccati (coordinazione SA1 rispettata).
//
// Pattern adapted from SeaOf0/dsh-redteam-model (MIT) — plugins/dsh-stage-gate.
// Gate phases: recon → map → test → authed → chains → report.
// Gate-log format: `| iso | mode/phase | pass | criteria | ... |` (append-only).

'use strict';
const fs = require('fs');
const path = require('path');
const { dataPaths } = require('./config');

// GATE_WS: workspace-root override per i test (fixture in mkdtemp, MAI il workspace reale);
// default = the configured data root, so a `--config` start gates the engagement it serves
// and not the checkout. The path helpers below are the ONE place a gate file is resolved.
const WS = () => process.env.GATE_WS || dataPaths().dataRoot;
const REPORTS = () => (process.env.GATE_WS ? path.join(WS(), 'reports') : dataPaths().reports);
// GATE_LOG_FILE: override per i test (fixture in mkdtemp, MAI il gate-log reale).
const GATE_LOG = () => process.env.GATE_LOG_FILE || path.join(REPORTS(), 'gate-log.md');

// A check names its file relative to the engagement (e.g. 'reports/tmp/run-audit.jsonl').
// Resolve it against the configured layout — reports need not be `<root>/reports` — while a
// GATE_WS fixture keeps the flat behaviour the gate tests rely on.
function wsPath(file) {
  if (path.isAbsolute(file)) return file;
  if (process.env.GATE_WS) return path.resolve(path.join(process.env.GATE_WS, file));
  const P = dataPaths();
  if (file === 'scope.json') return P.scope;
  if (file === 'auth.json') return P.auth;
  if (file === 'reports') return P.reports;
  if (file.startsWith('reports/')) return path.join(P.reports, file.slice('reports/'.length));
  return path.join(P.dataRoot, file);
}
const MODE = 'cyboros';

// ─── Gate definitions (structural checks, never model judgement) ───
// Each gate has:
//   - checks: array of { kind: "file"|"markers"|"table"|"findings"|"verify"|"chain"|"oracle"|"evidenceQuote", args }
//   - manual: human-review items (the model must confirm, never auto-check)
// Ondata1 additions to the report gate (additive — original semantics unchanged):
//   chain         → findings.jsonl hash-chain intact (A3); legacy unchained prefix is
//                   informational ('unchained-legacy'), a break fails the gate;
//   oracle        → every reality-level finding (confirmed/verified/exploited/proven_impact)
//                   re-has its mechanical oracle validated against DISK now (A1);
//   evidenceQuote → reality-level findings carry an evidence_quote whose text is a verbatim
//                   substring of the referenced artifact (A2).
// Ondata7 (additivo, in coda):
//   chainHeadVerifications → la testa del log delle verifiche (tools/verification-log.js)
//                   combacia con la sua ancora esterna, come per findings.jsonl. E i check su
//                   findings (verify/noPending/oracle/evidenceQuote/pocReplay) leggono la VISTA
//                   effettiva (tools/effective-findings.js): un finding promosso da una verifica
//                   registrata dopo la registrazione conta come verificato, senza che nessuno
//                   riscriva findings.jsonl (che è incatenato).
const GATES = {
  recon: {
    title: 'Reconnaissance baseline',
    checks: [
      { kind: 'file', file: 'scope.json', hint: 'scope.json exists' },
      { kind: 'scopeNonEmpty', hint: 'scope.json has allowed_hosts or allowed_ips' },
    ],
    manual: ['Scope entries carry written authorization (pentest agreed / in-scope bounty / own lab)'],
  },
  map: {
    title: 'Service enumeration baseline',
    checks: [
      { kind: 'file', file: 'reports/tmp/run-audit.jsonl', hint: 'at least one scan run' },
      { kind: 'file', file: 'reports/{host}-map.json', hint: 'target map exists (node tools/map.js / target-model.js)' },
      { kind: 'findings', min: 1, hint: 'at least one finding recorded' },
    ],
    manual: ['All in-scope hosts have been enumerated (ports + services)'],
  },
  test: {
    title: 'Vulnerability testing baseline',
    checks: [
      { kind: 'findings', min: 1, hint: 'findings recorded' },
      // Non più una ricerca di testo nel gate-log: un pass di un ALTRO host non conta.
      { kind: 'gatePassed', gateId: 'map', hint: 'map gate passed for this host' },
      { kind: 'coverage', hint: 'per-host coverage matrix prepared (node tools/coverage.js <host> --write)' },
    ],
    manual: ['Each vulnerability class (sql/injection/authz/xss/ssrf/...) has been tested or intentionally skipped with rationale'],
  },
  authed: {
    title: 'Authenticated post-auth baseline',
    checks: [
      { kind: 'file', file: 'auth.json', hint: 'auth.json exists' },
    ],
    manual: ['Authenticated surface tested (or skipped because no credentials)'],
  },
  chains: {
    title: 'Exploit chain coverage',
    checks: [
      { kind: 'findings', min: 1, hint: 'findings recorded' },
    ],
    manual: ['Chains built from low/medium findings that escalate to high impact'],
  },
  report: {
    title: 'Report readiness (P3)',
    checks: [
      { kind: 'findings', min: 1, hint: 'findings recorded' },
      { kind: 'verify', min: 1, hint: 'at least one finding verified' },
      { kind: 'noPending', hint: 'no finding with status pending for this host' },
      { kind: 'coverage', hint: 'per-host coverage matrix prepared, no class missed' },
      // Ondata1 A1/A2/A3 — fail-closed evidence quality (additive):
      { kind: 'chain', hint: 'findings.jsonl hash-chain intact' },
      { kind: 'oracle', hint: 'reality findings carry a disk-valid mechanical oracle' },
      { kind: 'evidenceQuote', hint: 'reality findings quote an exact artifact slice' },
      // Ondata 6 (additivo, SA1 invariato): la coda del gate cresce solo in coda —
      // test-gate-chain asserisce slice(0,4) legacy + slice(4) SA1 e viene aggiornato di conseguenza.
      { kind: 'pocReplay', hint: 'every verified finding has a reproducer exp/<id>.py on disk' },
      { kind: 'chainHead', hint: 'findings chain head matches the external head-anchor log' },
      // P0 (additivo, in coda): la matrice ATT&CK e' l'artefatto che misura la copertura offensiva
      // per tecnica (tools/attack-coverage.js --write), complementare a coverage-matrix.md.
      { kind: 'attackCoverage', hint: 'ATT&CK coverage matrix prepared' },
      { kind: 'chainHeadVerifications', hint: 'verifications log chain head matches its external anchor' },
    ],
    manual: ['Coverage matrix complete — every class tested or marked N/A with rationale', 'Cross-check done: independent subagent reviewed the findings'],
  },
};

// ─── Helpers ───

function loadJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

// ─── Host scoping ───
// Confronto per host normalizzato: mai `includes()` ("a.com" è substring di "evil-a.com").
// Accetta URL e host:porta nel campo host del finding; un host senza punto (localhost) resta sé.
function normalizeHost(h) {
  return String(h == null ? '' : h).trim().toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^.*@/, '')
    .replace(/:\d+$/, '')
    .replace(/\.$/, '');
}

function hostMatches(findingHost, host) {
  const want = normalizeHost(host);
  if (!want) return true;
  const got = normalizeHost(findingHost);
  if (!got) return false;
  return got === want || got.endsWith('.' + want);
}

// Nome file sicuro per `{host}` (stesso schema dei report: l'host è già validato altrove).
function safeHost(host) {
  return String(host || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
}

// Host-scoped lookups share one filter so a check can never silently see other engagements.
function rowsForHost(host) {
  const rows = effectiveRows();
  return host ? rows.filter((f) => hostMatches(f.host, host)) : rows;
}

function readText(file) {
  try { return fs.readFileSync(wsPath(file), 'utf8'); }
  catch { return ''; }
}

function gateLog() {
  return readText('reports/gate-log.md');
}

// ─── Check runners ───

function checkFile(file) {
  const full = wsPath(file);
  const ok = fs.existsSync(full);
  return { ok, detail: ok ? `${file} exists` : `${file} missing` };
}

function checkMarkers(file, markers) {
  const text = readText(file);
  const found = markers.filter((m) => text.includes(m));
  return { ok: found.length === markers.length, detail: `markers [${markers.join(', ')}] in ${file}: ${found.length}/${markers.length}` };
}

function checkFindings(min, host) {
  const findings = rowsForHost(host);
  const where = host ? ` (${normalizeHost(host)})` : '';
  return { ok: findings.length >= min, detail: `findings${where}: ${findings.length} >= ${min}` };
}

// Ondata 7: la VISTA effettiva (findings.jsonl + side log delle verifiche), non le righe grezze.
// Un finding promosso da una verifica registrata DOPO la registrazione conta come verificato, e
// nessuno ha dovuto riscrivere un file incatenato. Senza side log il risultato è identico alle
// righe grezze (un test lo asserisce), quindi il cambio è retrocompatibile.
function effectiveRows(file) {
  return require('./effective-findings')
    .effectiveFindings({ findingsFile: file || FINDINGS_FILE() }).findings;
}

function checkVerify(min, host) {
  const verified = rowsForHost(host).filter((f) => f.status === 'verified' || f.verified);
  const where = host ? ` (${normalizeHost(host)})` : '';
  return { ok: verified.length >= min, detail: `verified findings${where}: ${verified.length} >= ${min}` };
}

function checkNoPending(host) {
  const rows = rowsForHost(host);
  const isPending = require('./effective-findings').isPending;
  const pending = rows.filter(isPending);
  const where = host ? ` for ${normalizeHost(host)}` : '';
  if (!pending.length) return { ok: true, detail: `no pending findings${where} (${rows.length} effective row(s))` };
  const first = pending[0];
  return { ok: false, detail: `pending findings${where}: ${pending.length} (first: ${first.title || first.host || '?'} — ${first.verify_failed ? 'verification failed' : 'reality claim not substantiated'})` };
}

// Copertura = artefatto REALE, non "il file contiene una pipe". Il file è per-host
// (`reports/coverage-<host>.md`, scritto da `coverage.js <host> --write`): una matrice
// sovrascritta dall'host sbagliato non soddisfa più il gate di questo ingaggio.
// Prima bastava `text.includes('|')` — anche su 20 righe 'missed' il check passava.
function parseCoverageRows(text) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (cells.length !== 4) continue;
    if (!/^[a-z0-9._-]+$/i.test(cells[0])) continue;
    if (!/^\d+$/.test(cells[1]) || !/^\d+$/.test(cells[2])) continue;
    if (!['confirmed', 'tested', 'n-a', 'missed'].includes(cells[3].toLowerCase())) continue;
    rows.push({ class: cells[0], candidates: Number(cells[1]), findings: Number(cells[2]), status: cells[3].toLowerCase() });
  }
  return rows;
}

function checkCoverage(host) {
  const file = host ? `reports/coverage-${safeHost(host)}.md` : 'reports/coverage-matrix.md';
  const text = readText(file);
  if (!text) return { ok: false, detail: `${file} missing — run: node tools/coverage.js ${host || '<host>'} --write` };
  const rows = parseCoverageRows(text);
  if (!rows.length) return { ok: false, detail: `${file} has no class rows (not a coverage matrix)` };
  if (!host) return { ok: true, detail: `${file}: ${rows.length} class(es)` };
  const header = text.match(/^Host:\s*(.+)$/m);
  const declared = header ? normalizeHost(header[1]) : '';
  const want = normalizeHost(host);
  if (declared && declared !== want) return { ok: false, detail: `${file} covers ${declared}, not ${want} — regenerate for this host` };
  const missed = rows.filter((r) => r.status === 'missed');
  if (missed.length) {
    return { ok: false, detail: `${file}: ${missed.length}/${rows.length} class(es) missed: ${missed.slice(0, 6).map((r) => r.class).join(', ')}${missed.length > 6 ? ', …' : ''} — test them or mark them n-a with a rationale` };
  }
  return { ok: true, detail: `${file}: ${rows.length} class(es), none missed` };
}

// Il gate `test` non cerca più la stringa "cyboros/map" in un log globale: interroga il gate
// vero per l'host dell'ingaggio (o per l'host corrente di un pass globale).
function checkGatePassed(gateId, host) {
  const log = readText(GATE_LOG());
  const ok = gateLogHasPass(log, gateId, host);
  return { ok, detail: ok
    ? `${gateId} gate passed${host ? ' for ' + normalizeHost(host) : ' (any host)'}`
    : `${gateId} gate not passed${host ? ' for ' + normalizeHost(host) : ''} — run: node tools/gate.js pass ${gateId}${host ? ' ' + normalizeHost(host) : ''}` };
}

// P0: matrice ATT&CK — prodotta da "node tools/attack-coverage.js --write". L'header + almeno
// una riga di tattica provano che l'artefatto e' una matrice vera, non uno stub.
function checkAttackCoverage() {
  const text = readText('reports/attack-matrix.md');
  const rows = text.split('\n').filter((l) => l.trim().startsWith('|') && !/^\|\s*-{2,}/.test(l.trim()));
  const ok = text.includes('| Tactic |') && rows.length > 1;
  return { ok, detail: ok
    ? `attack-matrix.md has ${rows.length - 1} tactic row(s)`
    : 'attack-matrix.md missing or has no tactic rows (run: node tools/attack-coverage.js --write)' };
}

// Dual-schema scope normalization (additive): accepts the classic {allowed_hosts,allowed_ips}
// shape AND the lab shape {targets,exclusions} used by tools/scope-guard.js normalizeScope.
// Purely a superset — nothing that passed before can fail now; exclusions alone authorize
// nothing (an empty allowlist still fails). Accepts an injected scope object for offline tests;
// reads <ws>/scope.json when omitted.
function checkScopeNonEmpty(scopeObj) {
  let s = scopeObj;
  if (s == null) {
    try { s = JSON.parse(readText('scope.json')); } catch {
      return { ok: false, detail: 'scope.json unreadable' };
    }
  }
  try {
    const hosts = (s.allowed_hosts || []).length;
    const ips = (s.allowed_ips || []).length;
    const targets = Array.isArray(s.targets) ? s.targets.length : 0;
    const excl = Array.isArray(s.exclusions) ? s.exclusions.length : 0;
    const ok = hosts + ips + targets > 0;
    return { ok, detail: `scope.json: ${hosts} hosts, ${ips} IPs/CIDRs${targets ? `, ${targets} targets` : ''}${excl ? `, ${excl} exclusions` : ''}` };
  } catch {
    return { ok: false, detail: 'scope.json unreadable' };
  }
}

// ─── Ondata1 A1/A2/A3 checks ───
// All three take an optional findings.jsonl path (default: workspace reports/findings.jsonl)
// so tests can run them against temp fixtures without touching the real store.
const FINDINGS_FILE = () => path.join(REPORTS(), 'findings.jsonl');

function loadRawLines(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { return []; }
}

function checkChain(file) {
  file = file || FINDINGS_FILE();
  const lines = loadRawLines(file);
  if (!lines.length) return { ok: true, detail: 'findings.jsonl empty/absent — nothing chained yet' };
  const r = require('./record-finding').verifyFindingsChain(lines);
  if (!r.ok) return { ok: false, detail: `findings chain BROKEN at line ${r.index + 1}: ${r.reason}` };
  return { ok: true, detail: `findings chain intact: ${r.chained} chained, ${r.legacy} unchained-legacy (informational)` };
}

function realityOffenders(file, validateFn, host) {
  const findings = host ? effectiveRows(file).filter((f) => hostMatches(f.host, host)) : effectiveRows(file);
  const checked = [];
  const failed = [];
  for (const f of findings) {
    if (!require('./oracle').claimingReality(f)) continue;
    const err = validateFn(f);
    checked.push(f.title || f.host || '?');
    if (err) failed.push(`${f.title || f.host || '?'}: ${err}`);
  }
  return { checked, failed };
}

function checkOracle(file, host) {
  file = file || FINDINGS_FILE();
  const { checked, failed } = realityOffenders(file, (f) => require('./oracle').validateOracle(f.oracle), host);
  if (!checked.length) return { ok: true, detail: `no reality-level findings to oracle-check${host ? ' for ' + normalizeHost(host) : ''}` };
  const ok = failed.length === 0;
  return { ok, detail: `oracle re-validated on disk: ${checked.length - failed.length}/${checked.length} pass${failed.length ? ' — ' + failed[0] : ''}` };
}

function checkEvidenceQuote(file, host) {
  file = file || FINDINGS_FILE();
  const { checked, failed } = realityOffenders(file, (f) => require('./evidence-quote').validateQuote(f), host);
  if (!checked.length) return { ok: true, detail: `no reality-level findings to quote-check${host ? ' for ' + normalizeHost(host) : ''}` };
  const ok = failed.length === 0;
  return { ok, detail: `evidence quotes verbatim on disk: ${checked.length - failed.length}/${checked.length} pass${failed.length ? ' — ' + failed[0] : ''}` };
}

function checkPocReplay(file, host) {
  file = file || FINDINGS_FILE();
  const findings = host ? effectiveRows(file).filter((f) => hostMatches(f.host, host)) : effectiveRows(file);
  const r = require('./poc-replay').checkPocReplays(findings);
  if (!findings.length) return { ok: true, detail: `no findings yet — pocReplay vacuous${host ? ' for ' + normalizeHost(host) : ''}` };
  const ok = r.ok;
  return { ok, detail: ok
    ? `poc replays: ${r.checked.length} verified finding(s) with reproducer on disk`
    : `missing reproducer exp/<id>.py for: ${r.missingExp.join(', ')} — write one with: node tools/gen-poc.js <id>` };
}

function checkChainHead(opts) {
  const r = require('./record-finding').verifyHeadAnchor(opts);
  return { ok: !!r.ok, detail: r.detail || (r.ok ? 'head anchor ok' : 'head anchor mismatch') };
}

// Ondata 7: la testa del log delle verifiche, ancorata esternamente come findings.jsonl.
function checkChainHeadVerifications() {
  const r = require('./verification-log').verify();
  return { ok: !!r.ok, detail: r.detail || (r.ok ? 'verifications head anchor ok' : 'verifications head anchor mismatch') };
}

// `state.host` è l'host dell'ingaggio: ogni check che tocca findings o artefatti per-host lo
// riceve. `{host}` nel percorso è risolto qui, così anche i reports dichiarati da un workflow
// possono essere per-host.
function runCheck(check, state) {
  const host = state && state.host ? normalizeHost(state.host) : null;
  const file = typeof check.file === 'string' && check.file.includes('{host}')
    ? (host ? check.file.replace(/\{host\}/g, safeHost(host)) : check.file)
    : check.file;
  if (file && check.file !== file && !host) {
    return { ok: false, detail: `${check.file}: host required (pass an engagement host: node tools/gate.js pass <phase> <host>)` };
  }
  switch (check.kind) {
    case 'file': return checkFile(file);
    case 'markers': return checkMarkers(file, check.markers);
    case 'findings': return checkFindings(check.min, host);
    case 'verify': return checkVerify(check.min, host);
    case 'noPending': return checkNoPending(host);
    case 'coverage': return checkCoverage(host);
    case 'attackCoverage': return checkAttackCoverage();
    case 'scopeNonEmpty': return checkScopeNonEmpty();
    case 'chain': return checkChain(check.file);
    case 'oracle': return checkOracle(check.file, host);
    case 'evidenceQuote': return checkEvidenceQuote(check.file, host);
    case 'pocReplay': return checkPocReplay(check.file, host);
    case 'chainHead': return checkChainHead();
    case 'chainHeadVerifications': return checkChainHeadVerifications();
    case 'gatePassed': return checkGatePassed(check.gateId, host);
    default: return { ok: false, detail: `unknown check kind: ${check.kind}` };
  }
}

// E3: quando la fase dichiara reports: (workflow), i check kind 'file' hardcoded vengono
// SOSTITUITI dai report dichiarati; gli altri check (incl. SA1 chain/oracle/evidenceQuote)
// restano. Fasi senza dichiarazioni → elenco hardcoded (legacy byte-identico).
function gateChecks(gateId, workflowReports) {
  const gate = GATES[gateId];
  const declared = workflowReports && workflowReports[gateId];
  if (!declared || !declared.length) return gate.checks;
  const nonFile = gate.checks.filter((c) => c.kind !== 'file');
  const declaredChecks = declared.map((r) => ({
    kind: 'file', file: r.path,
    hint: `declared report${r.type ? ' (' + r.type + ')' : ''}${r.surface ? ', surface ' + r.surface : ''}`,
    declared: true, surface: r.surface || null, type: r.type || null,
  }));
  return [...nonFile, ...declaredChecks];
}

function runGate(gateId, opts) {
  opts = opts || {};
  const gate = GATES[gateId];
  if (!gate) return null;
  const checks = gateChecks(gateId, opts.workflowReports);
  const state = { host: opts.host || null };
  const results = checks.map((c) => runCheck(c, state));
  const allOk = results.every((r) => r.ok);
  return { gateId, title: gate.title, allOk, results, manual: gate.manual, checks, host: state.host };
}

// Carica i reports: dichiarati da un workflow (dialetto workflow.js). Fail-closed: YAML
// malformato o dialetto invalido → errore esplicito, mai fallback silenzioso al legacy.
function loadWorkflowReports(file) {
  const wf = require('./workflow');
  let loaded;
  try { loaded = wf.loadWorkflow(file); }
  catch (e) { throw new Error(`workflow load failed (${file}): ${e.message}`); }
  const errs = wf.validateDoc(loaded.doc);
  if (errs.length) throw new Error(`workflow invalid (${file}): ${errs.join('; ')}`);
  return (loaded.doc && loaded.doc.reports) || {};
}

// Un pass è valido per l'host che lo ha prodotto. Righe storiche (senza host) restano valide
// solo per il check globale: così un ingaggio chiuso non sblocca più il successivo.
const HOST_TAG = 'host=';

function gateLogHasPass(logText, gateId, host) {
  const needle = `${MODE}/${gateId}`;
  const want = host ? normalizeHost(host) : null;
  for (const line of String(logText ?? '').split('\n')) {
    if (!line.includes('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    if (!cells.includes(needle) || !cells.includes('pass')) continue;
    if (!want) return true; // legacy/global query
    const tagged = cells.find((c) => c.startsWith(HOST_TAG));
    const declared = tagged ? normalizeHost(tagged.slice(HOST_TAG.length).split(';')[0]) : '';
    if (declared && declared === want) return true;
  }
  return false;
}

function appendGateLog(gateId, verdict, detail, host) {
  const tag = host ? `${HOST_TAG}${normalizeHost(host)}; ` : '';
  const line = `| ${new Date().toISOString()} | ${MODE}/${gateId} | ${verdict} | ${tag}${detail} |`;
  try {
    fs.mkdirSync(path.dirname(GATE_LOG()), { recursive: true });
    fs.appendFileSync(GATE_LOG(), line + '\n');
  } catch {}
}

// ─── CLI ───

// Un gate è host-scoped se almeno un suo criterio legge artefatti per-host. Per questi gate
// l'host è obbligatorio: un PASS globale non verificherebbe nulla di ciò che il gate promette.
function gateRequiresHost(gateId, workflowReports) {
  const checks = gateChecks(gateId, workflowReports);
  return checks.some((c) => c.kind === 'coverage' || c.kind === 'gatePassed'
    || (typeof c.file === 'string' && c.file.includes('{host}')));
}

function loadReportsOrExit(workflowFile) {
  if (!workflowFile) return null;
  try { return loadWorkflowReports(workflowFile); } catch (e) { console.error('[gate] ' + e.message); process.exit(1); }
}

function cmdStatus(host, workflowFile) {
  const workflowReports = loadReportsOrExit(workflowFile);
  if (host) console.log(`[gate] engagement host: ${normalizeHost(host)}`);
  for (const [id, gate] of Object.entries(GATES)) {
    const r = runGate(id, { workflowReports, host });
    const passed = gateLogHasPass(readText(GATE_LOG()), id, host);
    const status = passed ? '✔ PASS' : '✗ MISS';
    console.log(`${status} ${id} — ${gate.title}`);
    if (!passed) {
      for (const c of r.results) {
        if (!c.ok) console.log(`     ${c.detail}`);
      }
    }
  }
}

function cmdPass(gateId, host, workflowFile) {
  const gate = GATES[gateId];
  if (!gate) {
    console.error(`unknown gate: ${gateId}. Valid: ${Object.keys(GATES).join(', ')}`);
    process.exit(2);
  }
  const workflowReports = loadReportsOrExit(workflowFile);
  if (!host && gateRequiresHost(gateId, workflowReports)) {
    console.error(`[gate] host required for gate '${gateId}': its criteria read per-engagement artifacts (map, coverage, findings).`);
    console.error(`[gate] usage: node tools/gate.js pass ${gateId} <host>`);
    process.exit(2);
  }
  const r = runGate(gateId, { workflowReports, host });
  const where = host ? ` (${normalizeHost(host)})` : '';
  if (r.allOk) {
    const detail = r.results.map((c) => c.detail).join('; ');
    appendGateLog(gateId, 'pass', detail, host);
    console.log(`[gate] PASS ${gateId}${where} — ${gate.title}`);
    process.exit(0);
  } else {
    for (const c of r.results) {
      if (!c.ok) console.error(`[gate] FAIL: ${c.detail}`);
    }
    console.error(`[gate] ${gateId} gate NOT passed${where} — fix the criteria above`);
    process.exit(1);
  }
}

function cmdCheck(gateId, host) {
  const workflowReports = loadReportsOrExit(process.env.GATE_WORKFLOW_FILE || null);
  if (!host && gateRequiresHost(gateId, workflowReports)) {
    console.log(`[gate] ${gateId} MISS (host required: node tools/gate.js check ${gateId} <host>)`);
    process.exit(1);
  }
  const passed = gateLogHasPass(readText(GATE_LOG()), gateId, host);
  const where = host ? ` (${normalizeHost(host)})` : '';
  if (passed) { console.log(`[gate] ${gateId} PASS${where}`); process.exit(0); }
  else { console.log(`[gate] ${gateId} MISS${where}`); process.exit(1); }
}

function main() {
  const args = process.argv.slice(2);
  const wfIndex = args.indexOf('--workflow');
  const workflowFile = wfIndex >= 0 ? args[wfIndex + 1] : (process.env.GATE_WORKFLOW_FILE || null);
  // `--workflow <file>` consuma il proprio valore: non deve mai finire fra i posizionali
  // (altrimenti pass/check leggerebbero il path del workflow come host).
  const positional = args.filter((a, i) => !a.startsWith('--') && (wfIndex < 0 || i !== wfIndex + 1));
  const cmd = positional[0];
  if (cmd === 'status' && positional[1]) {
    cmdStatus(positional[1], workflowFile);
  } else if (cmd === 'pass' && positional[1]) {
    cmdPass(positional[1], positional[2] || null, workflowFile);
  } else if (cmd === 'check' && positional[1]) {
    cmdCheck(positional[1], positional[2] || null);
  } else {
    console.error('usage: node tools/gate.js <status <host> | pass <phase> [host] | check <phase> [host]> [--workflow <file.yaml>]');
    console.error('phases: ' + Object.keys(GATES).join(', '));
    process.exit(2);
  }
}

if (require.main === module) main();

module.exports = { GATES, runGate, gateChecks, gateRequiresHost, loadWorkflowReports, gateLogHasPass, normalizeHost, hostMatches, safeHost, checkFile, checkMarkers, checkFindings, checkVerify, checkNoPending, checkCoverage, parseCoverageRows, checkGatePassed, checkAttackCoverage, checkScopeNonEmpty, checkChain, checkOracle, checkEvidenceQuote, checkPocReplay, checkChainHead, checkChainHeadVerifications, effectiveRows };