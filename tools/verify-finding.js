#!/usr/bin/env node
// Oracle-verification: a finding is not PROVEN until its structured `verify` PoC re-fires N/N
// against the LIVE target through repeater's request engine. Ladder: inconclusive < confirmed
// (agent asserts) < verified (oracle re-fired N/N). Only findings carrying a `verify` block
// auto-verify (no prose parsing).
//
// Ondata 7 (2026-09-28) — PERCHÉ `batch` NON SCRIVE PIÙ `findings.jsonl`.
// `findings.jsonl` è append-only, incatenato (A3) e ancorato esternamente (Ondata 6), e
// deduplicato per chiave: una verifica fatta DOPO la registrazione non ha un posto dove finire
// là dentro, e riscrivere le righe in place rompe la catena — da lì `record()` rifiuta ogni
// append e il gate `chain` fallisce (era il percorso documentato in knowledge.md: il footgun).
// La verifica è un fatto nuovo, non la modifica di un fatto vecchio: `batch` verifica, scrive il
// receipt dell'oracolo e APPENDE l'esito a tools/verification-log.js (stessa disciplina:
// append-only, catena, ancora). La vista effettiva dei finding si legge con
// `node tools/effective-findings.js list`.
//
// `verifyFile()` resta esportato per compatibilità, ma è fail-closed: su un file che contiene
// righe incatenate RIFIUTA di riscrivere (a meno di `allowRewrite` esplicito), perché una
// riscrittura in place è indistinguibile da una manomissione per la catena e per l'ancora.
//
// verify block (optional, in the finding JSON):
//   "verify": { "method":"GET", "url":"https://HOST/api/x", "as":"user_a", "data":null,
//               "expect": { "status":200, "body_contains":"marker",
//                           "body_similarity_to":null, "similarity_min":0.6 } }
'use strict';
const fs = require('fs');
const path = require('path');
const chain = require('./chain-log');

const FINDINGS = () => process.env.FINDINGS_JSONL || path.join(__dirname, '..', 'reports', 'findings.jsonl');

function readLines(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { return []; }
}

// Check one response against an expect block. Returns { ok, reason }.
function checkExpect(res, expect, baselineBody) {
  if (res.error) return { ok: false, reason: 'request error: ' + res.error };
  if (res.timeout) return { ok: false, reason: 'timeout' };
  if (expect.status != null && res.status !== expect.status)
    return { ok: false, reason: `status ${res.status} !== ${expect.status}` };
  const body = res.body || '';
  if (expect.body_contains && !body.includes(expect.body_contains))
    return { ok: false, reason: `body missing "${expect.body_contains}"` };
  if (expect.body_similarity_to) {
    const { similarity } = require('./repeater');
    const min = expect.similarity_min != null ? expect.similarity_min : 0.6;
    const sim = similarity(baselineBody || '', body);
    if (sim < min) return { ok: false, reason: `similarity ${sim.toFixed(3)} < ${min}` };
  }
  // Header assertions. Senza questi, una classe la cui prova è un HEADER (CORS: ACAO riflesso
  // con credentials) non poteva essere ri-sparata: il corpo non contiene niente che lo
  // dimostri, e l'oracle finiva per validare una cosa diversa dalla finding.
  if (expect.headers) {
    const got = res.headers || {};
    // "assente dalla risposta" e "non osservabile dal motore" sono due diagnosi opposte, e
    // confonderle costa un'indagine intera sul posto sbagliato: il primo è un PoC che non
    // regge, il secondo è un buco dell'harness. Successo sul reale: una finding open-redirect
    // che asseriva su `Location` falliva dicendo "header absent" — era il filtro del motore,
    // non il bersaglio.
    const observable = new Set(require('./repeater').SEC_HEADERS.map(String));
    for (const [k, want] of Object.entries(expect.headers)) {
      const key = String(k).toLowerCase();
      if (!observable.has(key)) {
        return { ok: false, reason: `header ${k} is not observable through the request engine (repeater filters it; add it to SEC_HEADERS) — this is a harness gap, not a failed PoC` };
      }
      const v = got[key];
      if (v == null) return { ok: false, reason: `header ${k} absent from the response` };
      const actual = Array.isArray(v) ? v.join(', ') : String(v);
      const w = String(want);
      if (w === '*') continue;
      if (actual !== w) return { ok: false, reason: `header ${k} = "${actual}" !== "${w}"` };
    }
  }
  return { ok: true, reason: 'ok' };
}

// Re-fire a finding's verify PoC `times` times. Passes only if ALL runs satisfy `expect`.
async function verifyOne(finding, { times = 2, exec } = {}) {
  const v = finding && finding.verify;
  if (!v || !v.url) return { verified: false, runs: [], reason: 'no verify block' };
  exec = exec || defaultExec;
  const expect = v.expect || {};
  let baselineBody = null;
  if (expect.body_similarity_to) {
    const b = await exec({ method: 'GET', url: expect.body_similarity_to, as: v.as, data: null });
    baselineBody = b.body || '';
  }
  const runs = [];
  for (let i = 0; i < times; i++) {
    const res = await exec({ method: v.method || 'GET', url: v.url, data: v.data == null ? null : v.data, as: v.as, headers: finding.headers });
    const c = checkExpect(res, expect, baselineBody);
    runs.push({ status: res.status, ok: c.ok, reason: c.reason });
    if (!c.ok) return { verified: false, runs, reason: `run ${i + 1}/${times} failed: ${c.reason}` };
  }
  return { verified: true, runs, reason: `${times}/${times} passed` };
}

// Default exec: reuse repeater's request engine (scope guard + DNS pin + identity headers).
async function defaultExec({ method, url, data, as, headers }) {
  const { loadScope } = require('./scope-guard');
  const rep = require('./repeater');
  const scope = loadScope();
  const idHeaders = await rep.resolveIdentity(as);
  const headerMap = {};
  const hdrList = ['User-Agent: ' + rep.DEFAULT_UA, ...idHeaders, 'Accept-Encoding: identity'];
  // JSON bodies need an explicit content type or ASP.NET-style APIs answer 415
  if (data != null && !hdrList.some((h) => h.toLowerCase().startsWith('content-type:'))) {
    hdrList.push('Content-Type: application/json');
  }// Gli header del finding (array "K: V") viaggiano con il re-fire. Servono a quelli che si
// dimostrano con una richiesta: un PoC CORS senza `Origin:` non dimostra niente, perche'
// senza Origin il server non riflette. Prima erano ignorati: il re-fire mandava solo UA,
// identita' e Accept-Encoding, quindi la classe era non verificabile per costruzione.
  for (const h of (Array.isArray(headers) ? headers : [])) {
    const i = String(h).indexOf(':');
    if (i > 0) headerMap[String(h).slice(0, i).trim()] = String(h).slice(i + 1).trim();
  }
  for (const h of hdrList) {
    const i = h.indexOf(':');
    if (i > 0) headerMap[h.slice(0, i).trim()] = h.slice(i + 1).trim();
  }
  const headersFor = () => Object.assign({}, headerMap);
  const res = await rep.sendChain(url, method || 'GET', headersFor, data == null ? null : data,
    { timeout: 10000, showBody: true, follow: false }, scope);
  if (res.blocked) return { error: 'scope-blocked: ' + res.reason };
  return res; // { status, body, headers, ... }
}

// Receipt dell'oracolo per un esito di re-fire: l'anchor è la stringa che poi viene quotata
// verbatim come evidence_quote (A2). Entrambi gli esiti — passato e fallito — lasciano traccia
// su disco: un tentativo di verifica fallito è un fatto della prova come uno riuscito.
function receiptFor(finding, key, r) {
  const safe = String(r.reason == null ? '' : r.reason).replace(/["\\\u0000-\u001F]/g, '');
  const anchor = `outcome ${r.verified ? 'passed' : 'failed'}: ${safe}`;
  const rec = require('./oracle').writeReceipt({
    type: 'http-diff',
    anchor,
    data: {
      detail: 'verify-refire',
      finding_key: key,
      url: finding.verify.url,
      method: finding.verify.method || 'GET',
      runs: Array.isArray(r.runs) ? r.runs : [],
      verify_reason: safe,
      source: 'verify-finding/verifyBatch',
    },
  });
  if (!rec.ok) return { ok: false, error: rec.error };
  return { ok: true, anchor, oracle: { type: 'http-diff', ref: rec.ref, token: rec.token }, evidence_quote: { file: rec.ref, text: anchor } };
}

// Batch: verifica i finding con blocco `verify` e APPENDE l'esito al side log. Non tocca
// findings.jsonl. Idempotente: un finding già `verified` nel side log viene saltato.
// opts: { file, verificationsFile, times, exec, log, keyOf }
async function verifyBatch(opts) {
  const o = opts || {};
  const file = o.file || FINDINGS();
  const exec = o.exec || defaultExec;
  const vlog = o.log || require('./verification-log');
  const keyOf = o.keyOf || ((f) => require('./record-finding').key(f));
  const findings = readLines(file).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const priorRecords = vlog.read({ file: o.verificationsFile });
  const out = { file, findings: findings.length, checked: 0, verified: 0, failed: 0, skipped_verified: 0, no_verify_block: 0, appended: 0, errors: [] };
  for (let i = 0; i < findings.length; i++) {
    const f = findings[i];
    if (!f.verify || !f.verify.url) { out.no_verify_block++; continue; }
    const key = keyOf(f);
    const seq = (f.chain && Number.isInteger(f.chain.seq)) ? f.chain.seq : i + 1;
    const prior = (o.verificationsFile ? priorRecords : vlog.read()).filter((x) => x.finding_key === key).pop();
    if (prior && prior.outcome === 'verified') { out.skipped_verified++; continue; }
    out.checked++;
    const r = await verifyOne(f, { times: o.times || 2, exec });
    if (r.verified) out.verified++; else out.failed++;
    const receipt = receiptFor(f, key, r);
    if (!receipt.ok) {
      out.errors.push({ key, error: `receipt not written (${receipt.error}) — outcome NOT recorded (fail-closed)` });
      continue;
    }
    const res = vlog.append({
      finding_key: key,
      finding_seq: seq,
      outcome: r.verified ? 'verified' : 'failed',
      reason: r.reason,
      runs: r.runs,
      oracle: receipt.oracle,
      evidence_quote: receipt.evidence_quote,
      verifier: 'verify-finding/batch',
      _file: o.verificationsFile,
    });
    if (res.ok) out.appended++;
    else out.errors.push({ key, error: res.error });
  }
  return out;
}

// Compatibilità: applica in place i risultati su un file di finding. FAIL-CLOSED su un log
// incatenato — riscriverlo romperebbe la catena A3 e l'ancora esterna (usare `batch`/rechain.js).
async function verifyFile(file, opts) {
  const o = opts || {};
  file = file || FINDINGS();
  const lines = readLines(file);
  const state = chain.verifyChain(lines);
  if (state.ok && state.chained > 0 && !o.allowRewrite)
    return {
      ok: false, updated: 0, checked: 0,
      error: `refusing to rewrite ${path.basename(file)} in place: ${state.chained} chained line(s) would break the A3 hash-chain and the external head anchor. Use verifyBatch()/CLI 'batch' (append-only side log), or tools/rechain.js after an explicit reconciliation.`,
    };
  if (!lines.length) return { ok: true, updated: 0, checked: 0, reason: 'no findings file' };
  let updated = 0, checked = 0;
  const out = [];
  for (const line of lines) {
    let f;
    try { f = JSON.parse(line); } catch { out.push(line); continue; }
    if (f.verify && f.status !== 'verified') {
      checked++;
      const r = await verifyOne(f, { exec: o.exec });
      if (r.verified) { f.status = 'verified'; f.verified = true; f.verified_at = new Date().toISOString(); updated++; }
      else { f.verify_failed = true; f.verify_reason = r.reason; }
      out.push(JSON.stringify(f));
    } else out.push(line);
  }
  const tmp = file + '.' + process.pid;
  fs.writeFileSync(tmp, out.join('\n') + '\n');
  fs.renameSync(tmp, file);
  return { ok: true, updated, checked };
}

module.exports = { verifyOne, verifyBatch, verifyFile, checkExpect, receiptFor, FINDINGS };

if (require.main === module) {
  (async () => {
    const [cmd, arg] = process.argv.slice(2);
    const flag = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
    if (cmd === 'one') {
      console.log(JSON.stringify(await verifyOne(JSON.parse(arg)), null, 2));
      process.exit(0);
    } else if (cmd === 'batch') {
      const r = await verifyBatch({ file: flag('--file'), verificationsFile: flag('--log') });
      console.log(JSON.stringify(r, null, 2));
      process.exit(r.errors.length ? 1 : 0);
    } else {
      console.error("usage: node verify-finding.js one '<finding-json>' | batch [--file findings.jsonl] [--log verifications.jsonl]");
      process.exit(2);
    }
  })();
}
