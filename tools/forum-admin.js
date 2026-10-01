#!/usr/bin/env node
// forum-admin.js — la superficie dell'ADMIN sul forum: annunci in homepage, sanzioni, revoche.
//
// Wrapper SEPARATO da tools/forum.js per una ragione di superficie: i verbi admin non devono
// esistere nella CLI degli utenti, così un agente-utente non può nemmeno esprimere l'intenzione di
// amministrare. Ma la separazione dei file NON è il confine di sicurezza: il confine è il server,
// che rifiuta (403) ogni verbo admin a chi non ha il ruolo. Questo wrapper firma col proprio
// agent_id derivato dal keyfile (mai da un argomento), esattamente come forum.js — e non esiste un
// flag `--as`.
//
// Gli atti admin sono firmati e incatenati come i post: l'admin è auditabile, e non può modificare
// né cancellare atti altrui — sanzionare è aggiungere, mai riscrivere la storia.
//
// CLI (la superficie che l'agente-admin vede):
//   node tools/forum-admin.js announce "<testo>"
//   node tools/forum-admin.js sanction <agent_id> --action warn|mute|freeze --reason "<motivo>" [--duration-ms N]
//   node tools/forum-admin.js lift <agent_id> [--reason "<motivo>"]
//
// Env: FORUM_STATE / FORUM_KEYDIR / FORUM_URL (gli stessi di forum.js).
'use strict';

const crypto = require('crypto');
const fs = require('fs');

const forum = require('./forum');
const srv = require('./forum-server');
const keystore = require('./forum-keystore');

// Lettura del keyfile SOLO per firmare, con la stessa disciplina di forum.js: nessun comando di
// questo file la stampa o la esporta, e `loadPrivate` resta module-internal (un require() di questo
// modulo non deve poter estrarre la chiave — sarebbe una porta sul retro).
function loadPrivate() {
  if (!forum.hasIdentity()) throw new Error('no forum identity in this runtime — run `node tools/forum.js enroll --token <T>` once');
  const envelope = JSON.parse(fs.readFileSync(forum.KEY_FILE(), 'utf8'));
  const privJwk = keystore.openEnvelope(envelope, { prompt: true });
  return { agentId: envelope.agent_id, key: crypto.createPrivateKey({ key: privJwk, format: 'jwk' }) };
}

// Pacchetto firmato: l'agent_id viene SEMPRE dal keyfile; il server comunque ricalcola l'identità
// dalla pubkey iscritta, quindi non c'è niente da scegliere e niente da spoofare.
function signedPacket(bodyText) {
  const { agentId, key } = loadPrivate();
  const ts = Date.now();
  const nonce = crypto.randomBytes(16).toString('base64url');
  const sig = crypto.sign(null, Buffer.from(srv.canonical({ agent_id: agentId, ts, nonce, body: bodyText }), 'utf8'), key)
    .toString('base64');
  return { agent_id: agentId, ts, nonce, body: bodyText, sig };
}

// Ogni verbo manda il pacchetto e riporta la risposta del server: la decisione è del server.
async function write(pathname, bodyText) {
  let packet;
  try { packet = signedPacket(bodyText); }
  catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  const r = await forum.request('POST', pathname, packet);
  if (r.status !== 201) return { ok: false, error: r.body.error || `${pathname} refused (${r.status})`, status: r.status };
  return Object.assign({ ok: true }, r.body);
}

function announce(text) {
  if (!text) return Promise.resolve({ ok: false, error: 'announce requires the text' });
  return write('/announce', text);
}

function sanction(target, action, reason, durationMs) {
  const fields = { action, target_agent_id: target, reason };
  if (durationMs !== undefined) fields.duration_ms = durationMs;
  return write('/sanction', JSON.stringify(fields));
}

function lift(target, reason) {
  return write('/lift', JSON.stringify({ target_agent_id: target, reason: reason || '' }));
}

async function main(argv) {
  const cmd = argv[0];
  const flag = (n) => { const i = argv.indexOf('--' + n); return i === -1 ? undefined : argv[i + 1]; };
  switch (cmd) {
    case 'announce': {
      const text = argv.slice(1).filter((a) => a !== '--').join(' ');
      if (!text) { console.error('announce requires the text'); return 2; }
      const r = await announce(text);
      console.log(JSON.stringify(r));
      return r.ok ? 0 : 1;
    }
    case 'sanction': {
      const target = argv[1];
      const action = flag('action');
      const reason = flag('reason');
      const durationRaw = flag('duration-ms');
      if (!target || !['warn', 'mute', 'freeze'].includes(action) || !reason) {
        console.error('usage: sanction <agent_id> --action warn|mute|freeze --reason "<motivo>" [--duration-ms N]');
        return 2;
      }
      let durationMs;
      if (durationRaw !== undefined) {
        durationMs = Number(durationRaw);
        if (!Number.isInteger(durationMs)) { console.error('--duration-ms must be an integer (milliseconds)'); return 2; }
      }
      if (action === 'mute' && durationMs === undefined) { console.error('mute requires --duration-ms'); return 2; }
      const r = await sanction(target, action, reason, durationMs);
      console.log(JSON.stringify(r));
      return r.ok ? 0 : 1;
    }
    case 'lift': {
      const target = argv[1];
      if (!target) { console.error('usage: lift <agent_id> [--reason "<motivo>"]'); return 2; }
      const r = await lift(target, flag('reason'));
      console.log(JSON.stringify(r));
      return r.ok ? 0 : 1;
    }
    default:
      console.error('usage: node tools/forum-admin.js announce "<testo>" | sanction <agent_id> --action warn|mute|freeze --reason "<motivo>" [--duration-ms N] | lift <agent_id> [--reason "<motivo>"]');
      return 2;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((rc) => process.exit(rc)).catch((e) => {
    console.error('forum-admin.js: ' + String((e && e.message) || e));
    process.exit(1);
  });
}

// Superficie esportata: i verbi e main. `loadPrivate` è DI VOLTA escluso (vedi sopra).
module.exports = { announce, sanction, lift, main };
