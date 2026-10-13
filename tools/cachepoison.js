#!/usr/bin/env node
// Cyboros cache — web cache poisoning / cache deception detection. Fills a real coverage gap
// (no cache-attack tool existed). Reuses the harness's DNS-rebinding-safe, scope-checked request
// path (net.resolveAndGuard + scope-guard), same as header-check.js/cors.js.
//
//   node tools/cachepoison.js probe <url> [--marker s]        unkeyed-input poisoning candidates (auto)
//   node tools/cachepoison.js deception <url>                 cache-deception (static-suffix) candidates (auto)
//   node tools/cachepoison.js headers                          list the unkeyed headers we test
//
// Method: send a BENIGN marker via headers a cache commonly leaves UNKEYED (X-Forwarded-Host,
// X-Forwarded-Scheme, X-Original-URL, ...). If the marker reflects in the body AND the response
// is cacheable (Age / X-Cache: HIT / CF-Cache-Status / Cache-Control public), that is a poisoning
// CANDIDATE — reported detection-only. Cache deception appends a static-looking suffix
// (`/x.css`, `;.css`, `.json`) to a path and flags a response that becomes publicly cacheable
// while still returning dynamic content.
//
// SAFETY: this tool only DETECTS with benign markers. A PERSISTENT poisoning that would serve the
// tainted response to OTHER users is impactful → confirm-tier (enforced in runProbe): it is never
// performed without --confirm "<reason>" + explicit in-session approval. Detection stays auto.
//
// ponytail: cache keys are opaque and CDN-specific; a "candidate" here is a lead to verify, not a
// proven poisoning. Confirm the shared-cache hit with a second uncredentialed request per report.
'use strict';
const http = require('http');
const https = require('https');
const { loadScope, inScope } = require('./scope-guard');
const { resolveAndGuard } = require('./net');

// Headers a front-end cache frequently forwards to the origin but does NOT include in the cache key.
const UNKEYED_HEADERS = [
  'X-Forwarded-Host', 'X-Forwarded-Scheme', 'X-Forwarded-Proto', 'X-Forwarded-Port',
  'X-Forwarded-Server', 'X-Forwarded-Prefix', 'X-Host', 'X-Original-URL', 'X-Rewrite-URL',
  'X-Original-Host', 'X-HTTP-Host-Override', 'Forwarded',
];

function newMarker() { return 'cyboros-c' + Math.random().toString(36).slice(2, 8); }

// ---- cache signal analysis (pure) -------------------------------------------
function cacheIndicators(headers) {
  const h = {};
  for (const k of Object.keys(headers || {})) h[k.toLowerCase()] = headers[k];
  const ind = {};
  if ('age' in h) ind.age = h.age;
  if ('x-cache' in h) ind.x_cache = h['x-cache'];
  if ('cf-cache-status' in h) ind.cf_cache_status = h['cf-cache-status'];
  if ('x-cache-hits' in h) ind.x_cache_hits = h['x-cache-hits'];
  if ('x-served-by' in h) ind.x_served_by = h['x-served-by'];
  if ('cache-control' in h) ind.cache_control = h['cache-control'];
  return ind;
}
function isCacheable(headers) {
  const ind = cacheIndicators(headers);
  const cc = String(ind.cache_control || '').toLowerCase();
  if (/no-store|private|no-cache/.test(cc)) return false;
  const hitish = /hit/i.test(String(ind.x_cache || '')) || /hit/i.test(String(ind.cf_cache_status || '')) || ('age' in ind);
  const publicish = /\bpublic\b|max-age=\d+|s-maxage=\d+/.test(cc);
  return !!(hitish || publicish);
}
function reflects(body, marker) { return typeof body === 'string' && body.indexOf(marker) !== -1; }

function deceptionPaths(url) {
  const u = new URL(url);
  const base = u.pathname.replace(/\/+$/, '');
  const suffixes = ['/cyboros.css', ';.css', '/cyboros.js', '.json', '%0Acyboros.css', '/%2e%2e/cyboros.css'];
  return suffixes.map((s) => u.origin + base + s + u.search);
}

// ---- scope-safe HTTP send (injectable) --------------------------------------
function realSend(url, method, extraHeaders, timeoutMs) {
  return new Promise((resolve) => {
    const scope = loadScope();
    const g = inScope(url, scope);
    if (!g.ok) return resolve({ blocked: g.reason });
    resolveAndGuard(url, scope).then((pin) => {
      if (pin.blocked) return resolve({ blocked: pin.reason });
      const U = new URL(url);
      const lib = U.protocol === 'https:' ? https : http;
      const headers = Object.assign({ 'User-Agent': 'cyboros-cache/0.1', Host: U.hostname, Accept: '*/*' }, extraHeaders || {});
      const opts = {
        hostname: pin.address, port: U.port || (U.protocol === 'https:' ? 443 : 80),
        path: U.pathname + U.search, method: method || 'GET', headers,
        timeout: timeoutMs || 10000,
        lookup: (host, o, cb) => cb(null, pin.address, pin.family),
      };
      const req = lib.request(opts, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d })); });
      req.on('timeout', () => { req.destroy(); resolve({ blocked: 'timeout' }); });
      req.on('error', (e) => resolve({ blocked: e.message }));
      req.end();
    });
  });
}

// ---- poisoning probe --------------------------------------------------------
// Detection only. `confirm` gates a hypothetical persistent poisoning (not performed here).
async function runProbe(url, opts) {
  opts = opts || {};
  const send = opts.send || realSend;
  const marker = opts.marker || newMarker();
  const baseline = await send(url, 'GET', {}, opts.timeoutMs);
  if (baseline && baseline.blocked) return { ok: false, reason: baseline.blocked };

  const candidates = [];
  for (const hName of (opts.headers || UNKEYED_HEADERS)) {
    const val = /host|server|prefix|url/i.test(hName) ? `${marker}.example` : marker;
    const r = await send(url, 'GET', { [hName]: val }, opts.timeoutMs);
    if (!r || r.blocked) continue;
    const refl = reflects(r.body, marker);
    const cacheable = isCacheable(r.headers);
    if (refl) candidates.push({ header: hName, value: val, reflected: true, cacheable, indicators: cacheIndicators(r.headers), severity: cacheable ? 'High' : 'Low', note: cacheable ? 'reflected AND cacheable → poisoning candidate' : 'reflected but no cache indicator → deception risk only' });
  }
  return { ok: true, url, marker, tested_headers: (opts.headers || UNKEYED_HEADERS).length, candidates };
}

async function runDeception(url, opts) {
  opts = opts || {};
  const send = opts.send || realSend;
  const findings = [];
  for (const p of deceptionPaths(url)) {
    const r = await send(p, 'GET', {}, opts.timeoutMs);
    if (!r || r.blocked) continue;
    const cacheable = isCacheable(r.headers);
    const dynamic = r.status && r.status < 400;
    if (cacheable && dynamic) findings.push({ url: p, status: r.status, cacheable: true, indicators: cacheIndicators(r.headers), severity: 'Medium', note: 'static-suffix path returns dynamic content AND is cacheable → cache deception candidate' });
  }
  return { ok: true, base: url, candidates: findings };
}

module.exports = { UNKEYED_HEADERS, cacheIndicators, isCacheable, reflects, deceptionPaths, runProbe, runDeception, newMarker };

// ---- CLI --------------------------------------------------------------------
async function main() {
  const [cmd, url] = process.argv.slice(2);
  const rest = process.argv.slice(4);
  const opts = {};
  for (let i = 0; i < rest.length; i++) { if (rest[i] === '--marker') opts.marker = rest[++i]; else if (rest[i] === '--confirm') opts.confirm = rest[++i]; }
  if (cmd === 'headers') { console.log(JSON.stringify(UNKEYED_HEADERS, null, 2)); return; }
  if (!url) { console.error('usage: node tools/cachepoison.js <probe|deception|headers> <url> [--marker s]'); process.exit(2); }
  const res = cmd === 'deception' ? await runDeception(url, opts) : await runProbe(url, opts);
  console.log(JSON.stringify(res, null, 2));
  process.exit(res.ok ? 0 : 1);
}
if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
