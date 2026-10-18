#!/usr/bin/env node
// Zero-dependency test for tools/gate.js.
// Run: node tools/test-gate.js  → prints PASS/FAIL per case, exit 1 on any failure.

'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const {
  runGate, gateRequiresHost, gateLogHasPass, checkFile, checkMarkers, checkFindings, checkVerify,
  checkNoPending, checkCoverage, normalizeHost, hostMatches,
} = require('./gate');

// Hermetic workspace: gate.js resolves paths against GATE_WS (env override, default = package
// root). Point it at a mkdtemp fixture so the test never depends on the repo's live engagement
// files (scope.json / reports/ are gitignored and absent in a fresh checkout).
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-ws-'));
fs.mkdirSync(path.join(ws, 'reports'), { recursive: true });
fs.writeFileSync(path.join(ws, 'scope.json'), JSON.stringify({ allowed_hosts: ['target.example'], allowed_ips: [] }));
fs.writeFileSync(path.join(ws, 'reports', 'findings.jsonl'), JSON.stringify({
  severity: 'Low', title: 'fixture', host: 'target.example', poc: 'x', status: 'inconclusive',
}) + '\n');
process.env.GATE_WS = ws;
process.env.GATE_LOG_FILE = path.join(ws, 'reports', 'gate-log.md');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

// Structural checks
ok('checkFile scope.json exists', checkFile('scope.json').ok);
ok('checkFile missing file reports', !checkFile('reports/__nonexistent__').ok);

ok('checkMarkers in scope.json', checkMarkers('scope.json', ['allowed_hosts']).ok);
ok('checkMarkers missing marker', !checkMarkers('scope.json', ['__MISSING_MARKER__']).ok);

// Findings: our reports/findings.jsonl should exist and have items
const findingsCheck = checkFindings(0);
ok('checkFindings min 0 passes', findingsCheck.ok);
const findingsOne = checkFindings(1);
ok('checkFindings min 1 passes (fixture has one finding)', findingsOne.ok);

// Gate log hasPass
const sampleLog = '| 2025-01-01T00:00:00Z | cyboros/recon | pass | scope ok |';
ok('gateLogHasPass finds existing', gateLogHasPass(sampleLog, 'recon'));
ok('gateLogHasPass rejects missing', !gateLogHasPass(sampleLog, 'report'));

// runGate logic
const r = runGate('recon');
ok('runGate recon returns gateId', r.gateId === 'recon');
ok('runGate recon has results array', Array.isArray(r.results));

// verify gate structure
const keys = Object.keys(runGate('recon').results);
ok('unknown gate returns null', runGate('__fake__') === null);

// ── Host scoping: un ingaggio non deve leggere né sbloccare un altro ────────────────────────
const findFile = path.join(ws, 'reports', 'findings.jsonl');
fs.appendFileSync(findFile, JSON.stringify({
  severity: 'Low', title: 'foreign hypothesis', host: 'other.example', poc: 'x', status: 'inconclusive',
}) + '\n');
// Una riga pending vera: afferma la realtà con un oracolo che su disco non esiste.
fs.appendFileSync(findFile, JSON.stringify({
  severity: 'Low', title: 'foreign pending', host: 'other.example', poc: 'x', status: 'confirmed',
  oracle: { type: 'http-diff', ref: 'reports/__no_such_oracle__.json', token: 'deadbeef' },
}) + '\n');
ok('checkFindings scoped: target has 1', checkFindings(2, 'target.example').ok === false && checkFindings(1, 'target.example').ok);
ok('checkFindings scoped: other host has 2', checkFindings(2, 'other.example').ok);
ok('checkNoPending scoped ignores other hosts', checkNoPending('target.example').ok);
ok('checkNoPending global still sees them', !checkNoPending().ok);

ok('normalizeHost strips scheme/port/userinfo', normalizeHost('https://user@Example.COM:8443/x') === 'example.com');
ok('hostMatches accepts a subdomain', hostMatches('api.target.example', 'target.example'));
ok('hostMatches rejects a substring host (no includes())', !hostMatches('evil-target.example', 'target.example'));

const hostLog = [
  '| 2025-01-01T00:00:00Z | cyboros/report | pass | host=other.example; old engagement |',
].join('\n');
ok('gateLogHasPass scoped: another host pass does not count', !gateLogHasPass(hostLog, 'report', 'target.example'));
ok('gateLogHasPass scoped: own host pass counts', gateLogHasPass(hostLog, 'report', 'other.example'));
ok('gateLogHasPass legacy global query still matches', gateLogHasPass(hostLog, 'report'));
ok('gateLogHasPass scoped: untagged legacy pass is not host evidence', !gateLogHasPass(sampleLog, 'recon', 'target.example'));

// map gate: la mappa è un artefatto per-host e senza host il gate non può passare.
ok('map gate is host-scoped', gateRequiresHost('map'));
ok('recon gate is not host-scoped', !gateRequiresHost('recon'));
ok('map gate without host fails (no silent skip)', !runGate('map').allOk);
fs.mkdirSync(path.join(ws, 'reports', 'tmp'), { recursive: true });
fs.writeFileSync(path.join(ws, 'reports', 'tmp', 'run-audit.jsonl'), '{}\n', { flag: 'w' });
const mapMissingHost = runGate('map', { host: 'target.example' });
ok('map gate fails without reports/<host>-map.json', mapMissingHost.allOk === false
  && mapMissingHost.results.some((c) => /target\.example-map\.json/.test(c.detail)));
fs.writeFileSync(path.join(ws, 'reports', 'target.example-map.json'), JSON.stringify({ endpoints: [] }));
ok('map gate passes once the map exists', runGate('map', { host: 'target.example' }).allOk);

// coverage: il vecchio check accettava qualsiasi file con una pipe; ora serve una matrice vera.
ok('coverage without matrix fails', !checkCoverage('target.example').ok);
const covFile = path.join(ws, 'reports', 'coverage-target.example.md');
fs.writeFileSync(covFile, ['# Coverage Matrix', '', 'Host: target.example', '',
  '| Class | Candidates | Findings | Status |', '|---|---|---|---|',
  '| sqli | 0 | 0 | missed |'].join('\n'));
const covMissed = checkCoverage('target.example');
ok('coverage with a missed class fails', covMissed.ok === false && /missed: sqli/.test(covMissed.detail));
fs.writeFileSync(covFile, ['# Coverage Matrix', '', 'Host: target.example', '',
  '| Class | Candidates | Findings | Status |', '|---|---|---|---|',
  '| sqli | 3 | 1 | confirmed |', '| xss | 0 | 0 | n-a |'].join('\n'));
ok('coverage with no missed class passes', checkCoverage('target.example').ok);
fs.writeFileSync(covFile, '# Coverage Matrix\n\nHost: other.example\n\n| Class | Candidates | Findings | Status |\n|---|---|---|---|\n| sqli | 1 | 1 | confirmed |\n');
ok('coverage whose header names another host fails', !checkCoverage('target.example').ok);
ok('coverage with no rows fails (it is not a matrix)', !checkCoverage('__host_without_file__').ok);

fs.rmSync(ws, { recursive: true, force: true });
console.log(`\ngate: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);