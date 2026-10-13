#!/usr/bin/env node
// verification-log.js — il side log append-only dei FATTI DI VERIFICA.
//
// Perché esiste. `reports/findings.jsonl` è append-only e deduplicato per chiave
// (host|endpoint|title): una volta registrato un finding non ha più un posto dove scrivere che
// una verifica è avvenuta DOPO. L'unico percorso esistente (verify-finding.js batch) riscriveva
// le righe in place, cioè rompeva la catena A3 di `findings.jsonl` — e da lì `record()` rifiuta
// ogni append e il gate `chain` fallisce. Il principio: **la verifica è un fatto nuovo, non la
// modifica di un fatto vecchio.** Quindi vive qui, in un log con la stessa disciplina
// (append-only, catena hash, ancora esterna) e `findings.jsonl` resta immutabile.
//
// Record:
//   { kind:'verification', finding_key:'host|endpoint|title', finding_seq:12,
//     outcome:'verified'|'failed', reason, runs, oracle:{type,ref,token},
//     evidence_quote:{file,text}, verifier, ts, chain:{seq,prev_sha256,ts} }
//
// Fail-closed: un record `verified` senza un oracle valido SU DISCO (ora) e senza una quote
// verbatim non si scrive; con la catena rotta non si appende nulla.
//
// CLI:
//   node tools/verification-log.js append '<json>'   # appende un record (valida prima)
//   node tools/verification-log.js verify            # catena + ancora esterna (exit 0/1)
//   node tools/verification-log.js list [--json]
'use strict';
const fs = require('fs');
const path = require('path');
const chain = require('./chain-log');
const { validateOracle, WS_ROOT } = require('./oracle');
const { validateQuote } = require('./evidence-quote');

const FILE = () => process.env.VERIFICATIONS_JSONL || path.join(WS_ROOT(), 'reports', 'verifications.jsonl');
const ANCHOR = () => process.env.VERIFICATIONS_HEAD_ANCHOR_FILE
  || path.join(WS_ROOT(), 'reports', 'tmp', 'verifications-head-anchor.jsonl');
const ANCHOR_KIND = 'verifications-head-anchor';
const OUTCOMES = ['verified', 'failed'];

// Un record `verified` è una rivendicazione di realtà: oracle e quote si ri-validano su disco
// ADESSO, non si crede al chiamante. Un `failed` è un fatto legittimo e non promuove nulla.
function validate(rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return 'record must be an object';
  if (rec.kind != null && rec.kind !== 'verification') return `record.kind must be 'verification' (got ${JSON.stringify(rec.kind)})`;
  if (typeof rec.finding_key !== 'string' || !rec.finding_key.trim()) return 'finding_key is required (the finding dedup key: host|endpoint|title)';
  if (!Number.isInteger(rec.finding_seq) || rec.finding_seq < 1) return 'finding_seq is required (the 1-based line number of the finding in findings.jsonl)';
  if (!OUTCOMES.includes(rec.outcome)) return `outcome must be one of ${OUTCOMES.join('|')}`;
  if (rec.finding_key.length > 512) return 'finding_key too long (max 512)';
  if (typeof rec.reason === 'string' && Buffer.byteLength(rec.reason, 'utf8') > 4096) return 'reason too long (max 4096 bytes)';
  if (rec.outcome === 'verified') {
    const oerr = validateOracle(rec.oracle);
    if (oerr) return `outcome 'verified' requires a mechanical oracle valid on disk: ${oerr}`;
    if (!rec.evidence_quote || typeof rec.evidence_quote !== 'object')
      return "outcome 'verified' requires evidence_quote {file,text} (the exact slice of the oracle artifact)";
    const qerr = validateQuote({ status: 'verified', evidence_quote: rec.evidence_quote });
    if (qerr) return `evidence_quote invalid: ${qerr}`;
  }
  return null;
}

// Appende un record. Idempotente per (finding_key, outcome, oracle.ref): rieseguire la stessa
// verifica non gonfia il log, cambia solo il verdetto cambiato.
function append(rec) {
  const err = validate(rec);
  if (err) return { ok: false, error: err };
  const file = rec._file || FILE();
  const anchorFile = rec._anchorFile || ANCHOR();
  const existing = chain.readLines(file);
  // Idempotenza sulla CONCLUSIONE, non sul receipt: rieseguire la stessa verifica produce un
  // receipt NUOVO (token casuale), quindi confrontare l'oracle non deduplicherebbe mai. La stessa
  // conclusione con lo stesso motivo e gli stessi run è lo stesso fatto; cambia la conclusione (o
  // il motivo), e allora è una riga nuova — l'ultima vince (vedi effective-findings.js).
  const last = lastFor(chain.readJsonl(file), rec.finding_key);
  if (last && last.outcome === rec.outcome
    && String(last.reason || '') === String(rec.reason || '')
    && JSON.stringify(last.runs || null) === JSON.stringify(rec.runs || null))
    return { ok: true, deduped: true, finding_key: rec.finding_key, outcome: rec.outcome, seq: last.chain ? last.chain.seq : null };
  const out = Object.assign({ kind: 'verification' }, rec);
  delete out._file;
  delete out._anchorFile;
  out.ts = out.ts || new Date().toISOString();
  const res = chain.appendChained(file, out, {
    fileName: path.basename(file), anchorFile, anchorKind: ANCHOR_KIND,
  });
  if (!res.ok) return res;
  return { ok: true, seq: res.seq, finding_key: out.finding_key, outcome: out.outcome, head_anchor: res.head_anchor };
}

function lastFor(records, key) {
  let found = null;
  for (const r of records) if (r.finding_key === key) found = r;
  return found;
}

function read(opts) {
  return chain.readJsonl((opts && opts.file) || FILE());
}

// Verifica del log: catena + testa ancorata, con le riconciliazioni eventuali nominate.
function verify(opts) {
  const o = opts || {};
  const file = o.file || FILE();
  const anchorFile = o.anchorFile || ANCHOR();
  const lines = chain.readLines(file);
  const state = chain.verifyChain(lines);
  if (!state.ok) return { ok: false, detail: `${path.basename(file)} chain broken at line ${state.index + 1}: ${state.reason}` };
  const head = chain.verifyHeadAnchor({ file, anchorFile, kind: ANCHOR_KIND, fileName: path.basename(file) });
  return { ok: head.ok, detail: `${path.basename(file)}: ${state.chained} chained, ${state.legacy} legacy — ${head.detail}`, chain: state, head };
}

module.exports = { FILE, ANCHOR, ANCHOR_KIND, OUTCOMES, validate, append, read, verify, lastFor };

if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (cmd === 'append') {
    let rec;
    try { rec = JSON.parse(args[1] || ''); } catch (e) {
      console.log(JSON.stringify({ ok: false, error: 'invalid JSON: ' + e.message }));
      process.exit(1);
    }
    const r = append(rec);
    console.log(JSON.stringify(r));
    process.exit(r.ok ? 0 : 1);
  }
  if (cmd === 'verify') {
    const r = verify();
    console.log(JSON.stringify(r));
    process.exit(r.ok ? 0 : 1);
  }
  if (cmd === 'list') {
    const rows = read();
    if (args.includes('--json')) console.log(JSON.stringify(rows, null, 2));
    else for (const r of rows) console.log(`${r.chain ? r.chain.seq : '-'}\t${r.outcome}\t${r.finding_key}`);
    process.exit(0);
  }
  console.error("usage: node tools/verification-log.js append '<json>' | verify | list [--json]");
  process.exit(2);
}
