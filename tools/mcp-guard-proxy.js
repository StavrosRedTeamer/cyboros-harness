#!/usr/bin/env node
// mcp-guard-proxy.js — mette le guardie IN SERIE a un server MCP di terze parti (stdio).
//
// Perché esiste: `README.md`, `SECURITY.md` e `docs/ARCHITECTURE.md` dichiarano l'unico buco
// dell'architettura — un server MCP montato gira nel suo processo e le guardie in-process non lo
// vedono. `tools/mcp-bridge.js` copre la direzione opposta (espone i NOSTRI tool guardati come
// server MCP); questo copre l'ingresso: il client MCP parla con il proxy, il proxy giudica e solo
// dopo parla con il server reale.
//
// La decisione è la stessa del resto dell'harness, non una reimplementazione: `scope-guard.js`
// (autorizzazione scritta in scope.json, fail-closed) + `ssrf-guard.js` (tier hard: metadata,
// loopback, link-local) letti dal processo del proxy. Deny-by-default: una chiamata che nomina un
// target fuori scope non raggiunge il server, e l'agente riceve un errore esplicito invece di un
// silenzio.
//
// Uso (il client MCP deve lanciare QUESTO comando al posto del server):
//   node tools/mcp-guard-proxy.js -- npx -y chrome-devtools-mcp@latest --headless --isolated
//   node tools/mcp-guard-proxy.js --audit reports/tmp/mcp-guard.jsonl -- <cmd> [args...]
//   node tools/mcp-guard-proxy.js --allow-unscoped -- <cmd> [args...]   # solo per debug locale
//
// Ogni tools/call produce una riga in `reports/tmp/mcp-guard.jsonl` (gitignored, 0600):
// allow-scoped / allow-unscoped / block. Le chiamate senza target (es. `take_snapshot`) passano
// e vengono marcate `allow-unscoped`: bloccarle renderebbe inutilizzabile un server browser, e
// l'audit è ciò che le rende visibili.
//
// Limiti dichiarati: (1) il giudizio è sui target ESTRATTI dagli argomenti (URL, host, IP); un
// tool che tocca la rete senza nominarla (script eseguito lato server) resta fuori dal giudizio;
// (2) un hostname in scope richiede che la risoluzione riesca (fail-closed come repeater): senza
// DNS la chiamata viene rifiutata, non lasciata passare.
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const WS = path.join(__dirname, '..');
const DEFAULT_AUDIT = path.join(WS, 'reports', 'tmp', 'mcp-guard.jsonl');

function parseArgs(argv) {
  const o = { cmd: [], audit: process.env.MCP_GUARD_AUDIT || DEFAULT_AUDIT, allowUnscoped: process.env.MCP_GUARD_ALLOW_UNSCOPED === '1', help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { o.cmd = argv.slice(i + 1); break; }
    else if (a === '--audit') o.audit = argv[++i];
    else if (a === '--allow-unscoped') o.allowUnscoped = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else { console.error(`mcp-guard-proxy: opzione sconosciuta "${a}" (usa --help)`); process.exit(2); }
  }
  return o;
}

// ---- estrazione dei target dagli argomenti ------------------------------------
const URL_RE = /\bhttps?:\/\/[^\s"'`<>\\]+/gi;
const HOST_CHARS_RE = /^[a-z0-9._:-]+$/i;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const HOSTNAME_RE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;
const FIELD_HINT_RE = /^(url|uri|target|host|hostname|origin|address|endpoint|navigate|page|domain)$/i;

function isTargetLike(s) {
  const bare = s.trim().replace(/^\[|\]$/g, '');
  if (!bare || !HOST_CHARS_RE.test(bare.replace(/^\w+:\/\//, ''))) return false;
  const host = bare.replace(/^\w+:\/\//, '').split('/')[0].split('?')[0];
  const noPort = host.replace(/:\d+$/, '');
  return IPV4_RE.test(noPort) || HOSTNAME_RE.test(noPort);
}

// Percorre gli argomenti e raccoglie (a) ogni URL scritto dentro una stringa, (b) le stringhe che
// SONO un host/IP, (c) i valori dei campi che per nome puntano a un target.
function targetsFrom(value, out, key) {
  out = out || [];
  if (typeof value === 'string') {
    for (const m of value.matchAll(URL_RE)) out.push(m[0]);
    if ((FIELD_HINT_RE.test(key || '') || /^https?:\/\//i.test(value)) && isTargetLike(value)) out.push(value);
    else if (isTargetLike(value) && !value.includes(' ')) out.push(value);
    return out;
  }
  if (Array.isArray(value)) { for (const v of value) targetsFrom(v, out, key); return out; }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) targetsFrom(v, out, k);
    return out;
  }
  return out;
}

// ---- giudizio -----------------------------------------------------------------
// Stessa sequenza dei tool in-process (repeater.js), riusando le stesse due funzioni: il layer 1
// è `scope-guard.inScope`, poi `net.resolveAndGuard` (che è dove vive la protezione
// DNS-rebinding: un hostname in scope che risolve a un indirizzo privato/loopback/link-local è
// rifiutato se quella subnet non è in allowed_ips), e infine `ssrf-guard.checkAddress`
// sull'INDIRIZZO fissato. Riusare le funzioni invece di reimplementarle è il punto: il proxy deve
// decidere come decide repeater, non come sembra ragionevole al proxy.
async function judgeTargets(targets) {
  const sg = require(path.join(WS, 'tools', 'scope-guard'));
  const ssrf = require(path.join(WS, 'tools', 'ssrf-guard'));
  const { resolveAndGuard } = require(path.join(WS, 'tools', 'net.js'));
  const scope = sg.loadScope();
  const allowMetadata = ssrf.envOptIn ? !!ssrf.envOptIn() : false;
  const verdicts = [];
  for (const t of targets) {
    const scopeVerdict = sg.inScope(t, scope);
    if (!scopeVerdict.ok) { verdicts.push({ target: t, ok: false, gate: 'scope-guard', why: scopeVerdict.reason }); continue; }
    // Risoluzione + pin: bloccata = DNS fallito, nessun indirizzo, o pivot verso una special
    // range non autorizzata (fail-closed in entrambi i casi).
    const pin = await resolveAndGuard(t, scope);
    if (pin.blocked) { verdicts.push({ target: t, ok: false, gate: 'scope-guard', why: 'resolve-pin: ' + pin.reason }); continue; }
    const address = pin.address || '';
    const addrVerdict = ssrf.checkAddress(address, { allowMetadata, scopeAuthorized: true });
    if (!addrVerdict.ok) {
      verdicts.push({ target: t, ok: false, gate: 'ssrf-guard', why: `${addrVerdict.tier}${addrVerdict.range ? ' (' + addrVerdict.range + ')' : ''}: ${addrVerdict.why || ''}`.trim() });
      continue;
    }
    verdicts.push({ target: t, ok: true, gate: 'ssrf-guard', tier: addrVerdict.tier, address });
  }
  return verdicts;
}

function auditAppend(file, row) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, JSON.stringify(row) + '\n', { mode: 0o600 });
  } catch { /* vedi sopra */ }
}

const HELP = `mcp-guard-proxy — guardie in serie a un server MCP di terze parti

  node tools/mcp-guard-proxy.js -- <command> [args...]

Opzioni:
  --audit <file>      log JSONL delle decisioni (default ${path.relative(WS, DEFAULT_AUDIT)})
  --allow-unscoped    lascia passare le chiamate senza target riconoscibile (default: passano
                      comunque, ma solo quelle senza target — vedi il commento in testa al file)
  --help              questo testo

Ambiente (impostato dal client MCP al lancio del server):
  MCP_GUARD_AUDIT, MCP_GUARD_ALLOW_UNSCOPED=1

Esempio (chrome-devtools al posto del server nudo):
  node tools/mcp-guard-proxy.js -- npx -y chrome-devtools-mcp@latest --headless --isolated
`;

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return 0; }
  if (!opts.cmd.length) { console.error('mcp-guard-proxy: manca il comando del server (usa `-- <cmd> [args...]`)\n' + HELP); return 2; }

  const [bin, ...args] = opts.cmd;
  const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'inherit'] });
  child.on('error', (e) => { console.error(`[mcp-guard] server non avviato: ${e.message}`); process.exit(2); });
  child.on('exit', (code, sig) => { process.exitCode = code == null ? 1 : code; if (sig) process.kill(process.pid, sig); });

  const send = (line) => { if (child.stdin.writable) child.stdin.write(line + '\n'); };
  // La risposta di un blocco va al CLIENT (stdout), non al server: il server non deve vedere
  // né la chiamata né la sua motivazione.
  const reply = (id, text, isError) => process.stdout.write(JSON.stringify({
    jsonrpc: '2.0', id,
    result: { content: [{ type: 'text', text }], isError: !!isError },
  }) + '\n');

  // stdout del server -> stdout del proxy (il client MCP non deve accorgersi del passaggio)
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    process.stdout.write(line + '\n');
  });

  // stdin del client -> giudizio -> stdin del server. Il giudizio è asincrono (DNS-pin), quindi le
  // richieste sono incatenate: l'ordine verso il server resta quello delle richieste del client.
  async function handle(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try { msg = JSON.parse(trimmed); } catch { return send(line); } // non-JSON: passthrough
    if (!msg || msg.method !== 'tools/call' || msg.id === undefined) return send(trimmed);

    const name = (msg.params && msg.params.name) || 'unknown';
    const targets = [...new Set(targetsFrom(msg.params && msg.params.arguments))];
    if (!targets.length) {
      auditAppend(opts.audit, { ts: new Date().toISOString(), tool: name, verdict: 'allow-unscoped', targets: [] });
      return send(trimmed);
    }
    const verdicts = await judgeTargets(targets);
    const blocked = verdicts.filter((v) => !v.ok);
    if (blocked.length) {
      auditAppend(opts.audit, { ts: new Date().toISOString(), tool: name, verdict: 'block', targets: verdicts });
      const text = blocked.map((b) => `${b.gate}: blocked ${b.target} — ${b.why}`).join('; ');
      console.error(`[mcp-guard] ${name}: ${text}`);
      return reply(msg.id, `[mcp-guard-proxy] ${text}\n(nessuna richiesta inviata al server: aggiungi il target a scope.json se è autorizzato, altrimenti non insistere)`, true);
    }
    auditAppend(opts.audit, { ts: new Date().toISOString(), tool: name, verdict: 'allow-scoped', targets: verdicts });
    return send(trimmed);
  }

  let chain = Promise.resolve();
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    chain = chain.then(() => handle(line)).catch((e) => {
      console.error(`[mcp-guard] errore nel giudizio: ${e.message}`);
      try { const m = JSON.parse(line); if (m && m.id !== undefined) reply(m.id, `[mcp-guard-proxy] errore interno: ${e.message}`, true); } catch { /* passthrough già fatto */ }
    });
  });

  process.stdin.on('end', () => { try { child.stdin.end(); } catch { /* già chiuso */ } });
  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { targetsFrom, judgeTargets, isTargetLike };
