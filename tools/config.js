#!/usr/bin/env node
// tools/config.js — one configuration surface for the console, validated at startup.
//
// Before this file the console was configured by whichever env var happened to be
// set: CC_ROOT here, SCOPE_JSON there, AUDIT_DIR only for the trail, GUI_PORT for
// the listener, and a half-dozen JSON files whose locations were agreed by
// convention. That is fine on the machine where it grew and unusable on a server
// someone else has to operate. Now there is one file:
//
//   cyboros.config.json   (or $CYBOROS_CONFIG, or --config <path>)
//
// Precedence, highest first: CLI flag > environment variable > config file >
// built-in default. Environment overrides exist because containers and tests set
// them; they are named in docs/DEPLOY.md.
//
// Validation is total and the failure is a single actionable message: every
// problem at once, with the file path and the fix, and exit code 2. There is no
// "start anyway with defaults" path for an invalid file — a console that quietly
// ignores half its configuration is worse than one that refuses to start.
'use strict';

const fs = require('fs');
const path = require('path');

const VERSION = 1;
const ROLE_NAMES = ['viewer', 'operator', 'admin'];

// The template is shipped at the repo root. The container's entrypoint and
// tools/init.js write a real one into the data directory.
const DEFAULTS = Object.freeze({
  version: VERSION,
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
});

const KNOWN_TOP = new Set(['version', 'data_root', 'http', 'paths', 'identity', 'service_token', 'service_token_role', 'read_only']);
const KNOWN_HTTP = new Set(['host', 'port', 'allowed_hosts']);
const KNOWN_PATHS = new Set(['scope', 'users', 'reports', 'audit', 'operation_state']);
const KNOWN_IDENTITY = new Set(['session_ttl_hours', 'idle_minutes', 'provider']);

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function readJson(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return { ok: true, value: JSON.parse(raw) };
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: false, missing: true, error: 'not found' };
    return { ok: false, error: e.message };
  }
}

function unknownKeys(obj, known, prefix, problems) {
  for (const k of Object.keys(obj)) {
    if (!known.has(k)) problems.push(`${prefix}${k} is not a known setting (known: ${[...known].join(', ')})`);
  }
}

// Resolve a configured path: absolute stays absolute, relative is relative to the
// data root. Returns an absolute path without normalising away a deliberate '..'
// (which the schema rejects separately, so the operator gets a clear message
// instead of a path silently pointing outside the data root).
function resolveUnder(root, p) {
  return path.isAbsolute(p) ? path.normalize(p) : path.resolve(root, p);
}

function hostListFromEnv(env) {
  const raw = env.CYBOROS_ALLOWED_HOSTS || '';
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * Build the effective configuration.
 * @returns {{ok:boolean, config:object|null, problems:string[], warnings:string[], source:string}}
 */
function loadConfig(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const argv = o.argv || process.argv.slice(2);
  const repoRoot = path.resolve(o.repoRoot || path.join(__dirname, '..'));
  const flag = (name, def) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] && !String(argv[i + 1]).startsWith('--') ? argv[i + 1] : def;
  };

  const problems = [];
  const warnings = [];

  // ── which file ────────────────────────────────────────────────────────────
  const explicit = flag('--config', env.CYBOROS_CONFIG || '');
  const defaultFile = path.resolve(repoRoot, 'cyboros.config.json');
  let file = explicit ? path.resolve(explicit) : defaultFile;
  let fileDoc = null;
  let source = 'defaults';
  const looked = readJson(file);
  if (looked.ok) {
    fileDoc = looked.value;
    source = file;
  } else if (looked.missing) {
    if (explicit) {
      problems.push(`config file not found: ${file}`);
    } else {
      // No file at all: the documented development defaults, rooted at the repo.
      file = null;
    }
  } else {
    problems.push(`cannot read ${file}: ${looked.error}`);
  }

  if (fileDoc != null && !isPlainObject(fileDoc)) {
    problems.push(`${file} must contain a JSON object`);
    fileDoc = null;
  }

  if (fileDoc) {
    if (Number(fileDoc.version) !== VERSION) {
      problems.push(`${file}: version ${JSON.stringify(fileDoc.version)} is not supported by this build (expected ${VERSION}); see docs/UPGRADING.md`);
    }
    unknownKeys(fileDoc, KNOWN_TOP, '', problems);
    if (fileDoc.http != null && !isPlainObject(fileDoc.http)) problems.push(`${file}: http must be an object`);
    else if (fileDoc.http) unknownKeys(fileDoc.http, KNOWN_HTTP, 'http.', problems);
    if (fileDoc.paths != null && !isPlainObject(fileDoc.paths)) problems.push(`${file}: paths must be an object`);
    else if (fileDoc.paths) unknownKeys(fileDoc.paths, KNOWN_PATHS, 'paths.', problems);
    if (fileDoc.identity != null && !isPlainObject(fileDoc.identity)) problems.push(`${file}: identity must be an object`);
    else if (fileDoc.identity) unknownKeys(fileDoc.identity, KNOWN_IDENTITY, 'identity.', problems);
  }

  const doc = fileDoc || {};
  const fhttp = isPlainObject(doc.http) ? doc.http : {};
  const fpaths = isPlainObject(doc.paths) ? doc.paths : {};
  const fident = isPlainObject(doc.identity) ? doc.identity : {};

  // A relative data_root is relative to the config file, so a config directory can
  // be mounted read-only while the data sits next to it.
  const baseDir = file ? path.dirname(file) : repoRoot;
  // An explicitly present but empty value is a mistake, not a request for the
  // default: falling back silently is how half a config gets ignored.
  const present = (v) => v !== undefined && v !== null && v !== '';
  const rawRoot = present(env.CC_ROOT) ? env.CC_ROOT : (doc.data_root !== undefined ? doc.data_root : DEFAULTS.data_root);
  if (typeof rawRoot !== 'string' || !rawRoot.trim()) problems.push('data_root must be a non-empty string');
  const dataRoot = path.resolve(baseDir, String(rawRoot || '.'));

  // ── http ──────────────────────────────────────────────────────────────────
  const hostSrc = present(env.GUI_HOST) ? env.GUI_HOST : (fhttp.host !== undefined ? fhttp.host : DEFAULTS.http.host);
  const host = String(flag('--host', hostSrc));
  if (!host.trim() || !/^[a-zA-Z0-9.:\[\]-]+$/.test(host)) problems.push(`http.host must be a hostname or address, found ${JSON.stringify(host)}`);
  const portRaw = flag('--port', env.GUI_PORT != null ? env.GUI_PORT : (fhttp.port != null ? fhttp.port : DEFAULTS.http.port));
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    problems.push(`http.port must be an integer 0..65535 (0 = ephemeral), found ${JSON.stringify(portRaw)}`);
  }
  const allowedHosts = [
    ...(Array.isArray(fhttp.allowed_hosts) ? fhttp.allowed_hosts : []),
    ...hostListFromEnv(env),
  ].map((h) => String(h).trim().toLowerCase()).filter(Boolean);
  for (const h of allowedHosts) {
    if (!/^[a-z0-9.-]+$/.test(h) || h.includes('..')) {
      problems.push(`http.allowed_hosts entry ${JSON.stringify(h)} must be a bare hostname (no scheme, port or path)`);
    }
  }
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1' && allowedHosts.length === 0) {
    warnings.push(`http.host is ${host} but http.allowed_hosts is empty: the Host guard will refuse every browser request (add the hostname your users type)`);
  }

  // ── paths ─────────────────────────────────────────────────────────────────
  const pick = (key) => {
    const v = fpaths[key];
    if (v == null) return DEFAULTS.paths[key];
    if (typeof v !== 'string' || !v.trim()) {
      problems.push(`paths.${key} must be a non-empty string`);
      return DEFAULTS.paths[key];
    }
    return v;
  };
  const usersFile = env.CYBOROS_USERS_FILE || pick('users');
  const scopeFile = env.SCOPE_JSON || pick('scope');
  const reportsDir = pick('reports');
  const auditDir = env.AUDIT_DIR || pick('audit');
  const opstateFile = pick('operation_state');

  // Checked before resolution: path.resolve() would collapse `../x` and hide the
  // fact that the setting points outside the data root.
  const rawPaths = { scope: scopeFile, users: usersFile, reports: reportsDir, audit: auditDir, operation_state: opstateFile };
  for (const [key, val] of Object.entries(rawPaths)) {
    if (typeof val === 'string' && val.split(/[\\/]/).includes('..')) {
      problems.push(`paths.${key} must not contain '..' (got ${JSON.stringify(val)})`);
    }
  }
  const pathsOut = {
    scope: resolveUnder(dataRoot, scopeFile),
    users: resolveUnder(dataRoot, usersFile),
    reports: resolveUnder(dataRoot, reportsDir),
    audit: resolveUnder(dataRoot, auditDir),
    operationState: resolveUnder(dataRoot, opstateFile),
  };

  // ── identity ──────────────────────────────────────────────────────────────
  const ttlHours = Number(fident.session_ttl_hours != null ? fident.session_ttl_hours : DEFAULTS.identity.session_ttl_hours);
  if (!Number.isFinite(ttlHours) || ttlHours < 1 || ttlHours > 720) {
    problems.push(`identity.session_ttl_hours must be a number 1..720, found ${JSON.stringify(fident.session_ttl_hours)}`);
  }
  const idleMinutes = Number(fident.idle_minutes != null ? fident.idle_minutes : DEFAULTS.identity.idle_minutes);
  if (!Number.isFinite(idleMinutes) || idleMinutes < 1 || idleMinutes > 1440) {
    problems.push(`identity.idle_minutes must be a number 1..1440, found ${JSON.stringify(fident.idle_minutes)}`);
  }
  if (idleMinutes > ttlHours * 60) {
    problems.push(`identity.idle_minutes (${idleMinutes}) cannot exceed session_ttl_hours (${ttlHours}h = ${ttlHours * 60}m)`);
  }
  const providerRaw = env.CYBOROS_AUTH_PROVIDER || fident.provider || null;
  if (providerRaw != null && typeof providerRaw !== 'string') problems.push('identity.provider must be a file path or null');
  const provider = providerRaw ? path.resolve(baseDir, providerRaw) : null;
  if (provider && !fs.existsSync(provider)) problems.push(`identity.provider does not exist: ${provider}`);

  // ── service token + role ──────────────────────────────────────────────────
  const tokenSrc = present(env.SCC_TOKEN) ? env.SCC_TOKEN : (doc.service_token !== undefined ? doc.service_token : DEFAULTS.service_token);
  const tokenRaw = flag('--token', tokenSrc);
  const tokenOpt = String(tokenRaw == null ? 'auto' : tokenRaw);
  if (!['auto', 'off'].includes(tokenOpt) && tokenOpt.length < 16) {
    problems.push('service_token must be "auto", "off" or a literal of at least 16 characters');
  }
  const roleSrc = present(env.CYBOROS_TOKEN_ROLE) ? env.CYBOROS_TOKEN_ROLE : (doc.service_token_role !== undefined ? doc.service_token_role : DEFAULTS.service_token_role);
  const tokenRole = String(flag('--token-role', roleSrc));
  if (!ROLE_NAMES.includes(tokenRole)) {
    problems.push(`service_token_role must be one of ${ROLE_NAMES.join('|')}, found ${JSON.stringify(tokenRole)}`);
  }

  const readOnlyFlag = argv.includes('--read-only') || env.SCC_READ_ONLY === '1' || doc.read_only === true;
  if (doc.read_only != null && typeof doc.read_only !== 'boolean') problems.push('read_only must be a boolean');

  if (problems.length) {
    return { ok: false, config: null, problems, warnings, source: file || 'defaults' };
  }

  const config = {
    version: VERSION,
    configFile: file,
    dataRoot,
    http: { host, port, allowedHosts },
    paths: pathsOut,
    identity: {
      sessionTtlMs: Math.round(ttlHours * 3600 * 1000),
      idleMs: Math.round(idleMinutes * 60 * 1000),
      provider,
    },
    serviceToken: tokenOpt === 'off' ? null : tokenOpt,
    serviceTokenRole: tokenRole,
    readOnly: readOnlyFlag,
  };
  return { ok: true, config, problems: [], warnings, source: file || 'defaults' };
}

// ── the engagement layout, for tools that are not the console ────────────────
// The console, the tools it dispatches and the CLI have to agree on ONE tree: in a
// deployed instance the code is not where the engagement data is (and the code tree
// may be read-only). Child tools call dataPaths() instead of hardcoding
// `__dirname/../reports`, so the rule — flag > env > file > default, paths relative
// to the config file — stays here and nobody re-derives it.
//
// argv is deliberately NOT read: a tool's own flags are not config flags. The
// console exports CYBOROS_CONFIG and CC_ROOT to its children, so the decision it
// already made (including `--config`) reaches them through the environment.
//
// Throws when the config exists and is invalid: silently falling back to the repo
// tree is how a deployed tool serves stale engagement data.
function dataPaths(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const repoRoot = path.resolve(o.repoRoot || path.join(__dirname, '..'));
  const res = loadConfig({ argv: [], env, repoRoot });
  if (!res.ok) {
    const err = new Error('configuration is not usable: ' + res.problems.join('; ') +
      (res.source && res.source !== 'defaults' ? ` (${res.source})` : ''));
    err.code = 'CYBOROS_CONFIG_INVALID';
    err.problems = res.problems;
    throw err;
  }
  const c = res.config;
  return {
    dataRoot: c.dataRoot,
    configFile: c.configFile,
    scope: c.paths.scope,
    reports: c.paths.reports,
    users: c.paths.users,
    audit: c.paths.audit,
    operationState: c.paths.operationState,
    stateDb: path.join(c.paths.reports, 'state.db'),
    findings: path.join(c.paths.reports, 'findings.jsonl'),
    loot: path.join(c.paths.reports, 'loot.jsonl'),
    sessions: path.join(c.paths.reports, 'sessions.json'),
    gateLog: path.join(c.paths.reports, 'gate-log.md'),
    verifications: path.join(c.paths.reports, 'verifications.jsonl'),
    tmp: path.join(c.paths.reports, 'tmp'),
    auth: path.join(c.dataRoot, 'auth.json'),
    evidenceIndex: path.join(c.dataRoot, 'evidence-index.md'),
  };
}

// One message, every problem, and the file to edit.
function formatProblems(result) {
  const lines = [`configuration is not usable (${result.problems.length} problem${result.problems.length === 1 ? '' : 's'})`];
  result.problems.forEach((p, i) => lines.push(`  ${i + 1}. ${p}`));
  if (result.source && result.source !== 'defaults') lines.push(`Fix ${result.source} and start again (template: cyboros.config.example.json).`);
  else lines.push('Copy cyboros.config.example.json to cyboros.config.json, edit it, and start again.');
  return lines.join('\n');
}

// Redacted rendering for --print and for the startup banner: a token that lands in
// a log file is a token someone else can use.
function redacted(config) {
  const out = JSON.parse(JSON.stringify(config));
  if (typeof out.serviceToken === 'string' && out.serviceToken !== 'auto') out.serviceToken = '<' + out.serviceToken.length + ' chars>';
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const result = loadConfig({ argv, env: process.env, repoRoot: path.join(__dirname, '..') });
  if (!result.ok) {
    console.error('config: ' + formatProblems(result));
    return 2;
  }
  for (const w of result.warnings) console.error('config: warning: ' + w);
  if (argv.includes('--print')) {
    console.log(JSON.stringify(redacted(result.config), null, 2));
    return 0;
  }
  if (argv.includes('--paths')) {
    const c = result.config;
    console.log('config=' + (c.configFile || '<defaults>'));
    console.log('data_root=' + c.dataRoot);
    console.log('scope=' + c.paths.scope);
    console.log('users=' + c.paths.users);
    console.log('reports=' + c.paths.reports);
    console.log('audit=' + c.paths.audit);
    console.log('http=' + c.http.host + ':' + c.http.port);
    return 0;
  }
  console.log('config: ok (' + (result.config.configFile || 'built-in defaults') + ')');
  console.log('  data_root  ' + result.config.dataRoot);
  console.log('  endpoint   ' + result.config.http.host + ':' + result.config.http.port);
  console.log('  users      ' + result.config.paths.users);
  console.log('  audit      ' + result.config.paths.audit);
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = { VERSION, DEFAULTS, ROLE_NAMES, loadConfig, dataPaths, formatProblems, redacted, resolveUnder };
