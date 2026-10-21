// Self-check: report-html.js enriches findings (cvss/epss/cwe), escapes user text (no markup
// injection), and renders chains + recon from state.db. Pure builder is tested without I/O.
// Run: node tools/test-report-html.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const R = require('./report-html');
const state = require('./state');

// escaping
assert.strictEqual(R.htmlEscape('<script>"x"&</script>'), '&lt;script&gt;&quot;x&quot;&amp;&lt;/script&gt;');

// enrichment: cvss from vector, epss from cve, cwe title, normalized cves
const enr = R.enrichFinding({
  severity: 'High', title: 'SQLi', host: 'h', cvss_vector: 'AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
  cve: 'cve-2021-44228', cwe: 'cwe-79',
});
assert.strictEqual(enr.cvss, 9.8);
assert.deepStrictEqual(enr.cves, ['CVE-2021-44228']);
assert.ok(enr.epss > 0.9, 'Log4Shell EPSS should be high');
assert.strictEqual(enr.cwe_title, 'Cross-site Scripting');

// unknown CVE/CWE -> no epss, no crash
const enr2 = R.enrichFinding({ severity: 'Low', title: 'x', host: 'h', cwe: 'CWE-99999', cves: ['CVE-9999-0000'] });
assert.strictEqual(enr2.epss, null);
assert.strictEqual(enr2.cwe_title, null);

// summary counts
const s = R.summaryTable([
  { severity: 'Critical', cvss: 9.8, epss: 0.97 },
  { severity: 'High', cvss: 7.5, epss: null },
  { severity: 'Medium', cvss: null, epss: null },
]);
assert.strictEqual(s.total, 3);
assert.strictEqual(s.counts.Critical, 1);
assert.strictEqual(s.withCvss, 2);
assert.strictEqual(s.withEpss, 1);
assert.strictEqual(s.maxEpss, 0.97);

// buildHtml: title is escaped (XSS-safe), severity + cwe + epss + chains + recon all present
const html = R.buildHtml({
  generatedAt: '2026-08-18T00:00:00.000Z',
  findings: [
    { severity: 'Critical', title: '<img src=x onerror=alert(1)>', host: 'target.com', endpoint: '/a',
      cwe: 'CWE-79', cwe_title: 'Cross-site Scripting', cvss: 9.8, epss: 0.97, cves: ['CVE-2021-44228'], status: 'verified' },
  ],
  chains: [{ host: 'target.com', chain_count: 1, chains: [{ name: 'Leaked-secret authorization bypass', reasoning: 'why', findings: ['Leak [High]', 'IDOR [High]'] }] }],
  targets: [{ target: 'target.com', hosts: [{ address: '10.0.0.5', hostname: 'srv', os: 'Linux', ports: [{ port: 22, protocol: 'tcp', service: 'ssh', version: 'OpenSSH 8.2' }] }], endpoints: [] }],
  sploitByCve: { 'CVE-2021-44228': [{ edb_id: '1', title: 'x' }] },
});
assert.ok(!html.includes('<img src=x'), 'finding title must be escaped');
assert.ok(html.includes('&lt;img src=x'));
assert.ok(html.includes('Critical'));
assert.ok(html.includes('Cross-site Scripting'));
assert.ok(html.includes('97.0%'));
assert.ok(html.includes('1 sploit'));
assert.ok(html.includes('Leaked-secret authorization bypass'));
assert.ok(html.includes('OpenSSH 8.2'));
assert.ok(html.includes('verified'));

// The report is a client document: every string in it is product text, in English, and
// names no engagement file. This is the regression for the sections that were written in
// Italian (coverage, cost/usage) and for the internal paths the footer and empty states
// used to carry.
const localised = R.buildHtml({
  generatedAt: '2026-08-18T00:00:00.000Z',
  findings: [],
  targets: [{ target: 'target.com', hosts: [], endpoints: [] }],
  chains: [],
  coverage: {
    hosts: [{
      matrix: { rows: [{ class: 'upload', candidates: 3, findings: 1, status: 'tested' }] },
      summary: { host: 'target.com', candidatesTotal: 3, verified: 1, fpDiscarded: 0, untested: [{ class: 'jwt', cause: 'out of scope' }] },
    }],
    totals: { candidatesTotal: 3, verified: 1, fpDiscarded: 0, untestedTotal: 1 },
  },
  accounting: {
    session: { invocations: 2, tokens: 30, tokens_in: 20, tokens_out: 10, cost: null },
    actions: { per_bin: { nmap: { invocations: 1, tokens_in: 12, tokens_out: 8, tokens: 20, cost: null } } },
    agents: { per_agent: { scout: { invocations: 1, tokens_in: 8, tokens_out: 2, tokens: 10, cost: null } } },
  },
});
for (const heading of ['Coverage &amp; accuracy', 'Cost &amp; usage', 'Candidates', 'By agent', 'Untested:']) {
  assert.ok(localised.includes(heading), 'English report heading missing: ' + heading);
}
for (const marker of ['Nessun', 'Copertura', 'candidati', 'verificati', 'Legenda', 'Per agente', 'Per azione', 'Costo', 'invocazioni',
  'state.db', 'scope.json', '-map.json', 'tools/report-html.js']) {
  assert.ok(!localised.includes(marker), 'non-English or internal text in the client report: ' + marker);
}

// collectFromState reads targets/hosts/ports from a temp STATE_DB
const tmpDb = path.join(os.tmpdir(), 'cyboros-report-' + process.pid + '.db');
try { fs.unlinkSync(tmpDb); } catch {}
const db = state.open(tmpDb);
const tid = state.upsertTarget(db, 'target.com');
const hid = state.upsertHost(db, tid, '10.0.0.5', { hostname: 'srv', os: 'Linux' });
state.upsertPort(db, hid, 443, 'tcp', 'https', 'nginx', 'open');
state.upsertEndpoint(db, tid, 'GET', 'https://target.com/login', {});
const targets = R.collectFromState(db);
db.close();
assert.strictEqual(targets.length, 1);
assert.strictEqual(targets[0].hosts[0].ports[0].service, 'https');
assert.strictEqual(targets[0].endpoints.length, 1);
fs.unlinkSync(tmpDb);

console.log('report-html: all tests passed');
