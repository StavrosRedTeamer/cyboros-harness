#!/usr/bin/env node
// forum-server.js — forum multi-agente con IDENTITÀ ASSEGNATA DAL SERVER e una sola iscrizione per
// credenziale. Serve a testare comunicazione e collaborazione tra più agenti su ambienti
// simulati (orchestratore: tools/forum-sim.js).
//
// PERCHÉ questo modulo e non "un'istruzione nel prompt". L'invariante richiesto — un agente si
// registra una volta e non può crearne altri né fingersi qualcun altro — è una proprietà di
// SISTEMA, non di prompt: ciò che sta nel prompt è consultivo (context overflow, prompt
// injection cross-agent, jailbreak). Qui l'invariante è imposto FUORI dal modello:
//
//   - l'identità la sceglie il SERVER (agent_id derivato dalla pubkey, display name server-side):
//     il client non ha un campo "username" da scegliere, quindi l'impersonation non è vietata,
//     è non esprimibile nel protocollo;
//   - l'iscrizione è one-shot: il token è consumato al primo uso e l'identità resta `sealed`;
//     il secondo enrollment con lo stesso token è 409 e l'endpoint non torna indietro;
//   - ogni post porta una firma Ed25519 del TUO contenuto; il server verifica con la pubkey
//     iscritta per quell'agent_id. Falsificare l'autore richiede la chiave privata di un altro;
//   - il corpo è dentro la stringa firmata (via hash sha256): nessun replay e nessun body-tamper
//     senza la chiave. Il nonce + lo skew temporale chiudono il replay del pacchetto;
//   - il transcript è append-only incatenato (tools/chain-log.js) con ancora esterna: rimuovere o
//     riscrivere un messaggio è rilevabile, non silenzioso.
//
// La chiave PRIVATA non transita mai qui e non sta nel prompt: vive nel keyfile del client
// (tools/forum.js, 0600) e il modello vede solo il verbo `post`. Quindi un prompt injection
// può far chiedere all'agente di firmare un testo — non può rubare la firma per firmare come
// un altro, perché il wrapper firma SEMPRE col proprio agent_id, derivato dal proprio keyfile.
//
// RUOLO E MODERAZIONE (piano forum-admin, F1). Il ruolo lo assegna il SERVER al `mint`
// (operatore, fuori banda) e viene stampato sull'agente all'enroll: il client non ha un campo per
// dichiararlo. Da lì:
//
//   - `POST /announce` (solo admin): un annuncio firmato e incatenato che ogni `read` restituisce
//     SEMPRE in testa, in una sezione dedicata — la homepage del forum;
//   - `POST /sanction` (solo admin): `warn` (atto pubblico, nessun effetto), `mute` (blocca la
//     scrittura fino a scadenza, cap 24h), `freeze` (blocca fino a revoca). Motivo obbligatorio,
//     atto firmato e incatenato;
//   - `POST /lift` (solo admin): revoca le sospensioni attive di un agente;
//   - l'applicazione è QUI: un post di un agente sanzionato è rifiutato con il motivo; la LETTURA
//     resta sempre permessa; una scrittura rifiutata non consuma nonce né budget (non è un atto);
//   - l'admin non può modificare o cancellare atti altrui: sanzionare è aggiungere, mai riscrivere
//     la storia; anche i suoi atti sono firmati e incatenati (è auditabile).
//
// Il confine di superficie resta lo stesso: i verbi admin vivono in tools/forum-admin.js, non nella
// CLI utente; e comunque il server li rifiuta (403) a chi non ha il ruolo.
//
// Loopback-only, fail-closed: si binda su 127.0.0.1 e un bind non-loopback è un errore, non un
// fallback. Zero dipendenze, Node >= 22.
//
// CLI:
//   node tools/forum-server.js mint [--label <nome>] [--role user|admin]   # operatore: UN token one-shot
//   node tools/forum-server.js serve [--port N]      # server (porta effimera di default)
//   node tools/forum-server.js roster                # stato iscritzioni (no segreti)
//   node tools/forum-server.js verify                # catena + ancore del transcript
//
// Env: FORUM_STATE (default reports/tmp/forum), FORUM_HOST (default 127.0.0.1, rifiutato se non
// loopback), FORUM_PORT.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const chain = require('./chain-log');

const WS_ROOT = path.join(__dirname, '..');
const STATE_DIR = () => process.env.FORUM_STATE || path.join(WS_ROOT, 'reports', 'tmp', 'forum');
const STATE_FILE = () => path.join(STATE_DIR(), 'state.json');
const POSTS_LOG = () => path.join(STATE_DIR(), 'posts.jsonl');
const ANCHOR_FILE = () => path.join(STATE_DIR(), 'posts-head-anchor.jsonl');
const ENDPOINT_FILE = () => path.join(STATE_DIR(), 'endpoint.json');

// Limiti: un forum di test non deve diventare un vettore di esaurimento. Fail-closed, non "avvisa".
const MAX_BODY_BYTES = 8 * 1024;      // per messaggio
const TS_SKEW_MS = 5 * 60 * 1000;      // oltre ±5 min il pacchetto è stale, non solo replayato
const MAX_POSTS_PER_AGENT = 500;       // per sessione di server
const POST_WINDOW_MS = 60 * 1000;      // finestra del rate limit
const POST_BURST = 20;                // max post per agente nella finestra

// Ruolo e moderazione. Il ruolo è una proprietà del TOKEN, mai un campo della richiesta; le
// sanzioni sono atti firmati e incatenati, applicati da QUI (un post sanzionato è rifiutato con il
// motivo, la lettura resta sempre permessa).
const ADMIN_ROLE = 'admin';
const ROLES = ['user', 'admin'];
const MAX_MUTE_MS = 24 * 60 * 60 * 1000; // una sanzione a scadenza non dura più di 24h
const MAX_REASON_CHARS = 512;            // il motivo entra nel registro: limitato
const MAX_ANNOUNCEMENTS = 100;           // sezione homepage: gli ultimi N, sempre presenti
const MAX_SANCTIONS_RETURNED = 100;      // sezione sanzioni: gli ultimi N atti di moderazione

// ---- stato (JSON atomico tmp+rename, stessa disciplina di tools/proc-registry.js) ----
function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8'));
    return { tokens: s.tokens || {}, agents: s.agents || {} };
  } catch {
    return { tokens: {}, agents: {} };
  }
}
function saveState(s) {
  fs.mkdirSync(STATE_DIR(), { recursive: true });
  const tmp = STATE_FILE() + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n');
  fs.renameSync(tmp, STATE_FILE());
}

// I token non si conservano in chiaro: si registra solo lo sha256. Un dump di state.json non
// deve consegnare credenziali utilizzabili, quindi il token è single-use ma resta single-use
// anche se lo stato viene letto da qualcun altro.
function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

// L'identità è una FUNZIONE della pubkey, non un campo scelto dal client: due chiavi diverse
// non possono collidere, la stessa chiave non può ottenere due identità diverse.
function agentIdFromPub(pubJwk) {
  const canon = JSON.stringify({ crv: pubJwk.crv, kty: pubJwk.kty, x: pubJwk.x });
  return 'af-' + crypto.createHash('sha256').update(canon, 'utf8').digest('hex').slice(0, 12);
}
function displayFromId(agentId) {
  return agentId.replace(/^af-/, 'agent-').slice(0, 11);
}

// ---- firma ----
// La stringa canonica è ciò che il server ricalcola: agent_id, ts, nonce e l'HASH del corpo.
// Il corpo non è firmato letterale per non ricopiare testo potenzialmente enorme nel payload
// della richiesta, ma il suo sha256 lo vincola ugualmente: cambiare un byte del corpo cambia
// l'hash e invalida la firma.
function canonical({ agent_id, ts, nonce, body }) {
  return [agent_id, ts, nonce, crypto.createHash('sha256').update(String(body), 'utf8').digest('hex')].join('\n');
}
function verifySignature(pubJwk, canonicalStr, sigB64) {
  try {
    const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: pubJwk.x }, format: 'jwk' });
    const sig = Buffer.from(String(sigB64), 'base64');
    if (sig.length !== 64) return false;
    return crypto.verify(null, Buffer.from(canonicalStr, 'utf8'), key, sig);
  } catch {
    return false; // chiave malformata o firma non-decodificabile = non verificata, mai "forse"
  }
}

// ---- transcript append-only ----
// riusa tools/chain-log.js invece di reimplementare la catena: è lo stesso contratto dei finding
// (seq, prev_sha256, ancora esterna) e una seconda copia diverge.
function appendPost(record) {
  const r = chain.appendChained(POSTS_LOG(), record, {
    anchorFile: ANCHOR_FILE(),
    anchorKind: 'forum-head-anchor',
    fileName: 'posts.jsonl',
  });
  return r;
}
function readPosts() {
  return chain.readJsonl(POSTS_LOG());
}

// Nonce + contatori ricostruiti dal log a ogni avvio: il replay protection sopravvive al restart,
// non vive solo nella RAM di un processo.
function buildReplayIndex(posts) {
  const nonces = new Set();
  const counts = new Map();
  for (const p of posts) {
    if (p.nonce) nonces.add(`${p.agent_id}:${p.nonce}`);
    const n = (counts.get(p.agent_id) || 0) + 1;
    counts.set(p.agent_id, n);
  }
  return { nonces, counts };
}

// Una sanzione applicata all'indice di moderazione. Funzione UNICA usata sia nella ricostruzione
// dal log a ogni avvio (buildModerationIndex) sia all'append di un nuovo atto: una seconda copia
// della stessa logica divergerebbe. Semantica:
//   - warn  → nessun effetto sullo stato (resta nel registro, che è la sua unica forza);
//   - mute  → blocco a scadenza; un secondo mute non ACCORCIA un blocco attivo (max);
//   - freeze→ blocco fino a un lift;
//   - lift  → revoca TUTTE le sospensioni attive (freeze + mute), azzera l'ultimo motivo.
function applySanctionToIndex(m, r) {
  if (!r || r.kind !== 'sanction' || !r.target_agent_id) return;
  if (!m.has(r.target_agent_id))
    m.set(r.target_agent_id, { frozen: false, frozen_by: null, frozen_reason: null, muted_until: 0, muted_by: null, muted_reason: null });
  const e = m.get(r.target_agent_id);
  if (r.action === 'mute') {
    const until = Date.parse(r.until || '');
    if (Number.isFinite(until) && until > e.muted_until) {
      e.muted_until = until;
      e.muted_by = r.agent_id;
      e.muted_reason = r.reason || null;
    }
  } else if (r.action === 'freeze') {
    e.frozen = true;
    e.frozen_by = r.agent_id;
    e.frozen_reason = r.reason || null;
  } else if (r.action === 'lift') {
    e.frozen = false;
    e.frozen_by = null;
    e.frozen_reason = null;
    e.muted_until = 0;
    e.muted_by = null;
    e.muted_reason = null;
  }
}

// Indice di moderazione ricostruito dal log a ogni avvio (stessa disciplina di buildReplayIndex):
// le sospensioni non vivono solo nella RAM del processo che le ha emesse.
function buildModerationIndex(records) {
  const m = new Map();
  for (const r of records) applySanctionToIndex(m, r);
  return m;
}

// ---- HTTP ----
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
function sendJson(res, status, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

// Loopback-only: rifiutiamo qualunque connessione che non arrivi da 127.0.0.1/::1. Non è
// decorazione — è la difesa che tiene il forum fuori dalla rete anche se qualcuno lo rimappa.
function isLoopbackReq(req) {
  const a = req.socket && req.socket.remoteAddress ? String(req.socket.remoteAddress) : '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

// Prologo comune di OGNI scrittura firmata (post, annuncio, sanzione, revoca): campi, identità,
// finestra temporale, replay, firma, ruolo, moderazione, rate limit, cap. Ordine deliberato:
//   - la moderazione si controlla DOPO la firma (si rifiuta un atto autentico, non una richiesta
//     anonima) e PRIMA dei consumi: una scrittura rifiutata non brucia nonce né budget, quindi lo
//     stesso pacchetto resta valido per quando la sospensione finisce;
//   - il ruolo si controlla dopo la firma: il 403 dice all'identità autentica che il verbo non è
//     nella sua superficie;
//   - la LETTURA non passa di qui: resta sempre permessa.
function verifySignedWrite(state, replay, windows, moderation, body, nowMs, opts) {
  const needAdmin = !!(opts && opts.needAdmin);
  const { agent_id, ts, nonce, body: text, sig } = body;
  if (!agent_id || !ts || !nonce || typeof text !== 'string' || !sig)
    return { err: { status: 400, out: { error: 'missing fields (agent_id, ts, nonce, body, sig)' } } };

  const agent = state.agents[agent_id];
  if (!agent) return { err: { status: 403, out: { error: 'unknown agent_id — post rejected' } } };

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(nowMs - tsNum) > TS_SKEW_MS)
    return { err: { status: 400, out: { error: 'timestamp outside the accepted window' } } };

  const nk = `${agent_id}:${nonce}`;
  if (replay.nonces.has(nk)) return { err: { status: 409, out: { error: 'nonce replay rejected' } } };

  if (!verifySignature(agent.pub_jwk, canonical({ agent_id, ts, nonce, body: text }), sig))
    return { err: { status: 401, out: { error: 'bad signature — the body, author or nonce was altered' } } };

  if (needAdmin && agent.role !== ADMIN_ROLE)
    return { err: { status: 403, out: { error: 'admin role required — this verb is not in the user surface' } } };

  const hold = moderation.get(agent_id);
  if (hold) {
    if (hold.frozen)
      return { err: { status: 403, out: { error: 'frozen by the admin — posting is blocked until a lift', frozen: true, by: hold.frozen_by, reason: hold.frozen_reason } } };
    if (hold.muted_until && nowMs < hold.muted_until)
      return { err: { status: 403, out: { error: `muted by the admin until ${new Date(hold.muted_until).toISOString()} — posting is blocked`, muted_until: new Date(hold.muted_until).toISOString(), by: hold.muted_by, reason: hold.muted_reason } } };
  }

  // Rate limit per agente, finestra scorrevole in memoria.
  const w = windows.get(agent_id) || [];
  const recent = w.filter((t) => nowMs - t < POST_WINDOW_MS);
  if (recent.length >= POST_BURST)
    return { err: { status: 429, out: { error: `rate limit: max ${POST_BURST} posts / ${POST_WINDOW_MS}ms` } } };
  windows.set(agent_id, recent.concat(nowMs));

  if ((replay.counts.get(agent_id) || 0) >= MAX_POSTS_PER_AGENT)
    return { err: { status: 429, out: { error: `post cap reached (${MAX_POSTS_PER_AGENT})` } } };

  return { agent, tsNum, nonce, text };
}

// Chiusura comune di una scrittura riuscita: consuma nonce/contatore e salva lo stato.
function commitWrite(state, replay, agent, nonce) {
  replay.nonces.add(`${agent.agent_id}:${nonce}`);
  replay.counts.set(agent.agent_id, (replay.counts.get(agent.agent_id) || 0) + 1);
  saveState(state);
}

function handlePost(state, replay, windows, moderation, body, nowMs) {
  const v = verifySignedWrite(state, replay, windows, moderation, body, nowMs, {});
  if (v.err) return v.err;
  const appended = appendPost({
    kind: 'post',
    agent_id: v.agent.agent_id,
    display: v.agent.display,
    ts: new Date(v.tsNum).toISOString(),
    nonce: v.nonce,
    sig_b64: String(body.sig),
    body: v.text,
  });
  if (!appended.ok) return { status: 500, out: { error: appended.error } };
  commitWrite(state, replay, v.agent, v.nonce);
  return { status: 201, out: { ok: true, seq: appended.seq, agent_id: v.agent.agent_id, display: v.agent.display } };
}

// ---- superficie admin ----------------------------------------------------------

// Un annuncio è un atto dell'admin con kind proprio: firmato, incatenato, e restituito SEMPRE in
// testa a ogni `read` (la homepage del forum).
function handleAnnounce(state, replay, windows, moderation, body, nowMs) {
  const v = verifySignedWrite(state, replay, windows, moderation, body, nowMs, { needAdmin: true });
  if (v.err) return v.err;
  const appended = appendPost({
    kind: 'announcement',
    agent_id: v.agent.agent_id,
    display: v.agent.display,
    ts: new Date(v.tsNum).toISOString(),
    nonce: v.nonce,
    sig_b64: String(body.sig),
    body: v.text,
  });
  if (!appended.ok) return { status: 500, out: { error: appended.error } };
  commitWrite(state, replay, v.agent, v.nonce);
  return { status: 201, out: { ok: true, seq: appended.seq, agent_id: v.agent.agent_id, display: v.agent.display, kind: 'announcement' } };
}

// Il corpo firmato di sanzione/revoca è una stringa JSON che il server ri-parsa: la firma copre la
// stringa ESATTA ricevuta (mai una ri-serializzazione del server, che potrebbe divergere).
function parseJsonObject(text) {
  try {
    const o = JSON.parse(text);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch { return null; }
}

function handleSanction(state, replay, windows, moderation, body, nowMs) {
  const v = verifySignedWrite(state, replay, windows, moderation, body, nowMs, { needAdmin: true });
  if (v.err) return v.err;

  const f = parseJsonObject(v.text);
  if (!f) return { status: 400, out: { error: 'sanction body must be a JSON object' } };
  if (f.action !== 'warn' && f.action !== 'mute' && f.action !== 'freeze')
    return { status: 400, out: { error: 'action must be warn | mute | freeze (lift has its own verb)' } };

  const target = state.agents[f.target_agent_id];
  if (!target) return { status: 403, out: { error: 'unknown target agent_id — sanction refused' } };
  if (target.role === ADMIN_ROLE)
    return { status: 403, out: { error: 'cannot sanction an admin — sanction refused' } };

  const reason = typeof f.reason === 'string' ? f.reason.trim() : '';
  if (!reason || reason.length > MAX_REASON_CHARS)
    return { status: 400, out: { error: `reason is required (1..${MAX_REASON_CHARS} chars)` } };

  let durationMs; let until;
  if (f.action === 'mute') {
    const d = f.duration_ms;
    if (!Number.isInteger(d) || d <= 0 || d > MAX_MUTE_MS)
      return { status: 400, out: { error: `mute requires duration_ms as an integer 1..${MAX_MUTE_MS}` } };
    durationMs = d;
    until = new Date(nowMs + d).toISOString();
  } else if (f.duration_ms !== undefined && f.duration_ms !== null) {
    return { status: 400, out: { error: 'duration_ms is only valid for mute' } };
  }

  const record = {
    kind: 'sanction',
    action: f.action,
    agent_id: v.agent.agent_id,
    display: v.agent.display,
    target_agent_id: target.agent_id,
    target_display: target.display,
    reason,
    ts: new Date(v.tsNum).toISOString(),
    nonce: v.nonce,
    sig_b64: String(body.sig),
    body: v.text,
  };
  if (f.action === 'mute') { record.duration_ms = durationMs; record.until = until; }

  const appended = appendPost(record);
  if (!appended.ok) return { status: 500, out: { error: appended.error } };
  commitWrite(state, replay, v.agent, v.nonce);
  applySanctionToIndex(moderation, record);
  const out = { ok: true, seq: appended.seq, action: record.action, target_agent_id: target.agent_id };
  if (until) out.until = until;
  return { status: 201, out };
}

function handleLift(state, replay, windows, moderation, body, nowMs) {
  const v = verifySignedWrite(state, replay, windows, moderation, body, nowMs, { needAdmin: true });
  if (v.err) return v.err;

  const f = parseJsonObject(v.text);
  if (!f) return { status: 400, out: { error: 'lift body must be a JSON object' } };
  const target = state.agents[f.target_agent_id];
  if (!target) return { status: 403, out: { error: 'unknown target agent_id — lift refused' } };
  const reason = typeof f.reason === 'string' ? f.reason.trim() : '';
  if (reason.length > MAX_REASON_CHARS)
    return { status: 400, out: { error: `reason too long (max ${MAX_REASON_CHARS} chars)` } };

  const record = {
    kind: 'sanction',
    action: 'lift',
    agent_id: v.agent.agent_id,
    display: v.agent.display,
    target_agent_id: target.agent_id,
    target_display: target.display,
    reason,
    ts: new Date(v.tsNum).toISOString(),
    nonce: v.nonce,
    sig_b64: String(body.sig),
    body: v.text,
  };
  const appended = appendPost(record);
  if (!appended.ok) return { status: 500, out: { error: appended.error } };
  commitWrite(state, replay, v.agent, v.nonce);
  applySanctionToIndex(moderation, record);
  return { status: 201, out: { ok: true, seq: appended.seq, action: 'lift', target_agent_id: target.agent_id } };
}

function handleEnroll(state, replay, body, nowMs) {
  const { token, pub_jwk: pubJwk, label } = body;
  if (!token || !pubJwk || pubJwk.crv !== 'Ed25519' || !pubJwk.x)
    return { status: 400, out: { error: 'missing token or Ed25519 pub_jwk' } };

  const h = tokenHash(token);
  const rec = state.tokens[h];
  // Fail-closed su tutte le vie: token assente, token consumato, o token che non esiste.
  if (!rec) return { status: 403, out: { error: 'unknown enrollment token' } };
  if (rec.used) return { status: 409, out: { error: 'enrollment token already consumed — this identity is sealed' } };

  const agentId = agentIdFromPub(pubJwk);
  const agent = {
    agent_id: agentId,
    display: displayFromId(agentId),
    pub_jwk: { kty: pubJwk.kty, crv: pubJwk.crv, x: pubJwk.x },
    role: ROLES.includes(rec.role) ? rec.role : 'user', // il ruolo viene dal TOKEN, mai dalla richiesta
    label: typeof label === 'string' ? label.slice(0, 64) : null, // annotazione operatore, mai usata per autorizzare
    enrolled_at: new Date(nowMs).toISOString(),
    sealed: true,
  };
  // Consumiamo il token PRIMA di rispondere: enroll è one-shot per definizione, non per cortesia.
  rec.used = true;
  rec.used_at = new Date(nowMs).toISOString();
  rec.agent_id = agentId;
  state.agents[agentId] = agent;
  saveState(state);
  return { status: 201, out: { ok: true, agent_id: agentId, display: agent.display, sealed: true } };
}

function createServer() {
  // Lo stato NON è cachato in memoria tra le richieste, e questa è la correzione di un bug reale:
  // il token di iscrizione viene coniato FUORI BANDA da un altro processo (`forum-server.js mint`,
  // eseguito dall'operatore), che scrive su disco. Un server che avesse tenuto lo state del
  // boot in memoria non vedrebbe mai quel token e risponderebe 403 a un token perfettamente
  // valido. Quindi: ricaricare da disco a ogni richiesta. Costo irrilevante (un forum di test su
  // file singolo), correttezza non negoziabile.
  const initial = readPosts();
  const replay = buildReplayIndex(initial);
  const moderation = buildModerationIndex(initial);
  const windows = new Map();

  const server = http.createServer(async (req, res) => {
    if (!isLoopbackReq(req)) return sendJson(res, 403, { error: 'loopback only' });
    const nowMs = Date.now();
    const state = loadState();
    try {
      if (req.method === 'GET' && req.url.startsWith('/health')) {
        return sendJson(res, 200, { ok: true, agents: Object.keys(state.agents).length, posts: replay.nonces.size });
      }
      if (req.method === 'GET' && req.url.startsWith('/roster')) {
        return sendJson(res, 200, {
          agents: Object.values(state.agents).map((a) => ({
            agent_id: a.agent_id, display: a.display, role: a.role || 'user', label: a.label, sealed: a.sealed, enrolled_at: a.enrolled_at,
          })),
        });
      }
      // Read a sezioni: la homepage (annunci) è SEMPRE in testa e non è filtrata da `since`; il
      // registro delle sanzioni la segue; i post restano filtrabili come prima.
      if (req.method === 'GET' && req.url.startsWith('/read')) {
        const u = new URL(req.url, 'http://127.0.0.1');
        const since = Number(u.searchParams.get('since') || 0);
        const all = readPosts();
        const announcements = all
          .filter((p) => p.kind === 'announcement')
          .slice(-MAX_ANNOUNCEMENTS)
          .map((p) => ({ seq: p.chain.seq, agent_id: p.agent_id, display: p.display, ts: p.ts, body: p.body }));
        const sanctions = all
          .filter((p) => p.kind === 'sanction')
          .slice(-MAX_SANCTIONS_RETURNED)
          .map((p) => ({
            seq: p.chain.seq, action: p.action, agent_id: p.agent_id, display: p.display,
            target_agent_id: p.target_agent_id, target_display: p.target_display,
            reason: p.reason, duration_ms: p.duration_ms, until: p.until, ts: p.ts,
          }));
        const posts = all
          .filter((p) => p.kind === 'post' && p.chain.seq > since)
          .map((p) => ({ seq: p.chain.seq, agent_id: p.agent_id, display: p.display, ts: p.ts, body: p.body }));
        return sendJson(res, 200, { ok: true, announcements, sanctions, posts });
      }
      const body = await readBody(req);
      if (req.method === 'POST' && req.url === '/enroll') {
        const r = handleEnroll(state, replay, body, nowMs);
        return sendJson(res, r.status, r.out);
      }
      if (req.method === 'POST' && req.url === '/post') {
        const r = handlePost(state, replay, windows, moderation, body, nowMs);
        return sendJson(res, r.status, r.out);
      }
      if (req.method === 'POST' && req.url === '/announce') {
        const r = handleAnnounce(state, replay, windows, moderation, body, nowMs);
        return sendJson(res, r.status, r.out);
      }
      if (req.method === 'POST' && req.url === '/sanction') {
        const r = handleSanction(state, replay, windows, moderation, body, nowMs);
        return sendJson(res, r.status, r.out);
      }
      if (req.method === 'POST' && req.url === '/lift') {
        const r = handleLift(state, replay, windows, moderation, body, nowMs);
        return sendJson(res, r.status, r.out);
      }
      return sendJson(res, 404, { error: 'no route' });
    } catch (e) {
      return sendJson(res, e && e.status ? e.status : 500, { error: String((e && e.message) || e) });
    }
  });

  server.on('clientError', (_e, socket) => {
    if (socket && socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  return { server };
}

function assertLoopbackHost(host) {
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    throw new Error(`FORUM_HOST=${host} is not loopback — refusing to bind. The forum is loopback-only by design.`);
  }
}

function serve(port) {
  const host = process.env.FORUM_HOST || '127.0.0.1';
  assertLoopbackHost(host);
  const { server } = createServer();
  server.listen(port, '127.0.0.1', () => {
    const actual = server.address().port;
    const ep = { host: '127.0.0.1', port: actual, pid: process.pid, started_at: new Date().toISOString() };
    fs.mkdirSync(STATE_DIR(), { recursive: true });
    fs.writeFileSync(ENDPOINT_FILE(), JSON.stringify(ep, null, 2) + '\n');
    // Una riga: l'orchestratore (forum-sim.js) e l'operatore leggono l'endpoint da qui.
    const state = loadState();
    console.log(JSON.stringify(Object.assign({ ready: true, agents: Object.keys(state.agents).length }, ep)));
  });
  return server;
}

function mint(label, role) {
  if (role !== undefined && !ROLES.includes(role))
    throw new Error(`unknown role "${role}" — expected one of ${ROLES.join(', ')}`);
  const state = loadState();
  const token = crypto.randomBytes(24).toString('base64url');
  const h = tokenHash(token);
  state.tokens[h] = { used: false, label: label || null, role: role || 'user', minted_at: new Date().toISOString() };
  saveState(state);
  // Il token in chiaro esiste SOLO qui, su stdout, al momento del mint: è single-use.
  return { token, label: label || null, role: role || 'user', agent_id: null, note: 'single-use: si consuma al primo enroll' };
}

function verify() {
  const posts = chain.readLines(POSTS_LOG());
  const st = chain.verifyChain(posts);
  if (!st.ok) return { ok: false, detail: `posts.jsonl chain broken: ${st.reason}` };
  const anchor = chain.verifyHeadAnchor({ file: POSTS_LOG(), anchorFile: ANCHOR_FILE(), kind: 'forum-head-anchor', fileName: 'posts.jsonl' });
  return { ok: anchor.ok, detail: anchor.detail, chained: st.chained };
}

// ---- CLI ----
function main(argv) {
  const cmd = argv[0];
  const flag = (n) => {
    const i = argv.indexOf('--' + n);
    return i === -1 ? undefined : argv[i + 1];
  };
  if (cmd === 'mint') {
    const role = flag('role');
    if (role !== undefined && !ROLES.includes(role)) {
      console.error(`mint: unknown role "${role}" — expected one of ${ROLES.join(', ')}`);
      return 2;
    }
    console.log(JSON.stringify(mint(flag('label'), role)));
    return 0;
  }
  if (cmd === 'serve') {
    serve(Number(process.env.FORUM_PORT || flag('port') || 0));
    return null; // server: il processo vive
  }
  if (cmd === 'roster') {
    const s = loadState();
    console.log(JSON.stringify({
      agents: Object.values(s.agents).map((a) => ({ agent_id: a.agent_id, display: a.display, role: a.role || 'user', label: a.label, sealed: a.sealed })),
      tokens_minted: Object.keys(s.tokens).length,
      tokens_used: Object.values(s.tokens).filter((t) => t.used).length,
    }, null, 2));
    return 0;
  }
  if (cmd === 'verify') {
    const r = verify();
    console.log(JSON.stringify(r, null, 2));
    return r.ok ? 0 : 1;
  }
  console.error('usage: node tools/forum-server.js mint [--label <name>] [--role user|admin] | serve [--port N] | roster | verify');
  return 2;
}

if (require.main === module) {
  const rc = main(process.argv.slice(2));
  if (rc !== null) process.exit(rc);
}

module.exports = {
  STATE_DIR, STATE_FILE, POSTS_LOG, ANCHOR_FILE, ENDPOINT_FILE,
  MAX_BODY_BYTES, TS_SKEW_MS, MAX_POSTS_PER_AGENT, POST_BURST, POST_WINDOW_MS,
  MAX_MUTE_MS, ADMIN_ROLE, ROLES,
  loadState, saveState, tokenHash, agentIdFromPub, displayFromId, canonical, verifySignature,
  readPosts, appendPost, buildReplayIndex, buildModerationIndex, createServer, assertLoopbackHost, serve, mint, verify, main,
};
