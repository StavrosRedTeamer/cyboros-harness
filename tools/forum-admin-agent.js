#!/usr/bin/env node
// forum-admin-agent.js — il RUNTIME dell'agente-admin: il giro read -> decide -> act.
//
// Cosa fa questo modulo (e cosa NON fa):
//   FA il giro amministrativo: legge il forum (homepage + post nuovi), costruisce l'osservazione,
//   chiede UNA decisione al modello, esegue gli atti che il modello chiede, li registra nel
//   transcript, e chiude il giro su FINAL, su budget o sul kill switch.
//   NON decide al posto del modello e non lo convince: l'autorità è il RUOLO sul server, che
//   rifiuta comunque. Un agente-utente che usa questo runtime ottiene 403, non un permesso.
//
// Il confine con il modello è un PORT iniettato (`brain`): nei test è scriptato (nessun modello,
// nessuna rete verso llama.cpp), in esercizio è `llmBrain()` — lo stesso `LocalLLM` dell'edizione
// locale, con l'output vincolato dalla grammatica GBNF del protocollo ACTION/FINAL.
// Il protocollo del modello (parsing di ACTION, loop-guard, fallback testuale) vive in
// `local/llm.js`; qui vive la contabilità: turni, atti accettati, rifiuti, transcript.
//
// Contabilità (le regole che rendono il budget supervisionabile):
//   - un ATTTO RIFIUTATO dal server non consuma il budget: stesso principio del server, dove un
//     rifiuto non consuma nonce né contatore. Serve a non far sparire il budget per un errore del
//     modello (target inesistente, ruolo sbagliato) e a lasciare il rifiuto nel transcript;
//   - il tetto di atti è controllato PRIMA di eseguire: l'atto in eccesso è registrato come
//     `budget`, non come rifiuto del server (non è il server che ha rifiutato);
//   - il kill switch è controllato prima di ogni turno e prima di ogni atto: l'arresto è pulito
//     in ogni punto e ciò che è già in catena resta valido (il transcript firmato È la catena).
//
// CLI (uso in esercizio, con l'identità admin nel keyfile e il modello locale attivo):
//   node tools/forum-admin-agent.js run [--turns N] [--since N] [--rules "<testo>"] [--transcript <file>]
//
// Env: gli stessi di forum.js (FORUM_URL / FORUM_STATE / FORUM_KEYDIR).
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const srv = require('./forum-server');

// I verbi dell'admin, con lo stesso nome che il server usa nelle rotte.
const ADMIN_TOOLS = ['announce', 'sanction', 'lift', 'post'];

const MAX_TURNS_DEFAULT = 4;
const MAX_ACTIONS_DEFAULT = 8;
const MAX_ITERS_TEXT = '[max iterazioni tool raggiunte]';

// Schemi OpenAI dei quattro verbi: servono al percorso a tool NATIVI (quando la grammatica è
// disattivata in config). Con la grammatica attiva il modello passa dal protocollo testuale e gli
// schemi non vengono inviati — ma i nomi ammessi restano questi.
const ADMIN_TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'announce',
      description: 'Pubblica un annuncio in homepage: firmato, incatenato, visibile in testa a ogni lettura.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: 'Il testo dell\'annuncio o dell\'istruzione.' } },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'sanction',
      description: 'Sanziona un agente: warn (atto pubblico), mute (blocca la scrittura a scadenza), freeze (fino a revoca). Il motivo è obbligatorio.',
      parameters: {
        type: 'object',
        properties: {
          target_agent_id: { type: 'string' },
          action: { type: 'string', enum: ['warn', 'mute', 'freeze'] },
          reason: { type: 'string' },
          duration_ms: { type: 'integer', description: 'Solo per mute: durata in millisecondi (max 24h).' },
        },
        required: ['target_agent_id', 'action', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lift',
      description: 'Revoca tutte le sospensioni attive di un agente.',
      parameters: {
        type: 'object',
        properties: { target_agent_id: { type: 'string' }, reason: { type: 'string' } },
        required: ['target_agent_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'post',
      description: 'Scrive un messaggio nel forum come admin (non è un annuncio: non va in homepage).',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
  },
];

// ---- client ----------------------------------------------------------------

// Client HTTP firmato con la chiave PASSATA DAL CHIAMANTE (in memoria): nessun keyfile, nessuna
// variabile d'ambiente. È la forma che serve a un runner che tiene più identità nello stesso
// processo, e ai test. Firma e codifica sono quelle del server (`canonical`), le stesse di
// forum.js/forum-admin.js: un pacchetto firmato qui è indistinguibile da uno firmato dal wrapper.
function httpClient({ url, agentId, key, timeoutMs = 15000 }) {
  const base = String(url).replace(/\/$/, '');
  const priv = key instanceof crypto.KeyObject ? key : crypto.createPrivateKey({ key, format: 'jwk' });

  function call(method, pathname, payload) {
    const data = payload === undefined ? null : Buffer.from(JSON.stringify(payload), 'utf8');
    const u = new URL(base + pathname);
    return new Promise((resolve) => {
      const r = http.request({
        host: u.hostname, port: u.port || 80, path: u.pathname + u.search, method,
        headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {},
        timeout: timeoutMs,
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let body = {};
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = { raw: Buffer.concat(chunks).toString('utf8') }; }
          resolve({ status: res.statusCode, body });
        });
      });
      r.on('timeout', () => { r.destroy(new Error(`timeout dopo ${timeoutMs}ms su ${pathname}`)); });
      r.on('error', (e) => resolve({ status: 0, body: { error: String((e && e.message) || e) } }));
      if (data) r.write(data);
      r.end();
    });
  }

  // Il pacchetto firmato: `agent_id` è quello dell'identità iniettata, mai un argomento del modello.
  function signed(bodyText) {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('base64url');
    const sig = crypto.sign(null, Buffer.from(srv.canonical({ agent_id: agentId, ts, nonce, body: bodyText }), 'utf8'), priv)
      .toString('base64');
    return { agent_id: agentId, ts, nonce, body: bodyText, sig };
  }

  // Ogni scrittura ha la stessa forma in uscita: { ok, seq } oppure { ok:false, error, status }.
  async function write(pathname, bodyText) {
    const r = await call('POST', pathname, signed(bodyText));
    if (r.status !== 201) return { ok: false, error: r.body.error || `${pathname} refused (${r.status})`, status: r.status, ...r.body };
    return Object.assign({ ok: true, agent_id: agentId }, r.body);
  }

  return {
    agent_id: agentId,
    async read(since = 0) {
      const r = await call('GET', `/read?since=${Number(since) || 0}`);
      if (r.status !== 200) return { ok: false, error: r.body.error || `read refused (${r.status})`, status: r.status };
      return { ok: true, announcements: r.body.announcements || [], sanctions: r.body.sanctions || [], posts: r.body.posts || [] };
    },
    post: (text) => write('/post', text),
    announce: (text) => write('/announce', text),
    sanction: (args) => {
      const fields = { action: args.action, target_agent_id: args.target_agent_id, reason: args.reason };
      if (args.duration_ms !== undefined) fields.duration_ms = args.duration_ms;
      return write('/sanction', JSON.stringify(fields));
    },
    lift: (args) => write('/lift', JSON.stringify({ target_agent_id: args.target_agent_id, reason: args.reason || '' })),
  };
}

// Client di esercizio: identità dal keyfile e endpoint dalle env, esattamente i verbi che l'agente
// vede in `skills/agent-forum-admin/SKILL.md`. Il require è pigro: un test non tocca il keyfile.
function liveClient() {
  const forum = require('./forum');
  const admin = require('./forum-admin');
  return {
    async read(since) {
      const r = await forum.read(since);
      if (!r.ok) return r;
      return { ok: true, announcements: r.announcements, sanctions: r.sanctions, posts: r.posts };
    },
    post: (text) => forum.post(text),
    announce: (text) => admin.announce(text),
    sanction: (args) => admin.sanction(args.target_agent_id, args.action, args.reason, args.duration_ms),
    lift: (args) => admin.lift(args.target_agent_id, args.reason),
  };
}

// ---- cervello (il port verso il modello) -----------------------------------

// Cervello di esercizio: il modello locale abliterato, con l'output vincolato dalla grammatica del
// protocollo ACTION/FINAL. Un solo `runAgent` per turno: il loop dei tool dentro il turno è di
// `local/llm.js` (loop-guard incluso), il ciclo amministrativo è di questo file.
function llmBrain(opts = {}) {
  const cfg = opts.cfg || JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'local', 'config.local.json'), 'utf8'));
  const { LocalLLM } = require('../local/llm');
  const { toolProtocolGrammar } = require('../local/grammar');
  const llm = new LocalLLM(cfg);
  const grammar = toolProtocolGrammar(ADMIN_TOOLS, { allowThinking: cfg.runtime && cfg.runtime.allow_thinking });
  return ({ system, task, tools, dispatch }) => llm.runAgent({ system, task, tools, dispatch, grammar });
}

// ---- il giro ---------------------------------------------------------------

function systemPrompt({ subject, rules }) {
  return [
    `Sei ${subject}, l'admin di un forum agentico firmato. Amministri in autonomia: annunci le`,
    'regole e le istruzioni in homepage, reagisci a ciò che accade nei thread, sanzioni chi le',
    'viola.',
    rules ? `\nRegole del forum (vincolanti per gli agenti, e metro del tuo giudizio):\n${rules}` : '',
    '\nI tuoi verbi, e solo questi:',
    '- announce({"text":"..."}) — homepage: firmato, incatenato, sempre in testa a ogni lettura.',
    '- sanction({"target_agent_id":"...","action":"warn|mute|freeze","reason":"...","duration_ms":N}) — il motivo è obbligatorio; duration_ms solo per mute (max 24h).',
    '- lift({"target_agent_id":"...","reason":"..."}) — revoca tutte le sospensioni attive.',
    '- post({"text":"..."}) — un messaggio nel forum, non in homepage.',
    '\nNon puoi modificare né cancellare atti altrui (sanzionare è aggiungere), non puoi sanzionare',
    'un admin, e i tuoi atti sono firmati e incatenati come i post: sei auditabile.',
    'Il server è l\'autorità: se un atto viene rifiutato, leggi il motivo e non ripeterlo identico.',
    '\nDecidi una cosa per volta e chiudi il giro con FINAL: <riassunto>.',
  ].filter(Boolean).join('\n');
}

function observationTask({ turn, maxTurns, obs, actionsLeft }) {
  const homepage = obs.announcements.slice(-5).map((a) => `  [seq ${a.seq}] ${a.display || a.agent_id}: ${a.body}`).join('\n');
  const sanctions = obs.sanctions.slice(-5).map((s) => `  [seq ${s.seq}] ${s.action} su ${s.target_display || s.target_agent_id}: ${s.reason || ''}${s.until ? ` (fino a ${s.until})` : ''}`).join('\n');
  const posts = obs.posts.map((p) => `  [seq ${p.seq}] ${p.display || p.agent_id}: ${p.body}`).join('\n');
  return [
    `OSSERVAZIONE — turno ${turn}/${maxTurns}. Atti ancora disponibili: ${actionsLeft}.`,
    `\nHOMEPAGE (ultimi annunci):\n${homepage || '  (nessuno)'}`,
    `\nSANZIONI RECENTI:\n${sanctions || '  (nessuna)'}`,
    `\nPOST NUOVI (dall'ultima lettura):\n${posts || '  (nessuno)'}`,
    '\nDecidi: annuncia, sanziona, revoca, partecipa, oppure chiudi con FINAL.',
  ].join('\n');
}

// `runAdminAgent` esegue UN giro amministrativo (dal primo read al FINAL, o al budget, o al kill
// switch). Un runner di simulazione lo richiama per round: qui non c'è nessun loop infinito.
async function runAdminAgent({
  brain, client,
  subject = 'l\'admin',
  rules = null,
  maxTurns = MAX_TURNS_DEFAULT,
  maxActions = MAX_ACTIONS_DEFAULT,
  shouldStop = null,
  onEvent = null,
  transcriptPath = null,
  since = 0,
} = {}) {
  if (typeof brain !== 'function') throw new Error('runAdminAgent: serve un `brain` (funzione di decisione)');
  if (!client || typeof client.read !== 'function') throw new Error('runAdminAgent: serve un `client` (read + verbi)');

  const transcript = [];
  const startedAt = new Date().toISOString();
  const emit = (entry) => {
    const e = Object.assign({ n: transcript.length + 1, at: new Date().toISOString() }, entry);
    transcript.push(e);
    if (transcriptPath) fs.appendFileSync(transcriptPath, JSON.stringify(e) + '\n');
    if (onEvent) onEvent(e);
    return e;
  };

  const system = systemPrompt({ subject, rules });
  let turns = 0;
  let actions = 0;
  let refused = 0;
  let reads = 0;
  let cursor = Number(since) || 0;
  let stop = null;
  let stoppedEarly = false;

  const killSwitch = () => typeof shouldStop === 'function' && shouldStop() === true;

  while (turns < maxTurns) {
    if (killSwitch()) { stop = 'kill-switch'; break; }

    const obs = await client.read(cursor);
    reads++;
    if (!obs.ok) {
      emit({ kind: 'read-refused', error: obs.error, status: obs.status });
      stop = 'read-refused';
      break;
    }
    // Il cursore avanza coi post: l'annuncio resta nella homepage di ogni lettura (non è un post).
    for (const p of obs.posts) if (Number(p.seq) > cursor) cursor = Number(p.seq);
    emit({ kind: 'read', announcements: obs.announcements.length, sanctions: obs.sanctions.length, posts: obs.posts.length, cursor });

    turns++;
    let actedThisTurn = 0;
    let touchedThisTurn = 0; // atti + rifiuti + blocchi: se il turno ha toccato qualcosa, non è "vuoto"

    const dispatch = async (tool, args) => {
      if (stoppedEarly) return 'STOP: il giro è già stato interrotto.';
      if (!ADMIN_TOOLS.includes(tool)) {
        touchedThisTurn++;
        emit({ kind: 'unknown-tool', tool, args });
        return `ERRORE: verbo sconosciuto "${tool}". Ammessi: ${ADMIN_TOOLS.join(', ')}.`;
      }
      if (killSwitch()) {
        stoppedEarly = true;
        stop = 'kill-switch';
        touchedThisTurn++;
        emit({ kind: 'kill-switch', tool, args });
        return 'STOP: kill switch — nessun altro atto.';
      }
      if (actions >= maxActions) {
        touchedThisTurn++;
        emit({ kind: 'budget', tool, args, maxActions });
        return `BUDGET ATTI ESAURITO (${maxActions}): chiudi il giro con FINAL.`;
      }
      const verb = client[tool];
      if (typeof verb !== 'function') {
        touchedThisTurn++;
        emit({ kind: 'unknown-tool', tool, args });
        return `ERRORE: il client non ha il verbo "${tool}".`;
      }
      let r;
      try {
        r = await verb(tool === 'announce' || tool === 'post' ? (args && args.text) : args);
      } catch (e) {
        r = { ok: false, error: String((e && e.message) || e) };
      }
      if (r && r.ok) {
        actions++; actedThisTurn++; touchedThisTurn++;
        emit({ kind: 'act', tool, args, seq: r.seq === undefined ? null : r.seq, status: 201, author: client.agent_id || null });
        return `OK (${tool}, seq ${r.seq}).`;
      }
      // Rifiuto: registrato, ma NON conta come atto (stessa dottrina del server sui rifiuti).
      refused++; touchedThisTurn++;
      emit({ kind: 'refused', tool, args, error: r && r.error ? r.error : 'rifiutato', status: r && r.status ? r.status : null });
      return `RIFIUTATO (${tool}): ${r && r.error ? r.error : 'rifiutato dal server'}. Non ripetere lo stesso atto.`;
    };

    const res = await brain({ system, task: observationTask({ turn: turns, maxTurns, obs, actionsLeft: Math.max(0, maxActions - actions) }), tools: ADMIN_TOOL_SCHEMAS, dispatch, turn: turns });
    const text = String((res && res.text) || '');

    if (stop === 'kill-switch') break;
    if (actions >= maxActions) { stop = 'budget-actions'; break; }
    if (text === MAX_ITERS_TEXT) {
      if (!actedThisTurn) { emit({ kind: 'max-iters' }); stop = 'max-iters'; break; }
      continue; // ha agito ma non ha chiuso: decide il budget
    }
    // Turno vuoto = nessun atto, nessun rifiuto, nessun blocco, nessun testo: ripeterlo sarebbe
    // solo budget speso per lo stesso esito.
    if (!touchedThisTurn && !text) { emit({ kind: 'no-progress' }); stop = 'no-progress'; break; }
    if (text) { emit({ kind: 'final', text }); stop = 'final'; break; }
  }
  if (!stop) stop = 'budget-turns';

  return {
    ok: stop !== 'read-refused',
    stop_reason: stop,
    turns, actions, refused, reads,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    transcript,
  };
}

// ---- CLI -------------------------------------------------------------------

async function main(argv) {
  const cmd = argv[0] || 'run';
  const flag = (n) => { const i = argv.indexOf('--' + n); return i === -1 ? undefined : argv[i + 1]; };
  if (cmd !== 'run') {
    console.error('usage: node tools/forum-admin-agent.js run [--turns N] [--since N] [--rules "<testo>"] [--transcript <file>]');
    return 2;
  }
  const run = await runAdminAgent({
    brain: llmBrain(),
    client: liveClient(),
    rules: flag('rules') || null,
    maxTurns: flag('turns') ? Number(flag('turns')) : MAX_TURNS_DEFAULT,
    maxActions: flag('actions') ? Number(flag('actions')) : MAX_ACTIONS_DEFAULT,
    since: flag('since') || 0,
    transcriptPath: flag('transcript') || null,
  });
  console.log(JSON.stringify({ ok: run.ok, stop_reason: run.stop_reason, turns: run.turns, actions: run.actions, refused: run.refused }));
  return run.ok ? 0 : 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((rc) => process.exit(rc)).catch((e) => {
    console.error('forum-admin-agent.js: ' + String((e && e.message) || e));
    process.exit(1);
  });
}

module.exports = {
  ADMIN_TOOLS, ADMIN_TOOL_SCHEMAS, MAX_ITERS_TEXT,
  httpClient, liveClient, llmBrain, systemPrompt, observationTask, runAdminAgent, main,
};
