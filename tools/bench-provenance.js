#!/usr/bin/env node
// bench-provenance.js — chi ha prodotto questa run di benchmark, letto dai dischi di Freebuff.
//
//   node tools/bench-provenance.js            # l'ultima chat che ha un log.jsonl
//   node tools/bench-provenance.js <chatdir>  # una chat specifica
//
// Perché esiste. `settings.json:freebuffModel` dice quale modello HAI CHESTO, non quale
// modello ha girato: uno slug non valido viene scartato in silenzio e ricade sul default, e
// la TUI puo' avere scelto dal catalogo (`agentType = base3-free-catalog`) ignorando il
// setting. Il log della chat e' l'unico record per-request del modello usato, ed e' la riga
// che va in `--model` di gen-bench: un numero senza provenienza non e' riproducibile.
//
// Niente da installare, niente da scrivere: legge e basta. Zero dipendenze.
'use strict';
const fs = require('fs');
const path = require('path');

const CHATS_ROOT = () => path.join(
  process.env.HOME || process.env.USERPROFILE,
  '.config', 'manicode', 'projects');

function newestChatDir(root) {
  let projects;
  try { projects = fs.readdirSync(root); } catch (e) { return null; }
  const found = [];
  for (const p of projects) {
    const chats = path.join(root, p, 'chats');
    let dirs;
    try { dirs = fs.readdirSync(chats); } catch (e) { continue; }
    for (const d of dirs) {
      const full = path.join(chats, d);
      if (fs.existsSync(path.join(full, 'log.jsonl'))) found.push(full);
    }
  }
  if (!found.length) return null;
  found.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return found[0];
}

// Solo slug `vendor/nome`: il log contiene anche `contextTokenBaseline.model`, che e' un
// blob opaco e non un modello — insieme falserebbe l'identificazione.
function modelsIn(log) {
  const out = new Set();
  for (const m of log.match(/"model":"([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)"/g) || [])
    out.add(m.slice(9, -1));
  return [...out];
}

// La 0.2.11 ha migrato lo schema: `settings.json` non tiene piu' lo slug ma una
// `freebuffModelKey` tipo `m-096e75164d`, e il file live della sessione riporta la stessa
// chiave. Quella chiave e` un id di catalogo lato server: non e` nel binario e non e` su
// disco, quindi da filesystem NON si puo` risolvere in uno slug. Il nome leggibile lo mostra
// solo la TUI (o il log per-request, a sessione finita). Dire "non lo so" e' l'unica risposta
// onesta — indovinare qui produrrebbe una riga di history falsa.
function liveModelKey() {
  const dir = path.dirname(CHATS_ROOT());
  let files;
  try { files = fs.readdirSync(dir).filter(f => /^freebuff-live-.*\.json$/.test(f)); } catch (e) { return null; }
  let best = null;
  for (const f of files) {
    const full = path.join(dir, f);
    try {
      const j = JSON.parse(fs.readFileSync(full, 'utf8'));
      const age = Date.now() - fs.statSync(full).mtimeMs;
      if (j.model && age < 6 * 3600e3 && (!best || age < best.age)) best = { age, model: j.model, pid: j.ownerPid, file: f };
    } catch (e) { /* file live non leggibile: e' scritto a raffica, non un errore */ }
  }
  return best;
}

function main() {
  const arg = process.argv[2];
  const dir = arg ? path.resolve(arg) : newestChatDir(CHATS_ROOT());
  if (!dir) {
    console.error('bench-provenance: nessuna chat Freebuff con log.jsonl trovata');
    process.exit(2);
  }
  const log = fs.readFileSync(path.join(dir, 'log.jsonl'), 'utf8');
  const models = modelsIn(log);
  let firstPrompt = null;
  try { firstPrompt = JSON.parse(fs.readFileSync(path.join(dir, 'chat-meta.json'), 'utf8')).firstPrompt || null; } catch (e) {}

  const agentType = (() => {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, 'run-state.json'), 'utf8')).sessionState;
      return (s && s.mainAgentState && s.mainAgentState.agentType) || null;
    } catch (e) { return null; }
  })();

  const armed = !!firstPrompt && /^\s*@(cyboros|eni)\b/.test(firstPrompt);
  const live = liveModelKey();
  const out = {
    session: path.basename(dir),
    model: models.length === 1 ? models[0] : (models.length ? models : null),
    modelCount: models.length,
    liveModelKey: live ? live.model : null,
    agentType,
    identityArmed: armed,
    firstPromptLine: firstPrompt ? String(firstPrompt).split('\n')[0].slice(0, 120) : null,
    // il flag che va in gen-bench: esattamente lo slug osservato, mai quello che hai scelto
    benchModel: models.length === 1 ? models[0] : null,
  };
  const warnings = [];
  if (!out.benchModel && out.liveModelKey) warnings.push('lo slug del modello non e` ancora nel log: la 0.2.11 tiene solo la chiave di catalogo "' + out.liveModelKey + '" (id server, non risolvibile su disco). Il nome leggibile lo mostra la TUI: guardalo li` prima di fidarti di --model.');
  if (models.length > 1) warnings.push('piu` di un modello nella stessa chat: il benchmark ne ha uno solo');
  if (agentType === 'base3-free-catalog') warnings.push('agentType = base3-free-catalog: il modello e` stato scelto dal picker, non pinnato da settings.json');
  if (!armed) warnings.push('il primo messaggio non arma nessuna identita` (@cyboros/@eni): la sessione non e` Cyboros');
  if (warnings.length) out.warning = warnings.join(' | ');
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.benchModel && armed ? 0 : 1);
}

if (require.main === module) main();
module.exports = { modelsIn, newestChatDir, CHATS_ROOT };