// Offline self-check for WP3 — campaign model (cc-campaign.js).
// Run: node tools/test-cc-campaign.js
// Everything lives in a mkdtemp; scope.json / campaign.json / reports are NEVER the real ones.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboros-cc-campaign-'));
const WS = path.join(__dirname, '..');
process.env.CC_ROOT = T;
process.env.CC_CAMPAIGN_FILE = path.join(T, 'campaign.json');
process.env.CC_CAMPAIGNS_DIR = path.join(T, 'campaigns');
process.env.CC_HISTORY_FILE = path.join(T, 'reports', 'campaign-history.jsonl');
process.env.CC_TEMPLATES_DIR = path.join(WS, 'templates', 'campaign');
process.env.SCOPE_JSON = path.join(T, 'scope.json');

const cc = require('./cc-campaign');

// ── templates present ────────────────────────────────────────────────────────
const tpl = cc.listTemplates().map((t) => t.name);
for (const want of ['web-app', 'internal-network', 'wireless', 'mobile', 'red-team-full']) {
  assert.ok(tpl.includes(want), 'missing template: ' + want);
}

// ── validation: structural errors vs. advisory warnings ─────────────────────
const bad = cc.validate({ version: 1, name: 'x' });
assert.strictEqual(bad.ok, false, 'missing id is a structural error');
assert.ok(bad.errors.some((e) => /id/.test(e)));

const draft = cc.fromTemplate('web-app', { client: 'Acme', name: 'Acme Web' }).campaign;
assert.strictEqual(draft.version, 1);
assert.ok(draft.surfaces.includes('web'));
assert.ok(draft.gates.includes('report'));
const draftVal = cc.validate(draft);
assert.strictEqual(draftVal.ok, true, 'template draft is structurally valid');
assert.ok(draftVal.warnings.some((w) => /RoE/.test(w)), 'no RoE → advisory warning, not an error');

// ── activate anchors scope.json but never rewrites it ───────────────────────
const scopeText = JSON.stringify({ allowed_hosts: ['lab.local'], max_requests_per_second: 2 }, null, 2) + '\n';
fs.writeFileSync(process.env.SCOPE_JSON, scopeText);
const before = fs.readFileSync(process.env.SCOPE_JSON, 'utf8');

draft.roe = { authorized_by: 'CISO', contact: 'soc@acme.example', document: 'sow-42' };
draft.window = { start: '2026-10-01', end: '2026-10-15' };
draft.objectives = ['map', 'test'];
const act = cc.activate(draft, { actor: 'op' });
assert.strictEqual(act.ok, true, JSON.stringify(act.validation));
assert.ok(fs.existsSync(process.env.CC_CAMPAIGN_FILE), 'active manifest written');
assert.strictEqual(fs.readFileSync(process.env.SCOPE_JSON, 'utf8'), before, 'activate NEVER rewrites scope.json');
assert.strictEqual(cc.loadActive().id, draft.id);

const hist = cc.history();
assert.ok(hist.some((h) => h.event === 'activate' && h.id === draft.id), 'history records the activation');

// ── scope drift + explicit re-anchor ────────────────────────────────────────
assert.strictEqual(cc.drift().stale, false, 'freshly anchored → not stale');
fs.writeFileSync(process.env.SCOPE_JSON, JSON.stringify({ allowed_hosts: ['lab.local', 'extra.local'] }));
assert.strictEqual(cc.drift().stale, true, 'scope changed outside the app → stale badge');
cc.resign('op');
assert.strictEqual(cc.drift().stale, false, 'resign re-anchors the hash');
assert.ok(cc.history().some((h) => h.event === 'resign-scope'), 'resign is recorded');

// ── update is atomic + recorded ─────────────────────────────────────────────
const up = cc.update(null, { notes: 'kickoff done', 'budget.max_requests': 1234 }, { actor: 'op' });
assert.strictEqual(up.ok, true);
assert.strictEqual(cc.loadActive().notes, 'kickoff done');
assert.strictEqual(cc.loadActive().budget.max_requests, 1234, 'dotted set updates nested field');
assert.ok(cc.history().some((h) => h.event === 'update'));

// ── archive removes the active pointer, keeps the archive ───────────────────
const ar = cc.archive(null, { actor: 'op' });
assert.strictEqual(ar.ok, true);
assert.strictEqual(cc.loadActive(), null, 'no active campaign after archive');
assert.ok(fs.existsSync(path.join(process.env.CC_CAMPAIGNS_DIR, draft.id + '.json')), 'archived manifest kept');
assert.ok(cc.listCampaigns().some((c) => c.id === draft.id && c.status === 'archived'));
assert.ok(cc.history().some((h) => h.event === 'archive'));

// client data must never land in git — the paths are the gitignored ones (report only)
assert.ok(!String(process.env.CC_CAMPAIGN_FILE).includes(path.join(WS, 'campaign.json')), 'test used a tmp manifest');

console.log('test-cc-campaign: OK');
