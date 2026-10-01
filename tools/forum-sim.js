#!/usr/bin/env node
// forum-sim.js — orchestratore del test di comunicazione e collaborazione tra più agenti su un
// ambiente SIMULATO.
//
// Cosa misura, in due tempi distinti:
//
//   COLLABORAZIONE — N agenti, ciascuno in un PROCESSO SEPARATO con la propria identità (keydir
//   proprio), leggono e rispondono ai messaggi degli altri sullo stesso ambiente simulato. Non si
//   misura "ha postato": si misura la dipendenza reciproca — quanti messaggi citano l'agent_id di
//   un altro, e se il riepilogo finale si riferisce a più di una fonte.
//
//   ROGUE — un agente prova deliberatamente a violare gli invarianti: ri-iscriversi, firmare con
//   l'identità di un altro, riprodurre un pacchetto già inviato, modificare un corpo dopo la firma.
//   Ogni tentativo deve essere RESPINTO. Se uno passa, la simulazione esce non-zero: è il segnale
//   che il forum ha smesso di essere un confine.
//
// Perché processi separati e non oggetti in un unico processo: l'identità vive in un keyfile su
// disco e il wrapper è una CLI. Un test in-process con N oggetti "agente" passerebbe anche se la
// separazione fosse solo una convenzione; qui ogni agente ha davvero il proprio filesystem, la
// propria chiave e la propria sessione — la stessa condizione in cui gira un agente vero.
//
// L'ambiente è SIMULATO per costruzione: una directory temporanea con un target di fantasia
// (`sim-target.local`, mai risolto, mai contattato) e appunti locali. Nessuna rete oltre il
// loopback del forum, nessun file del workspace toccato.
//
// CLI:
//   node tools/forum-sim.js run [--agents 4] [--keep]   # orchestratore (default)
//   node tools/forum-sim.js agent <ruolo>               # il processo-agente (invocato dal padre)
//
// Env: FORUM_STATE / FORUM_KEYDIR / FORUM_URL le imposta l'orchestratore per ciascun figlio.
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const srv = require('./forum-server');
const keystore = require('./forum-keystore');

const SELF = path.join(__dirname, 'forum-sim.js');
const WRAPPER = path.join(__dirname, 'forum.js');

// L'ambiente simulato: un target di fantasia e la sua lista di osservazioni. Nessun host è
// risolto o contattato — è un file di testo che i figli leggono per avere qualcosa su cui
// collaborating davvero.
function writeSimEnv(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'target-sim.local.md'), [
    '# sim-target.local — AMBIENTE SIMULATO',
    '',
    'Target di fantasia per il test di collaborazione. Non esiste: nessun DNS, nessuna rete.',
    '',
    '## superficie osservabile',
    '- GET /checkout?id=... -> parametro riflesso in un header di debug',
    '- /admin/legacy -> risponde 200 anche senza cookie di sessione (osservazione del team)',
    '- header X-Powered-By rivela il framework del simulatore',
    '',
  ].join('\n'));
}

function spawnAsync(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, opts);
    let stdout = ''; let stderr = '';
    if (c.stdout) c.stdout.on('data', (d) => { stdout += d; });
    if (c.stderr) c.stderr.on('data', (d) => { stderr += d; });
    c.on('error', reject);
    c.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function wrapper(args, env) {
  return spawnAsync(process.execPath, [WRAPPER, ...args], { encoding: 'utf8', env });
}
// Il wrapper non stampa sempre JSON su una riga: `read` e `verify` lo stampano indentato su più
// righe. Un parser che legge solo l'ultima riga li perdeva per intero — e con loro la lettura del
// forum, cioè la collaborazione che questa simulazione esiste per misurare. Prima si prova
// l'intero stdout, poi si ripiega sulle righe singole (che è il formato di enroll/post/whoami).
function lastJson(stdout) {
  const s = String(stdout || '').trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch { /* non è un JSON singolo: passo alle righe */ }
  const lines = s.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]); } catch { /* non è JSON: proseguo col blocco precedente */ }
  }
  return null;
}

// ---- il processo-agente ------------------------------------------------------
// Ogni figlio è un "runtime" indipendente: ha il proprio FORUM_KEYDIR, e quindi la propria
// identità. È qui che vive l'istruzione che l'agente vero riceverebbe dal prompt — prendere la
// propria identità, poi parlare. Gli attacchi rogue stanno nello stesso codice, perché un agente
// "rogue" è un agente che esegue gli stessi verbi con cattive intenzioni: la differenza è
// l'intento, e l'invariante deve reggere in entrambi i casi.
//
// Due ROUND, non un'unica passata: se gli agenti girassero uno dopo l'altro, il primo troverebbe
// il forum vuoto e nessuno avrebbe mai risposto a nessuno — la collaborazione sarebbe misurata
// solo a cascata e il test passerebbe senza che la collaborazione esista. Con due round tutti
// postano, poi tutti leggono e rispondono a un autore diverso dal proprio: la dipendenza reciproca
// è allora una proprietà verificata, non un effetto dell'ordine di esecuzione.
async function agentMain(role, envDir, envUrl, stateDir, round) {
  const env = Object.assign({}, process.env, {
    FORUM_STATE: stateDir,
    FORUM_KEYDIR: path.join(envDir, 'keys'),
    FORUM_URL: envUrl,
  });
  const report = { role, round, steps: [], rogue: [], ok: true };
  const note = (step, detail) => report.steps.push(Object.assign({ step }, detail));
  const me = () => JSON.parse(fs.readFileSync(path.join(env.FORUM_KEYDIR, 'identity.json'), 'utf8')).agent_id;

  if (round === 1) {
    // 1. prendere la propria identità — una volta sola, con il token che l'operatore ha coniato
    const token = fs.readFileSync(path.join(envDir, 'token.txt'), 'utf8').trim();
    const enrolled = lastJson((await wrapper(['enroll', '--token', token, '--label', role], env)).stdout);
    note('enroll', { ok: !!(enrolled && enrolled.ok), agent_id: enrolled && enrolled.agent_id });
    if (!enrolled || !enrolled.ok) { report.ok = false; console.log(JSON.stringify(report)); return 0; }

    // 2. il tentativo ROGUE di ri-iscriversi con lo stesso token
    const re = lastJson((await wrapper(['enroll', '--token', token, '--label', role], env)).stdout);
    report.rogue.push({ attempt: 're-enroll with the same token', refused: !!(re && re.ok === false), detail: re && re.error });

    // 3. postare l'osservazione sull'ambiente simulato
    const obs = {
      recon: 'Osservazione: /admin/legacy risponde 200 senza sessione. Ho il permalink, non ancora la spiegazione.',
      exploit: 'Osservazione: id=<F> viene riflesso in X-Debug-Echo. Fin qui confermo il rispecchiamento, non l\'impatto.',
      report: 'Osservazione: X-Powered-By del simulatore, quindi posso attribuire la superficie al framework giusto.',
      rogue: 'Osservazione: mi registro, poi vedo se riesco a parlare per qualcun\'altro. Questa riga è un test del test.',
    }[role] || 'Osservazione generica.';
    const p1 = lastJson((await wrapper(['post', obs], env)).stdout);
    note('post observation', { ok: !!(p1 && p1.ok), seq: p1 && p1.seq });

    report.agent_id = enrolled.agent_id;
    report.rogue_held = report.rogue.filter((r) => r.refused).length;
    report.rogue_total = report.rogue.length;
    console.log(JSON.stringify(report));
    return 0;
  }

  // ---- round 2: leggere, rispondere, e provare a rompere gli invarianti ----
  const identity = me();
  report.agent_id = identity;

  // COLLABORAZIONE: leggere il forum e rispondere a un altro autore, citandolo.
  const inbox = lastJson((await wrapper(['read'], env)).stdout);
  const others = ((inbox && inbox.posts) || []).filter((p) => p.agent_id !== identity && p.display);
  if (others.length) {
    // risponde al PRIMO autore non proprio: una risposta fissa sarebbe più facile da infilare
    const target = others[0];
    const reply = lastJson((await wrapper([
      'post', `${target.display} (${target.agent_id}) ha scritto: "${String(target.body).slice(0, 70)}…" — la accorcio io: verifico la claim e riporto l'esito qui.`,
    ], env)).stdout);
    note('reply to another agent', { ok: !!(reply && reply.ok), replied_to: target.agent_id, cross_agent: true });
  } else {
    note('reply to another agent', { ok: false, cross_agent: false, reason: 'nessun altro autore visibile' });
  }

  // ROGUE: impersonation, replay, body tamper — via HTTP grezzo, cioè come farebbe un agente
  // che ignora il wrapper e parla direttamente al server.
  const state = srv.loadState();
  const otherAgent = Object.values(state.agents).find((a) => a.agent_id !== identity);
  if (otherAgent) {
    const raw = await rawSignedPost(env, otherAgent.agent_id, `sono ${otherAgent.display}`);
    report.rogue.push({ attempt: `impersonate ${otherAgent.display} over raw HTTP`, refused: !raw.ok, detail: raw.error });

    const ts = Date.now();
    const nonce = 'rogue' + ts;
    const body = 'pacchetto firmato una volta sola';
    const sig = signLocal(env, identity, ts, nonce, body);
    const first = await rawPost(env, { agent_id: identity, ts, nonce, body, sig });
    const again = await rawPost(env, { agent_id: identity, ts, nonce, body, sig });
    report.rogue.push({
      attempt: 'replay the same signed packet twice',
      refused: !(first.ok && again.ok),
      detail: again.ok ? 'SECONDO INVIO ACCETTATO — invariante rotta' : again.error,
    });

    const ts2 = Date.now();
    const nonce2 = 'tamp' + ts2;
    const altered = 'testo che l-agente-crede-innocuo';
    const sig2 = signLocal(env, identity, ts2, nonce2, 'testo ORIGINALE');
    const tampered = await rawPost(env, { agent_id: identity, ts: ts2, nonce: nonce2, body: altered, sig: sig2 });
    report.rogue.push({ attempt: 'alter the body after signing', refused: !tampered.ok, detail: tampered.error });
  }

  report.rogue_held = report.rogue.filter((r) => r.refused).length;
  report.rogue_total = report.rogue.length;
  console.log(JSON.stringify(report));
  return 0;
}

// Firma aprendo il keystore del figlio: serve solo a fabbricare i pacchetti rogue, che è
// esattamente ciò che un aggressore farebbe (ha accesso alla PROPRIA chiave, non a quella altrui).
// Si passa per tools/forum-keystore e non per un `priv_jwk` grezzo: con i backend cifrati la
// chiave non è nel keyfile, e leggere il file a mano romperebbe — o peggio, riporterebbe
// involontariamente a una custodia in chiaro.
function signLocal(env, agentId, ts, nonce, body) {
  const crypto = require('crypto');
  const envelope = JSON.parse(fs.readFileSync(path.join(env.FORUM_KEYDIR, 'identity.json'), 'utf8'));
  const privJwk = keystore.openEnvelope(envelope, { prompt: false });
  const key = crypto.createPrivateKey({ key: privJwk, format: 'jwk' });
  return crypto.sign(null, Buffer.from(srv.canonical({ agent_id: agentId, ts, nonce, body }), 'utf8'), key).toString('base64');
}
function rawPost(env, payload) {
  return new Promise((resolve) => {
    const u = new URL(env.FORUM_URL);
    const data = Buffer.from(JSON.stringify(payload), 'utf8');
    const r = http.request({
      host: u.hostname, port: u.port, path: '/post', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': data.length },
    }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => {
        let j = {};
        try { j = JSON.parse(b); } catch { /* risposta non JSON */ }
        resolve({ ok: res.statusCode === 201, status: res.statusCode, error: j.error });
      });
    });
    r.on('error', (e) => resolve({ ok: false, error: String(e.message) }));
    r.write(data);
    r.end();
  });
}
// Firma con una chiave casuale che NON è quella iscritta per quell'agent_id: il caso "ti fai
// passare per B" con una chiave estranea.
function rawSignedPost(env, agentId, body) {
  const crypto = require('crypto');
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const ts = Date.now();
  const nonce = 'rogue-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
  const sig = crypto.sign(null, Buffer.from(srv.canonical({ agent_id: agentId, ts, nonce, body }), 'utf8'), privateKey).toString('base64');
  return rawPost(env, { agent_id: agentId, ts, nonce, body, sig });
}

// ---- orchestratore ----------------------------------------------------------
async function run(nAgents, keep) {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'forum-sim-'));
  const stateDir = path.join(T, 'state');
  const envDir = path.join(T, 'simenv');
  writeSimEnv(envDir);
  process.env.FORUM_STATE = stateDir;

  const server = srv.serve(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const results = [];

  const roles = ['recon', 'exploit', 'report', 'rogue'].slice(0, Math.max(2, Math.min(nAgents, 4)));

  // I token si coniano QUI, fuori banda, uno per agente: è l'operatore che autorizza le identità,
  // mai gli agenti stessi. Nessun agente può ottenerne uno che non gli sia stato assegnato.
  for (const role of roles) {
    const dir = path.join(T, role);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'token.txt'), srv.mint(role).token + '\n');
  }

  // Due round: il primo iscrive e fa osservare, il secondo fa leggere, rispondere e provare a
  // rompere gli invarianti. Ogni figlio conserva il proprio keydir tra i round, quindi l'identità
  // presa al primo giro è la stessa che firma al secondo.
  for (const round of [1, 2]) {
    for (const role of roles) {
      const dir = path.join(T, role);
      const r = await spawnAsync(process.execPath, [SELF, 'agent', role, String(round)], {
        encoding: 'utf8',
        env: Object.assign({}, process.env, {
          FORUM_STATE: stateDir,
          FORUM_KEYDIR: path.join(dir, 'keys'),
          FORUM_URL: url,
        }),
      });
      const report = lastJson(r.stdout);
      if (report) results.push(report);
      else results.push({ role, round, error: 'no report from agent', stdout: r.stdout, stderr: r.stderr });
    }
  }

  const posts = srv.readPosts().filter((p) => p.kind === 'post');
  const identities = [...new Set(posts.map((p) => p.agent_id))];
  const rogueTotal = results.reduce((n, r) => n + (r.rogue_total || 0), 0);
  const rogueHeld = results.reduce((n, r) => n + (r.rogue_held || 0), 0);
  const replies = results.reduce((n, r) => n + (r.steps || []).filter((s) => s.cross_agent).length, 0);
  const enrolled = results.filter((r) => r.round === 1 && r.agent_id).length;
  // collaborazione verificata: OGNI agente (non solo qualcuno) ha risposto a un altro autore
  const repliedAgents = results.filter((r) => r.round === 2 && (r.steps || []).some((s) => s.cross_agent)).length;

  const chainOk = srv.verify();
  const verdict = {
    agents_requested: nAgents,
    agents_enrolled: enrolled,
    distinct_identities: identities.length,
    posts: posts.length,
    agents_that_replied_to_another: repliedAgents,
    cross_agent_replies: replies,
    rogue_attempts: rogueTotal,
    rogue_refused: rogueHeld,
    transcript_chain_ok: chainOk.ok,
    // Il forum ha tenuto se: ogni identità è distinta, TUTTI i tentativi rogue sono stati
    // respinti, la catena del transcript è intatta, e ogni agente ha parlato con almeno un altro.
    // Se la collaborazione non c'è, il verdetto è false anche se la sicurezza regge: il test
    // esiste per misurare entrambe.
    invariants_held: identities.length === enrolled && rogueHeld === rogueTotal && rogueTotal > 0
      && chainOk.ok && repliedAgents === enrolled,
    results,
  };
  server.close();
  if (!keep) { try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* best-effort */ } }
  else console.error(`forum-sim: workspace kept at ${T}`);

  console.log(JSON.stringify(verdict, null, 2));
  return verdict.invariants_held ? 0 : 1;
}

async function main(argv) {
  const cmd = argv[0] === 'agent' ? 'agent' : 'run';
  if (cmd === 'agent') {
    const role = argv[1];
    if (!role) { console.error('usage: node tools/forum-sim.js agent <ruolo> [round]'); return 2; }
    return agentMain(
      role,
      path.dirname(process.env.FORUM_KEYDIR || '.'), // il token vive accanto al keydir del figlio
      process.env.FORUM_URL,
      process.env.FORUM_STATE,
      Number(argv[2]) === 2 ? 2 : 1,
    );
  }
  const i = argv.indexOf('--agents');
  const n = i === -1 ? 4 : Math.max(2, parseInt(argv[i + 1], 10) || 4);
  const keep = argv.includes('--keep');
  return run(n, keep);
}

if (require.main === module) {
  main(process.argv.slice(2)).then((rc) => process.exit(rc)).catch((e) => {
    console.error('forum-sim: ' + String((e && e.stack) || e));
    process.exit(1);
  });
}

module.exports = { run, agentMain, writeSimEnv, main };
