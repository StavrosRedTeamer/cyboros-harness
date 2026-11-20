#!/usr/bin/env node
'use strict';
// tools/sage/state.js — il run è un file, non una sessione in memoria.
//
// Perché esiste: un run reale dura 1-2 ore su questo hardware, e un processo che vive due
// ore su un laptop trova sempre il modo di morire (sospensione, OOM, Ctrl-C, update).
// Quindi ogni passo scrive lo stato su disco in modo ATOMICO (tmp + rename): al resume si
// riparte dal primo URL non completato, senza rifetch e senza richieste duplicate.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const ARTIFACTS = path.join(ROOT, 'artifacts', 'sage');
const REPORTS = path.join(ROOT, 'reports', 'sage');

// 20261027-134512 — ordina da sé, leggibile a occhio, niente dipendenze di formato.
function stamp(d = new Date()) {
  return d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

/** Id del run: `<stamp>-<lane>`, con suffisso se due run nascono nello stesso secondo. */
function runId(lane, when = new Date()) {
  const base = `${stamp(when)}-${lane}`;
  let id = base;
  for (let i = 2; fs.existsSync(path.join(ARTIFACTS, id)); i++) id = `${base}-${i}`;
  return id;
}

/** Percorsi di un run. Un solo posto che li conosce: nessun modulo ricompone path a mano. */
function dirs(id) {
  const base = path.join(ARTIFACTS, id);
  return {
    base,
    sources: path.join(base, 'sources'),
    claims: path.join(base, 'claims.jsonl'),
    dropped: path.join(base, 'dropped.jsonl'),
    egress: path.join(base, 'egress.jsonl'),
    state: path.join(base, 'state.json'),
  };
}

function ensure(id) {
  const d = dirs(id);
  fs.mkdirSync(d.sources, { recursive: true });
  return d;
}

function atomicWriteJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function load(id) {
  try { return JSON.parse(fs.readFileSync(dirs(id).state, 'utf8')); } catch { return null; }
}

function save(st) {
  st.updatedAt = new Date().toISOString();
  atomicWriteJson(dirs(st.runId).state, st);
  return st;
}

function appendJsonl(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n')
      .filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

/** Run esistenti, dal più recente. Usa solo lo state.json: niente directory orfane. */
function list() {
  let names = [];
  try { names = fs.readdirSync(ARTIFACTS); } catch { return []; }
  return names
    .map((id) => load(id))
    .filter(Boolean)
    .sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
}

function elapsedMin(st, now = Date.now()) {
  const t0 = Date.parse(st.startedAt);
  return Number.isFinite(t0) ? (now - t0) / 60000 : 0;
}

// Il budget è TEMPO ATTIVO, non tempo di calendario: un run interrotto alle 23 e ripreso la
// mattina dopo si chiudeva al primo giro con "budget esaurito" e un report vuoto marcato
// `done` (lo stesso difetto di classe del resume senza piano). Il cronometro vive su due
// campi: `budgetSpentMin` (minuti già consumati) e `activeSince` (istante in cui il conto è
// ripartito). `pauseClock` lo ferma (SIGINT, fine run), `resumeClock` lo riavvia.
function spentMin(st, now = Date.now()) {
  const base = Number(st && st.budgetSpentMin);
  const since = Number(st && st.activeSince);
  const running = Number.isFinite(since) && since > 0 ? Math.max(0, now - since) / 60000 : 0;
  return (Number.isFinite(base) ? base : 0) + running;
}

function pauseClock(st, now = Date.now()) {
  st.budgetSpentMin = spentMin(st, now);
  delete st.activeSince;
  return st;
}

function resumeClock(st, now = Date.now()) {
  st.activeSince = now;
  return st;
}

/** Minuti contati da budget e report: tempo attivo se il run lo traccia, wall clock se è vecchio. */
function activeMin(st, now = Date.now()) {
  const tracked = (st && st.budgetSpentMin != null) || (st && st.activeSince != null);
  return tracked ? spentMin(st, now) : elapsedMin(st, now);
}

function budgetLeft(st, now = Date.now()) {
  const budget = Number(st.budgetMin);
  if (!Number.isFinite(budget) || budget <= 0) return Infinity;
  return budget - activeMin(st, now);
}

/** Report e proposte di un run: stesso stem, due estensioni. Puro: nessun I/O. */
function stemFor(st) {
  const slug = slugify(st && st.brief ? st.brief : st.runId).slice(0, 48) || st.runId;
  const day = String((st && st.startedAt) || new Date().toISOString()).slice(0, 10);
  return path.join(REPORTS, `${day}-${slug}-${st.runId}`);
}

function reportStem(id) {
  const st = load(id);
  return stemFor(st || { runId: id });
}

function slugify(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

module.exports = {
  ROOT, ARTIFACTS, REPORTS,
  stamp, runId, dirs, ensure, load, save, appendJsonl, readJsonl,
  list, elapsedMin, activeMin, spentMin, pauseClock, resumeClock, budgetLeft,
  reportStem, stemFor, slugify, atomicWriteJson,
};
