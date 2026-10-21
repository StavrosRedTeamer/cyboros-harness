#!/usr/bin/env node
// effective-findings.js — la vista EFFETTIVA dei finding: `findings.jsonl` (immutabile) fuso con
// il side log delle verifiche. Un finding non viene mai riscritto: la sua promozione a
// `verified` è un fatto registrato altrove e qui calcolato.
//
// Perché una vista e non una scrittura: `findings.jsonl` è incatenato (A3), quindi modificarlo è
// indistinguibile da una manomissione. La conseguenza di leggere le righe grezze è che un
// finding verificato *dopo* la registrazione non risulta verificato; la conseguenza di riscriverlo
// è rompere la catena. La vista è la terza opzione.
//
// Regole del fold (fail-closed VERSO IL BASSO: la vista non promuove mai più di quanto il disco
// non provi, e senza side log il risultato è identico alle righe grezze):
//   1. nessun record per la chiave            → resta lo stato registrato;
//   2. outcome 'failed'                       → `verify_failed` esposto, nessuna promozione;
//   3. outcome 'verified'                     → promozione SOLO se oracle e quote si ri-validano
//                                               su disco ADESSO (mai fidandosi del record);
//   4. più record per la stessa chiave        → vince l'ultimo;
//   5. record con `finding_seq` successivo a quello del finding → non applicato (una verifica non
//      anticipa ciò che verifica), e il motivo finisce in `diagnostics`.
'use strict';
const fs = require('fs');
const path = require('path');
const { validateOracle, claimingReality } = require('./oracle');
const { validateQuote } = require('./evidence-quote');
const vlog = require('./verification-log');
const { key: findingKey } = require('./record-finding');

const FINDINGS = () => process.env.FINDINGS_JSONL || require('./config').dataPaths().findings;

// Un record promuove solo se il disco, ora, regge: oracle rivalidato e quote verbatim.
function promotable(rec) {
  if (rec.outcome !== 'verified') return { ok: false, reason: `outcome '${rec.outcome}' does not promote (a failed verification is a fact, not a promotion)` };
  const oerr = validateOracle(rec.oracle);
  if (oerr) return { ok: false, reason: `oracle no longer validates on disk: ${oerr}` };
  if (!rec.evidence_quote || typeof rec.evidence_quote !== 'object')
    return { ok: false, reason: 'record carries no evidence_quote' };
  const qerr = validateQuote({ status: 'verified', evidence_quote: rec.evidence_quote });
  if (qerr) return { ok: false, reason: `evidence quote is not verbatim on disk any more: ${qerr}` };
  return { ok: true };
}

function fold(findings, records) {
  const byKey = new Map();
  for (const r of records || []) {
    if (!r || typeof r.finding_key !== 'string') continue;
    const arr = byKey.get(r.finding_key);
    if (arr) arr.push(r);
    else byKey.set(r.finding_key, [r]);
  }
  const diagnostics = [];
  const out = (findings || []).map((f, i) => {
    const seq = (f.chain && Number.isInteger(f.chain.seq)) ? f.chain.seq : i + 1;
    const key = findingKey(f);
    const row = Object.assign({}, f, {
      effective_status: f.status,
      effective_verify_level: f.verify_level,
      // Lo stato REGISTRATO resta leggibile: la vista non cancella ciò che la catena dice, lo
      // affianca. `status`/`verify_level` diventano però lo stato effettivo quando una verifica
      // valida promuove il finding, così un consumer che legge `status` vede la verità effettiva
      // (ed è il motivo per cui claimingReality() continua a funzionare sulla vista).
      registered_status: f.status,
      registered_verify_level: f.verify_level,
      verification: null,
      verified: f.verified === true,
    });
    const candidates = byKey.get(key) || [];
    if (!candidates.length) return row;
    const applicable = candidates.filter((c) => Number.isInteger(c.finding_seq) && c.finding_seq <= seq);
    if (!applicable.length) {
      diagnostics.push({ key, finding_seq: seq, reason: 'verification record(s) exist but all point to a later finding line — not applied' });
      return row;
    }
    const rec = applicable[applicable.length - 1];
    row.verification = {
      seq: rec.chain ? rec.chain.seq : null,
      outcome: rec.outcome,
      verifier: rec.verifier || null,
      ts: rec.ts || null,
      reason: rec.reason || null,
      runs: rec.runs || null,
    };
    if (rec.outcome === 'failed') {
      row.verify_failed = true;
      row.verify_reason = rec.reason || row.verify_reason;
      diagnostics.push({ key, finding_seq: seq, reason: `verification ${row.verification.seq} failed: ${rec.reason || 'no reason recorded'}` });
      return row;
    }
    const p = promotable(rec);
    if (!p.ok) {
      diagnostics.push({ key, finding_seq: seq, reason: `verification ${row.verification.seq} does not promote: ${p.reason}` });
      return row;
    }
    row.effective_status = 'verified';
    row.status = 'verified';
    row.verified = true;
    row.verified_at = rec.ts || row.verified_at;
    row.oracle = rec.oracle;
    row.evidence_quote = rec.evidence_quote;
    return row;
  });
  return { findings: out, diagnostics };
}

function load(opts) {
  const o = opts || {};
  const file = o.findingsFile || FINDINGS();
  let findings = [];
  try {
    findings = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { findings = []; }
  return { findings, records: vlog.read({ file: o.verificationsFile }) };
}

function effectiveFindings(opts) {
  const { findings, records } = load(opts);
  return fold(findings, records);
}

// Pendente, in una definizione FALSIFICABILE. La vecchia definizione (`status === 'pending'`)
// non poteva fallire: `validate()` impone lo status e ammette solo confirmed|inconclusive|verified,
// quindi nessun corpus registrato dal validator attuale poteva contenerne uno — uno dei tre
// criteri del gate "nessun report senza..." era decorativo. Pendente significa ora: un finding
// che RIVENDICA REALTÀ e la cui catena di prova non è risolta, cioè
//   (a) una verifica registrata è fallita, oppure
//   (b) l'oracle non regge più su disco, oppure
//   (c) un esito 'verified' è stato registrato ma non promuove (prova non sostanziabile).
// Un `confirmed` con un oracle valido NON è pendente: è risolto come "provato fino a confirmed",
// e il gate ha già `verify` (min 1) per chiedere che almeno uno arrivi a verified.
function isPending(f) {
  if (!f || typeof f !== 'object') return false;
  if (!(claimingReality(f) || f.effective_status === 'verified')) return false;
  if (f.verify_failed) return true;
  if (f.effective_status !== 'verified' && validateOracle(f.oracle)) return true;
  if (f.verification && f.verification.outcome === 'verified' && f.effective_status !== 'verified') return true;
  return false;
}

function pendingFindings(opts) {
  const { findings, diagnostics } = effectiveFindings(opts);
  return findings.filter(isPending).map((f) => ({
    key: findingKey(f),
    status: f.effective_status,
    verify_level: f.effective_verify_level,
    verify_failed: f.verify_failed === true,
    oracle_error: f.effective_status === 'verified' ? null : validateOracle(f.oracle),
    diagnostics: diagnostics.filter((d) => d.key === findingKey(f)).map((d) => d.reason),
  }));
}

module.exports = { fold, load, effectiveFindings, pendingFindings, isPending, promotable, FINDINGS };

if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'list';
  if (cmd === 'list') {
    const { findings, diagnostics } = effectiveFindings();
    // --out scrive il VERO elenco come array JSON: e' il formato che `gen-bench.js eval
    // --findings` accetta, quindi la vista effettiva (che e' l'unica onesta, perche' promuove
    // a verified solo cio che il disco dimostra ancora) diventa direttamente punteggiabile.
    // Senza questo, l'export naturale ({findings, diagnostics}) viene respinto da eval come
    // "JSON array atteso" e l'ultimo passo della pipeline muore su un dettaglio di forma.
    const outAt = args.indexOf('--out');
    if (outAt >= 0) {
      const dest = args[outAt + 1];
      if (!dest) {
        console.error('effective-findings: --out richiede un percorso');
        process.exit(2);
      }
      fs.writeFileSync(dest, JSON.stringify(findings, null, 2) + '\n');
      for (const d of diagnostics) console.error(`  note: ${d.key} — ${d.reason}`);
      console.log(dest + ' (' + findings.length + ' findings)');
      process.exit(0);
    }
    if (args.includes('--json')) console.log(JSON.stringify({ findings, diagnostics }, null, 2));
    else {
      for (const f of findings) console.log(`${f.effective_status}\t${findingKey(f)}`);
      for (const d of diagnostics) console.log(`  note: ${d.key} — ${d.reason}`);
    }
    process.exit(0);
  }
  if (cmd === 'pending') {
    const p = pendingFindings();
    console.log(JSON.stringify(p, null, 2));
    process.exit(p.length ? 1 : 0);
  }
  console.error("usage: node tools/effective-findings.js list [--json] [--out <file>] | pending");
  process.exit(2);
}
