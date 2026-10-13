#!/usr/bin/env node
// Captive-portal recon + bypass-surface analysis (READ-ONLY, zero-dep, deterministic).
//
//   node tools/portal.js probe <url> [--json] [--no-follow] [--timeout <ms>]
//   node tools/portal.js analyze <url> [--json] [--record] [--no-follow] [--timeout <ms>]
//
// Captive portals are HTTP, so scope is the ordinary scope.json (IP/host) enforced by
// scope-guard.js — NOT the BSSID/ESSID model of wifi.js. Every request is scope-checked and
// DNS-pinned (net.js resolveAndGuard, anti-rebinding) before it is sent, and each redirect hop
// is re-checked.
//
//   probe   — fingerprint the controller/appliance (Cisco, Aruba, MikroTik, pfSense, UniFi,
//             openNDS, Fortinet, ...) and decide whether the page IS a captive portal.
//   analyze — parse the portal's forms/params and flag the classic ways a portal grants access
//             without a real credential: a client-supplied MAC, redirect-parameter tampering,
//             cleartext credentials, cross-host form actions, replayable tokens.
//
// Nothing here exploits anything: it only reads the portal and reports candidate surfaces for a
// follow-up (repeater.js / spray.js) that stays behind the same scope-guard + confirm-tier gates.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { loadScope, inScope, hostOf } = require('./scope-guard');
const { resolveAndGuard } = require('./net');

const UA = 'cyboros-portal/0.1';

// ---------------------------------------------------------------------------
// HTML helpers (pure)
// ---------------------------------------------------------------------------

function titleOf(html) {
  const m = String(html == null ? '' : html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

// Parse the attributes of a single tag body: name=value pairs, values quoted or bare.
function parseAttrs(s) {
  const out = {};
  const re = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let m;
  while ((m = re.exec(String(s == null ? '' : s)))) {
    out[m[1].toLowerCase()] = m[2] != null ? m[2] : m[3] != null ? m[3] : m[4];
  }
  return out;
}

// Extract every form and its named fields (input/select/button/textarea).
function parseForms(html) {
  const forms = [];
  const body = String(html == null ? '' : html);
  const fre = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  let m;
  while ((m = fre.exec(body))) {
    const attrs = parseAttrs(m[1]);
    const fields = [];
    const ifre = /<(input|select|button|textarea)\b([^>]*)>/gi;
    let im;
    while ((im = ifre.exec(m[2]))) {
      const a = parseAttrs(im[2]);
      if (!a.name) continue;
      const type = (a.type || '').toLowerCase() || (im[1].toLowerCase() === 'input' ? 'text' : im[1].toLowerCase());
      fields.push({
        tag: im[1].toLowerCase(),
        name: a.name,
        type,
        value: a.value != null ? a.value : null,
        hidden: type === 'hidden',
      });
    }
    forms.push({
      action: attrs.action || null,
      method: (attrs.method || 'get').toLowerCase(),
      fields,
    });
  }
  return forms;
}

function headerVal(headers, name) {
  const h = headers || {};
  const v = h[String(name).toLowerCase()];
  if (Array.isArray(v)) return v[0];
  return v == null ? null : String(v);
}

function resolveLocation(base, loc) {
  try { return new URL(loc, base).toString(); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Controller / appliance fingerprints (public banners + redirect/body markers)
// ---------------------------------------------------------------------------

const CONTROLLERS = [
  { id: 'cisco-wlc', name: 'Cisco WLC / AireOS', re: /cisco|aireos|webui\/login|cisco ?systems/i },
  { id: 'cisco-meraki', name: 'Cisco Meraki', re: /meraki|splash\.meraki/i },
  { id: 'aruba', name: 'Aruba / ClearPass', re: /aruba|clearpass|securelogin\.arubanetworks/i },
  { id: 'unifi', name: 'Ubiquiti UniFi', re: /unifi|ubiquiti|guest\/portal|unifi\.com/i },
  { id: 'mikrotik', name: 'MikroTik Hotspot (RouterOS)', re: /mikrotik|routeros|login\?dst=|\/hotspot\//i },
  { id: 'opennds', name: 'OpenWrt openNDS / Nodogsplash', re: /opennds|nodogsplash|\/fas\/|splash\.html/i },
  { id: 'pfsense', name: 'pfSense Captive Portal', re: /pfsense|netgate|:8002/i },
  { id: 'coovachilli', name: 'CoovaChilli / Chillispot', re: /coova|chilli|chillispot/i },
  { id: 'fortinet', name: 'Fortinet FortiGate', re: /fortinet|fortigate|fgtauth/i },
  { id: 'sophos', name: 'Sophos / Astaro UTM', re: /sophos|astaro|\butm\b/i },
  { id: 'ruckus', name: 'Ruckus / CommScope SmartZone', re: /ruckus|commscope|smartzone|zonedirector/i },
  { id: 'extreme', name: 'Extreme / Aerohive', re: /aerohive|extreme ?networks|hiveap|idmanager/i },
  { id: 'nomadix', name: 'Nomadix / Guest-Tek', re: /nomadix|guest-?tek/i },
  { id: 'huawei', name: 'Huawei / ZTE portal', re: /huawei|zte|access\.html\?/i },
  { id: 'zyxel', name: 'Zyxel / TP-Link Omada', re: /zyxel|tp-?link|omada/i },
  { id: 'generic-portal', name: 'Generic captive portal', re: /captive|portal|splash|hotspot|web-?auth|access.?code|sign.?in|guest/i },
];

// Pure: fingerprint from response headers (medium confidence) or body markers (low confidence).
function fingerprint(page) {
  page = page || {};
  const h = page.headers || {};
  const headerText = [h.server, h['x-powered-by'], h['www-authenticate'], h.location, h['set-cookie'], h['x-redirect-by']]
    .filter(Boolean).join('\n');
  const body = String(page.body || '');
  const hits = [];
  for (const c of CONTROLLERS) {
    const inHeaders = c.re.test(headerText);
    const inBody = !inHeaders && c.re.test(body);
    if (inHeaders || inBody) hits.push({ id: c.id, name: c.name, confidence: inHeaders ? 'medium' : 'low' });
  }
  return {
    controllers: hits,
    server: headerVal(h, 'server'),
    powered_by: headerVal(h, 'x-powered-by'),
    www_authenticate: headerVal(h, 'www-authenticate'),
    title: titleOf(body),
    tls: page.url ? /^https:/i.test(page.url) : null,
  };
}

// Pure: does this page look like a captive portal?
function portalLikely(page) {
  page = page || {};
  const h = page.headers || {};
  const body = String(page.body || '');
  const reasons = [];
  if (headerVal(h, 'www-authenticate')) reasons.push('WWW-Authenticate header (proxy / web-auth challenge)');
  if (/connectivitycheck|captive|portal|splash|hotspot|web-?auth|sign.?in|guest/i.test(body))
    reasons.push('portal/sign-in markers in the page body');
  const forms = parseForms(body);
  if (forms.some((f) => f.fields.some((x) => x.type === 'password'))) reasons.push('login form with a password field');
  if (/portal|splash|guest|hotspot|web-?auth|captive/i.test(String(h.location || '')))
    reasons.push('redirect to a portal-looking path');
  return { likely: reasons.length > 0, reasons };
}

// ---------------------------------------------------------------------------
// Bypass-surface analysis (pure)
// ---------------------------------------------------------------------------

const RE_REDIRECT = /^(?:redirect(?:_?url)?|url|dst|dest|destination|target|continue|next|return(?:_?to|_?url)?|goto|go|r|u|link|out|to|forward|back|redir)$/i;
const RE_MAC = /^(?:mac|client_?mac|station|mac_?addr(?:ess)?|device_?mac|hwaddr|wlan|client_?id|device_?id|ap_?mac|bssid|ip)$/i;
const RE_TOKEN = /(?:token|csrf|xsrf|authenticity|session|nonce|state|ticket|sid|seed|signature|sig)$/i;
const RE_IDENTITY = /^(?:username|user|email|login|password|pass|passwd|pwd|access_?code|code|pin|voucher|room|last_?name)$/i;

// Pure: bucket parameter names into the surfaces a portal is usually attacked through.
function classifyParams(names) {
  const out = { redirect: [], mac: [], token: [], identity: [] };
  const seen = { redirect: new Set(), mac: new Set(), token: new Set(), identity: new Set() };
  for (const raw of names || []) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) continue;
    if (RE_REDIRECT.test(s) && !seen.redirect.has(s)) { seen.redirect.add(s); out.redirect.push(s); }
    if (RE_MAC.test(s) && !seen.mac.has(s)) { seen.mac.add(s); out.mac.push(s); }
    if (RE_IDENTITY.test(s) && !seen.identity.has(s)) { seen.identity.add(s); out.identity.push(s); }
    if (RE_TOKEN.test(s) && !seen.token.has(s)) { seen.token.add(s); out.token.push(s); }
  }
  return out;
}

function collectParamNames(url, forms) {
  const names = new Set();
  try { for (const k of new URL(url).searchParams.keys()) names.add(k); } catch {}
  for (const f of forms || []) for (const x of f.fields || []) if (x.name) names.add(x.name);
  return [...names];
}

function actionHost(action, base) {
  try { return new URL(action, base).hostname.toLowerCase(); } catch { return null; }
}

// Pure: forms + params + the ranked bypass surfaces (record-finding-ready).
function analyzePage(page, url) {
  page = page || {};
  const body = String(page.body || '');
  const forms = parseForms(body);
  const params = classifyParams(collectParamNames(url, forms));
  const surfaces = [];

  for (const n of params.redirect)
    surfaces.push({ severity: 'medium', class: 'redirect', cwe: 'CWE-601', issue: `Redirect parameter '${n}' exposed — open-redirect / post-auth redirect tampering`, evidence: n });
  for (const n of params.mac)
    surfaces.push({ severity: 'medium', class: 'authz', cwe: 'CWE-639', issue: `Client-supplied MAC/identity parameter '${n}' — MAC-based authorization bypass / spoofing candidate`, evidence: n });
  for (const n of params.token)
    surfaces.push({ severity: 'info', class: 'session', cwe: 'CWE-294', issue: `Token/nonce parameter '${n}' — capture and test for cross-session replay`, evidence: n });

  const pageHost = hostOf(url);
  const hasPw = forms.some((f) => (f.fields || []).some((x) => x.type === 'password'));
  if (/^http:/i.test(String(url)) && hasPw)
    surfaces.push({ severity: 'medium', class: 'authn', cwe: 'CWE-319', issue: 'Password field submitted over cleartext HTTP (no TLS)', evidence: url });

  for (const f of forms) {
    const ah = f.action ? actionHost(f.action, url) : null;
    if (ah && pageHost && ah !== pageHost)
      surfaces.push({ severity: 'medium', class: 'redirect', cwe: 'CWE-601', issue: `Form action posts to a different host (${ah}) — credential-exfil / open-redirect surface`, evidence: f.action });
  }

  return { forms, params, surfaces };
}

const SEV_RANK = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
function topSurface(surfaces) {
  return (surfaces || [])
    .filter((s) => s.severity !== 'info')
    .sort((a, b) => (SEV_RANK[b.severity] || 0) - (SEV_RANK[a.severity] || 0))[0] || null;
}

// Pure: the record-finding.js payload for the worst non-info surface of an analyze() result.
// Returns null when there is nothing to record (so the CLI can report recorded:false).
function recordPayload(out, srcUrl) {
  const top = topSurface(out && out.surfaces);
  if (!out || !out.ok || !top) return null;
  const target = out.final_url || srcUrl;
  let u = null;
  try { u = new URL(target); } catch {}
  return {
    severity: top.severity.charAt(0).toUpperCase() + top.severity.slice(1),
    title: `Captive portal: ${top.issue}`,
    host: u ? u.hostname : target,
    endpoint: u ? u.pathname + u.search : '',
    class: top.class,
    cwe: top.cwe,
    cvss: 5.3,
    cvss_vector: 'AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:L/A:N',
    poc: `node tools/portal.js analyze ${target} --json`,
    remediation: 'Do not trust client-supplied identity/MAC or redirect parameters: bind authorization server-side to the authenticated session, validate redirect targets against an allowlist, and serve the portal over HTTPS.',
    notes: 'Ran via tools/portal.js (read-only analysis) — full surface list at stdout.',
  };
}

// ---------------------------------------------------------------------------
// HTTP (scope-guarded + DNS-pinned; injectable for offline tests)
// ---------------------------------------------------------------------------

function normalizePage(r) {
  const headers = {};
  const src = (r && r.headers) || {};
  for (const k of Object.keys(src)) headers[String(k).toLowerCase()] = src[k];
  return { status: (r && r.status) || 0, headers, body: r && r.body != null ? String(r.body) : '' };
}

function rawGet(url, address, family, timeoutMs) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: address,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers: { 'User-Agent': UA, Host: u.hostname, Accept: 'text/html,*/*' },
      timeout: timeoutMs,
      lookup: (host, o, cb) => cb(null, address, family),
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, headers: {}, body: '', error: 'timeout' }); });
    req.on('error', (e) => resolve({ status: 0, headers: {}, body: '', error: e.message }));
    req.end();
  });
}

// ctx.fetch (tests) -> (url) => { status, headers, body }; otherwise the real pinned GET.
async function fetchPage(url, ctx) {
  if (ctx && typeof ctx.fetch === 'function') return normalizePage(await ctx.fetch(url));
  const scope = (ctx && ctx.scope) || loadScope();
  const pin = await resolveAndGuard(url, scope);
  if (pin.blocked) return { status: 0, headers: {}, body: '', error: pin.reason, blocked: true };
  const r = await rawGet(url, pin.address, pin.family, (ctx && ctx.timeoutMs) || 10000);
  return Object.assign({ headers: {}, body: '' }, r);
}

// Follow redirects (bounded), re-checking scope on EVERY hop. Returns { chain, final } | { blocked }.
async function fetchChain(url, ctx, maxHops) {
  const scope = (ctx && ctx.scope) || loadScope();
  const chain = [];
  let current = url;
  let final = null;
  for (let i = 0; i < maxHops; i++) {
    const g = inScope(current, scope);
    if (!g.ok) return { blocked: true, reason: g.reason, chain };
    const p = await fetchPage(current, ctx);
    if (p.blocked) return { blocked: true, reason: p.error, chain };
    const loc = headerVal(p.headers, 'location');
    chain.push({ url: current, status: p.status, location: loc || null });
    final = { url: current, status: p.status, headers: p.headers, body: p.body };
    if (p.status >= 300 && p.status < 400 && loc) {
      const next = resolveLocation(current, loc);
      if (!next) break;
      current = next;
      continue;
    }
    break;
  }
  return { chain, final };
}

function safeScope() {
  try { return loadScope(); } catch { return null; }
}

// G1: a scope block on a private gateway is the #1 false start for a captive-portal run — the
// portal usually lives on an RFC1918 address, so it must be allowlisted explicitly. The guard
// stays fail-closed (no --allow-gateway bypass); we only make the refusal actionable.
function scopeHint(url) {
  const host = hostOf(url);
  if (!host) return 'Add the target host/IP to scope.json (allowed_hosts / allowed_ips), then retry.';
  return `"${host}" is not in scope.json. If this is an authorized private gateway, add its IP/CIDR to `
    + 'allowed_ips (e.g. "192.168.1.0/24") — or its hostname to allowed_hosts — then retry. '
    + 'Scope is fail-closed: nothing is probed until it is allowlisted.';
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function probe(url, ctx) {
  ctx = ctx || {};
  const scope = ctx.scope || safeScope();
  const gate = inScope(url, scope);
  if (!gate.ok) return { ok: false, blocked: true, reason: gate.reason, next_step: scopeHint(url), target: url };
  const maxHops = ctx.follow === false ? 1 : 4;
  const r = await fetchChain(url, Object.assign({}, ctx, { scope }), maxHops);
  if (r.blocked) return { ok: false, blocked: true, reason: r.reason, next_step: scopeHint(url), target: url, chain: r.chain };
  const page = r.final;
  const fp = fingerprint(page);
  const pl = portalLikely(page);
  return {
    ok: true,
    detection_only: true,
    target: url,
    status: page.status,
    final_url: page.url,
    redirect_chain: r.chain,
    portal_likely: pl.likely,
    portal_signals: pl.reasons,
    fingerprint: fp,
    next_step: pl.likely
      ? 'Portal detected: run "node tools/portal.js analyze <final_url>" to map forms/params and bypass surfaces.'
      : 'No portal signals on this page — capture the redirect that the network issues (e.g. http://<gateway>/ ) and probe that URL.',
  };
}

async function analyze(url, ctx) {
  ctx = ctx || {};
  const scope = ctx.scope || safeScope();
  const gate = inScope(url, scope);
  if (!gate.ok) return { ok: false, blocked: true, reason: gate.reason, next_step: scopeHint(url), target: url };
  const maxHops = ctx.follow === false ? 1 : 4;
  const r = await fetchChain(url, Object.assign({}, ctx, { scope }), maxHops);
  if (r.blocked) return { ok: false, blocked: true, reason: r.reason, next_step: scopeHint(url), target: url, chain: r.chain };
  const page = r.final;
  const a = analyzePage(page, page.url);
  const fp = fingerprint(page);
  return {
    ok: true,
    detection_only: true,
    target: url,
    final_url: page.url,
    status: page.status,
    tls: /^https:/i.test(String(page.url)),
    fingerprint: fp,
    forms: a.forms,
    params: a.params,
    surfaces: a.surfaces,
    next_step: a.surfaces.length
      ? 'Test each surface with repeater.js (same scope-guard + confirm-tier); record candidates via record-finding.js with verify_level suspected until reproduced.'
      : 'No obvious bypass surface in the markup — enumerate the gateway/controller directly and look for its management interface.',
  };
}

// ---------------------------------------------------------------------------
// serve — awareness/lab captive portal
//
// Hosting a portal that real devices will submit credentials to is confirm-tier: the CLI
// REFUSES to start without an explicit --confirm "<reason>". Collection is a SECOND, explicit
// opt-in (--collect): without it the submission is recorded but secret-looking fields are
// redacted, so an awareness run still counts attempts without harvesting the secret.
// ---------------------------------------------------------------------------

const DEFAULT_PORTAL_HTML = [
  '<!doctype html><html><head><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Wi-Fi Access</title></head>',
  '<body style="font-family:sans-serif;max-width:26rem;margin:8vh auto;padding:1rem">',
  '<h1>Wi-Fi access</h1><p>Sign in to continue to the internet.</p>',
  '<form method="post" action="/">',
  '<label>Username or email<br><input name="username" autocomplete="username"></label><br><br>',
  '<label>Access code / password<br><input name="password" type="password" autocomplete="current-password"></label><br><br>',
  '<button type="submit">Connect</button>',
  '</form></body></html>',
].join('\n');

function portalHtml(dir) {
  if (dir) {
    try { return fs.readFileSync(path.join(dir, 'index.html'), 'utf8'); } catch {}
  }
  return DEFAULT_PORTAL_HTML;
}

// Pure: turn a urlencoded POST body into a capture record. Field VALUES are kept only when
// opts.collect is set; otherwise secret-looking fields are redacted.
function handleSubmission(rawBody, opts) {
  opts = opts || {};
  const params = new URLSearchParams(String(rawBody == null ? '' : rawBody));
  const names = [];
  const fields = {};
  for (const [k, v] of params) {
    names.push(k);
    fields[k] = (opts.collect || !/pass|pwd|pin|secret|code/i.test(k)) ? v : '<redacted>';
  }
  return { names, fields, captured: !!opts.collect };
}

function serve(dir, opts) {
  opts = opts || {};
  // Port 0 is meaningful: ask the OS for an ephemeral port (used by the loopback test). Any other
  // absent value defaults to 80; an out-of-range/invalid value fails loudly instead of silently.
  const rawPort = opts.port;
  const port = rawPort === undefined || rawPort === null || rawPort === '' ? 80 : Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('invalid port: ' + rawPort);
  const capturesFile = opts.capturesFile || path.join(__dirname, '..', 'reports', 'tmp', 'portal-captures.jsonl');
  const server = http.createServer((req, res) => {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
      req.on('end', () => {
        const rec = Object.assign(
          { ts: new Date().toISOString(), remote: (req.socket && req.socket.remoteAddress) || null, path: req.url },
          handleSubmission(body, opts),
        );
        try {
          fs.mkdirSync(path.dirname(capturesFile), { recursive: true });
          fs.appendFileSync(capturesFile, JSON.stringify(rec) + '\n');
        } catch {}
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><meta charset="utf-8"><title>Connected</title><h1>Connected</h1><p>You can close this page.</p>');
      });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(portalHtml(dir));
  });
  // Report the ACTUAL bound port (server.address()) so port 0 (ephemeral, used by tests) works.
  // opts.host is additive: the default stays "all interfaces" (real clients); tests bind loopback.
  return new Promise((resolve) => {
    const cb = () => resolve({ port: server.address().port, server, capturesFile });
    if (opts.host) server.listen(port, opts.host, cb);
    else server.listen(port, cb);
  });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage() {
  console.error('usage: node tools/portal.js probe <url> [--json] [--no-follow] [--timeout <ms>] | analyze <url> [--json] [--record] [--no-follow] [--timeout <ms>] | serve [<dir>] [--port <n>] [--collect] [--captures <file>] --confirm "<reason>"');
  process.exit(2);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const pos = [];
  const opts = { json: false, record: false, follow: true };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--record') opts.record = true;
    else if (a === '--no-follow') opts.follow = false;
    else if (a === '--timeout') opts.timeoutMs = Number(argv[++i]) || 10000;
    else if (a === '--port') opts.port = Number(argv[++i]) || 80;
    else if (a === '--captures') opts.capturesFile = argv[++i];
    else if (a === '--collect') opts.collect = true;
    else if (a === '--confirm') opts.confirm = argv[++i];
    else pos.push(a);
  }
  if (cmd !== 'probe' && cmd !== 'analyze' && cmd !== 'serve') usage();

  if (cmd === 'serve') {
    if (!opts.confirm || !String(opts.confirm).trim()) {
      console.error(JSON.stringify({ blocked: true, reason: 'portal hosting is confirm-tier: pass --confirm "<reason>" (authorized awareness engagement only)' }));
      process.exit(1);
    }
    const s = await serve(pos[0] || null, opts);
    console.error('portal: serving on 0.0.0.0:' + s.port + ' — captures -> ' + s.capturesFile +
      (opts.collect ? ' (COLLECT ON: credentials are stored in cleartext — handle per engagement rules and destroy after)' : ' (collect OFF: secret fields redacted)'));
    console.log(JSON.stringify({ ok: true, serving: true, port: s.port, collect: !!opts.collect, captures_file: s.capturesFile }));
    return; // keep the process (and the HTTP server) alive
  }
  if (!pos[0]) usage();

  const fn = cmd === 'probe' ? probe : analyze;
  const out = await fn(pos[0], opts);

  if (opts.record) {
    const payload = recordPayload(out, pos[0]);
    if (!payload) {
      console.log(JSON.stringify({ ok: true, recorded: false, reason: out.reason || 'no non-info surface found' }));
      process.exit(out.ok ? 0 : 1);
    }
    console.log(JSON.stringify(payload));
    process.exit(0);
  }

  console.log(JSON.stringify(out, null, opts.json ? 0 : 2));
  process.exit(out.ok ? 0 : 1);
}

if (require.main === module) main().catch((e) => { console.error(JSON.stringify({ error: String((e && e.message) || e) })); process.exit(2); });

module.exports = {
  probe, analyze, serve, recordPayload, scopeHint,
  parseAttrs, parseForms, titleOf, fingerprint, portalLikely,
  classifyParams, collectParamNames, analyzePage, topSurface,
  fetchChain, normalizePage, handleSubmission, portalHtml, DEFAULT_PORTAL_HTML, CONTROLLERS,
};
