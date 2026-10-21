#!/usr/bin/env node
// tools/init.js — first run, outside the repository.
//
// A deployment owns a data directory: config, accounts, authorization, reports and
// the audit trail. The code stays where it was installed (the checkout, or the
// container image), and the two are connected by one config file. This command
// creates that data directory so an operator never has to edit the tree to start
// the console:
//
//   node tools/init.js --dir /srv/cyboros --admin alice
//   CYBOROS_CONFIG=/srv/cyboros/cyboros.config.json node tools/gui-server.js
//
// It is idempotent from the operator's side: an existing config or users file is
// never overwritten unless --force is given, and even then accounts are kept
// unless --reset-users is explicit (losing an admin is not a side effect).
'use strict';

const fs = require('fs');
const path = require('path');
const identity = require('./identity');
const configLib = require('./config');

function usage(code) {
  const text = [
    'usage: node tools/init.js --dir <data directory> [options]',
    '',
    '  --dir <path>        where config, users, scope and reports live (required)',
    '  --admin <name>      name of the first admin account (default: admin)',
    '  --role <role>       role for that account (default: admin)',
    '  --force             overwrite an existing config file',
    '  --reset-users       replace the accounts file (refused without --force)',
    '',
    'The command writes nothing outside --dir. It prints the generated password once.',
  ].join('\n');
  (code ? console.error : console.log)(text);
  process.exit(code);
}

function flag(argv, name, def) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !String(argv[i + 1]).startsWith('--') ? argv[i + 1] : def;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('-h') || argv.includes('--help')) usage(0);
  const dirArg = flag(argv, '--dir', '');
  if (!dirArg) usage(2);
  const dataDir = path.resolve(dirArg);
  const adminName = String(flag(argv, '--admin', 'admin')).trim().toLowerCase();
  const adminRole = String(flag(argv, '--role', 'admin'));
  const force = argv.includes('--force');
  const resetUsers = argv.includes('--reset-users');

  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dataDir, 0o700); } catch { /* windows */ }

  const configFile = path.join(dataDir, 'cyboros.config.json');
  const created = [];

  // ── config ────────────────────────────────────────────────────────────────
  if (fs.existsSync(configFile) && !force) {
    console.log('config already exists, leaving it alone: ' + configFile);
  } else {
    const doc = {
      version: configLib.VERSION,
      data_root: '.',
      http: { host: '127.0.0.1', port: 8787, allowed_hosts: [] },
      paths: {
        scope: 'scope.json',
        users: 'users.json',
        reports: 'reports',
        audit: 'artifacts/audit',
        operation_state: 'operation-state.json',
      },
      identity: { session_ttl_hours: 12, idle_minutes: 120, provider: null },
      service_token: 'auto',
      service_token_role: 'operator',
      read_only: false,
    };
    fs.writeFileSync(configFile, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
    try { fs.chmodSync(configFile, 0o600); } catch { /* windows */ }
    created.push(configFile);
  }

  // Validate what we just wrote, with the same loader the server uses: a first run
  // that produces an unusable config is a bug in this command, and it says so now.
  const check = configLib.loadConfig({ argv: ['--config', configFile], env: {} });
  if (!check.ok) {
    console.error('init: the generated config is not valid — ' + configLib.formatProblems(check));
    process.exit(2);
  }
  const cfg = check.config;

  // ── scope: fail-closed until the operator writes the authorization ───────
  if (!fs.existsSync(cfg.paths.scope)) {
    fs.writeFileSync(cfg.paths.scope, JSON.stringify({
      allowed_hosts: [],
      allowed_url_prefixes: [],
      allowed_ips: [],
      max_requests_per_second: 2,
      notes: 'Created by tools/init.js. This file IS the written authorization: add only hosts you are authorized to test. Empty = everything blocked.',
    }, null, 2) + '\n', { mode: 0o600 });
    try { fs.chmodSync(cfg.paths.scope, 0o600); } catch { /* windows */ }
    created.push(cfg.paths.scope);
  }

  fs.mkdirSync(cfg.paths.reports, { recursive: true });

  // ── first admin ──────────────────────────────────────────────────────────
  let password = null;
  if (fs.existsSync(cfg.paths.users) && !resetUsers) {
    const id = identity.createIdentity({ root: cfg.dataRoot, usersFile: cfg.paths.users, serviceToken: null });
    const users = id.listUsers();
    if (users.error) {
      console.error('init: the existing users file is not usable: ' + users.error);
      process.exit(2);
    }
    const admins = users.users.filter((u) => u.role === 'admin' && !u.disabled).length;
    console.log(`accounts already exist (${users.users.length}, ${admins} admin) — no password generated`);
    if (!admins) console.error('init: WARNING — no enabled admin exists; create one with node tools/users.js add <name> --role admin --generate');
  } else {
    if (resetUsers && !force) {
      console.error('init: --reset-users requires --force (it deletes every account)');
      process.exit(2);
    }
    const id = identity.createIdentity({ root: cfg.dataRoot, usersFile: cfg.paths.users, serviceToken: null });
    password = require('crypto').randomBytes(24).toString('base64url');
    const r = id.addUser({ username: adminName, role: adminRole, password, display_name: 'First admin' }, { actor: 'cli:init' });
    if (!r.ok) {
      console.error('init: cannot create the first account: ' + r.error);
      process.exit(1);
    }
    created.push(cfg.paths.users);
  }

  console.log('');
  console.log('Data directory ready: ' + dataDir);
  for (const f of created) console.log('  wrote  ' + f);
  console.log('  config ' + cfg.configFile);
  console.log('  scope  ' + cfg.paths.scope + ' (fail-closed: add your authorized hosts)');
  console.log('  audit  ' + cfg.paths.audit);
  if (password) {
    console.log('');
    console.log('  password for ' + adminName + ' (shown once, store it now):');
    console.log('  ' + password);
  }
  console.log('');
  console.log('Start the console:');
  console.log('  CYBOROS_CONFIG=' + cfg.configFile + ' node ' + path.join(__dirname, 'gui-server.js'));
  console.log('Then open http://' + (cfg.http.host === '0.0.0.0' ? '127.0.0.1' : cfg.http.host) + ':' + cfg.http.port + '/login');
  return 0;
}

if (require.main === module) {
  try { process.exit(main()); }
  catch (e) {
    console.error('init: ' + ((e && e.message) || e));
    process.exit(1);
  }
}

module.exports = { main };
