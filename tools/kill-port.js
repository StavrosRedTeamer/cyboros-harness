#!/usr/bin/env node
// Kill whoever is LISTENING on a port — the service, not the shell wrapper that launched it.
//   node tools/kill-port.js <port> [--dry-run] [--signal TERM|KILL] [--udp] [--yes] [--json]
//
// Perché esiste: `node tools/<server>.js &` restituisce il PID del wrapper/broker, non del
// processo che tiene la porta (osservato: kill del wrapper → EADDRINUSE, perché il listener era
// `next-server` figlio). Uccidere il PID sbagliato lascia la porta occupata e l'agente interpreta
// l'errore come "il servizio è ancora vivo". Qui la sorgente è il kernel (`ss -ltnp`), quindi il
// PID è quello del listener: nessuna euristica su nomi o parentele.
//
// --dry-run elenca e basta. Porte < 1024 richiedono --yes. Non tocca PID 1, sé stesso o il padre.
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');

const SELF = process.pid;
const PPID = process.ppid;

function parseArgs(argv) {
  const opts = { port: null, dryRun: false, signal: 'TERM', proto: 'tcp', yes: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run' || a === '-n') opts.dryRun = true;
    else if (a === '--udp') opts.proto = 'udp';
    else if (a === '--yes' || a === '-y') opts.yes = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--signal' || a === '-s') opts.signal = String(argv[++i] || '').toUpperCase();
    else if (a.startsWith('--signal=')) opts.signal = a.slice('--signal='.length).toUpperCase();
    else if (/^\d+$/.test(a) && opts.port == null) opts.port = Number(a);
    else opts.bad = `unknown argument: ${a}`;
  }
  return opts;
}

// `ss -ltnp` → righe con `users:(("name",pid=123,fd=4),("name",pid=124,fd=5))`.
function listenersViaSs(port, proto) {
  const flag = proto === 'udp' ? '-lunp' : '-ltnp';
  const r = spawnSync('ss', [flag], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  const out = [];
  for (const line of String(r.stdout || '').split('\n')) {
    // `ss -ltnp` / `-lunp` è già filtrato per protocollo; il campo 3 è Local Address:Port.
    const local = line.split(/\s+/)[3] || '';
    // Match esatto della porta: evita che 8080 catturi 18080 o 80800.
    const m = local.match(/:(\d+)$/);
    if (!m || Number(m[1]) !== port) continue;
    const pids = [...line.matchAll(/pid=(\d+)/g)].map((x) => Number(x[1]));
    const names = [...line.matchAll(/\("([^"]+)"/g)].map((x) => x[1]);
    if (!pids.length) out.push({ pid: null, name: names[0] || '(kernel)', state: line.trim() });
    for (const pid of new Set(pids)) out.push({ pid, name: names[0] || null, state: line.trim() });
  }
  return out;
}

// Fallback portabile quando `ss` non c'è (macOS/Git Bash): `lsof -t` restituisce i PID listener.
function listenersViaLsof(port, proto) {
  const spec = proto === 'udp' ? `-iUDP:${port}` : `-iTCP:${port}-sTCP:LISTEN`;
  const r = spawnSync('lsof', ['-nP', '-t', spec], { encoding: 'utf8' });
  if (r.error || (r.status !== 0 && !String(r.stdout || '').trim())) return null;
  return [...new Set(String(r.stdout || '').split('\n').map((s) => Number(s.trim())).filter(Boolean))]
    .map((pid) => ({ pid, name: null, state: null }));
}

function cmdline(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
  } catch {
    const r = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
    return String(r.stdout || '').trim() || null;
  }
}

// Uno zombie risponde a kill(0) ma non tiene più la porta: va contato come morto, altrimenti il
// tool dichiara "survived" un servizio che ha già rilasciato il socket (osservato nei test con
// figli non ancora reaped).
function alive(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const state = stat.slice(stat.lastIndexOf(')') + 2).trim()[0];
    if (state === 'Z') return false;
  } catch { /* no procfs: fall back to signal 0 */ }
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function findListeners(port, proto) {
  return listenersViaSs(port, proto) || listenersViaLsof(port, proto) || [];
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || opts.bad || !Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
    if (opts.bad) console.error(`[kill-port] ${opts.bad}`);
    console.error('usage: node tools/kill-port.js <port> [--dry-run] [--signal TERM|KILL] [--udp] [--yes] [--json]');
    process.exit(opts.help ? 0 : 2);
  }
  if (!['TERM', 'KILL', 'INT'].includes(opts.signal)) {
    console.error(`[kill-port] unsupported --signal ${opts.signal} (TERM|KILL|INT)`);
    process.exit(2);
  }
  if (opts.port < 1024 && !opts.yes && !opts.dryRun) {
    console.error(`[kill-port] port ${opts.port} is privileged: re-run with --yes if you really mean to stop the service on it`);
    process.exit(2);
  }

  const found = findListeners(opts.port, opts.proto);
  const result = { port: opts.port, proto: opts.proto, dry_run: opts.dryRun, signal: opts.signal, listeners: [], killed: [], survived: [] };
  // Un listener kernel senza PID (socket in TIME_WAIT, owner in un namespace) non è uccidibile:
  // lo si riporta così il chiamante non scambia "nessun PID" per "porta libera".
  // Node vuole il nome completo del segnale: 'TERM' → ERR_UNKNOWN_SIGNAL, 'SIGTERM' funziona.
  const sig = opts.signal.startsWith('SIG') ? opts.signal : `SIG${opts.signal}`;
  for (const l of found) {
    result.listeners.push({ pid: l.pid, name: l.name, cmdline: l.pid ? cmdline(l.pid) : null });
    if (!l.pid) continue;
    if (l.pid === SELF || l.pid === PPID || l.pid === 1) { result.survived.push({ pid: l.pid, reason: 'protected pid' }); continue; }
    if (opts.dryRun) continue;
    try {
      process.kill(l.pid, sig);
      result.killed.push(l.pid);
    } catch (e) {
      result.survived.push({ pid: l.pid, reason: e.code || e.message });
    }
  }

  // SIGTERM è asincrono: senza attesa, il chiamante riparte e trova EADDRINUSE un'altra volta.
  if (!opts.dryRun && result.killed.length) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && result.killed.some((pid) => alive(pid))) {
      spawnSync('sleep', ['0.1']);
    }
    for (const pid of result.killed) {
      if (alive(pid)) result.survived.push({ pid, reason: `still alive after SIG${opts.signal} (try --signal KILL)` });
    }
    result.killed = result.killed.filter((pid) => !result.survived.some((s) => s.pid === pid));
  }

  // Rilegge il kernel: "ho mandato il segnale" non è "la porta è libera".
  // In --dry-run non si afferma nulla sullo stato della porta (null).
  result.port_free = opts.dryRun ? null : findListeners(opts.port, opts.proto).length === 0;

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!result.listeners.length) {
    console.log(`[kill-port] nothing listening on ${opts.proto}/${opts.port}`);
  } else {
    for (const l of result.listeners) {
      const state = opts.dryRun ? 'would kill' : (result.killed.includes(l.pid) ? 'killed' : 'left running');
      console.log(`[kill-port] ${opts.proto}/${opts.port} pid=${l.pid} (${l.name || '?'}) ${state}: ${l.cmdline || ''}`.trim());
    }
    for (const s of result.survived) console.error(`[kill-port] pid=${s.pid} survived: ${s.reason}`);
  }
  process.exit(result.survived.length ? 1 : 0);
}

if (require.main === module) main();

module.exports = { parseArgs, listenersViaSs, listenersViaLsof, findListeners };
