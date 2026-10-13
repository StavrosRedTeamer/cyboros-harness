#!/usr/bin/env node
// rechain.js — riconciliazione di una catena rotta (`findings.jsonl` o un altro log incatenato).
//
// Perché esiste. La meccanica A3 + ancora esterna (tools/chain-log.js) rende OVVIA una catena
// rotta ma non dava alcuna via di ripristino: `record()` rifiuta di estendere una catena rotta,
// il gate `chain` fallisce, e l'unica menzione della parola "riconciliata" era un commento nel
// sorgente. Peggio, una ricatena INGENUA è un secondo guasto: riscrivere il file rigenerando la
// catena lo rende internamente coerente e fa scattare il mismatch con l'ancora esterna — cioè
// passa da "catena rotta" a "catena manomessa", indistinguibile da un attacco.
//
// Cosa fa invece: (1) rifiuta di toccare una catena sana; (2) fa un backup prima di scrivere;
// (3) ricostruisce la catena sul contenuto ESISTENTE (le righe legacy restano byte-identiche, il
// suffisso incatenato riceve seq/prev_sha256 coerenti; nessun campo dei finding cambia, cambia
// solo `chain`); (4) APPENDE all'anchor log l'evento `findings-rechain` con testa vecchia, testa
// nuova, motivo e path del backup, PRIMA della nuova ancora. La riscrittura diventa così un fatto
// della storia verificabile, non un'anomalia indistinguibile da una manomissione.
//
// CLI (confirm-tier: la ragione è obbligatoria, come le altre azioni distruttive del repo):
//   node tools/rechain.js plan [--file <log>] [--anchor <f>]          # non scrive nulla
//   node tools/rechain.js run  [--file <log>] [--anchor <f>] --confirm "<motivo>"
'use strict';
const fs = require('fs');
const path = require('path');
const chain = require('./chain-log');

const WS = () => path.join(__dirname, '..');
const FILE = (f) => f || process.env.FINDINGS_JSONL || path.join(WS(), 'reports', 'findings.jsonl');
const ANCHOR = (a) => a || process.env.FINDINGS_HEAD_ANCHOR_FILE
  || path.join(WS(), 'reports', 'tmp', 'findings-head-anchor.jsonl');

function firstChainedIndex(lines) {
  for (let i = 0; i < lines.length; i++) {
    let f = null;
    try { f = JSON.parse(lines[i]); } catch { /* riga non parsabile: non incatenata */ }
    if (f && f.chain && typeof f.chain === 'object') return i;
  }
  return -1;
}

// Cosa farebbe `run`: nessuna scrittura, solo la lettura dello stato.
//
// Nota (perché serve anche l'ancora, non solo la catena): la catena rileva una manomissione
// tramite il `prev_sha256` della riga SEGUENTE, quindi modificare l'ULTIMA riga lascia la catena
// internamente valida e si vede solo dal mismatch con l'ancora esterna. Un log è "sano" solo se
// reggono ENTRAMBE; altrimenti `run` rifiuterebbe di riparare il caso più insidioso.
function plan(opts) {
  const o = typeof opts === 'string' ? { file: opts } : (opts || {});
  const f = FILE(o.file);
  const anchorFile = ANCHOR(o.anchorFile);
  const lines = chain.readLines(f);
  const state = chain.verifyChain(lines);
  const start = firstChainedIndex(lines);
  const anchor = chain.verifyHeadAnchor({
    file: f, anchorFile, kind: 'findings-head-anchor', rechainKind: 'findings-rechain',
    fileName: path.basename(f),
  });
  return {
    file: f,
    anchor_file: anchorFile,
    lines: lines.length,
    chain: state,
    anchor,
    healthy: !!state.ok && !!anchor.ok,
    head: chain.chainHead(lines),
    first_chained_line: start >= 0 ? start + 1 : null,
    would_rechain: start >= 0 ? lines.length - start : 0,
    legacy_preserved: start >= 0 ? start : lines.length,
  };
}

// Ricostruisce il suffisso incatenato sul contenuto esistente. Ritorna {ok, lines} o {ok:false}.
// Le righe legacy (prima della prima incatenata) restano byte-identiche.
function rebuild(file) {
  const lines = chain.readLines(file);
  const start = firstChainedIndex(lines);
  if (start < 0) return { ok: false, error: 'no chained line found — nothing to rebuild (legacy-only log has no chain to repair)' };
  const out = lines.slice(0, start);
  for (let i = start; i < lines.length; i++) {
    let f = null;
    try { f = JSON.parse(lines[i]); } catch { /* gestito sotto */ }
    if (!f || typeof f !== 'object' || Array.isArray(f))
      return { ok: false, error: `line ${i + 1} is not a JSON object — a broken/unparseable line inside the chained suffix cannot be rebuilt automatically; inspect it by hand before reconciling` };
    out.push(chain.buildChainedLine(f, out, (f.chain && f.chain.ts) || undefined));
  }
  return { ok: true, lines: out, rechain_from: start + 1 };
}

function run(opts) {
  const o = opts || {};
  const reason = o.reason;
  if (!reason || !String(reason).trim())
    return { ok: false, error: 'a reconciliation reason is required (--confirm "<motivo>"): a rewrite without a recorded reason is exactly the tampering this tool exists to distinguish itself from' };
  const f = FILE(o.file);
  const anchorFile = ANCHOR(o.anchorFile);
  if (!fs.existsSync(f)) return { ok: false, error: `no log at ${f} — nothing to reconcile` };
  const before = plan({ file: f, anchorFile });
  if (before.healthy)
    return { ok: false, error: `chain and head anchor are intact (${before.chain.chained} chained, ${before.chain.legacy} legacy) — refusing to rewrite a healthy log` };
  const rebuilt = rebuild(f);
  if (!rebuilt.ok) return { ok: false, error: rebuilt.error };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${f}.pre-rechain.${stamp}`;
  try {
    fs.copyFileSync(f, backup);
    const tmp = `${f}.rechain.${process.pid}`;
    fs.writeFileSync(tmp, rebuilt.lines.join('\n') + '\n');
    fs.renameSync(tmp, f);
  } catch (e) {
    return { ok: false, error: `write failed (original untouched): ${e && e.message ? e.message : String(e)}` };
  }

  const newHead = chain.chainHead(chain.readLines(f));
  // L'evento di riconciliazione va PRIMA della nuova ancora: la storia dice "queste due teste
  // sono la stessa cosa, e il motivo è questo".
  const event = chain.appendHeadAnchor({
    anchorFile,
    headSha256: newHead ? newHead.head_sha256 : null,
    seq: newHead ? newHead.seq : null,
    kind: 'findings-rechain',
    extra: {
      rechain: true, reason: String(reason).slice(0, 2000), backup,
      old_head_sha256: before.head ? before.head.head_sha256 : null,
      old_seq: before.head ? before.head.seq : null,
      break: before.chain.reason || null,
      lines: rebuilt.lines.length, rechain_from_line: rebuilt.rechain_from,
      new_head_sha256: newHead ? newHead.head_sha256 : null,
    },
  });
  const anchor = chain.appendHeadAnchor({
    anchorFile,
    headSha256: newHead ? newHead.head_sha256 : null,
    seq: newHead ? newHead.seq : null,
    kind: 'findings-head-anchor',
  });
  // Lo stato "dopo" si misura DOPO entrambe le scritture: misurarlo prima confronterebbe la
  // nuova testa con la vecchia ancora e dichiarerebbe manomesso un log appena riconciliato.
  const after = stateOf({ file: f, anchorFile });
  return {
    ok: rebuilt.lines.length > 0 && after.ok,
    file: f, backup, reason: String(reason),
    broke_at: before.chain.index != null ? before.chain.index + 1 : null,
    break_reason: before.chain.reason || null,
    old_head: before.head ? before.head.head_sha256 : null,
    new_head: newHead ? newHead.head_sha256 : null,
    rechain_from_line: rebuilt.rechain_from,
    legacy_preserved: rebuilt.rechain_from - 1,
    chain: after.chain,
    anchor: after.anchor,
    reconciliation_event: event,
    head_anchor: anchor,
  };
}

function verifyAfter(file) {
  const lines = chain.readLines(FILE(file));
  return chain.verifyChain(lines);
}

function stateOf(opts) {
  const o = typeof opts === 'string' ? { file: opts } : (opts || {});
  const after = plan({ file: o.file, anchorFile: o.anchorFile });
  return { ok: after.healthy, chain: after.chain, anchor: after.anchor };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const cmd = args[0] || 'plan';
  const file = flag('--file');
  const anchorFile = flag('--anchor');
  if (cmd === 'plan') {
    const p = plan({ file, anchorFile });
    console.log(JSON.stringify(p, null, 2));
    process.exit(p.healthy ? 0 : 1);
  }
  if (cmd === 'run') {
    const r = run({ file, anchorFile, reason: flag('--confirm') || flag('--reason') });
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  }
  console.error('usage: node tools/rechain.js plan [--file <log>] [--anchor <f>]');
  console.error('       node tools/rechain.js run  [--file <log>] [--anchor <f>] --confirm "<motivo>"');
  process.exit(2);
}

module.exports = { plan, rebuild, run, verifyAfter, stateOf, firstChainedIndex, FILE, ANCHOR };
