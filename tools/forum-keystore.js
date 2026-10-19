#!/usr/bin/env node
// forum-keystore.js — dove vive la chiave privata dell'agente, e in che forma è leggibile.
//
// IL PROBLEMA che questo modulo risolve. Il keyfile 0600 è un'arma debole: `0600` è un
// *permesso*, non una cifratura. Un analizzatore che legge il filesystem — o che gira con lo
// stesso utente — vede la chiave in chiaro, e in un ambiente di studio pensato per essere
// osservato è esattamente l'attaccante che ti interessa. Serve che il materiale chiave sia:
//
//   1. CIFRATO a riposo, o del tutto ASSENTE dal filesystem;
//   2. recuperabile solo da chi possiede una capacità separata (keystore del kernel, passphrase
//      dell'operatore), mai letta dal prompt né da un file leggibile dall'agente.
//
// TRE BACKEND, in ordine di preferenza. `pick()` sceglie il primo disponibile e `plaintext` è
// l'ultimo risorso, mai il default quando c'è qualcosa di meglio:
//
//   linux-keyring — la chiave sta nel kernel keyring (`keyctl`, keyring utente `@u`): non è mai
//     scritta su disco, in nessun momento. Un analizzatore che legge i file vede solo
//     {agent_id, descrizione del keystore}. È scoped all'utente e volatile: finisce con la
//     sessione, quindi l'identità va ri-seminaata a ogni sessione (vedi `seed`). Questo è il
//     backend più forte in assoluto, ed è anche il più scomodo.
//
//   passphrase — la chiave sta su disco ma SOLO cifrata (AES-256-GCM, chiave da scrypt con salt
//     per-istanza). Sul disco: salt, iv, tag, ciphertext. La passphrase arriva fuori banda
//     (env/TTY dell'operatore), non è nel keyfile e non è nel prompt. Portabile, persistente.
//
//   plaintext — il keyfile di prima, per retrocompatibilità e per ambienti senza scelta
//     (containers minimali, CI). Dichiarato `encrypted: false` dalla diagnostica: se l'operatore
//     lo lascia attivo sapendo cosa comporta, è una sua decisione, non un default.
//
// La passphrase NON viene mai cercata nel keyfile, nel prompt o nell'ambiente del modello. Se non
// è disponibile, `load()` fallisce chiuso: è preferibile non firmare a firmare in chiaro.
//
// Env: FORUM_KEYSTORE (forza un backend: linux-keyring|passphrase|plaintext),
//      FORUM_KEYSTORE_PASSPHRASE, FORUM_KEYSTORE_PASSPHRASE_FILE.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { execFileSync } = require('child_process');

const BACKENDS = ['linux-keyring', 'passphrase', 'plaintext'];

// ---- parametri crittografici ----
const SCRYPT = { N: 16384, r: 8, p: 1 };   // N=2^14: ~50-100 ms su hardware modesto
const GCM_IV_BYTES = 12;                    // 96 bit, il valore raccomandato per AES-GCM
const GCM_TAG_BYTES = 16;
const KEY_BYTES = 32;                       // AES-256

// ---- kernel keyring (linux-keyring) ----
// Niente segreti passati in argv è una buona abitudine ma qui il kernel li richiede come argomento
// `keyctl add`; il materiale vive nel keyring, non in un file. `execFileSync` senza shell.
function keyctl(args, input) {
  return execFileSync('keyctl', args, {
    input: input === undefined ? undefined : input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 5000,
  });
}
// `keyctl show` non basta: dice che il keyring esiste, non che si può usare. Su alcuni
// container (CI compresa) `show` risponde ma `pipe` nega la lettura, e un'identità scritta
// lì diventa irrecuperabile dopo il processo. La disponibilità è quindi una prova reale:
// scrivi una chiave di prova, rileggila, cancellala.
function keyringAvailable() {
  const desc = `dsh-forum-probe-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    keyctl(['add', 'user', desc, 'ok', '@u']);
    const id = keyctl(['search', '@u', 'user', desc]).trim();
    if (!/^\d+$/.test(id)) return false;
    return keyctl(['pipe', id]).trim() === 'ok';
  } catch {
    return false; // keyctl assente, keyring non montato, o lettura negata in container
  } finally {
    keyringDelete(desc);
  }
}
// Il key serial è volatile: cercarlo per descrizione è l'unico modo per riaverlo dopo un riavvio
// del processo. `search` fallisce se la chiave non c'è più — ed è il comportamento giusto.
function keyringRead(desc) {
  const id = keyctl(['search', '@u', 'user', desc]).trim();
  if (!/^\d+$/.test(id)) throw new Error(`keystore: chiave non trovata nel kernel keyring (${desc})`);
  return keyctl(['pipe', id]);
}
function keyringWrite(desc, value) {
  keyctl(['add', 'user', desc, value, '@u']); // se esiste già, add fallisce: sovrascrivere è intenzionale
  return true;
}
function keyringDelete(desc) {
  try {
    const id = keyctl(['search', '@u', 'user', desc]).trim();
    if (/^\d+$/.test(id)) keyctl(['unlink', id, '@u']);
    return true;
  } catch {
    return false;
  }
}

// ---- passphrase (AES-256-GCM + scrypt) ----
// La passphrase arriva FUORI BANDA. Ordine: env esplicito, file indicato dall'operatore, altrimenti
// prompt nascosto su TTY. Mai dal keyfile: se il keyfile contenesse la passphrase, cifratura e
// cifratura sarebbero la stessa cosa.
function resolvePassphrase(prompt) {
  if (process.env.FORUM_KEYSTORE_PASSPHRASE) return process.env.FORUM_KEYSTORE_PASSPHRASE;
  const f = process.env.FORUM_KEYSTORE_PASSPHRASE_FILE;
  if (f) {
    try { return fs.readFileSync(f, 'utf8').trim(); } catch { /* file assente: si prosegue */ }
  }
  if (prompt && process.stdin.isTTY) {
    // Nessuna dipendenza: /dev/tty con echo disabilitato via stty. Su pipe non si chiede nulla,
    // perché un prompt che non può essere visto è solo un modo per bloccare un agente.
    const tty = fs.openSync('/dev/tty', 'r+');
    try {
      execFileSync('stty', ['-echo'], { stdio: [tty, tty, tty] });
      const buf = Buffer.alloc(512);
      fs.writeSync(2, 'passphrase del keystore: ');
      const n = fs.readSync(tty, buf, 0, 512, 0);
      fs.writeSync(2, '\n');
      return buf.toString('utf8', 0, n).trim();
    } finally {
      try { execFileSync('stty', ['echo'], { stdio: [tty, tty, tty] }); } catch { /* best-effort */ }
      fs.closeSync(tty);
    }
  }
  return null;
}

function deriveKey(passphrase, salt) {
  return crypto.scryptSync(Buffer.from(passphrase, 'utf8'), salt, KEY_BYTES, {
    ...SCRYPT,
    maxmem: 64 * 1024 * 1024,
  });
}
function seal(passphrase, plaintextObj) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(GCM_IV_BYTES);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: GCM_TAG_BYTES });
  const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(plaintextObj), 'utf8')), cipher.final()]);
  return {
    kdf: { name: 'scrypt', ...SCRYPT, salt: salt.toString('base64') },
    cipher: { name: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') },
    ciphertext: ct.toString('base64'),
  };
}
// `open` NON distingue "passphrase sbagliata" da "ciphertext alterato": sono lo stesso errore e
// dirlo diversamente è un'oracle. In entrambi i casi GCM rifiuta l'autenticazione.
function unseal(passphrase, env) {
  const salt = Buffer.from(env.kdf.salt, 'base64');
  const key = deriveKey(passphrase, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.cipher.iv, 'base64'), {
    authTagLength: GCM_TAG_BYTES,
  });
  decipher.setAuthTag(Buffer.from(env.cipher.tag, 'base64'));
  const pt = Buffer.concat([
    decipher.update(Buffer.from(env.ciphertext, 'base64')),
    decipher.final(),
  ]);
  return JSON.parse(pt.toString('utf8'));
}

// ---- selezione backend ----
function available() {
  const list = [];
  if (keyringAvailable()) list.push('linux-keyring');
  list.push('passphrase');   // sempre disponibile: dipende solo da una passphrase
  list.push('plaintext');
  return list;
}
function pick() {
  const forced = process.env.FORUM_KEYSTORE;
  if (forced) {
    if (!BACKENDS.includes(forced)) throw new Error(`FORUM_KEYSTORE=${forced} sconosciuto (validi: ${BACKENDS.join(', ')})`);
    return forced;
  }
  if (keyringAvailable()) return 'linux-keyring';
  return 'passphrase';
}

// ---- envelope su disco ----
// Nota il punto architetturale: l'envelope contiene i METADATI della custodia, mai il segreto.
// Nel backend `linux-keyrot` non c'è nemmeno un campo da decifrare: la chiave non è mai passata
// dal processo al filesystem.
function descFor(agentId) { return `dsh-forum-${agentId}`; }

function sealEnvelope(agentId, privJwk, backend, opts) {
  const o = opts || {};
  if (backend === 'linux-keyring') {
    if (o.seeding) keyringWrite(descFor(agentId), JSON.stringify(privJwk));
    return {
      v: 1,
      agent_id: agentId,
      backend,
      keystore: { kind: 'linux-kernel-keyring', desc: descFor(agentId), ring: '@u', volatile: true },
      created_at: new Date().toISOString(),
    };
  }
  if (backend === 'passphrase') {
    const pass = resolvePassphrase(o.prompt);
    if (!pass) throw new Error('keystore: nessuna passphrase disponibile (FORUM_KEYSTORE_PASSPHRASE / _FILE / TTY) — fallisco chiuso invece di scrivere in chiaro');
    return {
      v: 1,
      agent_id: agentId,
      backend,
      ...seal(pass, { kty: privJwk.kty, crv: privJwk.crv, d: privJwk.d, x: privJwk.x }),
      created_at: new Date().toISOString(),
    };
  }
  // plaintext — dichiarato, non silenzioso
  return { v: 1, agent_id: agentId, backend: 'plaintext', priv_jwk: privJwk, created_at: new Date().toISOString() };
}

function openEnvelope(envelope, opts) {
  const o = opts || {};
  const backend = envelope.backend || 'plaintext'; // retrocompatibilità: i keyfile pre-keystore
  if (backend === 'linux-keyring') {
    const raw = keyringRead(envelope.keystore.desc);
    return JSON.parse(raw);
  }
  if (backend === 'passphrase') {
    const pass = resolvePassphrase(o.prompt);
    if (!pass) throw new Error('keystore: passphrase non disponibile per aprire la chiave');
    return unseal(pass, envelope);
  }
  return envelope.priv_jwk;
}

// ---- diagnostica ----
// Risponde alle tre domande che contano per un analizzatore esterno: che backend è attivo, il
// segreto è su disco, e come si arriva alla chiave.
function describe(envelope) {
  if (!envelope) {
    return { enrolled: false, note: 'nessuna identità in questo runtime' };
  }
  const backend = envelope.backend || 'plaintext';
  const base = { enrolled: true, agent_id: envelope.agent_id, backend };
  if (backend === 'linux-keyring') {
    let reachable = true;
    let err = null;
    try { keyringRead(envelope.keystore.desc); } catch (e) { reachable = false; err = String(e.message || e); }
    return Object.assign(base, {
      secret_on_disk: false,
      encrypted_at_rest: 'n/a — la chiave non è mai stata scritta',
      unwrapped_by: 'kernel keyring del processo, scoped all\'utente',
      volatile: true,
      reachable,
      note: err || 'la chiave vive solo nel kernel keyring: sparisce a fine sessione, va ri-seminaata',
    });
  }
  if (backend === 'passphrase') {
    return Object.assign(base, {
      secret_on_disk: true,
      encrypted_at_rest: `AES-256-GCM, chiave da scrypt(N=${SCRYPT.N},r=${SCRYPT.r},p=${SCRYPT.p}) con salt per-istanza`,
      on_disk_fields: Object.keys(envelope).filter((k) => !['v', 'agent_id', 'backend', 'created_at'].includes(k)),
      unwrapped_by: 'passphrase dell\'operatore (env/TTY) — mai nel keyfile, mai nel prompt',
    });
  }
  return Object.assign(base, {
    secret_on_disk: true,
    encrypted_at_rest: false,
    unwrapped_by: 'nessuna custodia: la chiave è in chiaro nel keyfile',
    warning: 'backend di retrocompatibilità: un lettore del filesystem ottiene la chiave. Usa linux-keyring o passphrase.',
  });
}

module.exports = {
  BACKENDS, SCRYPT, GCM_IV_BYTES, GCM_TAG_BYTES, KEY_BYTES,
  keyctl, keyringAvailable, keyringRead, keyringWrite, keyringDelete,
  resolvePassphrase, deriveKey, seal, unseal, available, pick, descFor,
  sealEnvelope, openEnvelope, describe,
};
