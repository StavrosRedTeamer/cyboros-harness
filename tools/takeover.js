#!/usr/bin/env node
// Stavros takeover — subdomain takeover + DNS hygiene audit (P1.3, detection-only, read-only).
//
//   node tools/takeover.js scan <domain> [--subs <file>] [--resolver <ip>]    audit → reports/takeover-<domain>.json
//   node tools/takeover.js parse <records-file>                               offline verdicts from saved records
//
// What it does (single pass, stdlib only):
//   1. Subdomain collection: REUSES existing recon output only (reports/tmp/<host>/subs-*.txt or
//      --subs file). NO new massive resolution: the audit resolves at most the hosts recon already
//      surfaced, paced under max_requests_per_second (scope.json).
//   2. Per host: resolve CNAME/A → dangling verdicts:
//        - CNAME → provider placeholder with NXDOMAIN   (cnameCandidateProvider, no request sent)
//        - single GET body marker (NoSuchBucket, GitHub Pages 404, Azure default…)  (ONE request
//          per dangling candidate, via fingerprintBody) → verify_level 'suspected'; the claim-check
//          PoC (register the claimed resource) stays a MANUAL operator step — never automated.
//   3. DNS hygiene in the same pass: TXT _dmarc/SPF (p=none, +all lax policies), AXFR per NS
//      (should be refused), wildcard check. Classes: 'dns', 'email-auth'.
//
// Invariants: every hostname resolved belongs to the audited domain; no brute force, one AXFR
// attempt per NS, one fingerprint GET per candidate. Takeover findings go through record-finding.js
// (severity ceiling respected: suspected → Low max at the registry, provider severity kept as info).
'use strict';
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;

const WS = path.join(__dirname, '..');
const TMP_DIR = () => process.env.STAVROS_TMP_DIR || path.join(WS, 'reports', 'tmp');

// ---- takeover fingerprints (provider → body marker / CNAME shape) -------------
// Pure data + pure matchers: fully unit-testable offline. Sources: can-i-take-over-xyz public
// fingerprint list; only markers verifiable with a SINGLE GET.
const FINGERPRINTS = [
  { provider: 'aws-s3', re: /NoSuchBucket|The specified bucket does not exist/i, severity: 'High' },
  { provider: 'azure', re: /404 Web Site not found|<title>Microsoft Azure/i, severity: 'High' },
  { provider: 'github-pages', re: /There isn'?t a GitHub Pages site here/i, severity: 'High' },
  { provider: 'heroku', re: /herokudns\.com|No such app/i, severity: 'High' },
  { provider: 'cloudfront', re: /ERROR: The request could not be satisfied/i, severity: 'Medium' },
  { provider: 'shopify', re: /Sorry, this shop is currently unavailable/i, severity: 'Medium' },
  { provider: 'webflow', re: /The page you are looking for doesn't exist or has been moved/i, severity: 'Medium' },
  { provider: 'ghost', re: /The thing you were looking for is no longer here/i, severity: 'Medium' },
  { provider: 'tumblr', re: /Whatever you were looking for doesn't currently exist at this address/i, severity: 'Medium' },
  { provider: 'fastly', re: /Fastly error: unknown domain/i, severity: 'Medium' },
  { provider: 'netlify', re: /Not Found - Request ID/i, severity: 'Medium' },
  { provider: 'vercel', re: /The deployment could not be found|DEPLOYMENT_NOT_FOUND/i, severity: 'Medium' },
];
const NX_CNAMES = [
  { provider: 'aws-s3', re: /\.s3[.-][\w.-]*amazonaws\.com$/i },
  { provider: 'azure', re: /\.cloudapp\.azure\.com$|\.azurewebsites\.net$/i },
  { provider: 'github-pages', re: /\.github\.io$/i },
  { provider: 'heroku', re: /\.herokuapp\.com$|\.herokudns\.com$/i },
  { provider: 'cloudfront', re: /\.cloudfront\.net$/i },
  { provider: 'netlify', re: /\.netlify\.app$|\.netlify\.global\.ssl\.fastly\.net$/i },
  { provider: 'vercel', re: /\.vercel\.app$|\.cname\.vercel-dns\.com$/i },
  { provider: 'webflow', re: /\.proxy-ssl\.webflow\.com$/i },
  { provider: 'shopify', re: /shops\.myshopify\.com$/i },
  { provider: 'tumblr', re: /domains\.tumblr\.com$/i },
  { provider: 'ghost', re: /domains\.ghost\.io$/i },
  { provider: 'cargocollective', re: /cargocollective\.com$/i },
];

function fingerprintBody(body) {
  const t = String(body || '');
  if (!t) return null;
  for (const f of FINGERPRINTS) if (f.re.test(t)) return { provider: f.provider, severity: f.severity };
  return null;
}
function cnameCandidateProvider(cname) {
  for (const f of NX_CNAMES) if (f.re.test(String(cname || ''))) return f.provider;
  return null;
}

// ---- subdomain sources (reuse recon output; never re-discover) ----------------
function sanitizeHost(h) { return String(h || '').replace(/[^a-z0-9_.-]/gi, '_'); }
function defaultSubsFiles(domain) {
  const d = path.join(TMP_DIR(), sanitizeHost(domain));
  try { return fs.readdirSync(d).filter((f) => f.startsWith('subs-')).map((f) => path.join(d, f)); }
  catch { return []; }
}
function collectSubs(domain, opts) {
  const out = new Set([String(domain).toLowerCase()]);
  const files = opts && opts.subsFile ? [opts.subsFile] : defaultSubsFiles(domain);
  for (const f of files) {
    try {
      for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
        const h = line.trim().toLowerCase().replace(/^\*\./, '');
        if (!h) continue;
        if (h === domain || h.endsWith('.' + domain)) out.add(h);
      }
    } catch { /* missing file: fine, we still audit the apex */ }
  }
  return [...out];
}

// ---- DNS probes (injectable resolver for offline tests) -----------------------
function defaultResolver(resolverIp) {
  if (!resolverIp) return dns;
  const R = new dns.Resolver();
  R.setServers([String(resolverIp)]);
  return R;
}
function paceFromScope() {
  try {
    const scope = JSON.parse(fs.readFileSync(path.join(WS, 'scope.json'), 'utf8'));
    const rps = Number(scope.max_requests_per_second) || 1;
    return Math.max(50, Math.ceil(1000 / rps)); // ≤ scope rate; 50ms floor for resolver sanity
  } catch { return 1000; }
}

// One record per sub; every DNS failure lands in the record (never throws).
// Dangling semantics: a CNAME whose FINAL TARGET no longer resolves is the takeover signal;
// a host that is entirely absent (no CNAME, NXDOMAIN) is just a dead record, not a finding.
async function resolveHosts(subs, opts) {
  opts = opts || {};
  const R = opts.resolverLib || defaultResolver(opts.resolver);
  const paceMs = opts.paceMs != null ? opts.paceMs : paceFromScope();
  const isNx = (e) => e && /ENOTFOUND|ENODATA/.test(String(e.code || e.message));
  const out = [];
  for (const h of subs) {
    const rec = { host: h, cname: null, ips: [], nxdomain: false, error: null };
    try {
      const cn = await R.resolveCname(h);
      if (cn && cn.length) rec.cname = cn[cn.length - 1]; // last element = final target
    } catch (e) {
      if (isNx(e)) rec.nxdomain = true; // host itself absent (no CNAME)
      else rec.error = e.message;
    }
    if (rec.cname) {
      // The CNAME exists: does the FINAL TARGET still resolve?
      try { rec.ips = (await R.resolve4(rec.cname)) || []; }
      catch (e) { if (isNx(e)) rec.nxdomain = true; else if (!rec.error) rec.error = e.message; }
    } else if (!rec.nxdomain) {
      try { rec.ips = (await R.resolve4(h)) || []; }
      catch (e) { if (isNx(e)) rec.nxdomain = true; }
    }
    out.push(rec);
    if (paceMs > 0) await new Promise((r) => setTimeout(r, paceMs));
  }
  return out;
}

// ---- hygiene checks (TXT/SPF/DMARC + AXFR + wildcard) --------------------------
function laxSpfPolicy(txtRecords) {
  for (const raw of txtRecords || []) {
    const t = String(raw || '').trim();
    if (!/^v=spf1/i.test(t)) continue;
    if (/\+all$/i.test(t)) return t;                 // explicit +all: everyone may send
  }
  return null;
}
function noneDmarcPolicy(txtRecords) {
  for (const raw of txtRecords || []) {
    const t = String(raw || '').trim();
    if (/^v=DMARC1/i.test(t) && /p=none/i.test(t)) return t;
  }
  return null;
}

// AXFR via dig (stdlib has no zone transfer): ONE read-only attempt per NS. Injectable for tests.
function axfrProbe(domain, server) {
  const { execFile } = require('child_process');
  return new Promise((resolve) => {
    execFile('dig', ['@' + server, domain, 'axfr', '+short', '+time=3', '+tries=1'],
      { timeout: 8000 }, (err, stdout) => {
        if (err) return resolve({ server, transferred: false, records: 0, reason: 'refused-or-error' });
        const lines = String(stdout || '').split('\n').filter((l) => l.trim());
        resolve({ server, transferred: lines.length > 5, records: Math.min(lines.length, 200), reason: lines.length > 5 ? 'AXFR ALLOWED' : 'refused' });
      });
  });
}

async function hygiene(domain, opts) {
  opts = opts || {};
  const R = opts.resolverLib || defaultResolver(opts.resolver);
  const out = { dmarc: null, spf: null, spf_lax: null, axfr: [] };
  try { out.spf = ((await R.resolveTxt(domain)).flat() || []).find((t) => /^v=spf1/i.test(t)) || null; } catch { /* no SPF */ }
  try { out.dmarc = ((await R.resolveTxt('_dmarc.' + domain)).flat() || []).find((t) => /^v=DMARC1/i.test(t)) || null; } catch { /* no DMARC */ }
  out.spf_lax = out.spf ? laxSpfPolicy([out.spf]) : null;
  try {
    const ns = (await R.resolveNs(domain)) || [];
    for (const server of ns.slice(0, 5)) {
      out.axfr.push(opts.axfrProbe ? await opts.axfrProbe(domain, server) : await axfrProbe(domain, server));
    }
  } catch { /* no NS resolvable */ }
  return out;
}

// Wildcard check: resolve a high-entropy label; an answer means a wildcard zone is configured
// (dangling-host claims on wildcard zones need extra care — auto-flag it for the operator).
async function wildcardCheck(domain, opts) {
  const R = (opts && opts.resolverLib) || defaultResolver(opts && opts.resolver);
  const probe = 'stavros-wildcard-' + Math.random().toString(36).slice(2, 10) + '.' + domain;
  try {
    const a = await R.resolve4(probe);
    return (a && a.length) ? { wildcard: true, sample: a[0] } : { wildcard: false };
  } catch { return { wildcard: false }; }
}

// ---- single fingerprint GET per dangling candidate (injectable) ----------------
function httpProbe(url, timeoutMs) {
  const http = require('http');
  const https = require('https');
  return new Promise((resolve) => {
    const U = new URL(url);
    const mod = U.protocol === 'https:' ? https : http;
    const req = mod.request({ hostname: U.hostname, port: U.port || (U.protocol === 'https:' ? 443 : 80), path: '/', method: 'GET', headers: { 'User-Agent': 'stavros-takeover/0.1' }, timeout: timeoutMs || 6000 }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c.length > 4096 ? '' : c; });
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.end();
  });
}

// ---- verdict assembly (pure) ---------------------------------------------------
// rec = {host, cname, ips, nxdomain} (+ optional body probe result in rec.http).
function verdictFor(rec) {
  if (rec.cname && rec.nxdomain) {
    const provider = cnameCandidateProvider(rec.cname);
    return { class: 'takeover', verify_level: 'suspected', severity: provider ? 'High' : 'Medium', provider: provider || 'unknown', reason: `CNAME ${rec.cname} → NXDOMAIN (dangling)` };
  }
  if (rec.http && rec.http.status) {
    const fp = fingerprintBody(rec.http.body);
    if (fp) return { class: 'takeover', verify_level: 'suspected', severity: fp.severity, provider: fp.provider, reason: `HTTP ${rec.http.status} body matches ${fp.provider} placeholder` };
  }
  return null;
}

function findingsFromScan(domain, records, hygieneOut, wildcardOut) {
  const findings = [];
  for (const rec of records) {
    const v = verdictFor(rec);
    if (v) findings.push({ host: rec.host, ...v, evidence: { cname: rec.cname, http_status: rec.http && rec.http.status } });
  }
  const h = hygieneOut || {};
  if (h.spf_lax) findings.push({ host: domain, class: 'email-auth', verify_level: 'confirmed', severity: 'Low', reason: `SPF permissivo (+all): ${h.spf_lax}`, evidence: { txt: h.spf_lax } });
  if (h.dmarc && /p=none/i.test(h.dmarc)) findings.push({ host: domain, class: 'email-auth', verify_level: 'confirmed', severity: 'Low', reason: 'DMARC p=none (nessuna enforcement)', evidence: { txt: h.dmarc } });
  if (!h.dmarc) findings.push({ host: domain, class: 'email-auth', verify_level: 'confirmed', severity: 'Info', reason: 'DMARC assente', evidence: { txt: null } });
  for (const ax of (h.axfr || []).filter((a) => a.transferred)) {
    findings.push({ host: ax.server, class: 'dns', verify_level: 'confirmed', severity: 'High', reason: `AXFR consentito su ${ax.server} (${ax.records} record)`, evidence: { server: ax.server } });
  }
  if (wildcardOut && wildcardOut.wildcard) {
    findings.push({ host: domain, class: 'dns', verify_level: 'confirmed', severity: 'Info', reason: `wildcard DNS attivo (${wildcardOut.sample})`, evidence: { sample: wildcardOut.sample } });
  }
  return findings;
}

// ---- record findings (record-finding.js; takeover class only, best-effort) -----
function recordFindings(domain, findings) {
  let rf;
  try { rf = require('./record-finding'); } catch { return { recorded: 0, reason: 'record-finding unavailable' }; }
  let n = 0;
  for (const f of findings) {
    const res = rf.record(JSON.stringify({
      title: `${f.class === 'takeover' ? 'Subdomain takeover (suspected)' : f.class === 'email-auth' ? 'DNS/email-auth hygiene' : 'DNS hygiene'}: ${f.reason}`.slice(0, 160),
      host: f.host, endpoint: f.host, class: f.class,
      severity: 'Low', verify_level: 'suspected', status: 'suspected',
      cwe: 'CWE-350',
      poc: f.evidence && f.evidence.cname ? `CNAME → ${f.evidence.cname}` : JSON.stringify(f.evidence),
      technique: 'T1583/T1594',
      remediation: f.class === 'takeover'
        ? 'Rimuovere il record DNS pendente o ripristinare la risorsa sul provider (claim-check PoC = passo manuale dell\'operatore).'
        : 'Rafforzare SPF/DMARC (p=quarantine/reject) e rifiutare AXFR verso resolver non autorizzati.',
      notes: 'tools/takeover.js (detection-only, single-request verify).',
    }));
    if (res && res.ok) n++;
  }
  return { recorded: n };
}

// ---- scan ----------------------------------------------------------------------
async function scan(domain, opts) {
  opts = opts || {};
  const subs = collectSubs(domain, opts);
  const records = await resolveHosts(subs, opts);
  // ONE fingerprint GET per CNAME candidate that still resolves (never for plain A records).
  for (const rec of records) {
    if (rec.cname && !rec.nxdomain) {
      const host = rec.host;
      rec.http = opts.httpProbe
        ? await opts.httpProbe(`http://${host}/`, opts.timeoutMs)
        : await httpProbe(`http://${host}/`, opts.timeoutMs);
    }
  }
  const h = await hygiene(domain, opts);
  const wild = await wildcardCheck(domain, opts);
  const findings = findingsFromScan(domain, records, h, wild);
  const report = {
    domain, generated_at: new Date().toISOString(), subs_audited: subs.length,
    sources: opts.subsFile ? [opts.subsFile] : defaultSubsFiles(domain).map((p) => path.basename(p)),
    findings, hygiene: { dmarc: h.dmarc, spf: h.spf, spf_lax: h.spf_lax, axfr: h.axfr, wildcard: wild },
  };
  const outDir = process.env.STAVROS_REPORTS_DIR || path.join(WS, 'reports');
  try {
    fs.mkdirSync(outDir, { recursive: true });
    const f = path.join(outDir, `takeover-${sanitizeHost(domain)}.json`);
    fs.writeFileSync(f, JSON.stringify(report, null, 2));
    report._file = f;
  } catch { /* non-fatal */ }
  const rec = opts.record === false
    ? { recorded: 0 }
    : recordFindings(domain, findings.filter((f) => f.class === 'takeover'));
  return { ...report, recorded: rec.recorded };
}

// ---- CLI -----------------------------------------------------------------------
async function main() {
  const [cmd, arg] = process.argv.slice(2);
  const get = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
  if (cmd === 'scan' && arg) {
    const res = await scan(arg, { subsFile: get('--subs'), resolver: get('--resolver') });
    console.log(JSON.stringify(res, null, 2));
    process.exit(0);
  }
  if (cmd === 'parse' && arg) {
    // Offline verdicts from a saved records file (resolveHosts output shape).
    const recs = JSON.parse(fs.readFileSync(arg, 'utf8'));
    console.log(JSON.stringify(recs.map(verdictFor).filter(Boolean), null, 2));
    process.exit(0);
  }
  console.error('usage: node tools/takeover.js scan <domain> [--subs <file>] [--resolver <ip>] | parse <records.json>');
  process.exit(2);
}
if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });

module.exports = {
  FINGERPRINTS, NX_CNAMES, fingerprintBody, cnameCandidateProvider, collectSubs,
  resolveHosts, hygiene, wildcardCheck, verdictFor, findingsFromScan, laxSpfPolicy, noneDmarcPolicy, scan,
};
