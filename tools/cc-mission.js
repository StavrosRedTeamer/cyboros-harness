#!/usr/bin/env node
// WP5 — Mission control: UN payload deterministico che dice "cosa adesso e perché".
//
// Non c'è nessun LLM qui: ogni voce viene dai moduli dell'harness (next-actions, coverage-loop,
// gate, budget), quindi i numeri coincidono per costruzione con l'output CLI. Ogni card porta
// `why`, `tier` e `cost` — e le azioni confirm-tier non partono mai da sole.
//
// Read-only. Il dispatch (esecuzione) vive nel router e passa SEMPRE dai wrapper esistenti
// (run.js / workflow.js / stavros.js) — questo modulo produce solo la specifica di argv.
//
// CLI:
//   node tools/cc-mission.js show [--json]
//   node tools/cc-mission.js dispatch --tool tools/run.js -- <args...>   (stampa la specifica)
'use strict';
const fs = require('fs');
const path = require('path');
const u = require('./cc-util');

const root = () => process.env.CC_ROOT || u.ROOT;
const reports = () => path.join(root(), 'reports');
const gateLogFile = () => process.env.GATE_LOG_FILE || path.join(reports(), 'gate-log.md');
const scopeFile = () => process.env.SCOPE_JSON || path.join(root(), 'scope.json');

function readText(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } }

// Tools the app is allowed to dispatch through. Anything else is refused fail-closed.
const ALLOWED_TOOLS = new Set([
  'tools/run.js', 'tools/workflow.js', 'tools/stavros.js',
  'tools/gate.js', 'tools/budget.js', 'tools/report-html.js', 'tools/coverage-loop.js',
]);

function safeInt(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }

// ── gates ───────────────────────────────────────────────────────────────────
function gatesPayload() {
  let gate;
  try { gate = require('./gate'); } catch { return []; }
  const log = readText(gateLogFile());
  return Object.keys(gate.GATES).map((id) => {
    let r = null;
    try { r = gate.runGate(id); } catch { /* keep null */ }
    const passed = gate.gateLogHasPass(log, id);
    return {
      id, title: (r && r.title) || id, passed,
      all_ok: !!(r && r.allOk),
      missing: r ? r.results.filter((x) => !x.ok).map((x) => x.detail) : [],
      manual: (r && r.manual) || [],
    };
  });
}

// ── budget (spawn the CLI so the exit-code contract is reused verbatim) ──────
function budgetPayload() {
  const env = Object.assign({}, process.env);
  if (env.STATE_DB && !env.BUDGET_STATE_FILE) env.BUDGET_STATE_FILE = env.STATE_DB + '.opstate.json';
  const r = u.runTool([path.join('tools', 'budget.js'), 'check'], { env });
  let json = null;
  try { json = JSON.parse((r.stdout || '').trim()); } catch { /* non-JSON */ }
  return {
    enabled: json ? json.enabled !== false : false,
    halted: !!(json && json.halted),
    exceeded: (json && json.exceeded) || [],
    operator_action: json && json.operator_action ? json.operator_action : null,
    exit_code: r.code,
    detail: json && json.note ? json.note : null,
    // Pass-through per il War Room (burn % e proiezione al ritmo medio): stessi numeri
    // della CLI, nessuna seconda spawn di budget.js.
    counters: (json && json.counters) || null,
    caps: (json && json.caps) || null,
    notes: (json && json.notes) || [],
  };
}

// ── planner + coverage (one model snapshot, never re-read) ──────────────────
function plannerPayload() {
  try {
    const tm = require('./target-model');
    const db = tm.open();
    try {
      const na = require('./next-actions');
      const cl = require('./coverage-loop');
      return {
        next: na.planFromDb(db, {}),
        coverage: cl.gapsFromDb(db, {}),
      };
    } finally { if (db && typeof db.close === 'function') db.close(); }
  } catch (e) {
    return { next: { actions: [], summary: null }, coverage: [], error: String((e && e.message) || e) };
  }
}

function checkpointPayload() {
  try { return require('./autopilot-checkpoint').read(); } catch { return null; }
}

function approvalsPayload() {
  try {
    return require('./cc-approvals').list({ all: false }).filter((t) => t.status === 'pending' || t.status === 'granted');
  } catch { return []; }
}

function campaignPayload() {
  try {
    const cc = require('./cc-campaign');
    const c = cc.loadActive();
    if (!c) return null;
    return { id: c.id, name: c.name, client: c.client, status: c.status, validation: cc.validate(c), drift: cc.drift(c) };
  } catch { return null; }
}

// ── unified action cards ────────────────────────────────────────────────────
// Each card: { source, label, why, tier, cost, host, cmd, blocked, requires_approval, ref }
function buildActions(p) {
  const cards = [];
  for (const a of (p.next.actions || [])) {
    cards.push({
      source: 'planner',
      label: (a.host || '') + (a.surface ? ' · ' + a.surface : ''),
      why: a.reason || a.scope_reason || '',
      tier: a.requires_optin ? 'confirm' : 'auto',
      cost: safeInt(a.priority, 0),
      host: a.host || null,
      cmd: a.cmd || null,
      ref: a.ref || null,
      blocked: !!a.blocked,
      blocked_reason: a.blocked ? (a.scope_reason || 'out of scope') : null,
      requires_approval: !!a.requires_optin,
      covered: !!a.covered,
    });
  }
  for (const rep of (p.coverage || [])) {
    for (const gap of (rep.gaps || [])) {
      cards.push({
        source: 'coverage',
        label: rep.host + ' · gap ' + gap,
        why: rep.coverage_pct + '% covered on ' + rep.host + ' — class ' + gap + ' untested',
        tier: 'auto',
        cost: 5,
        host: rep.host,
        cmd: null,
        blocked: false,
        requires_approval: false,
      });
    }
  }
  if (p.budget.halted) {
    cards.push({
      source: 'budget',
      label: 'Budget halt — operator reset',
      why: 'budget cap reached (' + p.budget.exceeded.map((e) => e.cap).join(', ') + '); agent is stopped until an operator resets',
      tier: 'confirm',
      cost: 100,
      cmd: 'node tools/budget.js reset --reason "<why>"',
      ref: 'budget-reset',
      blocked: false,
      requires_approval: true,
    });
  }
  for (const ap of (p.approvals || [])) {
    cards.push({
      source: 'approval',
      label: (ap.status === 'pending' ? 'Pending: ' : 'Approved: ') + ap.action_class + ' → ' + ap.host,
      why: ap.reason || 'requested by ' + (ap.requested_by || 'agent'),
      tier: 'confirm',
      cost: 50,
      host: ap.host,
      cmd: null,
      ref: ap.id,
      blocked: false,
      requires_approval: ap.status === 'pending',
      approval_id: ap.id,
    });
  }
  return cards.sort((a, b) => b.cost - a.cost);
}

function build(opts) {
  const o = opts || {};
  const pl = plannerPayload();
  const p = {
    generated_at: u.nowIso(),
    campaign: campaignPayload(),
    next: pl.next,
    coverage: pl.coverage,
    coverage_error: pl.error || null,
    gates: gatesPayload(),
    budget: budgetPayload(),
    checkpoint: checkpointPayload(),
    approvals: approvalsPayload(),
    scope_fail_closed: (() => { try { const sg = require('./scope-guard'); const s = sg.loadScope(); return !(s.allowed_hosts.length || s.allowed_url_prefixes.length || s.allowed_ips.length); } catch { return true; } })(),
  };
  p.actions = buildActions(p);
  p.headline = {
    open_actions: p.actions.filter((a) => !a.blocked && a.tier === 'auto').length,
    blocked: p.actions.filter((a) => a.blocked).length,
    needs_approval: p.actions.filter((a) => a.requires_approval).length,
    pending_approvals: p.approvals.filter((a) => a.status === 'pending').length,
    gates_passed: p.gates.filter((g) => g.passed).length,
    gates_total: p.gates.length,
    coverage_remaining: (p.coverage || []).reduce((n, r) => n + (r.gaps ? r.gaps.length : 0), 0),
    budget_halted: p.budget.halted,
    scope_fail_closed: p.scope_fail_closed,
  };
  return p;
}

// ── dispatch spec ───────────────────────────────────────────────────────────
// The router uses this to turn a request into a safe argv. NEVER a shell string,
// NEVER a tool outside the allowlist. `confirm` actions need an approval token.
function dispatchSpec(body) {
  const b = body || {};
  let argv = Array.isArray(b.argv) ? b.argv.map(String) : null;
  if (!argv && b.cmd) argv = String(b.cmd).trim().split(/\s+/);
  if (!argv || !argv.length) return { ok: false, error: 'missing argv (or cmd)' };
  const tool = argv[0];
  if (!ALLOWED_TOOLS.has(tool)) return { ok: false, error: 'tool not allowed for dispatch: ' + tool };
  if (argv.some((a) => a.includes('\u0000'))) return { ok: false, error: 'invalid argument' };
  const confirmTier = !!b.confirm || b.tier === 'confirm';
  return { ok: true, argv, tool, confirmTier, host: b.host || null, approval: b.approval || null };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function main(argv) {
  const cmd = argv[0] || 'show';
  if (cmd === 'show') {
    console.log(JSON.stringify(build(), null, 2));
    return 0;
  }
  if (cmd === 'dispatch') {
    const toolIdx = argv.indexOf('--tool');
    const tool = toolIdx >= 0 ? argv[toolIdx + 1] : null;
    const sep = argv.indexOf('--');
    const rest = sep >= 0 ? argv.slice(sep + 1) : [];
    const spec = dispatchSpec({ argv: tool ? [tool].concat(rest) : rest });
    console.log(JSON.stringify(spec, null, 2));
    return spec.ok ? 0 : 1;
  }
  console.error('usage: node tools/cc-mission.js show [--json] | dispatch --tool <tools/tool.js> [-- tier] -- <args...>');
  return 2;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { build, buildActions, dispatchSpec, gatesPayload, budgetPayload, ALLOWED_TOOLS };
