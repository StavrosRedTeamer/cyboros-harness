// Offline self-check for the deterministic pipeline (cyboros.js). No network, no real
// scanners: a fake runBin returns canned tool output, and we assert the records written
// to a temporary STATE_DB + the phase/resume bookkeeping.
// Run: node tools/test-cyboros.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const state = require('./state');
const cyboros = require('./cyboros');

const tmpDir = path.join(os.tmpdir(), 'cyboros-test-' + process.pid);
fs.mkdirSync(tmpDir, { recursive: true });

const dbFile = path.join(tmpDir, 'state.db');
const db = state.open(dbFile);

const NMAP_XML = `<?xml version="1.0"?>
<nmaprun><host><status state="up"/>
  <address addr="10.0.0.5" addrtype="ipv4"/>
  <hostnames><hostname name="web.example.com" type="PTR"/></hostnames>
  <os><osmatch name="Linux 5.15" accuracy="98"/></os>
  <ports>
    <port protocol="tcp" portid="22"><state state="open"/><service name="ssh" product="OpenSSH" version="8.9"/></port>
    <port protocol="tcp" portid="443"><state state="open"/><service name="https" product="nginx" version="1.25"/></port>
  </ports>
</host></nmaprun>`;

// Fake runBin keyed on the binary: returns the same canned output the real tools would.
function fakeRunBin(bin) {
  switch (bin) {
    case 'subfinder':
      return { status: 0, stdout: 'api.example.com\napp.example.com\n', stderr: '' };
    case 'amass':
    case 'dnsx':
      return { status: 0, stdout: 'cdn.example.com\n', stderr: '' };
    case 'katana':
      return { status: 0, stdout: 'https://app.example.com/login\n', stderr: '' };
    case 'gau':
      return { status: 0, stdout: 'https://api.example.com/v1/users\n', stderr: '' };
    case 'waybackurls':
      return { status: 0, stdout: 'https://app.example.com/old\n', stderr: '' };
    case 'httpx':
      return {
        status: 0,
        stdout: [
          JSON.stringify({ url: 'https://api.example.com/', input: 'api.example.com', status_code: 200, title: 'API', webserver: 'nginx', tech: ['nginx'], content_type: 'application/json', host: '10.0.0.5' }),
          JSON.stringify({ url: 'https://app.example.com/login', input: 'app.example.com', status_code: 301, tech: ['express'], host: '10.0.0.6' }),
        ].join('\n'),
        stderr: '',
      };
    case 'naabu':
      return { status: 0, stdout: '10.0.0.5:22\n10.0.0.5:443\n', stderr: '' };
    case 'nmap':
      return { status: 0, stdout: NMAP_XML, stderr: '' };
    case 'ffuf':
      return {
        status: 0,
        stdout: [
          JSON.stringify({ url: 'https://example.com/admin', status: 200, length: 100, words: 5, lines: 3 }),
          JSON.stringify({ url: 'https://example.com/login', status: 301, length: 0, words: 0, lines: 0 }),
        ].join('\n'),
        stderr: '',
      };
    case 'arjun':
      return { status: 0, stdout: "[+] Parameters found: ['id', 'q']\n", stderr: '' };
    default:
      return { status: 1, stdout: '', stderr: 'not found' };
  }
}

(async () => {
  // ---- recon: subdomains -> httpx -> hosts + endpoints in state.db ----
  const r1 = await cyboros.recon(db, 'example.com', { runBin: fakeRunBin, tmpDir });
  assert.ok(r1.hosts >= 2, 'subdomains collected: ' + JSON.stringify(r1));
  const run1 = state.lastRun(db);
  assert.strictEqual(run1.target, 'example.com');
  assert.strictEqual(state.getPhase(db, run1.id, 'recon').status, 'done', 'recon phase done');
  const tExample = state.getTarget(db, 'example.com');
  assert.ok(tExample, 'target example.com stored');
  const hosts = state.listHosts(db, tExample.id);
  assert.strictEqual(hosts.length, 2, 'two live hosts: ' + JSON.stringify(hosts));
  assert.ok(hosts.some((h) => h.hostname === 'api.example.com' && h.address === '10.0.0.5'));
  assert.strictEqual(state.listEndpoints(db, tExample.id).length, 2, 'httpx endpoints recorded');

  // ---- enumerate: ffuf hits + arjun params appended to the SAME target ----
  const r2 = await cyboros.enumerate(db, 'example.com', { runBin: fakeRunBin });
  assert.strictEqual(r2.endpoints, 2, 'ffuf hits: ' + JSON.stringify(r2));
  const eps = state.listEndpoints(db, tExample.id);
  assert.strictEqual(eps.length, 5, '2 recon + 2 ffuf + 1 arjun base: ' + JSON.stringify(eps.map((e) => e.url)));
  const base = eps.find((e) => e.url === 'https://example.com');
  assert.ok(base, 'arjun base endpoint stored');
  assert.deepStrictEqual(JSON.parse(base.params), ['id', 'q'], 'arjun params stored');

  // ---- scan: naabu ports + nmap XML -> hosts/ports/services ----
  const r3 = await cyboros.scan(db, '10.0.0.5', { runBin: fakeRunBin });
  assert.strictEqual(r3.ports, 2, 'naabu ports: ' + JSON.stringify(r3));
  const tIp = state.getTarget(db, '10.0.0.5');
  assert.ok(tIp, 'scan target stored');
  const scanHosts = state.listHosts(db, tIp.id);
  assert.strictEqual(scanHosts.length, 1);
  assert.strictEqual(scanHosts[0].address, '10.0.0.5');
  assert.strictEqual(scanHosts[0].hostname, 'web.example.com');
  assert.strictEqual(scanHosts[0].os, 'Linux 5.15');
  const ports = state.listPorts(db, scanHosts[0].id);
  assert.strictEqual(ports.length, 2);
  const p443 = ports.find((p) => p.port === 443);
  assert.strictEqual(p443.service, 'https');
  assert.strictEqual(p443.version, '1.25');
  assert.strictEqual(p443.state, 'open');

  // ---- status + report ----
  const st = cyboros.status(db, 'example.com');
  assert.strictEqual(st.targets.length, 1);
  assert.strictEqual(st.targets[0].endpoints, 5);
  const rep = cyboros.report(db, { findingsFile: path.join(tmpDir, 'findings-empty.jsonl') });
  assert.strictEqual(rep.targets.length, 2, 'both targets consolidated');
  assert.strictEqual(rep.findings_count, 0, 'no findings file yet');
  assert.strictEqual(rep.run.status, 'done', 'report closes the current run');

  db.close();
})().then(() => {
  // ---- resume: a fresh run with only recon done, resume must skip it and finish ----
  const db2 = state.open(path.join(tmpDir, 'state2.db'));
  return (async () => {
    await cyboros.recon(db2, 'resume.example.com', { runBin: fakeRunBin, tmpDir });
    const before = state.lastRun(db2);
    assert.strictEqual(before.status, 'running');
    assert.strictEqual(state.getPhase(db2, before.id, 'scan'), null, 'scan not done yet');
    const res = await cyboros.resume(db2, { runBin: fakeRunBin, tmpDir });
    assert.strictEqual(res.resumed, true);
    assert.deepStrictEqual(res.results, { recon: 'skipped', scan: 'done', enumerate: 'done' }, JSON.stringify(res.results));
    assert.strictEqual(state.lastRun(db2).status, 'done', 'resume finishes the run');
    db2.close();
  })();
}).then(() => {
  // ---- resume overlaps scan ‖ enumerate: the two independent phases interleave ----
  // A tracing runBin records the order spawns START. scan does `await naabu` then `nmap`, so
  // nmap only starts after naabu resolves; enumerate launches `ffuf` synchronously. If the two
  // phases overlap, ffuf's start is recorded before nmap's; if they ran sequentially, scan would
  // finish (nmap started) before enumerate's ffuf ever started.
  const db3 = state.open(path.join(tmpDir, 'state3.db'));
  const startOrder = [];
  const delays = { naabu: 25, nmap: 5, ffuf: 5, arjun: 5 }; // naabu slow enough to expose ordering
  const tracingRunBin = async (bin, args, o) => {
    startOrder.push(bin);
    await new Promise((r) => setTimeout(r, delays[bin] || 1));
    return fakeRunBin(bin, args, o);
  };
  return (async () => {
    // seed a run with recon already done, so resume goes straight to scan ‖ enumerate
    await cyboros.recon(db3, 'overlap.example.com', { runBin: tracingRunBin, tmpDir });
    const res = await cyboros.resume(db3, { runBin: tracingRunBin, tmpDir, noauthScript: '' });
    assert.strictEqual(res.resumed, true);
    assert.deepStrictEqual(res.results, { recon: 'skipped', scan: 'done', enumerate: 'done' }, JSON.stringify(res.results));
    const iFfuf = startOrder.indexOf('ffuf');
    const iNmap = startOrder.indexOf('nmap');
    assert.ok(iFfuf >= 0 && iNmap >= 0, 'both phases spawned their tools: ' + JSON.stringify(startOrder));
    assert.ok(iFfuf < iNmap, 'scan ‖ enumerate overlap: ffuf must start before nmap, got ' + JSON.stringify(startOrder));
    assert.strictEqual(state.lastRun(db3).status, 'done', 'overlapped resume finishes the run');
    db3.close();
  })();
}).then(() => {
  // ---- a failed phase in the parallel group rejects resume and leaves the run 'running' ----
  const db4 = state.open(path.join(tmpDir, 'state4.db'));
  // scan fails (nmap + port pre-scan error), enumerate succeeds; allSettled lets enumerate still
  // record 'done' while resume rejects and the run stays open for a later retry.
  const failingScanRunBin = async (bin, args, o) => {
    if (bin === 'naabu' || bin === 'rustscan' || bin === 'nmap') throw new Error('scan boom');
    return fakeRunBin(bin, args, o);
  };
  return (async () => {
    await cyboros.recon(db4, 'fail.example.com', { runBin: failingScanRunBin, tmpDir });
    const run = state.lastRun(db4);
    await assert.rejects(
      cyboros.resume(db4, { runBin: failingScanRunBin, tmpDir, noauthScript: '' }),
      /scan boom/,
      'resume rejects when a parallel phase throws'
    );
    assert.strictEqual(state.getPhase(db4, run.id, 'scan').status, 'failed', 'scan phase recorded failed');
    assert.strictEqual(state.getPhase(db4, run.id, 'enumerate').status, 'done', 'enumerate still completed (allSettled)');
    assert.strictEqual(state.lastRun(db4).status, 'running', 'run stays running for a later resume');
    db4.close();
  })();
}).then(() => {
  // ---- defaultRunBin fail-closed (scope-check + no-host), no subprocess spawned ----
  const scopeFile = path.join(tmpDir, 'scope.json');
  fs.writeFileSync(scopeFile, JSON.stringify({ allowed_hosts: ['example.com'], allowed_ips: [], max_requests_per_second: 100 }));
  process.env.SCOPE_JSON = scopeFile;
  return Promise.all([
    assert.rejects(cyboros.defaultRunBin('echo', ['evil.com']), /out-of-scope/),
    assert.rejects(cyboros.defaultRunBin('echo', []), /no target host/),
  ]);
}).then(() => {
  delete process.env.SCOPE_JSON;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('cyboros: all tests passed');
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
