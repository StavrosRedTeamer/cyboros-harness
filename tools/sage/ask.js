#!/usr/bin/env node
'use strict';
// tools/sage/ask.js — un solo modo di chiedere qualcosa al modello locale.
//
// Perché esiste: plan, extract, synth e REPL devono passare dallo stesso punto — stesso
// system, stesso budget di contesto, stesso parser tollerante — altrimenti ogni stadio
// inventa un dialetto JSON diverso e un modello da ~3B attivi ne sbaglia uno su tre.
// Il contratto è volutamente povero: testo dentro, testo o JSON fuori. Nessun tool.

const path = require('node:path');
const { LocalLLM } = require(path.join(__dirname, '..', '..', 'local', 'llm'));

const JSON_ONLY = 'Rispondi con UN SOLO oggetto JSON valido, senza testo prima o dopo e senza recinti ```.';

function makeLlm(cfg) {
  return new LocalLLM(cfg);
}

/**
 * Un turno completo senza tool. Restituisce il risultato grezzo di runAgent
 * (`text`, `messages`, `finish_reason`) perché il REPL deve poter continuare la conversazione.
 */
async function askTurn(llm, { system, task, history = [], onUsage, onTimings }) {
  return llm.runAgent({
    system,
    task,
    tools: [],
    dispatch: async () => '',
    history,
    onUsage,
    onTimings,
  });
}

async function askText(llm, opts) {
  const res = await askTurn(llm, opts);
  return res.text == null ? '' : String(res.text);
}

/**
 * Estrae un oggetto JSON da una risposta che può essere sporca (fence, preambolo, virgole
 * finali, parentesi di troppo). Non prova a "riparare" la semantica: se il JSON non c'è,
 * restituisce null e lo stadio chiamante decide (di solito: retry, poi fallback).
 * @param {string} raw
 * @returns {object|null}
 */
function parseJsonLoose(raw) {
  let t = String(raw == null ? '' : raw).trim();
  if (!t) return null;
  // Un recinto ```json ... ``` è il modo più comune in cui un modello "risponde JSON".
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  const body = t.slice(start, end + 1);
  const attempts = [
    body,
    body.replace(/,\s*([}\]])/g, '$1'),   // virgole finali
  ];
  for (const a of attempts) {
    try {
      const v = JSON.parse(a);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    } catch { /* prova la successiva */ }
  }
  return null;
}

/**
 * Domanda con risposta JSON. Un retry con istruzione esplicita: costa una chiamata e
 * salva un intero stadio, che è il compromesso giusto su un modello piccolo.
 * @returns {Promise<{json: object|null, raw: string}>}
 */
async function askJson(llm, { system, task, onUsage, onTimings, retries = 1 }) {
  const sys = `${system}\n\n${JSON_ONLY}`;
  let res = await askTurn(llm, { system: sys, task, onUsage, onTimings });
  let raw = res.text == null ? '' : String(res.text);
  let json = parseJsonLoose(raw);
  for (let i = 0; i < retries && !json; i++) {
    // Un JSON invalido per TRONCAMENTO (finish_reason=length) e un JSON invalido per forma
    // chiedono cose opposte: nel primo caso "più conciso", nel secondo "solo JSON".
    // Ripetere la stessa richiesta identica spende una chiamata e riottiene lo stesso taglio.
    const cut = res.finish_reason === 'length';
    res = await askTurn(llm, {
      system: sys,
      task: (cut
        ? 'La risposta precedente è stata TRONCATA dal limite di output. Rispondi con lo stesso formato ma molto più conciso: al massimo 3 note e 3 proposte, frasi brevi.\n\n'
        : 'La risposta precedente non era un oggetto JSON valido. Rispondi di nuovo con UN oggetto JSON valido e nient\'altro.\n\n')
        + 'Richiesta originale:\n' + task,
      onUsage,
      onTimings,
    });
    raw = res.text == null ? '' : String(res.text);
    json = parseJsonLoose(raw);
  }
  return { json, raw, finishReason: res.finish_reason };
}

/** Contatore token uniforme, tollerante ai nomi che i provider usano davvero. */
function usageTokens(u) {
  if (!u || typeof u !== 'object') return { in: 0, out: 0 };
  const inTok = Number(u.prompt_tokens ?? u.tokens_in ?? u.input_tokens ?? 0);
  const outTok = Number(u.completion_tokens ?? u.tokens_out ?? u.output_tokens ?? 0);
  return {
    in: Number.isFinite(inTok) ? inTok : 0,
    out: Number.isFinite(outTok) ? outTok : 0,
  };
}

module.exports = { makeLlm, askTurn, askText, askJson, parseJsonLoose, usageTokens, JSON_ONLY };
