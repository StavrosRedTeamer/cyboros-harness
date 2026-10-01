#!/usr/bin/env node
// test-tags: loopback   # avvia un server su 127.0.0.1 -> il runner imposta ALLOW_METADATA_TARGET=1
// test-forum-admin-agent.js — il RUNTIME dell'agente-admin, provato contro il server vero con un
// cervello INIETTATO (nessun modello: i test restano hermetici e offline).
//
//   1. CLIENT       — l'identità entra con la chiave in memoria, non col keyfile nell'ambiente.
//   2. GIRO         — read -> decide -> act: il modello vede homepage + post nuovi, gli atti
//                     arrivano al server firmati, e il giro chiude su FINAL o su budget.
//   3. ENFORCEMENT  — il criterio F3: violatore scriptato -> annuncio in homepage + sanzione
//                     firmata + post successivo RIFIUTATO dal server, con il motivo.
//   4. BUDGET       — turni e atti contati; un atto RIFIUTATO dal server non consuma il budget
//                     (stessa dottrina del server: un rifiuto non è un atto).
//   5. KILL SWITCH  — l'arresto è pulito in ogni punto e la catena resta verificabile.
//   6. AUTORITÀ     — un agente con la superficie admin ma senza il RUOLO non ottiene nulla dal
//                     server: l'autorità dell'agente non è nel suo prompt.
//
// Tutto in mkdtemp: nessuna scrittura sulle state reali del workspace.
'use strict';

const { ok, okAsync, summary, fixture } = require('./testkit');
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const srv = require('./forum-server');
const agentMod = require('./forum-admin-agent');

const T = fixture('forum-admin-agent-test-');
process.env.FORUM_STATE = path.join(T, 'forum-state');
process.env.FORUM_KEYDIR = path.join(T, 'keys');
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
        try { b = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* non JSON */ }
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

async function boot() {
  process.env.FORUM_PORT = '0';
  server = srv.serve(0);
  await new Promise((resolve) => server.once('listening', resolve));
  PORT = server.address().port;
}

async function enrollNew(label, role) {
  const token = srv.mint(label, role).token;
  const kp = keypair();
  const id = srv.agentIdFromPub(kp.pub);
  const r = await req('POST', '/enroll', { token, pub_jwk: kp.pub, label });
  assert.strictEqual(r.status, 201, `setup: enroll di ${label}: ${JSON.stringify(r.body)}`);
  return { id, kp };
}

// Client dell'agente: chiave in memoria, nessun keyfile nell'ambiente (la stessa forma dei verbi
// di forum.js/forum-admin.js, ma senza passare dal filesystem dell'identità).
const clientFor = (who) => agentMod.httpClient({ url: url(), agentId: who.id, key: who.kp.priv });

// Cervello scriptato: emula il contratto del modello (guida il loop dei tool e chiude con FINAL).
// `steps` sono i turni; l'ultimo si ripete se il loop ne chiede un altro.
function scripted(steps, opts = {}) {
  const calls = [];
  const brain = async (ctx) => {
    calls.push({
      system: ctx.system,
      task: ctx.task,
      tools: (ctx.tools || []).map((t) => (t.function ? t.function.name : t.name)),
      turn: calls.length + 1,
    });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    return step(ctx);
  };
  brain.calls = calls;
  if (opts.transcriptPath) brain.transcriptPath = opts.transcriptPath;
  return brain;
}

// Un turno: usa i tool indicati e NON chiude il giro; senza tool chiude con FINAL (come il modello
// che, dopo aver agito, riassume e termina).
const turn = (...calls) => async ({ dispatch }) => {
  const obs = [];
  for (const [tool, args] of calls) obs.push(await dispatch(tool, args));
  return { text: calls.length ? '' : 'FINAL: giro concluso', observations: obs };
};
const finalOnly = (text = 'FINAL: niente da fare') => async () => ({ text });

(async function main() {
  await boot();

  const admin = await enrollNew('capo', 'admin');
  const flooder = await enrollNew('flooder', 'user');
  const innocent = await enrollNew('innocente', 'user');

  // Il violatore esiste già prima che l'admin cominci: tre messaggi di fila (ritmo, RS2).
  const floodClient = clientFor(flooder);
  for (const m of ['primo', 'secondo', 'terzo']) await floodClient.post(`messaggio ${m} senza costrutto`);
  const adminClient = clientFor(admin);

  // ---- 1. client: identità in memoria, niente keyfile ---------------------
  await okAsync('il client dell\'agente legge la homepage senza keyfile nell\'ambiente', async () => {
    const r = await adminClient.read(0);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual(Object.keys(r), ['ok', 'announcements', 'sanctions', 'posts']);
    assert.strictEqual(r.posts.length, 3);
  });

  // ---- 2. il giro: read -> decide -> act ----------------------------------
  const brain1 = scripted([
    turn(['announce', { text: 'REGOLA — al massimo 3 messaggi per round; il resto lo rifiuta il server.' }]),
    turn(['sanction', {
      target_agent_id: flooder.id, action: 'mute', reason: 'ritmo: tre messaggi in un round', duration_ms: 120000,
    }]),
    turn(),
  ]);
  const run1 = await agentMod.runAdminAgent({ brain: brain1, client: adminClient, subject: 'capo', rules: 'RS2 — ritmo.', maxTurns: 6 });

  await okAsync('il cervello vede homepage e post nuovi (osservazione, non memoria interna)', async () => {
    const first = brain1.calls[0];
    assert.match(first.system, /admin/i);
    assert.match(first.system, /RS2 — ritmo\./, 'le regole seed non entrano nel system');
    assert.deepStrictEqual(first.tools.sort(), ['announce', 'lift', 'post', 'sanction']);
    assert.match(first.task, /messaggio primo/, 'i post nuovi non arrivano al modello');
    assert.match(brain1.calls[1].task, /REGOLA —/, 'la homepage non rientra nell\'osservazione dopo l\'annuncio');
  });

  await okAsync('due atti accettati (annuncio + mute), giro chiuso su FINAL', async () => {
    assert.strictEqual(run1.actions, 2, JSON.stringify(run1.transcript));
    assert.strictEqual(run1.refused, 0);
    assert.strictEqual(run1.stop_reason, 'final');
    assert.strictEqual(run1.turns, 3);
    const acts = run1.transcript.filter((e) => e.kind === 'act');
    assert.deepStrictEqual(acts.map((e) => e.tool), ['announce', 'sanction']);
    assert.ok(acts.every((e) => Number.isInteger(e.seq)), 'un atto senza seq: non è entrato in catena');
  });

  await okAsync('l\'annuncio è in homepage, in testa alla lettura', async () => {
    const r = await adminClient.read(0);
    assert.strictEqual(r.announcements.length, 1);
    assert.match(r.announcements[0].body, /REGOLA —/);
    assert.strictEqual(r.announcements[0].agent_id, admin.id);
  });

  await okAsync('il criterio F3: il post successivo del sanzionato è RIFIUTATO dal server, col motivo', async () => {
    const r = await floodClient.post('quarto messaggio');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 403);
    assert.match(r.error, /muted by the admin/);
    // Il motivo lo decide l'admin e il server lo consegna a chi è sanzionato: il rifiuto non è
    // muto (struttura, non solo prosa).
    assert.match(r.reason, /ritmo: tre messaggi in un round/);
    assert.ok(r.muted_until, 'un mute senza scadenza non è un mute');
    // e la lettura resta permessa
    const read = await floodClient.read(0);
    assert.strictEqual(read.ok, true);
  });

  await okAsync('la catena resta verificabile e gli atti sono dell\'admin', async () => {
    const chain = srv.verify();
    assert.strictEqual(chain.ok, true, JSON.stringify(chain));
    const sanction = (await adminClient.read(0)).sanctions.find((s) => s.action === 'mute');
    assert.strictEqual(sanction.target_agent_id, flooder.id);
    assert.strictEqual(sanction.agent_id, admin.id);
    assert.match(sanction.reason, /ritmo/);
    assert.ok(sanction.until, 'un mute senza scadenza non è un mute');
  });

  // ---- 3. lift: la revoca restituisce la scrittura -------------------------
  await okAsync('lift via agente: il sanzionato torna a scrivere', async () => {
    const brain = scripted([turn(['lift', { target_agent_id: flooder.id, reason: 'ha letto le regole' }]), turn()]);
    const run = await agentMod.runAdminAgent({ brain, client: adminClient, maxTurns: 4 });
    assert.strictEqual(run.stop_reason, 'final');
    assert.strictEqual(run.actions, 1);
    const back = await floodClient.post('quarto messaggio, dopo la revoca');
    assert.strictEqual(back.ok, true, JSON.stringify(back));
  });

  // ---- 3b. warn: atto pubblico, nessun effetto sulla scrittura -------------
  await okAsync('un warn dell\'agente è un atto pubblico e non blocca la scrittura', async () => {
    const brain = scripted([turn(['sanction', { target_agent_id: innocent.id, action: 'warn', reason: 'tono sopra le righe' }]), turn()]);
    const run = await agentMod.runAdminAgent({ brain, client: adminClient, maxTurns: 4 });
    assert.strictEqual(run.actions, 1);
    assert.strictEqual(run.stop_reason, 'final');
    const mine = await clientFor(innocent).post('prendo atto del richiamo');
    assert.strictEqual(mine.ok, true, JSON.stringify(mine));
  });

  // ---- 3c. il cervello di esercizio: wiring, non modello -------------------
  await okAsync('il cervello live si costruisce e la grammatica ammette solo i quattro verbi', async () => {
    assert.strictEqual(typeof agentMod.llmBrain(), 'function');
    const { toolProtocolGrammar } = require('../local/grammar');
    const g = toolProtocolGrammar(agentMod.ADMIN_TOOLS);
    for (const t of agentMod.ADMIN_TOOLS) assert.ok(g.includes(t), `la grammatica non ammette ${t}`);
    assert.ok(!g.includes('exec'), 'la grammatica ammette un verbo che l\'admin non ha');
  });

  // ---- 4. budget: gli atti rifiutati non lo consumano ----------------------
  await okAsync('un atto rifiutato dal server è registrato ma NON consuma il budget', async () => {
    const brain = scripted([
      turn(['sanction', { target_agent_id: 'af-inesistente', action: 'warn', reason: 'prova' }]),
      turn(['sanction', { target_agent_id: innocent.id, action: 'warn', reason: 'avviso' }]),
      turn(),
    ]);
    const run = await agentMod.runAdminAgent({ brain, client: adminClient, maxTurns: 5, maxActions: 1 });
    assert.strictEqual(run.refused, 1);
    assert.strictEqual(run.actions, 1, 'il rifiuto ha mangiato il budget');
    assert.strictEqual(run.stop_reason, 'budget-actions');
    const refused = run.transcript.find((e) => e.kind === 'refused');
    assert.match(String(refused.error), /unknown target agent_id/);
  });

  await okAsync('il tetto di atti ferma il giro prima di superarlo', async () => {
    const brain = scripted([
      turn(['post', { text: 'nota del capo 1' }], ['post', { text: 'nota del capo 2' }]),
      turn(),
    ]);
    const run = await agentMod.runAdminAgent({ brain, client: adminClient, maxTurns: 5, maxActions: 1 });
    assert.strictEqual(run.actions, 1);
    assert.strictEqual(run.stop_reason, 'budget-actions');
    assert.strictEqual(run.transcript.filter((e) => e.kind === 'budget').length, 1);
  });

  await okAsync('il tetto di turni chiude il giro (budget-turns)', async () => {
    const brain = scripted([turn(['post', { text: 'nota del capo 3' }])]);
    const run = await agentMod.runAdminAgent({ brain, client: adminClient, maxTurns: 1, maxActions: 10 });
    assert.strictEqual(run.turns, 1);
    assert.strictEqual(run.stop_reason, 'budget-turns');
  });

  // ---- 5. kill switch: arresto pulito -------------------------------------
  await okAsync('kill switch: il giro si ferma, ciò che è già in catena resta valido', async () => {
    let acts = 0;
    const brain = scripted([
      turn(['post', { text: 'nota prima dello stop' }], ['post', { text: 'nota mai scritta' }]),
      turn(),
    ]);
    const run = await agentMod.runAdminAgent({
      brain, client: adminClient, maxTurns: 5, maxActions: 10,
      onEvent: (e) => { if (e.kind === 'act') acts++; },
      shouldStop: () => acts >= 1,
    });
    assert.strictEqual(run.stop_reason, 'kill-switch');
    assert.strictEqual(run.actions, 1);
    assert.strictEqual(run.transcript.filter((e) => e.kind === 'act').length, 1);
    assert.strictEqual(srv.verify().ok, true);
  });

  // ---- 6. l'autorità non è nel prompt: è nel ruolo -------------------------
  await okAsync('un agente-utente con la superficie admin ottiene 403 dal server, e non scrive nulla', async () => {
    const before = (await adminClient.read(0)).announcements.length;
    const brain = scripted([turn(['announce', { text: 'annuncio abusivo' }]), turn()]);
    const run = await agentMod.runAdminAgent({ brain, client: floodClient, maxTurns: 3 });
    assert.strictEqual(run.actions, 0);
    assert.strictEqual(run.refused, 1);
    assert.match(String(run.transcript.find((e) => e.kind === 'refused').error), /admin role required/);
    assert.strictEqual((await adminClient.read(0)).announcements.length, before);
  });

  await okAsync('senza lettura non si decide: il giro si chiude dichiarandolo', async () => {
    const dead = agentMod.httpClient({ url: 'http://127.0.0.1:1', agentId: admin.id, key: admin.kp.priv });
    const run = await agentMod.runAdminAgent({ brain: scripted([turn()]), client: dead, maxTurns: 3 });
    assert.strictEqual(run.ok, false);
    assert.strictEqual(run.stop_reason, 'read-refused');
    assert.strictEqual(run.actions, 0);
  });

  await okAsync('il transcript è anche su disco, una riga per evento', async () => {
    const file = path.join(T, 'transcript.jsonl');
    const brain = scripted([finalOnly()]);
    await agentMod.runAdminAgent({ brain, client: adminClient, maxTurns: 2, transcriptPath: file });
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(lines.length >= 2, 'transcript vuoto');
    assert.ok(lines.some((l) => l.kind === 'read'));
    assert.ok(lines.some((l) => l.kind === 'final'));
  });

  await okAsync('un giro senza atti e senza testo non si ripete a vuoto (no-progress)', async () => {
    const brain = scripted([async () => ({ text: '[max iterazioni tool raggiunte]' })]);
    const run = await agentMod.runAdminAgent({ brain, client: adminClient, maxTurns: 5 });
    assert.strictEqual(run.actions, 0);
    assert.strictEqual(run.stop_reason, 'max-iters');
  });

  if (server) server.close();
  process.exit(summary('forum-admin-agent') ? 0 : 1);
})().catch((e) => {
  console.error('forum-admin-agent test: errore inatteso —', e && e.stack ? e.stack : e);
  if (server) server.close();
  process.exit(1);
});
