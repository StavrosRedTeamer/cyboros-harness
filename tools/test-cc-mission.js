// Offline self-check for WP5 (mission + dispatch) and WP6 (ledger/graph/coverage).
// Run: node tools/test-cc-mission.js
// Hermetic: STATE_DB / GATE_WS / CC_* all point into a mkdtemp, never the real workspace files.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const WS = path.join(__dirname, '..');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboros-cc-mission-'));
const GATE_WS = path.join(T, 'gate-ws');
fs.mkdirSync(path.join(GATE_WS, 'reports'), { recursive: true });

process.env.CC_ROOT = T;
process.env.STATE_DB = path.join(T, 'state.db');
process.env.GATE_WS = GATE_WS;
process.env.GATE_LOG_FILE = path.join(GATE_WS, 'reports', 'gate-log.md');
process.env.CC_OPSTATE_FILE = path.join(T, 'operation-state.json');
process.env.CC_APPROVALS_FILE = path.join(T, 'approvals.jsonl');
process.env.CC_CAMPAIGN_FILE = path.join(T, 'campaign.json');
process.env.CC_CAMPAIGNS_DIR = path.join(T, 'campaigns');
process.env.CC_HISTORY_FILE = path.join(T, 'reports', 'campaign-history.jsonl');
process.env.CC_TEMPLATES_DIR = path.join(WS, 'templates', 'campaign');
process.env.AUDIT_DIR = path.join(T, 'artifacts', 'audit');
process.env.RUN_AUDIT_FILE = path.join(T, 'run-audit.jsonl');
process.env.SCOPE_JSON = path.join(T, 'scope.json');
fs.writeFileSync(process.env.SCOPE_JSON, JSON.stringify({ allowed_ips: ['127.0.0.1'] }));

const mission = require('./cc-mission');
const ledger = require('./cc-ledger');
const graph = require('./cc-graph');
const coverage = require('./cc-coverage');
const gate = require('./gate');

// ── mission build is consistent with the underlying modules ─────────────────
const m = mission.build();
assert.ok(m.generated_at, 'mission has a timestamp');
assert.strictEqual(m.gates.length, Object.keys(gate.GATES).length, 'gate count == gate.GATES');
assert.ok(m.headline && typeof m.headline.open_actions === 'number');
assert.ok(Array.isArray(m.actions), 'unified action cards');
// budget payload mirrors the CLI contract
const budget = require('child_process').spawnSync(process.execPath, [path.join(WS, 'tools', 'budget.js'), 'check'],
  { encoding: 'utf8', env: Object.assign({}, process.env, { BUDGET_STATE_FILE: path.join(T, 'opstate-budget.json') }) });
assert.strictEqual(m.budget.halted, false, 'no budget config → not halted (matches CLI)');
assert.ok(typeof budget.stdout === 'string');

// ── dispatch spec: allowlist + fail-closed ──────────────────────────────────
assert.strictEqual(mission.dispatchSpec({ argv: ['tools/run.js', '--dry-run', 'nmap', '127.0.0.1'] }).ok, true);
assert.strictEqual(mission.dispatchSpec({ argv: ['tools/workflow.js', 'run', 'workflows/web.yaml', '-t', 'x'] }).ok, true);
assert.strictEqual(mission.dispatchSpec({ argv: ['rm', '-rf', '/'] }).ok, false, 'only allowlisted wrappers can be dispatched');
assert.strictEqual(mission.dispatchSpec({ argv: [] }).ok, false);
const confirmSpec = mission.dispatchSpec({ argv: ['tools/budget.js', 'reset', '--reason', 'x'], confirm: true });
assert.strictEqual(confirmSpec.confirmTier, true);

// ── ledger chain verdict coincides with gate.js ─────────────────────────────
const findings = path.join(GATE_WS, 'reports', 'findings.jsonl');
fs.writeFileSync(findings, [
  JSON.stringify({ severity: 'Low', title: 'a', host: 'h', status: 'confirmed' }),
  JSON.stringify({ severity: 'Low', title: 'b', host: 'h', status: 'confirmed' }),
].join('\n') + '\n');
const lc = ledger.chain(findings);
const gc = gate.checkChain(findings);
assert.strictEqual(lc.ok, gc.ok, 'chain verdict matches gate.js');
assert.strictEqual(lc.detail, gc.detail, 'chain detail matches gate.js (same function)');

// no findings → vacuous pass, still identical
fs.rmSync(findings);
assert.deepStrictEqual(ledger.chain(findings), gate.checkChain(findings));

// ── ledger build + evidence bundle ──────────────────────────────────────────
const built = ledger.build({ tail: 20 });
assert.ok(built.chain && Array.isArray(built.timeline.rows));
fs.writeFileSync(path.join(T, 'operation-state.json'), JSON.stringify({ revision: 1, transitions: [] }));
const bundle = ledger.evidenceBundle({ outDir: path.join(T, 'ev') });
assert.ok(fs.existsSync(bundle.manifest), 'manifest written');
const manifest = JSON.parse(fs.readFileSync(bundle.manifest, 'utf8'));
assert.strictEqual(manifest.kind, 'cyboros-evidence-bundle');
const entry = manifest.files.find((f) => f.path === 'operation-state.json');
assert.ok(entry, 'bundle lists the opstate file');
const diskHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(T, 'operation-state.json'))).digest('hex');
assert.strictEqual(entry.sha256, diskHash, 'manifest hash matches the file on disk');
if (bundle.ok) assert.ok(fs.existsSync(bundle.tar), 'tar.gz produced when tar is available');

// ── graph + coverage are read-only projections that never throw ─────────────
const g = graph.build();
assert.ok(Array.isArray(g.hosts), 'graph exposes the host exposure map');
assert.ok(g.unassigned && Array.isArray(g.unassigned.endpoints) && Array.isArray(g.unassigned.vulns));
assert.ok(g.counts && typeof g.counts.hosts === 'number' && typeof g.counts.open_ports === 'number');
const cov = coverage.build();
assert.ok(Array.isArray(cov.hosts));
assert.ok(cov.attack && 'executed' in cov.attack);

console.log('test-cc-mission: OK');
