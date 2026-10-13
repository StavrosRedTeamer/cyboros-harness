#!/usr/bin/env node
// Structured endpoint map — the deterministic handoff between mapper and testers.
// Instead of freeform markdown that weak models drift on, the mapper records every endpoint
// as validated JSON that testers can consume reliably.
//
//   node tools/map.js add '<json>'                    # add/update one endpoint
//   node tools/map.js show <host>                     # pretty-print the map
//   node tools/map.js candidates <host>               # flat candidate lists per vuln class
//   node tools/map.js count <host>                    # summary
//
// add payload: { "host":"api.x.com", "path":"/v1/Order/GetOrder", "method":"GET",
//                "params":["id"], "auth_required":true, "notes":"...",
//                "candidates": { "sqli":["id"], "xss":[], "idor":["id"], "ssrf":[], "other":[] } }
// Stored at reports/<host>-map.json. candidates keys are validated against the known classes.
const { env } = require('./env');
const fs = require('fs');
const path = require('path');

// Fallback taxonomy: used ONLY when test-registry.json is missing/corrupt, so the map keeps
// validating against a sane list instead of accepting anything.
const BASE_CLASSES = ['sqli', 'xss', 'idor', 'bola', 'bfla', 'authn', 'authz', 'ssrf', 'smuggling', 'llm', 'mcp', 'mobile', 'container', 'other'];

// Standards registry (REDflare-pattern, repo-vet plan QW7): stable per-class pointers to
// WSTG / ASVS / CWE / OWASP API Top 10. Loaded lazily so a missing/corrupt file degrades
// to "no refs" instead of breaking the map.
function loadRegistry() {
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(__dirname, 'test-registry.json'), 'utf8'));
    return reg && reg.classes ? reg.classes : {};
  } catch {
    return {};
  }
}

// G3: ONE source of truth — the accepted candidate classes ARE the test-registry classes, so a
// class emitted by a tool (e.g. portal.js's `redirect`/`session`, or the new `wireless`) is
// never rejected here. 'mobile'/'container' are added back because coverage.js tracks them as
// EXTRA_CLASSES (P1.4/M.4) but the registry does not list them. Falls back to BASE_CLASSES only
// when the registry file is unavailable.
const CLASSES = (() => {
  const fromRegistry = Object.keys(loadRegistry()).filter((k) => !k.startsWith('_'));
  const base = fromRegistry.length ? fromRegistry : BASE_CLASSES;
  return [...new Set(base.concat(['mobile', 'container']))];
})();
const REQUIRED = ['host', 'path'];

function refsFor(cls) {
  const r = loadRegistry()[cls];
  if (!r) return null;
  return { class: cls, wstg: r.wstg || [], asvs: r.asvs || [], cwe: r.cwe || [], owasp_api: r.owasp_api || [], owasp_llm: r.owasp_llm || [], owasp_agentic: r.owasp_agentic || [] };
}

// CYBOROS_MAP_DIR lets tests (and out-of-tree runs) avoid the live reports/ dir.
function mapFile(host) {
  return path.join(env('MAP_DIR') || path.join(__dirname, '..', 'reports'), host + '-map.json');
}

function load(host) {
  try {
    return JSON.parse(fs.readFileSync(mapFile(host), 'utf8'));
  } catch {
    return { host, endpoints: [] };
  }
}

function validate(entry) {
  for (const k of REQUIRED) if (!entry[k] || !String(entry[k]).trim()) return 'missing field: ' + k;
  if (entry.candidates) {
    for (const k of Object.keys(entry.candidates)) {
      if (!CLASSES.includes(k)) return 'unknown candidate class: ' + k + ' (use ' + CLASSES.join('/') + ')';
      if (!Array.isArray(entry.candidates[k])) return 'candidates.' + k + ' must be an array';
    }
  }
  return null;
}

function add(raw) {
  let e;
  try {
    e = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: 'invalid JSON: ' + err.message };
  }
  const err = validate(e);
  if (err) return { ok: false, error: err };
  const map = load(e.host);
  const key = (e.method || 'GET').toUpperCase() + ' ' + e.path;
  const i = map.endpoints.findIndex((x) => (x.method || 'GET').toUpperCase() + ' ' + x.path === key);
  if (i >= 0) map.endpoints[i] = e;
  else map.endpoints.push(e);
  try {
    fs.mkdirSync(path.dirname(mapFile(e.host)), { recursive: true });
    fs.writeFileSync(mapFile(e.host), JSON.stringify(map, null, 2));
  } catch (werr) {
    return { ok: false, error: 'cannot write map: ' + werr.message };
  }
  return { ok: true, host: e.host, endpoints: map.endpoints.length, action: i >= 0 ? 'updated' : 'added' };
}

function candidates(host) {
  const map = load(host);
  const out = {};
  for (const c of CLASSES) out[c] = [];
  for (const e of map.endpoints) {
    const method = (e.method || 'GET').toUpperCase();
    const cands = e.candidates || {};
    for (const c of CLASSES) {
      for (const p of cands[c] || []) out[c].push(method + ' ' + e.path + '  ?' + p + '=  (' + host + ')');
    }
    // endpoints with params but no explicit class get listed under 'other' for manual triage
    if ((e.params || []).length && !Object.keys(cands).length) {
      out.other.push(method + ' ' + e.path + '  params=' + e.params.join(',') + '  (untriaged)');
    }
  }
  // per-class methodology references (WSTG/ASVS/CWE/OWASP-API) for every class that has
  // candidates — testers read the standard before testing the class (REDflare pattern).
  const refs = {};
  for (const c of CLASSES) {
    if (!out[c].length) continue;
    const r = refsFor(c);
    if (r) refs[c] = r;
  }
  return { host, candidates: out, refs };
}

const [cmd, arg1, arg2] = process.argv.slice(2);
if (require.main === module) {
  if (cmd === 'add') {
    const r = add(arg1 || '');
    console.log(JSON.stringify(r));
    process.exit(r.ok ? 0 : 1);
  } else if (cmd === 'show') {
    console.log(JSON.stringify(load(arg1 || ''), null, 2));
  } else if (cmd === 'candidates') {
    console.log(JSON.stringify(candidates(arg1 || ''), null, 2));
  } else if (cmd === 'count') {
    const map = load(arg1 || '');
    console.log(JSON.stringify({ host: map.host, endpoints: map.endpoints.length }));
  } else {
    console.error('usage: node tools/map.js add|show|candidates|count ...');
    process.exit(2);
  }
}

module.exports = { add, validate, load, candidates, CLASSES, refsFor, loadRegistry };
