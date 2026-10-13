#!/usr/bin/env node
// chain-log.js — un solo posto per la meccanica dei log append-only con catena hash (A3) e
// ancora esterna (Ondata 6). Estratto da record-finding.js perché lo stesso contratto serve ora
// anche al side log delle verifiche (tools/verification-log.js): una seconda copia della stessa
// meccanica è una seconda copia che diverge.
//
// Contratto, identico per ogni log che usa questo modulo:
//   - ogni riga è JSON con `chain:{seq, prev_sha256, ts}`;
//   - `prev_sha256` è lo sha256 della riga precedente NON VUOTA, come scritta su disco
//     (newline escluso); GENESIS ('0' ripetuto 64 volte) alla prima riga;
//   - un prefisso non incatenato è 'legacy' (informativo: mai fallito retroattivamente);
//   - una riga non incatenata DOPO una incatenata è manomissione (fail-closed);
//   - `seq` deve combaciare con la posizione: un buco è manomissione.
//
// Perché l'ancora esterna: la catena da sola rileva una modifica a metà file, ma una riscrittura
// TOTALE (catena rigenerata da zero) sarebbe di nuovo coerente al suo interno. Ogni append scrive
// quindi la nuova testa in un log di ancore append-only, e `verifyHeadAnchor` la ri-confronta.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const GENESIS = '0'.repeat(64);

function sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

// Righe NON VUOTE del log (l'assenza del file è "log vuoto", non un errore).
function readLines(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { return []; }
}

// Verify a raw line array. Returns { ok:true, chained, legacy } | { ok:false, index, seq, reason }
function verifyChain(lines) {
  let chained = 0, legacy = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    let f = null;
    try { f = JSON.parse(raw); } catch { /* le righe non parsabili sono coperte dall'hash del testo */ }
    if (!f || typeof f.chain !== 'object' || f.chain === null) {
      if (chained > 0)
        return { ok: false, index: i, reason: `chain sequence interrupted: unchained line ${i + 1} follows a chained line` };
      legacy++;
      continue;
    }
    const expectedPrev = i === 0 ? GENESIS : sha256Hex(lines[i - 1]);
    if (f.chain.prev_sha256 !== expectedPrev)
      return { ok: false, index: i, seq: f.chain.seq, reason: `prev_sha256 mismatch at line ${i + 1} (expected ${expectedPrev.slice(0, 12)}…)` };
    if (f.chain.seq !== i + 1)
      return { ok: false, index: i, seq: f.chain.seq, reason: `seq gap at line ${i + 1}: chain.seq=${f.chain.seq}, expected ${i + 1}` };
    chained++;
  }
  return { ok: true, chained, legacy };
}

// Serialize `obj` (mutandolo: aggiunge/riscrive `chain`) come riga agganciata alla precedente.
// L'hash di una riga è calcolato sulla stringa ESATTA scritta su disco meno il newline finale.
function buildChainedLine(obj, existingRawLines, ts) {
  obj.chain = {
    seq: existingRawLines.length + 1,
    prev_sha256: existingRawLines.length ? sha256Hex(existingRawLines[existingRawLines.length - 1]) : GENESIS,
    ts: ts || new Date().toISOString(),
  };
  return JSON.stringify(obj);
}

// Testa della parte incatenata: {seq, head_sha256} oppure null quando non c'è ancora una riga
// incatenata (solo legacy, o log vuoto).
function chainHead(lines) {
  for (let i = (lines || []).length - 1; i >= 0; i--) {
    let f = null;
    try { f = JSON.parse(lines[i]); } catch { continue; }
    if (f && f.chain && typeof f.chain === 'object') return { seq: f.chain.seq, head_sha256: sha256Hex(lines[i]) };
  }
  return null;
}

function readJsonl(file) {
  return readLines(file).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// ─── ancore esterne ───

// Appende una voce al log delle ancore. `kind` distingue le voci di testa dalle riconciliazioni
// (una ricatena registrata è un evento della storia, non un'anomalia invisibile).
// Best-effort ma LOUD: l'esito torna al chiamante, che lo espone.
function appendHeadAnchor(spec) {
  const { anchorFile, headSha256, seq, kind, extra } = spec || {};
  try {
    if (!anchorFile) return { ok: false, error: 'anchorFile is required' };
    fs.mkdirSync(path.dirname(anchorFile), { recursive: true });
    fs.appendFileSync(anchorFile, JSON.stringify(Object.assign({
      kind: kind || 'findings-head-anchor', ts: new Date().toISOString(), seq, head_sha256: headSha256,
    }, extra || {})) + '\n');
    return { ok: true, file: anchorFile };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

// Confronta l'ultima ancora con il log su disco. Fail-closed su ogni forma di manomissione:
// catena rotta, ancore senza righe incatenate (wipe), hash della riga ancorata diverso.
// spec: { file, anchorFile, kind?, rechainKind?, fileName? }
function verifyHeadAnchor(spec) {
  const s = spec || {};
  const anchorFile = s.anchorFile;
  const file = s.file;
  const kind = s.kind || 'findings-head-anchor';
  const name = s.fileName || path.basename(file || '');
  const all = readJsonl(anchorFile).filter((a) => a && typeof a.head_sha256 === 'string' && a.kind);
  const anchors = all.filter((a) => a.kind === kind);
  const rechains = s.rechainKind ? all.filter((a) => a.kind === s.rechainKind) : [];
  const rechainNote = rechains.length
    ? ` — ${rechains.length} riconciliazione/i registrata/e (kind=${s.rechainKind})`
    : '';
  if (!anchors.length) return { ok: true, detail: 'no head anchors recorded yet — nothing to compare (informational)' + rechainNote };
  const lines = readLines(file);
  const chainState = verifyChain(lines);
  if (!chainState.ok) return { ok: false, detail: `${name} chain broken: ${chainState.reason}${rechainNote}` };
  if (!chainState.chained)
    return { ok: false, detail: `${anchors.length} head anchor(s) exist but ${name} has no chained lines — possible wipe/tampering${rechainNote}` };
  const last = anchors[anchors.length - 1];
  const anchoredLine = Number.isInteger(last.seq) ? lines[last.seq - 1] : undefined;
  if (anchoredLine != null && sha256Hex(anchoredLine) === last.head_sha256)
    return { ok: true, detail: `head anchor #${anchors.length} (seq ${last.seq}) matches ${name} line ${last.seq}${rechainNote}` };
  return { ok: false, detail: `head anchor mismatch: anchor seq=${last.seq} head=${String(last.head_sha256).slice(0, 12)}… does not hash-match ${name} line ${last.seq} — chain was rewritten, truncated or wiped after anchoring${rechainNote}` };
}

// Append fail-closed: verifica la catena esistente, rifiuta di estendere una catena rotta,
// appende e ancora la nuova testa. Ritorna {ok, seq} | {ok:false, error} (+ head_anchor).
function appendChained(file, obj, spec) {
  const s = spec || {};
  const name = s.fileName || path.basename(file);
  const existing = readLines(file);
  const state = verifyChain(existing);
  if (!state.ok)
    return { ok: false, error: `${name} hash-chain broken at line ${state.index + 1}: ${state.reason} — refusing to append; investigate/restore ${name} before recording` };
  const line = buildChainedLine(obj, existing, s.ts || obj.ts);
  const selfCheck = verifyChain([...existing, line]);
  if (!selfCheck.ok) return { ok: false, error: `internal chain self-check failed (${selfCheck.reason}) — nothing written` };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line + '\n');
  } catch (e) {
    return { ok: false, error: `append failed: ${e && e.message ? e.message : String(e)}` };
  }
  const written = JSON.parse(line);
  const headAnchor = s.anchorFile
    ? appendHeadAnchor({ anchorFile: s.anchorFile, headSha256: sha256Hex(line), seq: written.chain.seq, kind: s.anchorKind })
    : { ok: true, file: null };
  return { ok: true, seq: written.chain.seq, head_anchor: headAnchor, line };
}

module.exports = {
  GENESIS, sha256Hex, readLines, readJsonl, verifyChain, buildChainedLine, chainHead,
  appendHeadAnchor, verifyHeadAnchor, appendChained,
};
