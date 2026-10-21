// Offline coverage for the deployment surface: tools/config.js and tools/init.js.
// No listener is opened, no network: schema validation, precedence, path
// resolution, the single actionable failure, first-run output, and the server
// refusing to boot on a broken file.
// Run: node tools/test-config.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { ok, summary } = require('./testkit');
const configLib = require('./config');
const identity = require('./identity');

const WS = path.join(__dirname, '..');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboros-config-'));

function writeJson(file, obj, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', { mode: mode || 0o600 });
  return file;
}

function baseDoc(over) {
  return Object.assign({
    version: 1,
    data_root: 'data',
    http: { host: '127.0.0.1', port: 9000, allowed_hosts: [] },
    paths: { scope: 'scope.json', users: 'users.json', reports: 'reports', audit: 'artifacts/audit', operation_state: 'operation-state.json' },
    identity: { session_ttl_hours: 4, idle_minutes: 30, provider: null },
    service_token: 'auto',
    service_token_role: 'operator',
    read_only: false,
  }, over || {});
}

function load(file, env) {
  return configLib.loadConfig({ argv: ['--config', file], env: env || {}, repoRoot: WS });
}

console.log('config — one validated surface for a deployment');

ok('no config file means documented development defaults at the repo root', () => {
  const r = configLib.loadConfig({ argv: [], env: {}, repoRoot: WS });
  assert.strictEqual(r.ok, true, configLib.formatProblems(r));
  assert.strictEqual(r.config.configFile, null);
  assert.strictEqual(r.config.dataRoot, WS);
  assert.strictEqual(r.config.http.host, '127.0.0.1');
  assert.strictEqual(r.config.http.port, 8787);
  assert.strictEqual(r.config.paths.users, path.join(WS, 'users.json'));
  assert.strictEqual(r.config.paths.audit, path.join(WS, 'artifacts', 'audit'));
  assert.strictEqual(r.config.serviceToken, 'auto');
});

ok('a config file resolves data_root against its own directory, paths against data_root', () => {
  const file = writeJson(path.join(T, 'one', 'cyboros.config.json'), baseDoc({
    http: { host: '0.0.0.0', port: 8787, allowed_hosts: ['Console.Example.COM'] },
    identity: { session_ttl_hours: 2, idle_minutes: 15 },
  }));
  const r = load(file);
  assert.strictEqual(r.ok, true, configLib.formatProblems(r));
  assert.strictEqual(r.config.configFile, file);
  assert.strictEqual(r.config.dataRoot, path.join(T, 'one', 'data'));
  assert.strictEqual(r.config.paths.scope, path.join(T, 'one', 'data', 'scope.json'));
  assert.strictEqual(r.config.paths.reports, path.join(T, 'one', 'data', 'reports'));
  assert.deepStrictEqual(r.config.http.allowedHosts, ['console.example.com'], 'hostnames are lowercased');
  assert.strictEqual(r.config.identity.sessionTtlMs, 2 * 3600 * 1000);
  assert.strictEqual(r.config.identity.idleMs, 15 * 60 * 1000);
});

ok('environment overrides the file, and GUI_PORT=0 survives as ephemeral', () => {
  const file = writeJson(path.join(T, 'env', 'cyboros.config.json'), baseDoc());
  const r = load(file, {
    CC_ROOT: path.join(T, 'env', 'root-from-env'),
    GUI_PORT: '0',
    GUI_HOST: '127.0.0.1',
    SCOPE_JSON: path.join(T, 'env', 'scope-from-env.json'),
    CYBOROS_USERS_FILE: path.join(T, 'env', 'users-from-env.json'),
    AUDIT_DIR: path.join(T, 'env', 'audit-from-env'),
    SCC_TOKEN: 'x'.repeat(32),
    CYBOROS_TOKEN_ROLE: 'viewer',
    CYBOROS_ALLOWED_HOSTS: 'one.example,two.example',
  });
  assert.strictEqual(r.ok, true, configLib.formatProblems(r));
  assert.strictEqual(r.config.dataRoot, path.join(T, 'env', 'root-from-env'));
  assert.strictEqual(r.config.http.port, 0);
  assert.strictEqual(r.config.paths.scope, path.join(T, 'env', 'scope-from-env.json'));
  assert.strictEqual(r.config.paths.users, path.join(T, 'env', 'users-from-env.json'));
  assert.strictEqual(r.config.paths.audit, path.join(T, 'env', 'audit-from-env'));
  assert.strictEqual(r.config.serviceToken, 'x'.repeat(32));
  assert.strictEqual(r.config.serviceTokenRole, 'viewer');
  assert.deepStrictEqual(r.config.http.allowedHosts, ['one.example', 'two.example']);
});

ok('an invalid file reports every problem, once, with the file path', () => {
  const file = writeJson(path.join(T, 'bad', 'cyboros.config.json'), {
    version: 7,
    data_root: '',
    http: { host: '127.0.0.1', port: 'eighty', allowed_hosts: ['https://x.example'] },
    paths: { scope: '../escape.json' },
    identity: { session_ttl_hours: 0, idle_minutes: 99999 },
    service_token: 'short',
    service_token_role: 'root',
    extra_key: true,
  });
  const r = load(file);
  assert.strictEqual(r.ok, false);
  const msg = r.problems.join('\n');
  assert.match(msg, /version 7 is not supported/, 'unknown version names the upgrade doc');
  assert.match(msg, /data_root must be a non-empty string/);
  assert.match(msg, /http\.port must be an integer/);
  assert.match(msg, /allowed_hosts entry/);
  assert.match(msg, /paths\.scope must not contain '\.\.'/);
  assert.match(msg, /session_ttl_hours must be a number 1\.\.720/);
  assert.match(msg, /idle_minutes/);
  assert.match(msg, /service_token must be/);
  assert.match(msg, /service_token_role must be one of/);
  assert.match(msg, /extra_key is not a known setting/, 'typos are refused, not ignored');
  const formatted = configLib.formatProblems(r);
  assert.match(formatted, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the message names the file');
  assert.match(formatted, /cyboros\.config\.example\.json/);
});

ok('a missing explicit config is an error; a missing default one is not', () => {
  const explicit = configLib.loadConfig({ argv: ['--config', path.join(T, 'nope.json')], env: {}, repoRoot: WS });
  assert.strictEqual(explicit.ok, false);
  assert.match(explicit.problems.join(' '), /config file not found/);
  const implicit = configLib.loadConfig({ argv: [], env: {}, repoRoot: path.join(T, 'empty-repo') });
  assert.strictEqual(implicit.ok, true);
  assert.strictEqual(implicit.config.configFile, null);
});

ok('--check validates without starting, --print redacts the token', () => {
  const good = writeJson(path.join(T, 'cli', 'cyboros.config.json'), baseDoc({ service_token: 'y'.repeat(40) }));
  const env = Object.assign({}, process.env, { CYBOROS_CONFIG: good, GUI_PORT: '', SCC_TOKEN: '' });
  const checked = spawnSync(process.execPath, [path.join(WS, 'tools', 'config.js'), '--check'], { env, encoding: 'utf8' });
  assert.strictEqual(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /config: ok/);

  const printed = execFileSync(process.execPath, [path.join(WS, 'tools', 'config.js'), '--print'], { env, encoding: 'utf8' });
  assert.ok(!printed.includes('y'.repeat(40)), 'the literal token is never printed');
  assert.match(printed, /<40 chars>/);

  const bad = writeJson(path.join(T, 'cli', 'bad.json'), baseDoc({ http: { host: '127.0.0.1', port: -1 } }));
  const refused = spawnSync(process.execPath, [path.join(WS, 'tools', 'config.js'), '--check'], {
    env: Object.assign({}, process.env, { CYBOROS_CONFIG: bad }), encoding: 'utf8',
  });
  assert.strictEqual(refused.status, 2, 'invalid config exits 2');
  assert.match(refused.stderr, /configuration is not usable/);
});

ok('the server refuses to start on an invalid config, before binding anything', () => {
  const bad = writeJson(path.join(T, 'boot', 'cyboros.config.json'), baseDoc({ http: { host: '127.0.0.1', port: 70000 } }));
  const r = spawnSync(process.execPath, [path.join(WS, 'tools', 'gui-server.js'), '--print-port'], {
    env: Object.assign({}, process.env, { CYBOROS_CONFIG: bad }),
    encoding: 'utf8', timeout: 15000,
  });
  assert.strictEqual(r.status, 2, 'exit 2');
  assert.match(r.stderr, /configuration is not usable/);
  assert.match(r.stderr, /http\.port/);
  assert.strictEqual(r.stdout.trim(), '', 'nothing started, no handshake printed');
});

ok('init.js creates a first-run directory outside the tree, once, with a working admin', () => {
  const dir = path.join(T, 'install');
  const out = execFileSync(process.execPath, [path.join(WS, 'tools', 'init.js'), '--dir', dir, '--admin', 'alice'], { encoding: 'utf8' });
  const pw = (out.match(/^\s{2}([A-Za-z0-9_-]{24,})\s*$/m) || [])[1];
  assert.ok(pw, 'generated password printed once');
  const configFile = path.join(dir, 'cyboros.config.json');
  assert.ok(fs.existsSync(configFile), 'config written into the data directory');
  assert.strictEqual(fs.statSync(configFile).mode & 0o077, 0, 'config is 0600');
  assert.strictEqual(fs.statSync(path.join(dir, 'users.json')).mode & 0o077, 0, 'users.json is 0600');
  const scope = JSON.parse(fs.readFileSync(path.join(dir, 'scope.json'), 'utf8'));
  assert.deepStrictEqual(scope.allowed_hosts, [], 'scope starts fail-closed');

  const loaded = configLib.loadConfig({ argv: ['--config', configFile], env: {}, repoRoot: WS });
  assert.strictEqual(loaded.ok, true, configLib.formatProblems(loaded));
  assert.strictEqual(loaded.config.dataRoot, dir);
  assert.strictEqual(loaded.config.paths.reports, path.join(dir, 'reports'));

  const id = identity.createIdentity({ root: dir, usersFile: loaded.config.paths.users, serviceToken: null, auditDir: loaded.config.paths.audit });
  assert.strictEqual(id.login('alice', pw, {}).ok, true, 'the printed password authenticates');

  // Second run: idempotent, and it does not silently replace accounts.
  const again = execFileSync(process.execPath, [path.join(WS, 'tools', 'init.js'), '--dir', dir], { encoding: 'utf8' });
  assert.match(again, /config already exists|accounts already exist/);
  assert.ok(!/password for/.test(again), 'no second password generated');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'users.json'), 'utf8').includes('alice'), true, 'accounts preserved');
});

ok('init.js refuses to replace accounts without --force, and rejects a missing --dir', () => {
  const dir = path.join(T, 'install-reset');
  execFileSync(process.execPath, [path.join(WS, 'tools', 'init.js'), '--dir', dir], { encoding: 'utf8' });
  const refused = spawnSync(process.execPath, [path.join(WS, 'tools', 'init.js'), '--dir', dir, '--reset-users'], { encoding: 'utf8' });
  assert.notStrictEqual(refused.status, 0);
  assert.match(refused.stderr, /requires --force/);
  const noDir = spawnSync(process.execPath, [path.join(WS, 'tools', 'init.js')], { encoding: 'utf8' });
  assert.strictEqual(noDir.status, 2);
  assert.match(noDir.stderr, /--dir/);
});

summary('config');
