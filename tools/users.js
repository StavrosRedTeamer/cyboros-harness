#!/usr/bin/env node
// tools/users.js — create and administer console accounts (zero-dep).
//
// Why: the Command Center's accounts are a file (users.json, mode 0600), not a
// database, so the first admin has to exist before anyone can log in. This CLI is
// that step, and it is also the escape hatch when the console is unreachable.
//
//   node tools/users.js add admin --role admin --generate
//   node tools/users.js add alice --role operator --password-stdin < /run/secrets/alice
//   node tools/users.js list
//   node tools/users.js passwd alice --password-stdin
//   node tools/users.js role alice admin
//   node tools/users.js disable alice | enable alice | remove alice
//
// The password is never accepted as an argument (it would land in shell history
// and procfs): it comes from stdin or is generated and printed exactly once.
// The file path follows the console: CYBOROS_USERS_FILE, else $CC_ROOT/users.json,
// else <repo>/users.json.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const identity = require('./identity');

const ROOT = process.env.CC_ROOT ? path.resolve(process.env.CC_ROOT) : path.join(__dirname, '..');
const USERS_FILE = process.env.CYBOROS_USERS_FILE || path.join(ROOT, 'users.json');

function usage(code) {
  const out = [
    'usage: node tools/users.js <command> [args]',
    '',
    '  add <username> --role admin|operator|viewer [--name "Display"] (--password-stdin | --generate)',
    '  passwd <username> (--password-stdin | --generate)',
    '  role <username> <role>',
    '  disable <username>',
    '  enable <username>',
    '  remove <username>',
    '  list',
    '  path',
    '',
    'The users file is ' + USERS_FILE,
    'Roles: viewer (read only) < operator (run the engagement) < admin (manage accounts).',
  ].join('\n');
  (code ? console.error : console.log)(out);
  process.exit(code);
}

function parse(argv) {
  const o = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--generate') o.flags.generate = true;
    else if (a === '--password-stdin') o.flags.stdin = true;
    else if (a === '--role') o.flags.role = argv[++i];
    else if (a === '--name') o.flags.name = argv[++i];
    else if (a === '-h' || a === '--help') usage(0);
    else if (a.startsWith('--')) { console.error('users: unknown flag ' + a); usage(2); }
    else o._.push(a);
  }
  return o;
}

function readStdin() {
  try {
    const buf = fs.readFileSync(0);
    return buf.toString('utf8').replace(/\r?\n$/, '');
  } catch { return ''; }
}

function passwordFor(flags) {
  if (flags.generate) {
    const pw = crypto.randomBytes(24).toString('base64url');
    return { ok: true, password: pw, generated: true };
  }
  if (flags.stdin) {
    if (process.stdin.isTTY) return { ok: false, error: '--password-stdin expects the password on stdin, e.g. < file or printf | ' };
    const pw = readStdin();
    if (!pw) return { ok: false, error: 'no password on stdin' };
    return { ok: true, password: pw };
  }
  return { ok: false, error: 'one of --generate or --password-stdin is required (a password argument is refused: it would leak into shell history)' };
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const o = parse(argv.slice(1));
  const id = identity.createIdentity({ root: ROOT, usersFile: USERS_FILE, serviceToken: null });
  const actor = 'cli:' + (os.userInfo().username || 'unknown');
  const meta = { actor, role: null };

  const need = (name) => {
    if (!name) { console.error('users: a username is required'); usage(2); }
    return name;
  };
  const printOnce = (r, what) => {
    if (!r.ok) { console.error('users: ' + r.error); process.exit(1); }
    if (r.generated) {
      console.log('');
      console.log('  password for ' + what + ' (shown once, store it now):');
      console.log('  ' + r.password);
      console.log('');
    }
    console.log(what + ': ' + (r.action || 'ok'));
  };

  if (cmd === 'list' || cmd === undefined) {
    const r = id.listUsers();
    if (r.error) { console.error('users: ' + r.error); process.exit(2); }
    if (!r.users.length) {
      console.log('no accounts in ' + USERS_FILE);
      console.log('create the first admin: node tools/users.js add <name> --role admin --generate');
      return;
    }
    for (const u of r.users) {
      console.log([u.username, u.role, u.disabled ? 'disabled' : 'active', u.display_name || '-', u.last_login || 'never'].join('\t'));
    }
    return;
  }
  if (cmd === 'path') { console.log(USERS_FILE); return; }

  if (cmd === 'add') {
    const username = need(o._[0]);
    const pw = passwordFor(o.flags);
    if (!pw.ok) { console.error('users: ' + pw.error); process.exit(2); }
    const r = id.addUser({ username, role: o.flags.role, password: pw.password, display_name: o.flags.name || '' }, meta);
    printOnce(Object.assign({}, r, { generated: pw.generated, password: pw.password, action: 'created' }), username);
    warnNoAdmin(id);
    return;
  }

  if (cmd === 'passwd') {
    const username = need(o._[0]);
    const pw = passwordFor(o.flags);
    if (!pw.ok) { console.error('users: ' + pw.error); process.exit(2); }
    const r = id.setPassword(username, pw.password, meta);
    printOnce(Object.assign({}, r, { generated: pw.generated, password: pw.password, action: 'password changed (existing sessions revoked)' }), username);
    return;
  }

  if (cmd === 'role') {
    const username = need(o._[0]);
    const role = need(o._[1]);
    const r = id.updateUser(username, { role }, meta);
    if (!r.ok) { console.error('users: ' + r.error); process.exit(1); }
    console.log(username + ': role ' + r.user.role);
    warnNoAdmin(id);
    return;
  }

  if (cmd === 'disable' || cmd === 'enable') {
    const username = need(o._[0]);
    const r = id.updateUser(username, { disabled: cmd === 'disable' }, meta);
    if (!r.ok) { console.error('users: ' + r.error); process.exit(1); }
    console.log(username + ': ' + (cmd === 'disable' ? 'disabled (sessions revoked)' : 'enabled'));
    return;
  }

  if (cmd === 'remove') {
    const username = need(o._[0]);
    const r = id.removeUser(username, meta);
    if (!r.ok) { console.error('users: ' + r.error); process.exit(1); }
    console.log(username + ': removed (sessions revoked)');
    return;
  }

  console.error('users: unknown command ' + cmd);
  usage(2);
}

function warnNoAdmin(id) {
  const r = id.listUsers();
  if (r.error) return;
  const admins = r.users.filter((u) => u.role === 'admin' && !u.disabled);
  if (!admins.length && r.users.length) console.error('users: WARNING — no enabled admin exists; user management is CLI-only until one is added');
}

if (require.main === module) {
  try { main(); } catch (e) {
    console.error('users: ' + ((e && e.message) || e));
    process.exit(1);
  }
}

module.exports = { USERS_FILE, parse, passwordFor };
