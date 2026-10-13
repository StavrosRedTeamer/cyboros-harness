// Offline self-check for the Graph projection (cc-graph.js) — the host exposure map.
// What regressed once and must not regress again: hosts were read from `h.host`/`h.state`
// (the snapshot exposes `address`/`alive`), so every host collapsed into one `host:undefined`
// node with duplicate ids, and endpoints/findings were linked to a host that did not exist.
// Run: node tools/test-cc-graph.js
// Hermetic: STATE_DB points into a mkdtemp, never the real reports/state.db.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ok, summary, fixture } = require('./testkit');

const T = fixture('cyboros-cc-graph');
process.env.STATE_DB = path.join(T, 'state.db');
process.env.FINDINGS_JSONL = path.join(T, 'findings.jsonl');

const tm = require('./target-model');
const graph = require('./cc-graph');

// ── fixture: one target with two hosts, a second target re-scanning one of them ────────────
const NMAP = '<nmaprun>'
  + '<host><address addr="10.0.0.5" addrtype="ipv4"/><hostnames><hostname name="app.lab"/></hostnames><ports>'
  + '<port protocol="tcp" portid="22"><state state="open"/><service name="ssh" version="OpenSSH 9"/></port>'
  + '<port protocol="tcp" portid="80"><state state="open"/><service name="http"/></port>'
  + '<port protocol="tcp" portid="443"><state state="open"/><service name="ssl/http"/></port>'
  + '<port protocol="tcp" portid="8080"><state state="open"/><service name="http-proxy"/></port>'
  + '<port protocol="tcp" portid="3306"><state state="open"/><service name="mysql"/></port>'
  + '<port protocol="tcp" portid="25"><state state="filtered"/></port>'
  + '<port protocol="tcp" portid="111"><state state="closed"/></port>'
  + '</ports></host>'
  + '<host><address addr="10.0.0.7" addrtype="ipv4"/><hostnames><hostname name="dc.lab"/></hostnames><ports>'
  + '<port protocol="tcp" portid="445"><state state="open"/><service name="microsoft-ds"/></port>'
  + '</ports></host></nmaprun>';
const NMAP_AGAIN = '<nmaprun><host><address addr="10.0.0.5" addrtype="ipv4"/><ports>'
  + '<port protocol="tcp" portid="22"><state state="open"/><service name="ssh"/></port>'
  + '<port protocol="tcp" portid="80"><state state="open"/><service name="http"/></port>'
  + '</ports></host></nmaprun>';

const db = tm.open();
try {
  tm.ingest(db, 'nmap', NMAP, { target: 'app.lab' });
  tm.ingest(db, 'nmap', NMAP_AGAIN, {});   // target 10.0.0.5: same host, must merge
  tm.ingest(db, 'httpx', [
    JSON.stringify({ url: 'https://app.lab/', host: '10.0.0.5', status_code: 200, webserver: 'nginx' }),
    JSON.stringify({ url: 'https://app.lab:8443/api', host: '10.0.0.5', status_code: 200 }),
    JSON.stringify({ url: 'https://10.0.0.7/', host: '10.0.0.7', status_code: 200 }),
    // no `host` field: the target is created and never gets a host row (a real failure mode)
    JSON.stringify({ url: 'https://ghost.lab/', status_code: 200 }),
  ].join('\n'), {});
  require('./state').upsertTarget(db, 'void.lab');   // created and never filled by any scan
  tm.ingest(db, 'nuclei', [
    JSON.stringify({ 'template-id': 'CVE-2021-44228', info: { name: 'Log4Shell', severity: 'critical' }, 'matched-at': 'https://app.lab/' }),
    JSON.stringify({ 'template-id': 'smb-signing', info: { name: 'SMB signing disabled', severity: 'high' }, 'matched-at': 'dc.lab:445' }),
  ].join('\n'), {});
} finally {
  db.close();
}

// The ledger: what the operator recorded, which never reaches the target model.
fs.writeFileSync(process.env.FINDINGS_JSONL, [
  JSON.stringify({ host: 'app.lab', title: 'IDOR on /api/v1/orders', severity: 'High', endpoint: 'https://app.lab/api/v1/orders/1', status: 'verified', verify_level: 'proven_impact', cvss: 8.1 }),
  JSON.stringify({ host: 'portal.lab', title: 'Exposed admin console', severity: 'Critical', endpoint: 'https://portal.lab/admin', status: 'confirmed' }),
].join('\n') + '\n');

const g = graph.build();

ok('build() is a host map, not a broken node list', () => {
  assert.ok(Array.isArray(g.hosts), 'hosts array');
  assert.ok(g.unassigned && Array.isArray(g.unassigned.endpoints) && Array.isArray(g.unassigned.vulns));
  assert.ok(g.targets.includes('app.lab') && g.targets.includes('10.0.0.5'), 'both targets are reported');
});

ok('the ledger is merged: a finding only recorded by hand still gets a host', () => {
  assert.strictEqual(g.hosts.length, 3, 'two scanned hosts + one known only from the ledger');
  const app = g.hosts.find((h) => h.address === '10.0.0.5');
  const portal = g.hosts.find((h) => h.hostname === 'portal.lab');
  assert.strictEqual(app.source, 'both', 'scanned AND recorded');
  assert.ok(app.vulns.some((v) => v.source === 'ledger' && v.label === 'IDOR on /api/v1/orders'), 'ledger finding attached to the scanned host by hostname');
  assert.ok(portal, 'ledger-only host present');
  assert.strictEqual(portal.source, 'ledger');
  assert.strictEqual(portal.port_counts.total, 0, 'never port-scanned');
  assert.strictEqual(portal.vulns[0].severity, 'critical');
  assert.strictEqual(g.counts.ledger_findings, 2);
});

ok('a target that contributed nothing is reported instead of silently missing', () => {
  assert.deepStrictEqual(g.empty_targets, ['void.lab']);
  assert.strictEqual(g.counts.empty_targets, 1);
  // ghost.lab has no host either, but it contributed an endpoint: that goes to the orphan list,
  // not to the empty-target list (it is represented, just not attachable).
  assert.deepStrictEqual(g.unassigned.endpoints.map((e) => e.url), ['https://ghost.lab/']);
});

ok('no undefined id survives the projection', () => {
  assert.ok(!JSON.stringify(g).includes('undefined'), 'no undefined anywhere in the payload');
  for (const h of g.hosts) assert.ok(h.id.startsWith('host:') && (h.address || h.hostname), 'host has an address- or name-keyed id');
});

ok('one host per address: the second target merges into the first', () => {
  assert.strictEqual(g.hosts.filter((h) => h.address).length, 2, 'two distinct addresses');
  const app = g.hosts.find((h) => h.address === '10.0.0.5');
  assert.ok(app, 'host 10.0.0.5 present');
  assert.deepStrictEqual(app.targets.sort(), ['10.0.0.5', 'app.lab']);
  assert.strictEqual(app.hostname, 'app.lab');
  // 7 ports from nmap + 8443 added by the httpx endpoint; 22/80 come from both scans once.
  assert.strictEqual(app.port_counts.total, 8, 'ports deduped across the two scans');
  assert.strictEqual(app.ports.filter((p) => p.port === 22).length, 1, 'port 22 recorded once');
});

ok('port states are counted and open services grouped', () => {
  const app = g.hosts.find((h) => h.address === '10.0.0.5');
  assert.deepStrictEqual(app.port_counts, { open: 6, filtered: 1, closed: 1, other: 0, total: 8 });
  assert.deepStrictEqual(app.services.map((s) => s.name), ['ssh', 'http', 'mysql', 'http-proxy']);
  assert.deepStrictEqual(app.services.find((s) => s.name === 'http').ports, [80, 443, 8443]);
  // the richer nmap fingerprint survives the merge with the bare re-scan of the same host
  assert.strictEqual(app.services.find((s) => s.name === 'ssh').ports[0], 22);
  assert.strictEqual(app.services.find((s) => s.name === 'ssh').versions[0], 'OpenSSH 9');
});

ok('endpoints attach to the host their URL resolves to', () => {
  const app = g.hosts.find((h) => h.address === '10.0.0.5');
  const dc = g.hosts.find((h) => h.address === '10.0.0.7');
  assert.deepStrictEqual(app.endpoints.map((e) => e.url).sort(), ['https://app.lab/', 'https://app.lab:8443/api']);
  assert.deepStrictEqual(dc.endpoints.map((e) => e.url), ['https://10.0.0.7/']);
  assert.deepStrictEqual(g.unassigned.endpoints.map((e) => e.url), ['https://ghost.lab/'], 'an endpoint whose target has no host cannot be attached');
});

ok('findings attach and drive the risk order', () => {
  const app = g.hosts.find((h) => h.address === '10.0.0.5');
  const dc = g.hosts.find((h) => h.address === '10.0.0.7');
  assert.strictEqual(app.vulns.length, 2, 'one ingested + one from the ledger');
  assert.strictEqual(app.vulns[0].severity, 'critical');
  assert.strictEqual(dc.vulns.length, 1);
  assert.strictEqual(dc.vulns[0].severity, 'high');
  assert.strictEqual(g.unassigned.vulns.length, 0, 'both findings landed on a host');
  assert.strictEqual(g.hosts[0].address, '10.0.0.5', 'the critical host sorts first');
});

ok('top-level counts match the hosts', () => {
  assert.strictEqual(g.counts.hosts, 3);
  assert.strictEqual(g.counts.ports, 10);
  assert.strictEqual(g.counts.open_ports, 8);
  assert.strictEqual(g.counts.endpoints, 4, '3 attached + the orphan');
  assert.strictEqual(g.counts.vulns, 4, '2 ingested + 2 from the ledger');
  assert.strictEqual(g.counts.hosts_with_findings, 3);
  assert.strictEqual(g.counts.findings.total, 4);
  assert.strictEqual(g.counts.findings.critical, 2);
  assert.strictEqual(g.counts.findings.high, 2);
});

ok('an empty workspace yields an empty map, never a throw', () => {
  const beforeDb = process.env.STATE_DB;
  const beforeFindings = process.env.FINDINGS_JSONL;
  process.env.STATE_DB = path.join(T, 'empty.db');
  process.env.FINDINGS_JSONL = path.join(T, 'empty-findings.jsonl');
  try {
    const e = graph.build();
    assert.deepStrictEqual(e.hosts, []);
    assert.strictEqual(e.counts.hosts, 0);
    assert.strictEqual(e.error, null);
  } finally {
    process.env.STATE_DB = beforeDb;
    process.env.FINDINGS_JSONL = beforeFindings;
  }
});

summary('test-cc-graph');
