#!/usr/bin/env node
// test-tags: loopback   # avvia un server su 127.0.0.1 -> il runner imposta ALLOW_METADATA_TARGET=1
// test-agent-forum.js — le quattro proprietà che l'invariante "un agente, una identità" richiede,
// verificate CONTRO il server in esecuzione (non sulla funzione in isolation: un test che non
// passa dalla rete non prova il confine).
//
//   1. ENROLL ONE-SHOT   — primo enroll 201, il token è consumato, il secondo è 409.
//   2. IMPERSONATION     — post firmato con agent_id altrui ma chiave propria → 401/403. Nessun
//                          campo "author" accettato dal server: l'identità si deriva dalla pubkey.
//   3. REPLAY            — stesso pacchetto (nonce incluso) due volte → 409.
//   4. BODY TAMPER       — corpo modificato dopo la firma → 401 (l'hash del corpo è nella firma).
//   + il transcript è incatenato: una riga manomessa fa fallire verifyChain.
//
// Tutto in mkdtemp: nessuna scrittura sulle state reali del workspace.
'use strict';

const { ok, okAsync, summary, fixture } = require('./testkit');
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

// spawn che PROMETTE (a differenza di spawnSync, che bloccherebbe l'event loop del server che
// questa suite ospita in-process).
function spawnAsync(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, opts);
    let stdout = ''; let stderr = '';
    c.stdout.on('data', (d) => { stdout += d; });
    c.stderr.on('data', (d) => { stderr += d; });
    c.on('error', reject);
    c.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const srv = require('./forum-server');
const forum = require('./forum');

const T = fixture('agent-forum-test-');
process.env.FORUM_STATE = path.join(T, 'forum-state');
process.env.FORUM_KEYDIR = path.join(T, 'forum-keys');
process.env.FORUM_HOST = '127.0.0.1';

let server = null;
let PORT = 0;
const url = () => `http://127.0.0.1:${PORT}`;

function req(method, pathname, payload) {
  return new Promise((resolve, reject) => {
    const data = payload === undefined ? null : Buffer.from(JSON.stringify(payload), 'utf8');
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: pathname, method,
      headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let b = {};
        try { b = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* body non JSON */ }
        resolve({ status: res.statusCode, body: b });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { pub: publicKey.export({ format: 'jwk' }), priv: privateKey };
}
function sign(priv, agentId, ts, nonce, body) {
  return crypto.sign(null, Buffer.from(srv.canonical({ agent_id: agentId, ts, nonce, body }), 'utf8'), priv).toString('base64');
}

async function boot() {
  process.env.FORUM_PORT = '0';
  server = srv.serve(0);
  await new Promise((resolve) => server.once('listening', resolve));
  PORT = server.address().port;
  process.env.FORUM_URL = url();
}

(async function main() {
  await boot();

  // ---- 1. enroll one-shot ----------------------------------------------------
  const tokenA = srv.mint('alpha').token;
  const kpA = keypair();
  const aId = srv.agentIdFromPub(kpA.pub);

  let r = await req('POST', '/enroll', { token: tokenA, pub_jwk: kpA.pub, label: 'alpha' });
  ok('primo enroll accettato (201) e l\'identità è assegnata dal server', () => {
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.agent_id, aId, 'agent_id derivato dalla pubkey, non scelto dal client');
    assert.strictEqual(r.body.sealed, true);
  });
  ok('l\'agente non sceglie il proprio nome: display calcolato dal server', () => {
    assert.strictEqual(r.body.display, srv.displayFromId(aId));
    assert.ok(!('username' in r.body), 'nessun campo username accettato in risposta');
  });

  r = await req('POST', '/enroll', { token: tokenA, pub_jwk: keypair().pub });
  ok('SECONDO enroll con lo stesso token rifiutato (409): una sola iscrizione per credenziale', () => {
    assert.strictEqual(r.status, 409);
    assert.match(r.body.error, /consumed|sealed/i);
  });

  r = await req('POST', '/enroll', { token: 'token-inventato', pub_jwk: keypair().pub });
  ok('enroll con token inesistente rifiutato (403) — fail-closed', () => {
    assert.strictEqual(r.status, 403);
  });

  // il token consumato non è in chiaro su disco
  ok('il token consumato non è recuperabile da state.json (solo sha256)', () => {
    const raw = fs.readFileSync(srv.STATE_FILE(), 'utf8');
    assert.ok(!raw.includes(tokenA), 'il token in chiaro è presente in state.json');
    assert.ok(raw.includes(srv.tokenHash(tokenA)), 'lo sha256 del token è registrato');
  });

  // ---- 2. post firmato: il caso normale ------------------------------------
  const ts = Date.now();
  const nonce = crypto.randomBytes(16).toString('base64url');
  r = await req('POST', '/post', { agent_id: aId, ts, nonce, body: 'primo messaggio', sig: sign(kpA.priv, aId, ts, nonce, 'primo messaggio') });
  ok('post firmato accettato (201) e registrato nel transcript', () => {
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.agent_id, aId);
  });

  // ---- 3. replay ------------------------------------------------------------
  r = await req('POST', '/post', { agent_id: aId, ts, nonce, body: 'primo messaggio', sig: sign(kpA.priv, aId, ts, nonce, 'primo messaggio') });
  ok('REPLAY del pacchetto identico rifiutato (409)', () => {
    assert.strictEqual(r.status, 409);
    assert.match(r.body.error, /replay/i);
  });

  // ---- 4. impersonation -----------------------------------------------------
  const kpB = keypair();
  const bId = srv.agentIdFromPub(kpB.pub);
  r = await req('POST', '/enroll', { token: srv.mint('bravo').token, pub_jwk: kpB.pub });
  assert.strictEqual(r.status, 201, 'setup: secondo agente iscritto');

  // (a) dichiarare l'identità di B ma firmare con la chiave di A
  const ts2 = Date.now();
  const n2 = crypto.randomBytes(16).toString('base64url');
  r = await req('POST', '/post', { agent_id: bId, ts: ts2, nonce: n2, body: 'sono B', sig: sign(kpA.priv, bId, ts2, n2, 'sono B') });
  ok('IMPERSONATION: firma di A su agent_id di B rifiutata (401)', () => {
    assert.strictEqual(r.status, 401);
    assert.match(r.body.error, /signature/i);
  });

  // (b) post con un agent_id inesistente
  const ts3 = Date.now();
  const n3 = crypto.randomBytes(16).toString('base64url');
  r = await req('POST', '/post', { agent_id: 'af-deadbeef0000', ts: ts3, nonce: n3, body: 'chi sono', sig: sign(kpA.priv, 'af-deadbeef0000', ts3, n3, 'chi sono') });
  ok('agent_id non iscritto rifiutato (403) anche con firma ben formata', () => {
    assert.strictEqual(r.status, 403);
  });

  // (c) il server non accetta un campo author/display: proviamo a iniarlo
  const ts4 = Date.now();
  const n4 = crypto.randomBytes(16).toString('base64url');
  r = await req('POST', '/post', {
    agent_id: aId, author: bId, display: 'agent-B', ts: ts4, nonce: n4,
    body: 'display spoofato', sig: sign(kpA.priv, aId, ts4, n4, 'display spoofato'),
  });
  ok('un campo author/display iniettato non viene registrato: il display è quello iscritto', () => {
    assert.strictEqual(r.status, 201);
    const posts = srv.readPosts();
    const p = posts[posts.length - 1];
    assert.strictEqual(p.display, srv.displayFromId(aId), 'il display è derivato dall\'identità, non dal request');
    assert.strictEqual(p.author, undefined, 'nessun campo author persistito');
  });

  // ---- 5. body tamper -------------------------------------------------------
  const ts5 = Date.now();
  const n5 = crypto.randomBytes(16).toString('base64url');
  r = await req('POST', '/post', {
    agent_id: aId, ts: ts5, nonce: n5,
    body: 'testo INNOCUO modificato',
    sig: sign(kpA.priv, aId, ts5, n5, 'testo ORIGINALE'),
  });
  ok('BODY TAMPER: corpo alterato dopo la firma rifiutato (401)', () => {
    assert.strictEqual(r.status, 401);
  });

  // ---- 6. timestamp fuori finestra ------------------------------------------
  const old = Date.now() - (srv.TS_SKEW_MS + 60_000);
  const n6 = crypto.randomBytes(16).toString('base64url');
  r = await req('POST', '/post', { agent_id: aId, ts: old, nonce: n6, body: 'vecchio', sig: sign(kpA.priv, aId, old, n6, 'vecchio') });
  ok('pacchetto con timestamp fuori finestra rifiutato (400)', () => {
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /timestamp/i);
  });

  // ---- 7. replay protection sopravvive al restart ---------------------------
  const replayIdx = srv.buildReplayIndex(srv.readPosts());
  ok('l\'indice dei nonce si ricostruisce dal log: il replay non vive solo nella RAM', () => {
    assert.ok(replayIdx.nonces.has(`${aId}:${nonce}`), 'il nonce del primo post è noto dopo il reload');
  });

  // ---- 8. transcript incatenato + tamper detection -------------------------
  const chain = require('./chain-log');
  ok('verifyChain OK sul transcript append-only', () => {
    const st = chain.verifyChain(chain.readLines(srv.POSTS_LOG()));
    assert.ok(st.ok, st.reason || '');
    assert.ok(st.chained > 0);
  });
  ok('una riga manomessa a metà catena viene rilevata', () => {
    const lines = chain.readLines(srv.POSTS_LOG());
    const tampered = lines.slice();
    const obj = JSON.parse(tampered[0]);
    obj.body = 'contenuto riscritto retroattivamente';
    tampered[0] = JSON.stringify(obj);
    const st = chain.verifyChain(tampered);
    assert.strictEqual(st.ok, false, 'la manomissione è stata accettata');
    assert.match(st.reason, /prev_sha256 mismatch/);
  });
  ok('l\'ancora esterna coincide con la testa del transcript', () => {
    const v = srv.verify();
    assert.ok(v.ok, v.detail);
    assert.match(v.detail, /head anchor/);
  });

  // ---- 9. il wrapper non espone la chiave ----------------------------------
  // I check seguenti leggono il CODICE del wrapper, non i suoi commenti: l'header documenta
  // esplicitamente che `--print-key` e `--as` non esistono, e un grep grezzo sul file segnalerebbe
  // come violazione la frase che spiega perché è una violazione.
  const codeOf = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8')
    .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  ok('loadPrivate NON è esportato: nessun require() può estrarre la chiave', () => {
    assert.strictEqual(forum.loadPrivate, undefined, 'loadPrivate è esportata');
    assert.ok(!Object.keys(forum).includes('loadPrivate'));
  });

  // PROVA a RUNTIME, non un grep sul sorgente: un regex che cerca "print del segreto" produce
  // falsi positivi sui messaggi d'aiuto (che nominano il token per spiegare come usarlo) e falsi
  // negativi su un `console.log(JSON.stringify(r))` che riversa un oggetto contenente `d`. Qui si
  // eseguono i verbi per davvero e si cerca il materiale chiave nell'output effettivamente
  // prodotto — l'unica verifica che risponda alla domanda utile ("il segreto esce?").
  //
  // ASINCRONO per necessità, non per stile: il server vive in QUESTO processo, quindi un
  // spawnSync qui bloccherebbe l'event loop e i child non riceverebbero mai una risposta — il
  // test si autodestruggerebbe con un timeout invece di verificare qualcosa.
  await okAsync('NESSUN verbo del wrapper stampa il materiale chiave (prova a runtime)', async () => {
    const kp = keypair();
    // keypair() restituisce il KeyObject (serve a sign()): per il check del segreto serve il JWK,
    // che è la forma in cui la chiave viene persistita e su cui si cerca la fuga.
    const privJwk = kp.priv.export({ format: 'jwk' });
    forum.saveIdentity('af-runtimecheck01', privJwk);
    const secretBits = [privJwk.d, privJwk.x].filter(Boolean).map(String);
    assert.ok(secretBits.length, 'il keyfile di prova non contiene materiale chiave');

    const out = [];
    for (const args of [['whoami'], ['post', 'messaggio di prova'], ['read'], ['verify']]) {
      const r = await spawnAsync(process.execPath, [path.join(__dirname, 'forum.js'), ...args], {
        encoding: 'utf8', env: Object.assign({}, process.env),
      });
      out.push(String(r.stdout || ''), String(r.stderr || ''));
    }
    const joined = out.join('\n');
    for (const bit of secretBits) {
      assert.ok(!joined.includes(bit), 'materiale chiave presente nell\'output del wrapper');
    }
    assert.ok(joined.includes('af-runtimecheck01'), 'l\'output contiene l\'identità pubblica: il check è reale');
  });

  // ---- 10. envelope del client: firma sempre legata al proprio agent_id -----
  ok('il client firma col proprio agent_id e non ha un flag --as', () => {
    const code = codeOf('forum.js');
    assert.ok(!/--as\b/.test(code), 'esiste un flag --as: impersonazione esprimibile');
    assert.match(code, /agent_id: agentId/, 'il post manda l\'agent_id derivato dal keyfile');
  });
  ok('nessun comando del wrapper accetta un agent_id da argomento', () => {
    const code = codeOf('forum.js');
    // l'unico riferimento a agentId è la lettura dal keyfile: nessun flusso CLI che lo sovrascriva
    assert.ok(!/agentId\s*=/.test(code), 'agentId riassegnabile: impersonazione esprimibile');
  });

  // ---- 11. custodia del segreto: sul disco NON c'è materiale chiave ---------
  // NOTA: questa asserzione è cambiata rispetto alla prima versione, che verificava il
  // CONTRARIO ("la chiave è persistita"). `0600` è un permesso, non una cifratura: un lettore
  // del filesystem — o un analizzatore esterno, che è il caso d'uso di questo ambiente di studio —
  // otteneva la chiave in chiaro. Ora il keyfile contiene solo l'envelope di custodia.
  const SUB = fixture('agent-forum-keysub-');
  ok('il keyfile dell\'identità è 0600', () => {
    const { saveIdentity, generateKeypair, KEY_FILE } = forum;
    const kp = generateKeypair();
    const kpJwk = kp.priv;   // forum.generateKeypair() restituisce già JWK, non KeyObject
    const savedKey = process.env.FORUM_KEYDIR;
    process.env.FORUM_KEYDIR = path.join(SUB, 'perm');
    try {
      saveIdentity('af-testtesttest', kpJwk);
      assert.ok(fs.existsSync(KEY_FILE()));
      if (process.platform !== 'win32') {
        const mode = fs.statSync(KEY_FILE()).mode & 0o777;
        assert.strictEqual(mode, 0o600, `mode ${mode.toString(8)} invece di 600`);
      }
      const raw = fs.readFileSync(KEY_FILE(), 'utf8');
      assert.ok(!raw.includes(kpJwk.d), 'il keyfile contiene ancora materiale chiave in chiaro');
      assert.ok(!raw.includes(kpJwk.x), 'il keyfile contiene la pubblica raw (accettabile ma non necessaria)');
    } finally {
      process.env.FORUM_KEYDIR = savedKey;
    }
  });

  // ---- 11b. i tre backend: nessuno lascia il segreto in chiaro su disco -----
  const keystore = require('./forum-keystore');
  for (const backend of ['linux-keyring', 'passphrase', 'plaintext']) {
    await okAsync(`backend ${backend}: roundtrip + nessuna chiave in chiaro sul disco`, async () => {
      const dir = path.join(SUB, backend);
      const saved = process.env.FORUM_KEYDIR;
      const savedBackend = process.env.FORUM_KEYSTORE;
      const savedPass = process.env.FORUM_KEYSTORE_PASSPHRASE;
      process.env.FORUM_KEYDIR = dir;
      process.env.FORUM_KEYSTORE = backend;
      if (backend === 'passphrase') process.env.FORUM_KEYSTORE_PASSPHRASE = 'passphrase-di-prova';
      try {
        const kp = keypair().priv.export({ format: 'jwk' });
        forum.saveIdentity('af-backendtest1', kp);
        const raw = fs.readFileSync(forum.KEY_FILE(), 'utf8');

        // plaintext è l'unico backend che ammette la chiave in chiaro, ed è dichiarato tale.
        if (backend !== 'plaintext') {
          assert.ok(!raw.includes(kp.d), `${backend}: materiale chiave in chiaro sul disco`);
        }
        // il roundtrip deve funzionare e restituire la STESSA chiave
        const back = keystore.openEnvelope(JSON.parse(raw), { prompt: false });
        assert.strictEqual(back.d, kp.d, `${backend}: la chiave riaperta non coincide`);
        // e la diagnostica deve descrivere la custodia senza mentire
        const rep = keystore.describe(JSON.parse(raw));
        assert.strictEqual(rep.backend, backend);
        if (backend === 'plaintext') assert.strictEqual(rep.encrypted_at_rest, false, 'plaintext non si dichiara cifrato');
        if (backend === 'linux-keyring') assert.strictEqual(rep.secret_on_disk, false, 'keyring: la chiave non deve essere su disco');
      } finally {
        process.env.FORUM_KEYDIR = saved;
        if (savedBackend === undefined) delete process.env.FORUM_KEYSTORE; else process.env.FORUM_KEYSTORE = savedBackend;
        if (savedPass === undefined) delete process.env.FORUM_KEYSTORE_PASSPHRASE; else process.env.FORUM_KEYSTORE_PASSPHRASE = savedPass;
      }
    });
  }

  // ---- 11c. la passphrase è la sola barriera: se è sbagliata, si fallisce chiuso
  await okAsync('passphrase backend: passphrase errata e ciphertext manomesso vengono entrambi respinti', async () => {
    const dir = path.join(SUB, 'passneg');
    const saved = process.env.FORUM_KEYDIR;
    const savedBackend = process.env.FORUM_KEYSTORE;
    const savedPass = process.env.FORUM_KEYSTORE_PASSPHRASE;
    process.env.FORUM_KEYDIR = dir;
    process.env.FORUM_KEYSTORE = 'passphrase';
    process.env.FORUM_KEYSTORE_PASSPHRASE = 'passphrase-corretta';
    try {
      const kp = keypair().priv.export({ format: 'jwk' });
      forum.saveIdentity('af-passnegtest1', kp);
      const good = JSON.parse(fs.readFileSync(forum.KEY_FILE(), 'utf8'));

      process.env.FORUM_KEYSTORE_PASSPHRASE = 'passphrase-sbagliata';
      assert.throws(() => keystore.openEnvelope(good, { prompt: false }), /authenticate|state/i,
        'una passphrase sbagliata ha aperto il keystore');

      // flip di un byte del ciphertext: AES-GCM deve rifiutare l'autenticazione
      process.env.FORUM_KEYSTORE_PASSPHRASE = 'passphrase-corretta';
      const tampered = JSON.parse(JSON.stringify(good));
      const b = Buffer.from(tampered.ciphertext, 'base64');
      b[0] ^= 1;
      tampered.ciphertext = b.toString('base64');
      assert.throws(() => keystore.openEnvelope(tampered, { prompt: false }), /authenticate|state/i,
        'un ciphertext manomesso ha aperto il keystore');
    } finally {
      process.env.FORUM_KEYDIR = saved;
      if (savedBackend === undefined) delete process.env.FORUM_KEYSTORE; else process.env.FORUM_KEYSTORE = savedBackend;
      if (savedPass === undefined) delete process.env.FORUM_KEYSTORE_PASSPHRASE; else process.env.FORUM_KEYSTORE_PASSPHRASE = savedPass;
    }
  });

  await okAsync('senza passphrase non si apre e non si degrada in chiaro', async () => {
    const saved = process.env.FORUM_KEYSTORE_PASSPHRASE;
    const savedFile = process.env.FORUM_KEYSTORE_PASSPHRASE_FILE;
    const savedTTY = process.stdin.isTTY;
    delete process.env.FORUM_KEYSTORE_PASSPHRASE;
    delete process.env.FORUM_KEYSTORE_PASSPHRASE_FILE;
    try {
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
      const dir = path.join(SUB, 'nopass');
      process.env.FORUM_KEYDIR = dir;
      process.env.FORUM_KEYSTORE = 'passphrase';
      const kp = keypair().priv.export({ format: 'jwk' });
      // deve fallire: è preferibile non iscriversi a iscriversi con la chiave in chiaro
      assert.throws(() => forum.saveIdentity('af-nopasstest1', kp), /passphrase/i);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: savedTTY, configurable: true });
      if (saved !== undefined) process.env.FORUM_KEYSTORE_PASSPHRASE = saved;
      if (savedFile !== undefined) process.env.FORUM_KEYSTORE_PASSPHRASE_FILE = savedFile;
    }
  });

  // ---- 12. enroll idempotente lato runtime ---------------------------------
  ok('un secondo enroll sullo stesso runtime non crea una seconda identità', async () => {
    const res = await forum.enroll(srv.mint('delta').token, 'delta');
    assert.ok(res.ok, 'primo enroll locale: ' + res.error);
    const again = await forum.enroll(srv.mint('epsilon').token, 'epsilon');
    assert.strictEqual(again.ok, false);
    assert.match(again.error, /already enrolled/);
    assert.strictEqual(again.agent_id, res.agent_id, 'l\'identità non è stata sostituita');
  });

  // ---- 13. il server non si binda fuori dal loopback -----------------------
  ok('un host non-loopback è rifiutato, non risolvato in fallback', () => {
    assert.throws(() => srv.assertLoopbackHost('0.0.0.0'), /not loopback/);
    assert.throws(() => srv.assertLoopbackHost('10.0.0.5'), /not loopback/);
    assert.strictEqual(srv.assertLoopbackHost('127.0.0.1'), undefined);
  });

  server.close();
  summary('agent-forum');
})().catch((e) => {
  console.error('test-agent-forum: ' + (e && e.stack || e));
  if (server) server.close();
  process.exit(1);
});
