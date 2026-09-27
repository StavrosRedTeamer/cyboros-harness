#!/usr/bin/env node
// Offline self-check for tools/takeover.js (P1.3). NO network, NO dig, NO record-finding side
// effects: a fake resolverLib returns fixture DNS shapes, AXFR and HTTP probes are injected,
// and record-finding is bypassed via opts.record === false.
// Run: node tools/test-takeover.js
// test-tags: offline
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tk = require('./takeover');

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log(`  PASS ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}: ${e.message}`); }
}
async function okA(name, fn) {
  try { await fn(); pass++; console.log(`  PASS ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}: ${e.message}`); }
}

async function main() {
// ---- pure fingerprint matchers ------------------------------------------------
ok('fingerprintBody: S3 NoSuchBucket → aws-s3 High', () => {
  const f = tk.fingerprintBody('<html><head><title>Error</title></head><body><h1>NoSuchBucket</h1>The specified bucket does not exist</body></html>');
  assert.deepStrictEqual(f, { provider: 'aws-s3', severity: 'High' });
});
ok('fingerprintBody: GitHub Pages marker → github-pages', () => {
  assert.strictEqual(tk.fingerprintBody('There isn\'t a GitHub Pages site here.').provider, 'github-pages');
});
ok('fingerprintBody: azure default → azure', () => {
  assert.strictEqual(tk.fingerprintBody('404 Web Site not found.').provider, 'azure');
});
ok('fingerprintBody: normal body → null (no false positive)', () => {
  assert.strictEqual(tk.fingerprintBody('<html>Welcome to our corporate site</html>'), null);
});
ok('cnameCandidateProvider: heroku CNAME shape', () => {
  assert.strictEqual(tk.cnameCandidateProvider('dangling-1234.herokudns.com'), 'heroku');
  assert.strictEqual(tk.cnameCandidateProvider('app.herokuapp.com'), 'heroku');
});
ok('cnameCandidateProvider: unrelated CNAME → null', () => {
  assert.strictEqual(tk.cnameCandidateProvider('normal.example-cdn.com'), null);
});

// ---- subs collection (fixture file, offline) -----------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'takeover-test-'));
const subsFile = path.join(tmp, 'subs-www.acme.test.txt');
fs.writeFileSync(subsFile, [
  'www.acme.test', 'old.acme.test', 'dangling-body.acme.test', '*.acme.test', 'www.acme.test.evil.com',
  'unrelated.example', '',
].join('\n') + '\n');
ok('collectSubs: only same-domain hosts, wildcard stripped, evil domain excluded', () => {
  const subs = tk.collectSubs('acme.test', { subsFile });
  assert.ok(subs.includes('acme.test'));
  assert.ok(subs.includes('www.acme.test'));
  assert.ok(subs.includes('old.acme.test'));
  assert.ok(subs.includes('dangling-body.acme.test'));
  assert.ok(!subs.includes('www.acme.test.evil.com'), 'different domain excluded');
  assert.ok(!subs.includes('*.acme.test'), 'wildcard stripped/normalized');
  assert.ok(!subs.includes('unrelated.example'));
});

// ---- verdicts (pure) -----------------------------------------------------------
ok('verdictFor: CNAME resolves but TARGET is NXDOMAIN = takeover (dangling target)', () => {
  const v = tk.verdictFor({ host: 'old.acme.test', cname: 'x.s3.amazonaws.com', ips: [], nxdomain: true });
  assert.strictEqual(v.class, 'takeover');
  assert.strictEqual(v.verify_level, 'suspected');
  assert.strictEqual(v.provider, 'aws-s3');
  assert.strictEqual(v.severity, 'High');
});
ok('verdictFor: CNAME → NXDOMAIN unknown provider = Medium', () => {
  const v = tk.verdictFor({ host: 'x', cname: 'elsewhere.invalid.', ips: [], nxdomain: true });
  assert.strictEqual(v.severity, 'Medium');
  assert.strictEqual(v.provider, 'unknown');
});
ok('verdictFor: host fully absent (no CNAME, NXDOMAIN) is NOT a takeover', () => {
  assert.strictEqual(tk.verdictFor({ host: 'dead', cname: null, ips: [], nxdomain: true }), null);
});
ok('verdictFor: healthy host → null', () => {
  assert.strictEqual(tk.verdictFor({ host: 'www', cname: null, ips: ['93.184.216.34'], nxdomain: false }), null);
});
ok('verdictFor: CNAME resolves, target NXDOMAIN, then served body still fingerprints', () => {
  const v = tk.verdictFor({ host: 'ghost.example', cname: 'domains.ghost.io', ips: ['1.2.3.4'], nxdomain: false, http: { status: 404, body: 'The thing you were looking for is no longer here' } });
  assert.strictEqual(v.class, 'takeover');
  assert.strictEqual(v.provider, 'ghost');
  assert.strictEqual(v.severity, 'Medium');
});
ok('verdictFor: HTTP body fingerprint (provider placeholder still served)', () => {
  const v = tk.verdictFor({ host: 'ghost.example', cname: 'domains.ghost.io', ips: ['1.2.3.4'], nxdomain: false, http: { status: 404, body: 'The thing you were looking for is no longer here' } });
  assert.strictEqual(v.class, 'takeover');
  assert.strictEqual(v.provider, 'ghost');
  assert.strictEqual(v.severity, 'Medium');
});

// ---- hygiene policy parsing -----------------------------------------------------
ok('laxSpfPolicy: +all flagged, -all clean', () => {
  assert.strictEqual(tk.laxSpfPolicy(['v=spf1 ip4:1.2.3.4 +all']), 'v=spf1 ip4:1.2.3.4 +all');
  assert.strictEqual(tk.laxSpfPolicy(['v=spf1 ip4:1.2.3.4 -all']), null);
  assert.strictEqual(tk.laxSpfPolicy(['v=spf1 ~all']), null);
});
ok('noneDmarcPolicy: p=none flagged, p=reject clean', () => {
  assert.strictEqual(tk.noneDmarcPolicy(['v=DMARC1; p=none; rua=mailto:x@y.z']), 'v=DMARC1; p=none; rua=mailto:x@y.z');
  assert.strictEqual(tk.noneDmarcPolicy(['v=DMARC1; p=reject']), null);
});

// ---- fake resolver: dangling + healthy + NX --------------------------------------
const NX = { code: 'ENOTFOUND' };
const fakeResolver = {
  // CNAME: only dangling-body has one (→ heroku). old is NXDOMAIN; apex/www exist WITHOUT
  // a CNAME (a real resolver returns an empty list there, not an error).
  resolveCname: async (h) => {
    if (h === 'dangling-body.acme.test') return ['app.herokuapp.com'];
    if (h === 'old.acme.test') throw NX; // host does not exist at all
    return [];
  },
  resolve4: async (h) => {
    if (h === 'old.acme.test') throw NX;                  // host itself NXDOMAIN
    if (h === 'app.herokuapp.com') throw NX;                 // CNAME TARGET is gone → dangling
    if (h === 'dangling-body.acme.test') return [];       // host has no A of its own (CNAME only)
    if (h === 'acme.test') return ['93.184.216.34'];      // apex healthy
    return [];
  },
  resolveTxt: async (h) => {
    if (h === 'acme.test') return [['v=spf1 ip4:10.0.0.0/24 +all']];
    if (h === '_dmarc.acme.test') return [['v=DMARC1; p=none']];
    throw NX;
  },
  resolveNs: async () => ['ns1.acme.test', 'ns2.acme.test'],
};

await okA('resolveHosts: NX/CNAME/A shapes with zero pace (offline)', async () => {
  const recs = await tk.resolveHosts(['acme.test', 'old.acme.test', 'dangling-body.acme.test'], { resolverLib: fakeResolver, paceMs: 0 });
  assert.strictEqual(recs.length, 3);
  const old = recs.find((r) => r.host === 'old.acme.test');
  assert.strictEqual(old.nxdomain, true, 'host itself NXDOMAIN');
  assert.strictEqual(old.cname, null);
  const body = recs.find((r) => r.host === 'dangling-body.acme.test');
  assert.strictEqual(body.cname, 'app.herokuapp.com');
  assert.strictEqual(body.nxdomain, true, 'CNAME exists, TARGET is NXDOMAIN (dangling target)');
  const apex = recs.find((r) => r.host === 'acme.test');
  assert.strictEqual(apex.nxdomain, false, 'apex healthy');
  assert.deepStrictEqual(apex.ips, ['93.184.216.34']);
});

await okA('hygiene: SPF +all and DMARC p=none detected from fixture TXT', async () => {
  const h = await tk.hygiene('acme.test', { resolverLib: fakeResolver, axfrProbe: async () => ({ server: 'ns1', transferred: false, records: 0, reason: 'refused' }) });
  assert.strictEqual(h.spf_lax, 'v=spf1 ip4:10.0.0.0/24 +all');
  assert.match(h.dmarc, /p=none/);
  assert.strictEqual(h.axfr.length, 2);
  assert.strictEqual(h.axfr[0].transferred, false);
});

await okA('hygiene: ALLOWED AXFR becomes a High dns finding', async () => {
  const h = await tk.hygiene('acme.test', { resolverLib: fakeResolver, axfrProbe: async () => ({ server: 'ns1.acme.test', transferred: true, records: 42, reason: 'AXFR ALLOWED' }) });
  const findings = tk.findingsFromScan('acme.test', [], h, { wildcard: false });
  const axfr = findings.find((f) => f.class === 'dns' && /AXFR/.test(f.reason));
  assert.ok(axfr, 'AXFR finding present');
  assert.strictEqual(axfr.severity, 'High');
});

await okA('findingsFromScan: full assembly (takeover + email-auth, no dupes)', async () => {
  const recs = [
    { host: 'old.acme.test', cname: 'x.s3.amazonaws.com', ips: [], nxdomain: true },
    { host: 'www.acme.test', cname: null, ips: ['1.2.3.4'], nxdomain: false },
  ];
  const h = { dmarc: 'v=DMARC1; p=none', spf: 'v=spf1 +all', spf_lax: 'v=spf1 +all', axfr: [] };
  const findings = tk.findingsFromScan('acme.test', recs, h, { wildcard: false });
  const takeover = findings.filter((f) => f.class === 'takeover');
  assert.strictEqual(takeover.length, 1);
  assert.strictEqual(takeover[0].host, 'old.acme.test');
  assert.strictEqual(findings.filter((f) => f.class === 'email-auth').length, 2, 'SPF + DMARC findings');
});

await okA('scan: end-to-end on fake resolver + injected probes (record:false, no network)', async () => {
  process.env.STAVROS_REPORTS_DIR = path.join(tmp, 'reports');
  const httpProbed = [];
  // app.herokuapp.com RESOLVES in this fixture: the sub is a body-fingerprint candidate.
  const res = await tk.scan('acme.test', {
    subsFile,
    resolverLib: { ...fakeResolver, resolve4: async (h) => {
      if (h === 'app.herokuapp.com') return ['54.1.2.3']; // target alive → body probe decides
      return fakeResolver.resolve4(h);
    } },
    paceMs: 0,
    axfrProbe: async () => ({ server: 'ns1', transferred: false, records: 0, reason: 'refused' }),
    httpProbe: async (url) => { httpProbed.push(url); return { status: 404, body: 'No such app' }; },
    record: false,
  });
  assert.strictEqual(res.domain, 'acme.test');
  assert.strictEqual(res.subs_audited, 4, 'apex + www + old + dangling-body');
  const takeover = res.findings.filter((f) => f.class === 'takeover');
  assert.strictEqual(takeover.length, 1, 'body-fingerprint on the resolving CNAME candidate');
  assert.strictEqual(takeover[0].host, 'dangling-body.acme.test');
  assert.strictEqual(takeover[0].provider, 'heroku');
  assert.strictEqual(takeover[0].severity, 'High', 'heroku "No such app" body marker is High in the fingerprint table');
  assert.ok(res.findings.some((f) => f.class === 'email-auth'));
  assert.ok(res._file && fs.existsSync(res._file), 'report persisted');
  assert.strictEqual(httpProbed.length, 1, 'ONE fingerprint GET, only for the resolving CNAME candidate');
  assert.ok(httpProbed[0].includes('dangling-body.acme.test'));
});

// cleanup
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\ntakeover: ${pass} pass, ${fail} fail`);
return fail ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(1); });
