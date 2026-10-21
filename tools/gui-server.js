#!/usr/bin/env node
// Cyboros Console — local dashboard GUI (zero-dependencies). This file is the
// composition root: it reads the config, builds the modules, wires them once and
// owns the process lifecycle. The request pipeline lives in console/app.js and the
// responsibilities behind it in tools/console/ (transport, gate, routes, jobs,
// terminals, read models) — see docs/ARCHITECTURE.md, "The console is a composition".
//
//   node tools/gui-server.js [--port N] [--host 127.0.0.1]
//
// Serves a single-page dashboard (tools/gui/) bound to 127.0.0.1 by default and
// exposes a small JSON API over the harness data. It NEVER bypasses the guards:
// write actions shell out to the existing tools (cyboros.js resume,
// report-html.js) and the scope editor validates through the same rules the
// scope-guard applies at runtime.
//
// Hardening: bound to loopback, Host must be 127.0.0.1/localhost/[::1] (plus
// http.allowed_hosts for a container or proxy), Origin checked when present
// (DNS-rebinding + CSRF), JSON body size capped. Identity: every /api request is
// authenticated by tools/identity.js and authorized by role (viewer < operator <
// admin). Humans log in with an account from users.json (scrypt, session cookie);
// a machine sends the startup service token and acts as `service` with role
// operator (--token-role). There is no unauthenticated data read. `--token off`
// disables the machine credential, not the accounts.
// Single instance: `--instance` uses the data root's app/server.lock
// (cc-instance.js); if a live instance already answers the handshake this process
// prints SCC_ATTACH=<url> and exits 3 instead of becoming a second backend over the
// same PTYs. `--print-port` prints SCC_PORT=/SCC_URL= once listening (port 0 =
// ephemeral).
'use strict';
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const ccInstance = require('./cc-instance');
const ccRouter = require('./cc-router');
const identityLib = require('./identity');
const configLib = require('./config');
const { augmentPath } = require('./tool-path');
const files = require('./console/files');
const { sendJson, sendText, bodyJson, createHostGuard, createStatic } = require('./console/http');
const { createGate } = require('./console/gate');
const { createScopeStore } = require('./console/scope');
const { createFindings } = require('./console/findings');
const { createPipeline } = require('./console/pipeline');
const { createEngagement } = require('./console/engagement');
const { createJobs } = require('./console/jobs');
const { createTerminals } = require('./console/terminals');
const routes = require('./console/routes/index');
const publicRoutes = require('./console/routes/public');
const { createApp } = require('./console/app');

// The harness resolves binaries through PATH (doctor.js, tool-plane.js, run.js) and every
// child of this server inherits ours. A dashboard started from a tray/autostart gets the
// SYSTEM path, which hides ~/go/bin and ~/.local/bin: installed tools would be reported as
// missing and dispatched jobs would die with "not found". Fix it once, here, for every child.
augmentPath(process.env);

const TOOLS_DIR = __dirname;
const REPO_ROOT = path.join(TOOLS_DIR, '..');
// GUI_DIR stays on the repo because the SPA assets ship with the code, not with the
// engagement data; everything the console reads at runtime follows the config.
const GUI_DIR = path.join(TOOLS_DIR, 'gui');

// ── configuration (one validated surface — tools/config.js) ─────────────────
// Everything below comes from the effective config: the file named by
// CYBOROS_CONFIG/--config, or cyboros.config.json at the repo root, with env and
// CLI overriding it. An invalid file is one message and exit 2, never a silent
// fallback to defaults.
const LOADED = configLib.loadConfig({ repoRoot: REPO_ROOT });
if (!LOADED.ok) {
  console.error('gui-server: ' + configLib.formatProblems(LOADED));
  process.exit(2);
}
for (const w of LOADED.warnings) console.warn('gui-server: warning: ' + w);
const CFG = LOADED.config;
const ROOT = CFG.dataRoot;
const REPORTS = CFG.paths.reports;
const SCOPE_FILE = CFG.paths.scope;
const OPSTATE_FILE = CFG.paths.operationState;
const SESSIONS_FILE = path.join(REPORTS, 'sessions.json');
const LOOT_FILE = path.join(REPORTS, 'loot.jsonl');
const STATE_DB = path.join(REPORTS, 'state.db');

// The console's decision about where the engagement lives has to reach every child
// it spawns AND every in-process module that resolves engagement paths (scope-guard,
// gate, report-html, …). Exporting it once here — children inherit the environment —
// is why a `--config` start also governs a job launched without the flag, and why no
// caller has to hand-pass ten resolved paths. tools/config.js is the only reader.
process.env.CC_ROOT = ROOT;
if (CFG.configFile) process.env.CYBOROS_CONFIG = CFG.configFile;

// port 0 = ephemeral: the real port is known after listen (and written to the lock)
const PORT = CFG.http.port;
const HOST = CFG.http.host;

const INSTANCE = process.argv.includes('--instance') || process.env.SCC_INSTANCE === '1';
const READ_ONLY = CFG.readOnly;
const PRINT_HANDSHAKE = process.argv.includes('--print-port') || process.env.SCC_PRINT_PORT === '1';
// `auto` mints a fresh machine credential per run; `off` means none (accounts only).
const TOKEN = CFG.serviceToken === 'auto' ? crypto.randomBytes(24).toString('hex') : CFG.serviceToken;
const STARTED_AT = new Date().toISOString();
let boundPort = PORT;

// The instance lock belongs to the installation, not to the checkout: with a mounted
// data directory (and a read-only code tree in the container) the default under the
// repo would land outside the backup or fail outright. cc-instance.js reads this
// env lazily, so setting it here is enough.
if (!process.env.CC_STATE_DIR) process.env.CC_STATE_DIR = path.join(REPORTS, 'app');

// ── identity (users.json + sessions + service token) ───────────────────────
// The service token keeps the launcher/desktop flow working, but it is a machine
// credential at its configured role: administrative actions need a real account.
const identity = identityLib.createIdentity({
  root: ROOT,
  usersFile: CFG.paths.users,
  serviceToken: TOKEN,
  tokenRole: CFG.serviceTokenRole,
  sessionTtlMs: CFG.identity.sessionTtlMs,
  sessionIdleMs: CFG.identity.idleMs,
  auditDir: CFG.paths.audit,
});
if (CFG.identity.provider) {
  try { identity.loadProvider(CFG.identity.provider); }
  catch (e) { console.error('gui-server: auth provider non caricato (' + CFG.identity.provider + '): ' + String((e && e.message) || e)); process.exit(2); }
}

// ── the modules, each with one owner ───────────────────────────────────────
const hostGuard = createHostGuard(CFG.http.allowedHosts);
const statics = createStatic({
  guiDir: GUI_DIR,
  guardOk: hostGuard.guardOk,
  exchangeServiceToken: (token) => identity.sessionForServiceToken(token),
});
const gate = createGate({ identity, sendJson });
const scope = createScopeStore({ scopeFile: SCOPE_FILE, files });
const findings = createFindings({ reportsDir: REPORTS, files });
const pipeline = createPipeline({ stateDb: STATE_DB });
// What the operator is actually looking at, shown in the status rail: two consoles on
// different ports (or over different data roots) are otherwise indistinguishable.
// `packaged` is the honest axis — the data root lives outside the code tree, which is
// what a container/volume install looks like — not a guess from an env var.
const instanceInfo = () => ({
  host: HOST,
  port: boundPort,
  dataRoot: ROOT,
  configFile: CFG.configFile || null,
  packaged: path.resolve(ROOT) !== path.resolve(REPO_ROOT),
  startedAt: STARTED_AT,
});
const engagement = createEngagement({
  files, scope, findings, pipeline,
  reportsDir: REPORTS, opstateFile: OPSTATE_FILE, sessionsFile: SESSIONS_FILE, lootFile: LOOT_FILE,
  instance: instanceInfo,
});
const jobs = createJobs({ root: ROOT });
const terminals = createTerminals({ root: ROOT, toolsDir: TOOLS_DIR });

// The seam every module is wired through: routes read only from this context, so a
// different identity or job backend is a different constructor call here.
const ctx = {
  dataRoot: ROOT, reportsDir: REPORTS, toolsDir: TOOLS_DIR,
  scopeFile: SCOPE_FILE, opstateFile: OPSTATE_FILE,
  token: TOKEN, readOnly: READ_ONLY,
  sendJson, sendText, bodyJson,
  guardOk: hostGuard.guardOk,
  static: statics, gate, identity,
  scope, findings, pipeline, engagement, jobs, terminals,
  routes, publicRoutes, ccRouter,
  instance: { host: HOST, port: () => boundPort, startedAt: STARTED_AT, tokenRequired: !!TOKEN },
};
const server = http.createServer(createApp(ctx));

// ── lifecycle: handshake output, lock ownership, graceful release ───────────
function releaseLock() {
  if (!INSTANCE) return;
  try { ccInstance.clear({ pid: process.pid }); } catch { /* ignore */ }
}
function shutdown(code) {
  releaseLock();
  process.exit(code);
}
process.on('exit', releaseLock);
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

function onListening() {
  const addr = server.address();
  boundPort = addr && typeof addr === 'object' && addr.port ? addr.port : PORT;
  const tokenized = 'http://' + HOST + ':' + boundPort + (TOKEN ? '/?token=' + TOKEN : '/');
  if (INSTANCE) {
    ccInstance.write({
      pid: process.pid, host: HOST, port: boundPort, token: TOKEN,
      url: tokenized, startedAt: STARTED_AT,
    });
  }
  console.log('Cyboros Console  →  ' + tokenized + '   (ctrl-c to stop)');
  console.log('config: ' + (CFG.configFile || 'built-in defaults') + ' · data ' + ROOT);
  const users = identity.listUsers();
  const n = users.users.length;
  if (users.error) {
    console.error('identity: users file is INVALID — every login is refused until it is fixed: ' + users.error);
  } else if (n === 0) {
    console.log('identity: no accounts yet — create the first one: node tools/users.js add <name> --role admin --generate');
  } else {
    console.log('identity: ' + n + ' account(s) in ' + identity.usersFile + ' · service token role: ' + identity.tokenRole);
  }
  if (PRINT_HANDSHAKE) {
    console.log('SCC_PORT=' + boundPort);
    console.log('SCC_URL=' + tokenized);
  }
}

server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.error('gui-server: porta ' + PORT + ' già in uso (avvia con --instance per l\'attach).');
    process.exit(3);
  }
  console.error('gui-server: ' + String((e && e.message) || e));
  process.exit(1);
});

async function start() {
  if (INSTANCE) {
    const cur = ccInstance.read();
    if (cur && ccInstance.isAlive(cur)) {
      const st = await ccInstance.probe(cur);
      if (st.ok) {
        console.log('SCC_ATTACH=' + (cur.url || ccInstance.url(cur)));
        process.exit(3);
      }
    }
    if (cur) ccInstance.clear({ force: true });   // stale or unresponsive: take over
  }
  server.listen(PORT, HOST, onListening);
}

start().catch((e) => {
  console.error('gui-server: ' + String((e && e.message) || e));
  process.exit(1);
});
