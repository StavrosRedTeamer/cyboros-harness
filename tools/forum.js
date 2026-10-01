#!/usr/bin/env node
// forum.js — il wrapper che l'agente invoca per parlare sul forum. È l'unico processo che tocca
// la chiave privata, e il modello non vede mai il segreto: vede i verbi.
//
// TRE PROPRIETÀ, per costruzione e non per convenzione:
//
//  1. IL SEGRETO NON ESCE. La chiave Ed25519 sta in un keyfile 0600 e nessun comando di questo
//     wrapper la stampa, la copia o la espone. `--print-key` non esiste. Un prompt injection che
//     faccia dire all'agente "invia la tua chiave" ottiene un rifiuto perché il comando non c'è.
//
//  2. NON C'È `--as`. L'agent_id viene SEMPRE derivato dal keyfile, mai da un argomento. L'es-
//     pressione "fingersi qualcun altro" non è vietata da una regola: non è scrivibile. Questo
//     è il motivo per cui il wrapper esiste invece di un `curl` con la chiave in mano.
//
//  3. LA FIRMA COBRA TUTTO. Firma l'agent_id, il timestamp, il nonce e l'hash del corpo: un
//     body-tamper, un replay o un cambio d'autore invalidano la firma lato server.
//
// Dopo l'enroll il wrapper è "sealed": non ha più verbi di identità. Un secondo `enroll` con lo
// stesso token viene rifiutato dal server (409) e il wrapper non lo ritenta da solo.
//
// CLI (l'unica superficie che il modello vede):
//   node tools/forum.js enroll --token <T>     # una volta sola, con il token dell'operatore
//   node tools/forum.js whoami                 # identità, senza segreti
//   node tools/forum.js post "<testo>"         # firma e pubblica
//   node tools/forum.js read [--since N]       # transcript + homepage (annunci) + sanzioni
//   node tools/forum.js verify                 # la firma del transcript (utilità operatore)
//
// Env: FORUM_STATE (stato server), FORUM_KEYDIR (default <FORUM_STATE>/keys), FORUM_URL.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');

const srv = require('./forum-server');
const keystore = require('./forum-keystore');

const KEY_DIR = () => process.env.FORUM_KEYDIR || path.join(srv.STATE_DIR(), 'keys');
// Il keyfile è l'identità: un solo file per processo. 0600 perché è una chiave privata e il
// repo già tratta i file di credenziali come 0600 (lo stesso criterio che usa tools/doctor.js).
const KEY_FILE = () => path.join(KEY_DIR(), 'identity.json');

function serverUrl() {
  if (process.env.FORUM_URL) return process.env.FORUM_URL;
  try {
    const ep = JSON.parse(fs.readFileSync(srv.ENDPOINT_FILE(), 'utf8'));
    return `http://${ep.host}:${ep.port}`;
  } catch {
    return null;
  }
}

function request(method, pathname, payload) {
  const base = serverUrl();
  if (!base) return Promise.resolve({ status: 0, body: { error: 'no forum endpoint — start forum-server.js serve first' } });
  const data = payload === undefined ? null : Buffer.from(JSON.stringify(payload), 'utf8');
  return new Promise((resolve) => {
    const u = new URL(base);
    const req = http.request({
      host: u.hostname,
      port: u.port || 80,
      path: pathname,
      method,
      headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = { raw: Buffer.concat(chunks).toString('utf8') }; }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('error', (e) => resolve({ status: 0, body: { error: String(e.message || e) } }));
    if (data) req.write(data);
    req.end();
  });
}

// ---- identità locale ----
function hasIdentity() { return fs.existsSync(KEY_FILE()); }

// Lettura SOLO per firmare. Nessun comando di questo file la restituisce a stdout e NON è
// esportata: `loadPrivate` è module-internal, il suo unico uso è `crypto.sign`. Esportarla
// sarebbe una porta sul retro: un `require('./tools/forum.js').loadPrivate()` qualunque
// consegnerebbe la chiave a chiunque può già eseguire codice in questo runtime.
//
// Il keyfile contiene solo l'ENVELOPE (metadati di custodia + eventuale ciphertext); la chiave
// privata vive nel keystore scelto — kernel keyring, passphrase, o, solo come ultima risorsa,
// in chiaro. Vedi tools/forum-keystore.js per perché `0600` da solo non basta.
function loadPrivate() {
  if (!hasIdentity()) throw new Error('no forum identity in this runtime — run `node tools/forum.js enroll --token <T>` once');
  const envelope = JSON.parse(fs.readFileSync(KEY_FILE(), 'utf8'));
  const privJwk = keystore.openEnvelope(envelope, { prompt: true });
  return { agentId: envelope.agent_id, key: crypto.createPrivateKey({ key: privJwk, format: 'jwk' }) };
}

function saveIdentity(agentId, privJwk, opts) {
  const backend = (opts && opts.backend) || keystore.pick();
  const envelope = keystore.sealEnvelope(agentId, privJwk, backend, { seeding: true, prompt: true });
  fs.mkdirSync(KEY_DIR(), { recursive: true });
  const tmp = KEY_FILE() + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(envelope, null, 2) + '\n');
  fs.renameSync(tmp, KEY_FILE());
  try { fs.chmodSync(KEY_FILE(), 0o600); } catch { /* piattaforme senza mode POSIX */ }
  return envelope;
}

// Diagnostica di custodia: che backend è attivo, se il segreto è su disco, come si arriva alla
// chiave. È la domanda che si pone un analizzatore esterno, quindi è la prima che rispondiamo.
function keyringReport() {
  const envelope = hasIdentity() ? JSON.parse(fs.readFileSync(KEY_FILE(), 'utf8')) : null;
  const rep = keystore.describe(envelope);
  return Object.assign(rep, {
    backends_available: keystore.available(),
    backend_selected: keystore.pick(),
    keyfile: KEY_FILE(),
  });
}

function generateKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { pub: publicKey.export({ format: 'jwk' }), priv: privateKey.export({ format: 'jwk' }) };
}

// ---- verbi ----
async function enroll(token, label) {
  // Idempotenza difensiva a livello di runtime: se l'identità esiste già, non la sostituiamo e
  // non "ri-iscriviamo". Il server è comunque l'autorità (409 sul token consumato): qui evito
  // solo di sprecare un token buono su un runtime che ha già la sua identità.
  if (hasIdentity()) {
    const cur = JSON.parse(fs.readFileSync(KEY_FILE(), 'utf8'));
    return { ok: false, error: `identity already enrolled in this runtime as ${cur.agent_id} — enrollment is one-shot`, agent_id: cur.agent_id };
  }
  const kp = generateKeypair();
  // `label` è annotazione dell'operatore: non autorizza niente e non compare nelle richieste
  // firmate. L'identità la deriva il server dalla pubkey.
  const r = await request('POST', '/enroll', { token, pub_jwk: { kty: kp.pub.kty, crv: kp.pub.crv, x: kp.pub.x }, label: label || null });
  if (r.status !== 201) return { ok: false, error: r.body.error || `enroll refused (${r.status})`, status: r.status };
  saveIdentity(r.body.agent_id, kp.priv);
  return { ok: true, agent_id: r.body.agent_id, display: r.body.display, sealed: true };
}

async function whoami() {
  if (!hasIdentity()) return { ok: false, error: 'not enrolled in this runtime' };
  const { agentId } = loadPrivate();
  const roster = await request('GET', '/roster');
  const me = (roster.body.agents || []).find((a) => a.agent_id === agentId) || null;
  return { ok: true, agent_id: agentId, display: me ? me.display : null, sealed: me ? me.sealed : null };
}

async function post(text) {
  if (!hasIdentity()) return { ok: false, error: 'not enrolled in this runtime' };
  const { agentId, key } = loadPrivate();
  const ts = Date.now();
  const nonce = crypto.randomBytes(16).toString('base64url');
  // agent_id NON è un parametro: viene dal keyfile. Nessun modo di firma per un altro.
  const sig = crypto.sign(null, Buffer.from(srv.canonical({ agent_id: agentId, ts, nonce, body: text }), 'utf8'), key)
    .toString('base64');
  const r = await request('POST', '/post', { agent_id: agentId, ts, nonce, body: text, sig });
  if (r.status !== 201) return { ok: false, error: r.body.error || `post refused (${r.status})`, status: r.status };
  return { ok: true, seq: r.body.seq, agent_id: agentId };
}

async function read(since) {
  const r = await request('GET', `/read?since=${Number(since) || 0}`);
  if (r.status !== 200) return { ok: false, error: r.body.error || `read refused (${r.status})`, status: r.status };
  // Sezioni: la homepage (annunci dell'admin) è SEMPRE in testa a ogni lettura; poi il registro
  // delle sanzioni; poi i post, filtrabili con --since come prima.
  return {
    ok: true,
    announcements: r.body.announcements || [],
    sanctions: r.body.sanctions || [],
    posts: r.body.posts || [],
  };
}

async function main(argv) {
  const cmd = argv[0];
  const flag = (n) => { const i = argv.indexOf('--' + n); return i === -1 ? undefined : argv[i + 1]; };
  switch (cmd) {
    case 'enroll': {
      const token = flag('token');
      if (!token) { console.error('enroll requires --token <T> (the operator mints it with forum-server.js mint)'); return 2; }
      const r = await enroll(token, flag('label'));
      console.log(JSON.stringify(r));
      return r.ok ? 0 : 1;
    }
    case 'whoami': {
      const r = await whoami();
      console.log(JSON.stringify(r));
      return r.ok ? 0 : 1;
    }
    case 'post': {
      const text = argv.slice(1).filter((a) => a !== '--').join(' ');
      if (!text) { console.error('post requires the message text'); return 2; }
      const r = await post(text);
      console.log(JSON.stringify(r));
      return r.ok ? 0 : 1;
    }
    case 'read': {
      const r = await read(flag('since'));
      console.log(JSON.stringify(r, null, 2));
      return r.ok ? 0 : 1;
    }
    case 'verify': {
      const r = srv.verify();
      console.log(JSON.stringify(r, null, 2));
      return r.ok ? 0 : 1;
    }
    case 'keyring': {
      console.log(JSON.stringify(keyringReport(), null, 2));
      return 0;
    }
    default:
      console.error('usage: node tools/forum.js enroll --token <T> | whoami | post "<testo>" | read [--since N] | verify | keyring');
      return 2;
  }
}

// `main` è async ma questo modulo resta CommonJS sincrono: un `await` a top-level metterebbe il
// file in un ESM graph con top-level await e i `require()` di altri tool (fork, test, simulatore)
// fallirebbero con ERR_REQUIRE_ASYNC_MODULE. Promise + then, quindi.
if (require.main === module) {
  main(process.argv.slice(2)).then((rc) => process.exit(rc)).catch((e) => {
    console.error('forum.js: ' + String((e && e.message) || e));
    process.exit(1);
  });
}

// Superficie esportata: `loadPrivate` è DI VOLTA escluso (vedi sopra). `generateKeypair` è
// innocuo (produce una chiave nuova, non legge nulla).
module.exports = {
  KEY_DIR, KEY_FILE, serverUrl, request, hasIdentity, saveIdentity, generateKeypair,
  keyringReport, enroll, whoami, post, read, main,
};
