#!/usr/bin/env node
// Offline self-check for the non-HTTP service rules in next-actions.js (P1 "Ondata servizi").
// Pure plan() over a fixture snapshot: no network, no DB, no binaries. Asserts that an open
// port proposes the right read-only action with the right tier/priority/covered semantics,
// that proposals are idempotent (covered on second sight) and out-of-scope hosts are blocked.
// Run: node tools/test-next-actions-services.js
// test-tags: offline
'use strict';
const assert = require('assert');
const na = require('./next-actions');

const inScope = () => ({ ok: true, reason: 'test scope' });

// Fixture: one host per service scenario. Endpoints empty => not covered (fresh surface).
function snap(hosts, endpoints, vulns) {
  return {
    generated_at: new Date().toISOString(),
    targets: [{
      host: '10.0.0.9',
      hosts: (hosts || []).map((h) => ({ address: h.address, ports: h.ports })),
      endpoints: endpoints || [],
      vulns: vulns || [],
      creds: [],
      technologies: [],
    }],
  };
}
const port = (n, svc) => ({ port: n, protocol: 'tcp', service: svc, state: 'open' });

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log(`  PASS ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}: ${e.message}`); }
}
function findOne(actions, surface) {
  return actions.filter((a) => a.surface === surface && !a.blocked);
}

// ---- ftp ---------------------------------------------------------------------
ok('ftp: open 21 proposes ftp-anon nmap script', () => {
  const p = na.plan(snap([{ address: '10.0.0.9', ports: [port(21, 'ftp')] }]), { inScope });
  const ftp = findOne(p.actions, 'ftp');
  assert.strictEqual(ftp.length, 1, 'exactly one ftp proposal');
  assert.match(ftp[0].cmd, /ftp-anon/);
  assert.strictEqual(ftp[0].tier, 'active');
  assert.strictEqual(ftp[0].priority, 20);
  assert.strictEqual(ftp[0].covered, false);
});

// ---- snmp --------------------------------------------------------------------
ok('snmp: open 161 proposes snmpwalk read-only workflow', () => {
  const p = na.plan(snap([{ address: '10.0.0.9', ports: [port(161, 'snmp')] }]), { inScope });
  const snmp = findOne(p.actions, 'snmp');
  assert.strictEqual(snmp.length, 1);
  assert.strictEqual(snmp[0].kind, 'workflow');
  assert.match(snmp[0].ref, /enum-snmp\.yaml$/);
  assert.strictEqual(snmp[0].tier, 'read');
  assert.strictEqual(snmp[0].priority, 18);
});

// ---- mssql -------------------------------------------------------------------
ok('mssql: open 1433 proposes enum-mssql workflow', () => {
  const p = na.plan(snap([{ address: '10.0.0.9', ports: [port(1433, 'ms-sql-s')] }]), { inScope });
  const mssql = findOne(p.actions, 'mssql');
  assert.strictEqual(mssql.length, 1);
  assert.match(mssql[0].ref, /enum-mssql\.yaml$/);
  assert.strictEqual(mssql[0].tier, 'read');
  assert.strictEqual(mssql[0].priority, 15);
});
ok('mssql: IMPERSONATE vuln adds opt-in chain proposal toward ad.js enum-relay', () => {
  const vulns = [{ class: 'authz', template_id: 'mssql_impersonate', url: null, host: '10.0.0.9' }];
  const p = na.plan(snap([{ address: '10.0.0.9', ports: [port(1433, 'mssql')] }], [], vulns), { inScope });
  const mssql = findOne(p.actions, 'mssql');
  const chain = mssql.find((a) => /enum-relay/.test(a.cmd));
  assert.ok(chain, 'chain proposal present');
  assert.strictEqual(chain.requires_optin, true, 'chain is opt-in (confirm-tier on execution)');
});

// ---- nfs ---------------------------------------------------------------------
ok('nfs: open 2049 proposes showmount -e', () => {
  const p = na.plan(snap([{ address: '10.0.0.9', ports: [port(2049, 'nfs')] }]), { inScope });
  const nfs = findOne(p.actions, 'nfs');
  assert.strictEqual(nfs.length, 1);
  assert.match(nfs[0].cmd, /showmount -e 10\.0\.0\.9/);
  assert.strictEqual(nfs[0].tier, 'read');
});

// ---- docker / kubelet --------------------------------------------------------
ok('docker: open 2375 proposes container workflow', () => {
  const p = na.plan(snap([{ address: '10.0.0.9', ports: [port(2375, 'docker')] }]), { inScope });
  const d = findOne(p.actions, 'docker');
  assert.strictEqual(d.length, 1);
  assert.match(d[0].ref, /enum-container\.yaml$/);
  assert.strictEqual(d[0].priority, 12);
});
ok('kubelet: open 10250/10255 proposes container workflow', () => {
  const p = na.plan(snap([{ address: '10.0.0.9', ports: [port(10250, 'kubelet'), port(10255, 'unknown')] }]), { inScope });
  const k = findOne(p.actions, 'kubelet');
  assert.strictEqual(k.length, 1);
  assert.match(k[0].ref, /enum-container\.yaml$/);
  assert.strictEqual(k[0].tier, 'read');
});

// ---- redis / elasticsearch / mongodb ------------------------------------------
ok('redis: open 6379 proposes unauth INFO (read)', () => {
  const p = na.plan(snap([{ address: '10.0.0.9', ports: [port(6379, 'redis')] }]), { inScope });
  const r = findOne(p.actions, 'redis');
  assert.strictEqual(r.length, 1);
  assert.match(r[0].ref, /enum-redis\.yaml$/);
  assert.strictEqual(r[0].priority, 12);
});
ok('elasticsearch: open 9200 proposes GET / via run.js curl', () => {
  const p = na.plan(snap([{ address: '10.0.0.9', ports: [port(9200, 'elasticsearch')] }]), { inScope });
  const e = findOne(p.actions, 'elasticsearch');
  assert.strictEqual(e.length, 1);
  assert.match(e[0].cmd, /curl -s http:\/\/10\.0\.0\.9:9200\//);
  assert.strictEqual(e[0].tier, 'read');
});
ok('mongodb: open 27017 proposes listDatabases workflow', () => {
  const p = na.plan(snap([{ address: '10.0.0.9', ports: [port(27017, 'mongod')] }]), { inScope });
  const m = findOne(p.actions, 'mongodb');
  assert.strictEqual(m.length, 1);
  assert.match(m[0].ref, /enum-mongo\.yaml$/);
  assert.strictEqual(m[0].priority, 15);
});

// ---- anti-duplicates / semantics ----------------------------------------------
ok('covered: existing endpoint on the same port suppresses the proposal (unless --all)', () => {
  const endpoints = [{ method: 'GET', url: 'redis://10.0.0.9:6379/0', auth: false }];
  const p0 = na.plan(snap([{ address: '10.0.0.9', ports: [port(6379, 'redis')] }], endpoints), { inScope });
  assert.strictEqual(findOne(p0.actions, 'redis').length, 0, 'covered => not proposed');
  const p1 = na.plan(snap([{ address: '10.0.0.9', ports: [port(6379, 'redis')] }], endpoints), { inScope, all: true });
  assert.strictEqual(findOne(p1.actions, 'redis').length, 1, '--all re-proposes with covered=true');
  assert.strictEqual(findOne(p1.actions, 'redis')[0].covered, true);
});

ok('closed ports propose nothing (state filter respected)', () => {
  const p = na.plan(snap([{ address: '10.0.0.9', ports: [{ port: 6379, protocol: 'tcp', service: 'redis', state: 'closed' }] }]), { inScope });
  assert.strictEqual(findOne(p.actions, 'redis').length, 0);
});

ok('out-of-scope host: proposal marked blocked (fail-closed)', () => {
  const p = na.plan(snap([{ address: '10.0.0.9', ports: [port(6379, 'redis')] }]), { inScope: () => ({ ok: false, reason: 'test' }) });
  const r = p.actions.filter((a) => a.surface === 'redis');
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].blocked, true);
});

ok('no service ports => zero service actions (additive planner unchanged elsewhere)', () => {
  const p = na.plan(snap([{ address: '10.0.0.9', ports: [port(80, 'http')] }]), { inScope });
  for (const s of ['ftp', 'snmp', 'mssql', 'nfs', 'docker', 'redis', 'elasticsearch', 'kubelet', 'mongodb']) {
    assert.strictEqual(findOne(p.actions, s).length, 0, `no ${s} proposal`);
  }
});

ok('all proposals are single read-only presence probes (no credentials, no brute force)', () => {
  const ports = [port(21, 'ftp'), port(161, 'snmp'), port(1433, 'mssql'), port(2049, 'nfs'),
    port(2375, 'docker'), port(6379, 'redis'), port(9200, 'elasticsearch'), port(10250, 'kubelet'), port(27017, 'mongod')];
  const p = na.plan(snap([{ address: '10.0.0.9', ports }]), { inScope });
  const svc = p.actions.filter((a) => !['network', 'smb', 'ldap', 'http', 'http-param', 'sqli', 'creds', 'llm', 'http-waf'].includes(a.surface));
  assert.ok(svc.length >= 9, `service actions present (${svc.length})`);
  for (const a of svc) {
    assert.ok(!/--pass|-p\s+'|password|-w\s|wordlist|hydra|medusa|spray/i.test(a.cmd), `no credential/brute flags in: ${a.cmd}`);
  }
});

console.log(`\nnext-actions-services: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
