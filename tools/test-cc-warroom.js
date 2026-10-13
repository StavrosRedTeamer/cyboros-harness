// Offline self-check for WP10 (war room snapshot): composition, fail-closed posture,
// attention rail, delta-ready fields. Hermetic: every path (CC_ROOT, scope, approvals,
// campaign, sessions, budget, findings, gate) points into a mkdtemp, never the workspace.
// Run: node tools/test-cc-warroom.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WS = path.join(__dirname, '..');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'stavros-cc-warroom-'));

process.env.CC_ROOT = T;
process.env.STATE_DB = path.join(T, 'state.db');
process.env.GATE_WS = path.join(T, 'gate-ws');
fs.mkdirSync(path.join(process.env.GATE_WS, 'reports'), { recursive: true });
process.env.GATE_LOG_FILE = path.join(T, 'gate-log.md');
process.env.CC_OPSTATE_FILE = path.join(T, 'operation-state.json');
process.env.CC_APPROVALS_FILE = path.join(T, 'approvals.jsonl');
process.env.CC_CAMPAIGN_FILE = path.join(T, 'campaign.json');
process.env.CC_CAMPAIGNS_DIR = path.join(T, 'campaigns');
process.env.CC_HISTORY_FILE = path.join(T, 'reports', 'campaign-history.jsonl');
process.env.CC_TEMPLATES_DIR = path.join(WS, 'templates', 'campaign');
process.env.AUDIT_DIR = path.join(T, 'artifacts', 'audit');
process.env.RUN_AUDIT_FILE = path.join(T, 'run-audit.jsonl');
process.env.SCOPE_JSON = path.join(T, 'scope.json');
process.env.SESSIONS_JSON = path.join(T, 'sessions.json');
process.env.BUDGET_STATE_FILE = path.join(T, 'operation-state.json');
process.env.BUDGET_CONFIG_FILE = path.join(T, 'budget.json');
process.env.FINDINGS_JSONL = path.join(T, 'reports', 'findings.jsonl');

const war = require('./cc-warroom');
const gate = require('./gate');
const chain = require('./chain-log');

// ── 1. empty workspace: fail-closed and honest, never a throw ───────────────
{
  const s = war.build({});
  assert.ok(s.generated_at, 'snapshot has a timestamp');
  assert.strictEqual(s.campaign, null, 'no active campaign');
  assert.strictEqual(s.scope.fail_closed, true, 'empty scope is fail-closed');
  assert.ok(s.attention.some((i) => i.id === 'scope-fail-closed' && i.tone === 'crit'), 'attention flags fail-closed scope');
  assert.ok(s.attention.some((i) => i.id === 'no-campaign'), 'attention flags the missing campaign');
  assert.strictEqual(s.approvals.pending, 0);
  assert.strictEqual(s.jobs.source, 'cli', 'no runner in CLI mode');
  assert.strictEqual(s.jobs.running.length, 0);
  assert.ok(Array.isArray(s.ledger.feed), 'ledger feed is an array even when empty');
  assert.strictEqual(s.headline !== null, true, 'mission headline is composed in');
  assert.deepStrictEqual(s.ledger.chain, gate.checkChain(path.join(T, 'reports', 'findings.jsonl')), 'chain verdict == gate.js');
}

// ── 2. scope + campaign + approvals + sessions compose into one snapshot ────
const cc = require('./cc-campaign');
const approvals = require('./cc-approvals');
fs.writeFileSync(process.env.SCOPE_JSON, JSON.stringify({ allowed_hosts: ['lab.local'], allowed_ips: ['127.0.0.1'] }));
{
  const t = cc.fromTemplate('web-app', { client: 'acme', name: 'acme web' });
  assert.ok(t.ok, 'campaign template resolves');
  const act = cc.activate(t.campaign, { actor: 'test' });
  assert.ok(act.ok, 'campaign activates');

  const rq = approvals.request({ host: 'lab.local', action_class: 'c2', command: 'nmap lab.local', reason: 'war room test' });
  assert.ok(rq.ok, 'approval request accepted: ' + JSON.stringify(rq));

  fs.writeFileSync(process.env.SESSIONS_JSON, JSON.stringify({
    sessions: {
      s1: { id: 's1', host: 'lab.local', status: 'active', artifacts: [{ removed: false }, { removed: true }] },
      s2: { id: 's2', host: 'lab.local', status: 'pending' },
    },
  }));

  const s = war.build({ tail: 10 });
  assert.strictEqual(s.scope.fail_closed, false, 'non-empty scope no longer fails closed');
  assert.strictEqual(s.campaign.id, act.campaign.id, 'active campaign is projected');
  assert.strictEqual(s.campaign.drift.stale, false, 'scope hash anchored at activation');
  assert.strictEqual(s.approvals.pending, 1, 'pending approval counted');
  assert.ok(s.attention.some((i) => i.id === 'approvals-pending'), 'approval shows up on the attention rail');
  assert.strictEqual(s.sessions.active, 1);
  assert.strictEqual(s.sessions.pending, 1);
  assert.strictEqual(s.sessions.rows.find((r) => r.id === 's1').open_artifacts, 1, 'only unremoved artifacts count as open');
  assert.ok(s.attention.some((i) => i.id === 'session-pending-s2'), 'pending teardown shows up on the attention rail');
  // attention is sorted: everything critical first, so the operator sees the worst at the top
  const firstWarn = s.attention.findIndex((i) => i.tone === 'warn');
  const lastCrit = s.attention.map((i) => i.tone).lastIndexOf('crit');
  assert.ok(lastCrit < firstWarn || firstWarn === -1, 'crit items sort before warn items');
}

// ── 3. jobs: running age + failures come from the runner snapshot ───────────
{
  const s = war.build({
    jobs: [
      { id: 'job1', name: 'nmap', state: 'running', exitCode: null, startedAt: new Date(Date.now() - 40 * 60000).toISOString(), finishedAt: null },
      { id: 'job2', name: 'report-html', state: 'error', exitCode: 1, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() },
    ],
  });
  assert.strictEqual(s.jobs.source, 'server');
  assert.strictEqual(s.jobs.running.length, 1);
  assert.ok(s.jobs.running[0].age_minutes >= 39, 'running job carries its age');
  assert.strictEqual(s.jobs.failed.length, 1);
  assert.ok(s.attention.some((i) => i.id === 'job-long-job1'), 'a long-running job is an attention item');
  assert.ok(s.attention.some((i) => i.id === 'job-failed-job2'), 'a failed job is an attention item');
}

// ── 4. budget burn + ETA at the average rate (same numbers as the CLI) ──────
{
  const started = new Date(Date.now() - 60 * 60000).toISOString();
  fs.writeFileSync(process.env.BUDGET_CONFIG_FILE, JSON.stringify({ max_requests: 100, max_wall_minutes: 480 }));
  fs.writeFileSync(process.env.BUDGET_STATE_FILE, JSON.stringify({ version: 1, created_at: started, updated_at: started, pending: [], budget: { started_at: started } }));
  fs.writeFileSync(process.env.RUN_AUDIT_FILE, Array.from({ length: 25 }, () => JSON.stringify({ ts: started, bin: 'nmap' })).join('\n') + '\n');

  const s = war.build({});
  assert.strictEqual(s.budget.enabled, true, 'budget config picked up');
  assert.strictEqual(s.budget.halted, false);
  assert.strictEqual(s.budget.burn.available, true);
  assert.strictEqual(s.budget.burn.requests.used, 25);
  assert.strictEqual(s.budget.burn.requests.cap, 100);
  assert.strictEqual(s.budget.burn.requests.pct, 25);
  // 25 requests in ~60 wall minutes => 75 left at ~0.42/min => ~180 min
  assert.ok(s.budget.burn.eta_minutes >= 170 && s.budget.burn.eta_minutes <= 190, 'ETA projects the average rate: ' + s.budget.burn.eta_minutes);
  assert.ok(s.headline.budget_halted === false);
}

// ── 5. findings chain: intact, then tampered → crit on the attention rail ───
{
  const findings = path.join(T, 'reports', 'findings.jsonl');
  const now = new Date().toISOString();
  const l1 = chain.buildChainedLine({ severity: 'Low', title: 'a', host: 'lab.local', status: 'confirmed', ts: now }, []);
  const l2 = chain.buildChainedLine({ severity: 'High', title: 'b', host: 'lab.local', status: 'confirmed', ts: now }, [l1]);
  fs.writeFileSync(findings, l1 + '\n' + l2 + '\n');

  const okSnap = war.build({});
  assert.strictEqual(okSnap.ledger.chain.ok, true, 'intact chain reads as intact');
  assert.deepStrictEqual(okSnap.ledger.chain, gate.checkChain(findings), 'chain verdict matches gate.js');
  assert.strictEqual(okSnap.findings.recent.length, 2, 'fresh findings land in the 60m window');

  fs.writeFileSync(findings, l1.replace('"a"', '"x"') + '\n' + l2 + '\n');
  const bad = war.build({});
  assert.strictEqual(bad.ledger.chain.ok, false, 'tampered chain reads as broken');
  assert.ok(bad.attention.some((i) => i.id === 'chain-broken' && i.tone === 'crit'), 'a broken chain is critical');
  assert.strictEqual(bad.attention[0].tone, 'crit', 'critical items lead the rail');
}

// ── 6. scope drift since anchoring ──────────────────────────────────────────
{
  fs.writeFileSync(process.env.SCOPE_JSON, JSON.stringify({ allowed_hosts: ['lab.local', 'extra.local'], allowed_ips: ['127.0.0.1'] }));
  const s = war.build({});
  assert.strictEqual(s.campaign.drift.stale, true, 'scope changed after activation');
  assert.ok(s.attention.some((i) => i.id === 'scope-stale' && i.tone === 'warn'), 'drift is an attention item');
}

// ── 7. campaign attribution: window > activation, and it is declared ────────
{
  // basis precedence, pure
  assert.strictEqual(war.campaignTimeline(null).basis, 'none');
  const winT = war.campaignTimeline({ id: 'x', window: { start: '2026-01-01T00:00:00Z', end: '2026-02-01T00:00:00Z' } });
  assert.strictEqual(winT.basis, 'window', 'an explicit RoE window wins');
  assert.strictEqual(winT.to, '2026-02-01T00:00:00Z');

  // one OLD approval in the append-only store must NOT count as campaign activity
  const oldTs = new Date(Date.now() - 48 * 3600e3).toISOString();
  fs.appendFileSync(process.env.CC_APPROVALS_FILE, JSON.stringify({
    type: 'request', id: 'ap-old', host: 'lab.local', action_class: 'c2', command_hash: 'deadbeef',
    scope_verdict: 'allowed', ttl_sec: 900, requested_by: 'test', reason: 'pre-campaign', ts: oldTs,
  }) + '\n');
  // two runs since activation: one plain, one refused by the guards
  const nowIso = new Date().toISOString();
  fs.appendFileSync(process.env.RUN_AUDIT_FILE, [
    JSON.stringify({ ts: nowIso, bin: 'nmap', args: ['-sV', 'lab.local'], hosts: ['lab.local'], blocked: false }),
    JSON.stringify({ ts: nowIso, bin: 'msfconsole', hosts: ['out.example'], blocked: true, reason: 'scope' }),
  ].join('\n') + '\n');
  // one gate pass since activation, one before it
  fs.appendFileSync(process.env.GATE_LOG_FILE, [
    `| ${nowIso} | stavros/map | pass | criteria | campaign |`,
    `| ${oldTs} | stavros/recon | pass | criteria | legacy |`,
  ].join('\n') + '\n');

  const s = war.build({
    jobs: [
      { id: 'job-now', name: 'nmap', state: 'running', exitCode: null, startedAt: nowIso, finishedAt: null },
      { id: 'job-old', name: 'report-html', state: 'error', exitCode: 1, startedAt: oldTs, finishedAt: oldTs },
    ],
  });
  const cs = s.campaign_scope;
  assert.strictEqual(cs.active, true);
  assert.strictEqual(cs.attributable, true, 'activation entry makes the campaign attributable');
  assert.strictEqual(cs.basis, 'activation', 'no RoE window -> activation is the basis');
  assert.ok(cs.from && cs.age_minutes >= 0, 'the window start is reported with its age');
  assert.strictEqual(cs.declared_classes.length > 0, true, 'the template classes are projected');

  // findings: the two tampered-chain fixtures from §5 carry ts=now, so both are in-campaign
  assert.strictEqual(cs.findings.total, 2, 'only findings recorded during the campaign count');
  assert.strictEqual(cs.findings.high, 1);
  assert.strictEqual(cs.findings.low, 1);
  assert.strictEqual(cs.findings.untimestamped, 0);
  assert.strictEqual(s.findings.total !== null, true, 'workspace totals stay available alongside');

  // approvals: the pre-campaign request is excluded, the in-campaign one is not
  assert.strictEqual(cs.approvals.requested, 1, 'pre-campaign approval is not campaign activity');
  // runs: the 25 budget rows are 60m old (before activation), and the refused run targets an
  // OUT-OF-SCOPE host: only the in-scope run is campaign activity, the refusal is reported apart
  assert.strictEqual(cs.runs.started, 1);
  assert.strictEqual(cs.runs.blocked, 0);
  assert.strictEqual(cs.runs.excluded_out_of_scope, 1, 'the out-of-scope run is counted as excluded');
  assert.strictEqual(cs.runs.refused_out_of_scope, 1, 'the guard refusal is reported, not dropped');
  assert.ok(s.attention.some((i) => i.id === 'runs-out-of-scope'), 'refusals outside the scope stay visible on the rail');
  // gates: only the phase passed inside the window
  assert.deepStrictEqual(cs.gates.passed, ['map'], 'pre-campaign gate passes do not leak in');
  // jobs: the live runner is filtered too
  assert.strictEqual(cs.jobs.started, 1, 'only jobs started during the campaign');
  assert.strictEqual(cs.jobs.failed, 0);
  assert.strictEqual(s.jobs.failed.length, 1, 'workspace job failures are still reported');

  // every feed row carries an explicit attribution, and the old approval is flagged false
  assert.ok(s.ledger.feed.every((r) => r.in_campaign === true || r.in_campaign === false), 'feed rows are attributed');
  assert.ok(s.ledger.feed.some((r) => r.kind === 'approval' && r.id === 'ap-old' && r.in_campaign === false), 'the pre-campaign row is marked out of campaign');
  assert.ok(s.ledger.feed.some((r) => r.in_campaign === true), 'campaign rows are marked in campaign');
}

// ── 8b. scope: what belongs to another engagement never counts on this board ─
{
  const now = new Date().toISOString();
  const rows = [
    chain.buildChainedLine({ severity: 'High', title: 'in scope', host: 'lab.local', status: 'confirmed', ts: now }, []),
  ];
  rows.push(chain.buildChainedLine({ severity: 'Critical', title: 'other engagement', host: 'other.example', status: 'confirmed', ts: now }, rows));
  rows.push(chain.buildChainedLine({ severity: 'Info', title: 'derived', host: 'lab.local', endpoint: 'https://lab.local/x', ts: now }, rows));
  fs.writeFileSync(process.env.FINDINGS_JSONL, rows.join('\n') + '\n');
  fs.writeFileSync(process.env.SESSIONS_JSON, JSON.stringify({
    sessions: {
      s1: { id: 's1', host: 'lab.local', status: 'active' },
      s2: { id: 's2', host: 'other.example', status: 'active' },
    },
  }));

  const f = war.scopeFilter();
  assert.strictEqual(f.applied, true, 'a non-empty scope means the filter is on');
  assert.strictEqual(f.check('lab.local'), true);
  assert.strictEqual(f.check('sub.lab.local'), true, 'derivatives of an authorized host are in scope');
  assert.strictEqual(f.check('lab.local.evil.example'), false, 'a lookalike suffix is not');
  assert.strictEqual(f.check('other.example'), false);

  const s = war.build({});
  assert.strictEqual(s.findings.total, 2, 'only the in-scope findings count');
  assert.strictEqual(s.findings.source_total, 3, 'the raw total stays available');
  assert.strictEqual(s.findings.excluded_out_of_scope, 1, 'the excluded count is declared, never silent');
  assert.strictEqual(s.engagement.scope_applied, true);
  assert.strictEqual(s.engagement.excluded.findings, 1);
  assert.ok(s.engagement.authorized.some((a) => a.value === 'lab.local' && a.kind === 'host'), 'the authorized set is projected');
  assert.ok(s.attention.some((i) => i.id === 'findings-out-of-scope'), 'hidden findings are announced on the rail');

  assert.strictEqual(s.sessions.total, 1, 'a session on an out-of-scope host is not part of this engagement');
  assert.strictEqual(s.sessions.excluded, 1);
  assert.strictEqual(s.findings.recent.length, 2, 'the fresh-findings window is scoped too');
}

// ── 8c. host focus: one host + its derivatives, declared in campaign.host ──
{
  const active = JSON.parse(fs.readFileSync(process.env.CC_CAMPAIGN_FILE, 'utf8'));
  assert.strictEqual(war.normalizeHost('https://App.Lab.Local:8443/x?y=1'), 'app.lab.local', 'a pasted URL is normalized');
  assert.strictEqual(war.normalizeHost('  '), null);
  assert.strictEqual(war.build({}).host_focus, null, 'no focus declared -> the board spans the whole scope');

  active.host = 'lab.local';
  fs.writeFileSync(process.env.CC_CAMPAIGN_FILE, JSON.stringify(active));
  const s = war.build({});
  assert.strictEqual(s.host_focus.host, 'lab.local');
  assert.strictEqual(s.host_focus.in_scope, true);
  assert.ok(s.host_focus.identities.includes('lab.local'), 'identities are projected');
  assert.strictEqual(s.host_focus.findings.total, 2, 'only findings naming the focus host');
  assert.strictEqual(s.host_focus.findings.in_campaign.total, 2, 'the host totals are split by the campaign window');
  assert.ok(s.host_focus.findings.recent.every((r) => r.in_campaign === true), 'each recent row says whether it is campaign activity');
  assert.strictEqual(s.host_focus.sessions, 1, 'sessions on the focus host');
  assert.strictEqual(s.engagement.focus.source, 'campaign');
  assert.ok(s.ledger.feed.some((r) => r.on_focus === true), 'feed rows touching the focus host are flagged');
  const m = war.identityMatcher(['lab.local']);
  assert.strictEqual(war.rowOnFocus({ kind: 'approval', host: 'lab.local' }, m), true);
  assert.strictEqual(war.rowOnFocus({ kind: 'approval', host: 'other.example' }, m), false, 'another host is not the focus');
  assert.strictEqual(war.rowOnFocus({ kind: 'audit', entry: { hosts: ['app.lab.local'] } }, m), true, 'a derivative matches the focus host');
  assert.strictEqual(war.rowOnFocus({ kind: 'audit', entry: { action: 'gate' } }, m), null, 'a row with no host stays unattributable, not "in focus"');

  active.host = 'other.example';
  fs.writeFileSync(process.env.CC_CAMPAIGN_FILE, JSON.stringify(active));
  const bad = war.build({});
  assert.strictEqual(bad.host_focus.in_scope, false, 'an out-of-scope focus is reported as such');
  assert.strictEqual(bad.host_focus.findings.total, 0, 'nothing in scope is attributed to it');
  assert.ok(bad.attention.some((i) => i.id === 'focus-out-of-scope' && i.tone === 'crit'), 'an out-of-scope focus is critical');

  delete active.host;
  fs.writeFileSync(process.env.CC_CAMPAIGN_FILE, JSON.stringify(active));
}

// ── 8. a campaign with no window and no activation entry is NOT attributable ─
{
  fs.writeFileSync(process.env.CC_CAMPAIGN_FILE, JSON.stringify({
    version: 1, id: 'manual-campaign', name: 'Manual', status: 'active',
    created_at: new Date().toISOString(), gates: ['recon'], classes: ['sqli'],
  }));
  const s = war.build({});
  assert.strictEqual(s.campaign.id, 'manual-campaign');
  assert.strictEqual(s.campaign_scope.attributable, false);
  assert.strictEqual(s.campaign_scope.basis, 'none');
  assert.strictEqual(s.campaign_scope.findings, undefined, 'no invented campaign numbers');
  assert.ok(s.attention.some((i) => i.id === 'campaign-not-attributable'), 'the board says it cannot attribute');
  assert.ok(s.ledger.feed.every((r) => r.in_campaign === null), 'feed rows are unattributed, not silently in-campaign');
}

console.log('test-cc-warroom: OK');
