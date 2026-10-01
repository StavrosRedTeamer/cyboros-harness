#!/usr/bin/env node
// test-tags: loopback   # avvia un server su 127.0.0.1 -> il runner imposta ALLOW_METADATA_TARGET=1
// test-forum-admin.js — ruolo admin, homepage e moderazione, provati CONTRO il server in esecuzione
// (non sulle funzioni in isolamento: un test che non passa dalla rete non prova il confine).
//
//   1. RUOLO        — assegnato al mint (operatore), stampato su enroll/roster; il client non sceglie.
//   2. SUPERFICIE   — announce/sanction/lift rifiutati (403) a un'identità senza ruolo admin.
//   3. HOMEPAGE     — gli annunci tornano SEMPRE in testa a `read`, anche con `since` che taglia i post.
//   4. SANZIONI     — warn non blocca; mute blocca a scadenza; freeze blocca fino al lift; lift restituisce.
//   5. INVARIANTI   — replay/firma/tamper valgono anche sui verbi admin; la catena resta verificabile.
//
// Tutto in mkdtemp: nessuna scrittura sulle state reali del workspace.
'use strict';

const { ok, summary, fixture } = require('./testkit');
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const srv = require('./forum-server');
const forum = require('./forum');

const T = fixture('forum-admin-test-');
process.env.FORUM_STATE = path.join(T, 'forum-state');
process.env.FORUM_KEYDIR = path.join(T, 'keys-main');
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

// Iscrive una identità NUOVA via HTTP e restituisce { id, kp }.
async function enrollNew(label, role) {
  const token = srv.mint(label, role).token;
  const kp = keypair();
  const id = srv.agentIdFromPub(kp.pub);
  const r = await req('POST', '/enroll', { token, pub_jwk: kp.pub, label });
  assert.strictEqual(r.status, 201, `setup: enroll di ${label}: ${JSON.stringify(r.body)}`);
  return { id, kp };
}

// Pacchetto firmato: l'agent_id è quello dell'identità (il server lo riverifica comunque).
function packet(who, text) {
  const ts = Date.now();
  const nonce = crypto.randomBytes(16).toString('base64url');
  return { agent_id: who.id, ts, nonce, body: text, sig: sign(who.kp.priv, who.id, ts, nonce, text) };
}
const post = (who, text) => req('POST', '/post', packet(who, text));
const announce = (who, text) => req('POST', '/announce', packet(who, text));
const sanction = (who, fields) => req('POST', '/sanction', packet(who, JSON.stringify(fields)));
const lift = (who, fields) => req('POST', '/lift', packet(who, JSON.stringify(fields)));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async function main() {
  await boot();

  // ---- 1. ruolo: assegnato dal server al mint, stampato su enroll ----------
  const admin = await enrollNew('capo', 'admin');
  const user = await enrollNew('utente', 'user');

  const roster = await req('GET', '/roster');
  const aRow = (roster.body.agents || []).find((a) => a.agent_id === admin.id);
  const uRow = (roster.body.agents || []).find((a) => a.agent_id === user.id);
  ok('il ruolo viene dal TOKEN (mint): admin per il capo, user per l\'utente', () => {
    assert.ok(aRow && uRow, 'roster incompleto');
    assert.strictEqual(aRow.role, 'admin');
    assert.strictEqual(uRow.role, 'user');
  });
  ok('un ruolo sconosciuto al mint fallisce chiuso (mai un default silenzioso)', () => {
    assert.throws(() => srv.mint('x', 'superadmin'), /unknown role/);
  });

  // ---- 2. la superficie admin non è nella portata dell'utente -------------
  let r = await announce(user, 'annuncio abusivo');
  ok('un utente NON può annunciare (403)', () => {
    assert.strictEqual(r.status, 403);
    assert.match(r.body.error, /admin role required/);
  });
  r = await sanction(user, { action: 'warn', target_agent_id: admin.id, reason: 'prova' });
  ok('un utente NON può sanzionare (403)', () => {
    assert.strictEqual(r.status, 403);
  });
  r = await lift(user, { target_agent_id: admin.id });
  ok('un utente NON può revocare (403)', () => {
    assert.strictEqual(r.status, 403);
  });

  // ---- 3. homepage: annunci sempre in testa a read ------------------------
  r = await announce(admin, 'REGOLA 1 — si parla solo per sé; il resto lo rifiuta il server.');
  ok('l\'admin annuncia (201) e l\'atto è un annuncio', () => {
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.kind, 'announcement');
  });
  const firstPost = await post(user, 'osservazione 1: la homepage è visibile a tutti.');
  ok('l\'utente pubblica normalmente (201)', () => assert.strictEqual(firstPost.status, 201));

  let read = await req('GET', '/read?since=0');
  ok('read è a sezioni: homepage (annunci) in testa, poi sanzioni, poi post', () => {
    assert.strictEqual(read.status, 200);
    assert.deepStrictEqual(Object.keys(read.body), ['ok', 'announcements', 'sanctions', 'posts']);
    assert.ok(read.body.announcements.some((p) => /REGOLA 1/.test(p.body)), 'annuncio assente');
    assert.strictEqual(read.body.posts.length, 1);
  });

  read = await req('GET', `/read?since=${firstPost.body.seq}`);
  ok('la homepage torna SEMPRE: con since oltre l\'ultimo post i post si svuotano, gli annunci no', () => {
    assert.deepStrictEqual(read.body.posts, []);
    assert.ok(read.body.announcements.length >= 1);
  });

  // ---- 4. sanzioni ---------------------------------------------------------
  r = await sanction(admin, { action: 'warn', target_agent_id: user.id, reason: 'tono sopra le righe' });
  ok('warn: atto pubblico registrato, nessun blocco', () => {
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.action, 'warn');
  });
  let p = await post(user, 'post dopo il warn: permesso');
  ok('dopo un warn si può ancora scrivere', () => assert.strictEqual(p.status, 201));

  read = await req('GET', '/read?since=0');
  ok('la sezione sanzioni riporta il warn (autore, destinatario, motivo)', () => {
    const w = read.body.sanctions.find((s) => s.action === 'warn' && s.target_agent_id === user.id);
    assert.ok(w, 'warn assente dalle sanzioni');
    assert.strictEqual(w.agent_id, admin.id);
    assert.match(w.reason, /tono/);
  });

  // mute: blocco a scadenza, la lettura resta permessa, e il rifiuto non brucia il pacchetto.
  r = await sanction(admin, { action: 'mute', target_agent_id: user.id, reason: 'ritmo', duration_ms: 1500 });
  ok('mute: registrato con scadenza', () => {
    assert.strictEqual(r.status, 201);
    assert.ok(r.body.until, 'manca until');
  });
  const mutedPacket = packet(user, 'post durante il mute');
  const refused = await req('POST', '/post', mutedPacket);
  ok('mute: il post è rifiutato CON il motivo', () => {
    assert.strictEqual(refused.status, 403);
    assert.match(refused.body.error, /muted by the admin/);
    assert.ok(refused.body.muted_until, 'il rifiuto deve dire fino a quando');
  });
  const readWhileMuted = await req('GET', '/read');
  ok('mute: la lettura resta permessa (sempre)', () => assert.strictEqual(readWhileMuted.status, 200));

  r = await lift(admin, { target_agent_id: user.id, reason: 'fine della prova' });
  ok('lift: revoca registrata', () => {
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.action, 'lift');
  });
  p = await req('POST', '/post', mutedPacket); // STESSO pacchetto: un rifiuto non consuma nonce/budget
  ok('lift: la scrittura torna permessa, e il pacchetto rifiutato era ancora valido', () => {
    assert.strictEqual(p.status, 201, JSON.stringify(p.body));
  });

  // freeze: blocco fino a revoca
  r = await sanction(admin, { action: 'freeze', target_agent_id: user.id, reason: 'recidiva' });
  ok('freeze: registrato', () => assert.strictEqual(r.status, 201));
  p = await post(user, 'post durante il freeze');
  ok('freeze: il post è rifiutato (fino a lift)', () => {
    assert.strictEqual(p.status, 403);
    assert.match(p.body.error, /frozen by the admin/);
  });
  await lift(admin, { target_agent_id: user.id, reason: 'riabilitato' });
  p = await post(user, 'post dopo il lift del freeze');
  ok('lift: dopo il freeze la scrittura è di nuovo permessa', () => assert.strictEqual(p.status, 201));

  // mute a scadenza: scade da solo
  await sanction(admin, { action: 'mute', target_agent_id: user.id, reason: 'scadenza', duration_ms: 400 });
  p = await post(user, 'post prima della scadenza');
  const blockedByExpiry = p.status;
  await sleep(800);
  p = await post(user, 'post dopo la scadenza');
  ok('mute: scade da solo, senza lift', () => {
    assert.strictEqual(blockedByExpiry, 403);
    assert.strictEqual(p.status, 201, JSON.stringify(p.body));
  });

  // ---- 5. validazione fail-closed dei payload ------------------------------
  r = await sanction(admin, { action: 'mute', target_agent_id: user.id, reason: 'senza durata' });
  ok('mute senza duration_ms → 400', () => {
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /duration_ms/);
  });
  r = await sanction(admin, { action: 'warn', target_agent_id: user.id });
  ok('warn senza motivo → 400 (il motivo entra nel registro)', () => {
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /reason/);
  });
  r = await sanction(admin, { action: 'freeze', target_agent_id: user.id, reason: 'x', duration_ms: 1000 });
  ok('duration_ms su un freeze → 400 (solo il mute ha una scadenza)', () => {
    assert.strictEqual(r.status, 400);
  });
  r = await sanction(admin, { action: 'warn', target_agent_id: 'af-000000000000', reason: 'x' });
  ok('target inesistente → 403, niente sanzioni nel vuoto', () => {
    assert.strictEqual(r.status, 403);
  });
  r = await sanction(admin, { action: 'freeze', target_agent_id: admin.id, reason: 'autosanzione' });
  ok('un admin non è sanzionabile → 403', () => {
    assert.strictEqual(r.status, 403);
    assert.match(r.body.error, /admin/);
  });

  // ---- 6. gli invarianti valgono anche sui verbi admin ---------------------
  const adminPacket = packet(admin, 'annuncio da rigiocare');
  const first = await req('POST', '/announce', adminPacket);
  const again = await req('POST', '/announce', adminPacket);
  ok('replay di un annuncio rifiutato (409)', () => {
    assert.strictEqual(first.status, 201);
    assert.strictEqual(again.status, 409);
  });

  const fake = { agent_id: admin.id, ts: Date.now(), nonce: crypto.randomBytes(16).toString('base64url'), body: 'finto capo', sig: '' };
  fake.sig = sign(user.kp.priv, admin.id, fake.ts, fake.nonce, fake.body);
  r = await req('POST', '/announce', fake);
  ok('impersonation su /announce rifiutata (401): la firma è dell\'utente, l\'agent_id dell\'admin', () => {
    assert.strictEqual(r.status, 401);
  });

  const signedBody = JSON.stringify({ action: 'warn', target_agent_id: user.id, reason: 'originale' });
  const tampered = JSON.stringify({ action: 'freeze', target_agent_id: user.id, reason: 'ALTERATO' });
  const tsT = Date.now(); const nonceT = crypto.randomBytes(16).toString('base64url');
  r = await req('POST', '/sanction', { agent_id: admin.id, ts: tsT, nonce: nonceT, body: tampered, sig: sign(admin.kp.priv, admin.id, tsT, nonceT, signedBody) });
  ok('body tamper su /sanction rifiutato (401)', () => assert.strictEqual(r.status, 401));

  // ---- 7. la catena resta verificabile, con i nuovi tipi di atto -----------
  const v = srv.verify();
  ok('il transcript incatenato verifica dopo annunci + sanzioni + lift', () => {
    assert.ok(v.ok, v.detail);
  });
  ok('annunci e sanzioni vivono nella stessa catena dei post', () => {
    const kinds = new Set(srv.readPosts().map((x) => x.kind));
    assert.ok(kinds.has('post') && kinds.has('announcement') && kinds.has('sanction'));
  });

  // ---- 8. F2 — il wrapper dell'admin: stessa disciplina, superficie separata ----------------
  // Il wrapper NON deve poter aggirare il server (il confine è il ruolo lato server), e la
  // superficie utente non deve guadagnare verbi admin. Entrambe le cose si provano eseguendo i
  // processi per davvero, non leggendo il listino dei comandi.
  const adminKeydir = path.join(T, 'admin-keys');
  const savedKeydir = process.env.FORUM_KEYDIR;
  process.env.FORUM_KEYDIR = adminKeydir;
  const enrolledAdmin = await forum.enroll(srv.mint('capo-wrapper', 'admin').token, 'capo-wrapper');
  process.env.FORUM_KEYDIR = savedKeydir;
  ok('setup: una seconda identità admin è iscritta per il wrapper', () => {
    assert.ok(enrolledAdmin.ok, enrolledAdmin.error);
  });

  const runChild = (script, args, env) => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, script), ...args], {
      env: Object.assign({}, process.env, env || {}),
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => resolve({ code: -1, stdout, stderr: String(e) }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  const lastJsonLine = (s) => {
    const line = String(s).split('\n').filter(Boolean).pop() || '';
    try { return JSON.parse(line); } catch { return null; }
  };
  const adminEnv = { FORUM_KEYDIR: adminKeydir, FORUM_URL: url() };

  let w = await runChild('forum-admin.js', ['announce', 'avviso dal wrapper dell\'admin'], adminEnv);
  ok('forum-admin.js announce: l\'admin iscritto pubblica (201) via wrapper', () => {
    assert.strictEqual(w.code, 0, w.stderr || '');
    const out = lastJsonLine(w.stdout);
    assert.strictEqual(out && out.ok, true);
    assert.strictEqual(out.kind, 'announcement');
  });

  // un'identità UTENTE che usa il wrapper admin: il server la rifiuta comunque (403)
  const userKeydir = path.join(T, 'user-keys');
  process.env.FORUM_KEYDIR = userKeydir;
  const enrolledUser = await forum.enroll(srv.mint('utente-wrapper', 'user').token, 'utente-wrapper');
  process.env.FORUM_KEYDIR = savedKeydir;
  ok('setup: una identità utente è iscritta per provare il confine', () => {
    assert.ok(enrolledUser.ok, enrolledUser.error);
  });
  w = await runChild('forum-admin.js', ['announce', 'da utente'], { FORUM_KEYDIR: userKeydir, FORUM_URL: url() });
  ok('il wrapper NON aggira il server: un utente con forum-admin.js ottiene 403', () => {
    assert.notStrictEqual(w.code, 0);
    assert.match(w.stdout + w.stderr, /admin role required/);
  });

  w = await runChild('forum-admin.js', ['sanction', user.id, '--action', 'mute', '--reason', 'prova wrapper', '--duration-ms', '3000'], adminEnv);
  const muteOut = lastJsonLine(w.stdout);
  const refusedAfterWrapperMute = await post(user, 'post mentre il wrapper ha mutato');
  ok('forum-admin.js sanction mute: sanzione firmata e davvero applicata dal server', () => {
    assert.strictEqual(w.code, 0, w.stderr || '');
    assert.strictEqual(muteOut && muteOut.ok, true);
    assert.strictEqual(refusedAfterWrapperMute.status, 403);
    assert.match(refusedAfterWrapperMute.body.error, /muted by the admin/);
  });

  w = await runChild('forum-admin.js', ['lift', user.id, '--reason', 'riabilitato dal wrapper'], adminEnv);
  const afterLift = await post(user, 'post dopo il lift dal wrapper');
  ok('forum-admin.js lift: la scrittura torna permessa', () => {
    assert.strictEqual(w.code, 0, w.stderr || '');
    assert.strictEqual(afterLift.status, 201, JSON.stringify(afterLift.body));
  });

  w = await runChild('forum-admin.js', ['sanziona', 'x'], adminEnv);
  ok('un verbo sconosciuto esce 2 con usage (nessuna superficie inventata)', () => {
    assert.strictEqual(w.code, 2);
    assert.match(w.stderr, /usage/);
  });

  w = await runChild('forum-admin.js', ['announce', 'x'], { FORUM_KEYDIR: path.join(T, 'vuoto'), FORUM_URL: url() });
  ok('senza identità il wrapper fallisce chiuso (exit ≠ 0, nessun atto)', () => {
    assert.notStrictEqual(w.code, 0);
    assert.match(w.stdout + w.stderr, /no forum identity|not enrolled/);
  });

  const u = await runChild('forum.js', ['announce', 'ciao'], { FORUM_URL: url() });
  ok('la superficie utente non guadagna verbi admin: forum.js announce esce 2 con usage', () => {
    assert.strictEqual(u.code, 2);
    assert.match(u.stderr, /usage/);
  });

  const v2 = srv.verify();
  ok('la catena resta integra anche dopo gli atti del wrapper', () => assert.ok(v2.ok, v2.detail));

  server.close();
  summary('forum-admin');
})().catch((e) => {
  console.error('test-forum-admin: ' + (e && e.stack || e));
  if (server) server.close();
  process.exit(1);
});
