#!/usr/bin/env node
'use strict';
// tools/sage/plan.js — dal brief alle domande.
//
// Un modello da ~3B attivi pianifica male se gli si chiede "pensa a cosa cercare": produce
// domande generiche o ripete il brief. Quindi il prompt chiede UNA cosa sola (5-6 domande
// operative) e c'è un fallback deterministico per lane: se il modello non risponde in
// formato, la ricerca parte lo stesso con domande sensate. Un piano peggiore di quello
// ottimo è accettabile; un run che non parte no.

const { askJson } = require('./ask');

const LANE_FOCUS = {
  offensive: 'tecniche offensive, classi di vulnerabilità, verifica riproducibile, tool open-source recenti',
  capability: 'capacità mancanti dell\'harness, architettura, misurabilità del miglioramento, progetti open-source',
};

function cleanList(v, { max = 8, minLen = 8, maxLen = 240 } = {}) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const raw of v) {
    if (typeof raw !== 'string') continue;
    const s = raw.replace(/\s+/g, ' ').trim();
    if (s.length < minLen || s.length > maxLen) continue;
    if (out.some((x) => x.toLowerCase() === s.toLowerCase())) continue;
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/** Domande di riserva: deterministiche, per lane. Nessun modello richiesto. */
function fallbackQuestions(brief, lane = 'offensive') {
  const b = String(brief == null ? '' : brief).replace(/\s+/g, ' ').trim();
  if (lane === 'capability') {
    return [
      `Quali capacità mancano all'harness per coprire ${b}?`,
      `Come si misura oggettivamente un miglioramento su ${b}?`,
      `Quali progetti open-source implementano ${b} e con quale maturità?`,
      `Quali compromessi (costo, latenza, sicurezza) introduce ${b}?`,
    ];
  }
  return [
    `Quali tecniche recenti permettono di sfruttare ${b}?`,
    `Come si verifica in modo riproducibile ${b}?`,
    `Quali tool open-source coprono ${b}?`,
    `Quali difese bloccano ${b} e come si aggirano?`,
  ];
}

/** 1-2 query per domanda: la domanda intera e una forma corta (i motori premiano poche parole). */
function queriesFor(question, lane = 'offensive') {
  const base = String(question == null ? '' : question).replace(/[?!.]+$/, '').replace(/\s+/g, ' ').trim();
  if (!base) return [];
  const qs = [base];
  const short = base.split(/\s+/).slice(0, 10).join(' ');
  if (short !== base && short.length > 12) qs.push(short);
  return [...new Set(qs)];
}

/**
 * @param {{llm: object, brief: string, lane?: string, maxQuestions?: number, onUsage?: Function}} opts
 * @returns {Promise<{questions: string[], origin: 'model'|'fallback'}>}
 */
async function makePlan({ llm, brief, lane = 'offensive', maxQuestions = 6, onUsage }) {
  const system = [
    'Sei un pianificatore di ricerca per un harness di pentest autorizzato.',
    `Lane: ${lane} (focus: ${LANE_FOCUS[lane] || LANE_FOCUS.offensive}).`,
    'Produci domande di ricerca OPERATIVE: ognuna deve poter essere cercata su un motore di ricerca o in un database di CVE.',
    'Niente premesse, niente ripetizioni del brief, niente domande retoriche.',
    'Formato: {"questions":["...","..."]}',
  ].join('\n');

  const task = [
    `BRIEF: ${brief}`,
    `Scrivi ${maxQuestions} domande di ricerca, dalla più concreta alla più ampia.`,
  ].join('\n');

  let json = null;
  try { ({ json } = await askJson(llm, { system, task, onUsage })); } catch { /* fallback sotto */ }

  const fromModel = cleanList(json && json.questions, { max: maxQuestions });
  if (fromModel.length >= 2) return { questions: fromModel, origin: 'model' };
  return { questions: fallbackQuestions(brief, lane).slice(0, maxQuestions), origin: 'fallback' };
}

module.exports = { makePlan, fallbackQuestions, queriesFor, cleanList, LANE_FOCUS };
