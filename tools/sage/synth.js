#!/usr/bin/env node
'use strict';
// tools/sage/synth.js — dai claim alle note e alle proposte, poi al report.
//
// Qui il codice fa da giudice, non da scriba: una proposta che non cita almeno un claim
// VERIFICATO viene scartata, e i claim duplicati (stessa affermazione da tre fonti) contano
// una volta sola. È il motivo per cui il report può essere letto da un umano in due minuti:
// ciò che resta ha una citazione, ciò che non ce l'ha non c'è.

const fs = require('node:fs');
const path = require('node:path');
const state = require('./state');
const { askJson } = require('./ask');

const PRIORITIES = new Set(['P1', 'P2', 'P3']);
const EFFORTS = new Set(['LOW', 'MEDIUM', 'HIGH']);

// Sotto questa soglia non si producono proposte. Perché: con un solo claim il modello
// scrive comunque 5 proposte che citano tutte la stessa frase generica — tecnica valida
// (citano qualcosa di reale) ma conclusione non sostenuta. Meglio un report che dice
// "evidenza insufficiente" di cinque raccomandazioni che fingono di avere una base.
const MIN_CLAIMS_FOR_PROPOSALS = 3;

function normKey(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 140);
}

/** Stessa affermazione, fonte diversa = un claim. La prima fonte vince (ordine di discovery). */
function dedupeClaims(claims) {
  const seen = new Set();
  const out = [];
  for (const c of claims) {
    const k = normKey(c.claim);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

function clip(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

function validIds(v, knownIds) {
  return (Array.isArray(v) ? v : []).map((x) => String(x)).filter((id) => knownIds.has(id)).slice(0, 8);
}

/**
 * Normalizza e VALIDA le proposte del modello: nome, testo e almeno un claim citato.
 * @returns {object[]}
 */
function validateProposals(raw, knownIds, { max = 5, idPrefix = 'SAGE' } = {}) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const p of list) {
    if (!p || typeof p !== 'object') continue;
    const name = clip(p.name, 120);
    const proposal = String(p.proposal == null ? '' : p.proposal).trim();
    const ids = validIds(p.claim_ids, knownIds);
    if (!name || proposal.length < 40 || !ids.length) continue;
    const effort = String(p.riskEffort || '').toUpperCase();
    out.push({
      // L'id porta il RUN: due ricerche nello stesso giorno producevano entrambe
      // SAGE-2026-10-27-01, e `promote` poteva applicare la proposta sbagliata.
      id: `${idPrefix}-${String(out.length + 1).padStart(2, '0')}`,
      lane: p.lane,
      name,
      category: clip(p.category || 'General', 60),
      priority: PRIORITIES.has(p.priority) ? p.priority : 'P2',
      riskEffort: EFFORTS.has(effort) ? effort : 'MEDIUM',
      relevant: true,
      proposal,
      gap_ref: clip(p.gap_ref || '', 200),
      claim_ids: ids,
      status: 'draft',
    });
    if (out.length >= max) break;
  }
  return out;
}

function validateNotes(raw, knownIds, { max = 6 } = {}) {
  const list = Array.isArray(raw) ? raw : [];
  return list.slice(0, max).map((n) => ({
    title: clip(n && n.title, 100) || '(nota)',
    body: String((n && n.body) || '').trim(),
    claim_ids: validIds(n && n.claim_ids, knownIds),
  })).filter((n) => n.body.length > 0);
}

/** Fallback deterministico: una nota per domanda, con i claim che le appartengono. */
function fallbackNotes(claims, questions) {
  const notes = [];
  for (const q of questions) {
    const own = claims.filter((c) => c.question === q).slice(0, 5);
    if (!own.length) continue;
    notes.push({
      title: clip(q, 90),
      body: own.map((c) => `- ${c.claim}`).join('\n'),
      claim_ids: own.map((c) => c.id),
    });
  }
  return notes.slice(0, 6);
}

/**
 * Sintesi finale. Se il modello non produce JSON valido, il report si costruisce comunque
 * dai claim: meglio un report senza prosa che nessun report dopo due ore di ricerca.
 */
async function synthesize({ llm, brief, lane, claims, questions = [], runId = '', onUsage }) {
  const knownIds = new Set(claims.map((c) => c.id));
  const idPrefix = runId ? `SAGE-${runId}` : 'SAGE';

  if (!claims.length) {
    return { summary: 'Nessun claim verificato: il report riporta le fonti lette e le citazioni scartate.', notes: [], proposals: [], origin: 'empty' };
  }

  const compact = claims.slice(0, 60).map((c) => ({
    id: c.id, claim: clip(c.claim, 240), confidence: c.confidence, source: path.basename(c.source),
  }));

  // Due chiamate piccole invece di una grande. Misurato su un 35B/3B attivi: chiedere in un
  // solo oggetto sintesi + 4 note + 5 proposte fa CHIUDERE il modello a metà JSON (EOS dopo
  // ~200 token, non troncamento del server). Ogni stadio qui deve stare in un output corto.
  const base = [
    'Sei un analista che scrive per un operatore di sicurezza esperto. Italiano, asciutto, niente premesse.',
    'Ricevi CLAIM già verificati (ognuno con id e fonte). Non inventare nulla che non sia in un claim.',
    'Ogni affermazione deve essere sostenuta da almeno un claim_id esistente. Se un\'idea non ha claim, non scriverla.',
  ].join('\n');
  const context = [
    `BRIEF: ${brief}`,
    `LANE: ${lane}`,
    `DOMANDE: ${questions.join(' | ')}`,
    'CLAIM VERIFICATI:',
    JSON.stringify(compact),
  ].join('\n');

  let notesRes = { json: null, raw: '' };
  try {
    notesRes = await askJson(llm, {
      system: `${base}\nFormato: {"summary":"3-5 frasi","notes":[{"title":"...","body":"...","claim_ids":["C-0001"]}]}`,
      task: `${context}\nScrivi la sintesi (max 5 frasi) e al massimo 4 note brevi.`,
      onUsage,
    });
  } catch { /* fallback sotto */ }

  const summary = notesRes.json && String(notesRes.json.summary || '').trim()
    ? String(notesRes.json.summary).trim()
    : `Sintesi non disponibile (la risposta del modello non era in formato JSON). Restano ${claims.length} claim verificati, leggibili nella tabella.`;
  let notes = notesRes.json ? validateNotes(notesRes.json.notes, knownIds) : [];
  if (!notes.length) notes = fallbackNotes(claims, questions);

  let proposals = [];
  let proposalsSkipped = '';
  let rawProposals = '';
  if (claims.length < MIN_CLAIMS_FOR_PROPOSALS) {
    proposalsSkipped = `servono almeno ${MIN_CLAIMS_FOR_PROPOSALS} claim verificati, ne esistono ${claims.length}`;
  } else {
    let propRes = { json: null, raw: '' };
    try {
      propRes = await askJson(llm, {
        system: `${base}\nFormato: {"proposals":[{"name":"...","category":"...","priority":"P1|P2|P3","riskEffort":"LOW|MEDIUM|HIGH","proposal":"...","gap_ref":"...","claim_ids":["C-0001"]}]}`,
        task: `${context}\nScrivi al massimo 3 proposte concrete e brevi (lane capability: migliorie all'harness; lane offensive: tecniche/playbook).`,
        onUsage,
      });
    } catch { /* gestito sotto */ }
    rawProposals = String(propRes.raw || '');
    proposals = propRes.json
      ? validateProposals(propRes.json.proposals, knownIds, { max: 3, idPrefix }).map((p) => ({ ...p, lane }))
      : [];
    if (!proposals.length) {
      proposalsSkipped = propRes.json
        ? 'nessuna proposta con un claim verificato a supporto'
        : 'la risposta del modello non era in formato JSON valido';
    }
  }

  return {
    summary,
    notes,
    proposals,
    proposalsSkipped,
    // Il fallback non deve essere muto: nel log va la risposta vera, chi legge capisce se il
    // modello ha divagato, chiuso a metà o restituito un formato diverso.
    raw: notesRes.json ? rawProposals.slice(0, 800) : String(notesRes.raw || rawProposals || '').slice(0, 800),
    origin: notesRes.json ? 'model' : 'fallback',
  };
}

// ── report ─────────────────────────────────────────────────────────────────────
function mdEscape(s) { return String(s == null ? '' : s).replace(/\|/g, '\\|'); }

function renderReport({ st, sources, claims, notes, proposals, summary, dropped, metrics, proposalsSkipped }) {
  const L = [];
  L.push(`# Sage Research — ${clip(st.brief, 120)}`);
  L.push('');
  L.push(`> run \`${st.runId}\` · lane **${st.lane}** · modello \`${st.model || 'sage'}\` · ${st.startedAt}`);
  L.push(`> ${metrics.sources} fonti · ${metrics.kept} claim verificati · ${metrics.dropped} citazioni scartate`
    + ` · ${metrics.minutes.toFixed(0)} min · ${metrics.tokPerSec ? `${metrics.tokPerSec.toFixed(1)} tok/s` : 'tok/s n/d'}`);
  L.push('');
  L.push('## Sintesi');
  L.push('');
  L.push(summary || '(nessuna sintesi)');
  L.push('');

  if (proposalsSkipped) {
    L.push('## Proposte');
    L.push('');
    L.push(`_Non generate: ${proposalsSkipped}._`);
    L.push('');
  }

  if (proposals.length) {
    L.push(`## Proposte (${proposals.length}, stato draft)`);
    L.push('');
    L.push('| id | nome | categoria | priorità | sforzo |');
    L.push('|---|---|---|---|---|');
    for (const p of proposals) L.push(`| \`${p.id}\` | ${mdEscape(p.name)} | ${mdEscape(p.category)} | ${p.priority} | ${p.riskEffort} |`);
    L.push('');
    const byId = new Map(claims.map((c) => [c.id, c]));
    for (const p of proposals) {
      L.push(`### ${p.id} — ${p.name}`);
      L.push('');
      L.push(p.proposal);
      if (p.gap_ref) { L.push(''); L.push(`_gap_: ${p.gap_ref}`); }
      L.push('');
      for (const id of p.claim_ids) {
        const c = byId.get(id);
        if (!c) continue;
        L.push(`> ${clip(c.quote, 260)}`);
        L.push(`> — \`${c.source}\` (${id})`);
        L.push('');
      }
    }
    L.push('_Le proposte restano draft: si promuovono con `node tools/sage/index.js promote <id> --apply` dopo aver messo `"status":"approved"` nel file .proposals.json._');
    L.push('');
  }

  if (notes.length) {
    L.push('## Note');
    L.push('');
    for (const n of notes) {
      L.push(`### ${n.title}`);
      L.push('');
      L.push(n.body);
      if (n.claim_ids.length) { L.push(''); L.push(`_claim_: ${n.claim_ids.join(', ')}`); }
      L.push('');
    }
  }

  L.push('## Claim verificati');
  L.push('');
  if (!claims.length) {
    L.push('_Nessuno._');
  } else {
    L.push('| id | claim | conf. | fonte |');
    L.push('|---|---|---|---|');
    for (const c of claims) L.push(`| ${c.id} | ${mdEscape(clip(c.claim, 160))} | ${c.confidence} | \`${path.basename(c.source)}\` |`);
  }
  L.push('');

  if (dropped && dropped.length) {
    const hist = new Map();
    for (const d of dropped) hist.set(d.reason, (hist.get(d.reason) || 0) + 1);
    L.push('## Citazioni scartate');
    L.push('');
    L.push('Nessuna di queste è entrata nel report: la citazione non era un frammento reale della fonte.');
    L.push('');
    for (const [reason, n] of [...hist.entries()].sort((a, b) => b[1] - a[1])) L.push(`- ${n} × ${reason}`);
    L.push('');
  }

  L.push('## Fonti lette');
  L.push('');
  // `estratti`, non `claim`: la tabella conta quelli di QUESTA fonte, prima della deduplica
  // globale. Chiamarli "claim" faceva sembrare sbagliato il totale in testa al report.
  L.push('| provider | titolo | estratti | artefatto congelato |');
  L.push('|---|---|---|---|');
  for (const s of sources) {
    L.push(`| ${s.provider} | ${mdEscape(clip(s.title, 100))} | ${s.claims == null ? '?' : s.claims} | \`${s.rel}\` |`);
  }
  L.push('');
  L.push('## Riproducibilità');
  L.push('');
  L.push('```bash');
  L.push(`node tools/sage/index.js resume ${st.runId}    # riprende senza rifetch`);
  L.push(`node tools/sage/index.js chat ${st.runId}      # interroga i risultati`);
  L.push('```');
  L.push('');
  L.push(`_claim_: \`artifacts/sage/${st.runId}/claims.jsonl\` · _egress_: \`artifacts/sage/${st.runId}/egress.jsonl\``);
  L.push('');
  return L.join('\n');
}

/** Scrive report + proposte + riga d'indice. Restituisce i path workspace-relative. */
function writeOutputs({ st, sources, claims, notes, proposals, summary, dropped, metrics, proposalsSkipped }) {
  const stem = state.reportStem(st.runId);
  fs.mkdirSync(state.REPORTS, { recursive: true });
  const mdPath = `${stem}.md`;
  const propPath = `${stem}.proposals.json`;
  fs.writeFileSync(mdPath, renderReport({ st, sources, claims, notes, proposals, summary, dropped, metrics, proposalsSkipped }), 'utf8');
  fs.writeFileSync(propPath, JSON.stringify({
    run: st.runId, lane: st.lane, brief: st.brief, generatedAt: new Date().toISOString(), proposals,
  }, null, 2), 'utf8');
  state.appendJsonl(path.join(state.REPORTS, 'index.jsonl'), {
    run: st.runId, lane: st.lane, brief: st.brief, at: new Date().toISOString(),
    claims: claims.length, proposals: proposals.length,
    report: path.relative(state.ROOT, mdPath),
  });
  return { report: path.relative(state.ROOT, mdPath), proposals: path.relative(state.ROOT, propPath) };
}

/** Bozza di playbook per `promote`: stessa forma delle reference esistenti, con la fonte in testa. */
function renderPlaybookDraft(proposal, claims, st) {
  const byId = new Map(claims.map((c) => [c.id, c]));
  const L = [];
  L.push(`# ${proposal.name}`);
  L.push('');
  L.push(`> Draft generato da Cyboros Sage — run \`${st ? st.runId : '?'}\` — ${new Date().toISOString().slice(0, 10)}.`);
  L.push('> Non è conoscenza attiva finché non viene revisionato e promosso.');
  L.push('');
  L.push(`**Categoria**: ${proposal.category} · **Priorità**: ${proposal.priority} · **Sforzo**: ${proposal.riskEffort}`);
  L.push('');
  L.push('## Proposta');
  L.push('');
  L.push(proposal.proposal);
  if (proposal.gap_ref) { L.push(''); L.push(`Gap: ${proposal.gap_ref}`); }
  L.push('');
  L.push('## Evidenza');
  L.push('');
  for (const id of proposal.claim_ids) {
    const c = byId.get(id);
    if (!c) continue;
    L.push(`> ${c.quote}`);
    L.push(`>`);
    L.push(`> — \`${c.source}\` (${id})`);
    L.push('');
  }
  return L.join('\n');
}

module.exports = {
  synthesize, dedupeClaims, validateProposals, validateNotes, fallbackNotes,
  renderReport, writeOutputs, renderPlaybookDraft, PRIORITIES, EFFORTS, MIN_CLAIMS_FOR_PROPOSALS,
};
