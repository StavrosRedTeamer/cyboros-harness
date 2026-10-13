#!/usr/bin/env node
// tools/autopilot.js — the deterministic outer control loop (the "driver").
//
// Boundary: this runs as `node tools/autopilot.js`. It CAN run other node tools (via
// child_process through the guarded entrypoints) but CANNOT call the DSH `subagent`
// primitive (model-facing). So `tick` RETURNS directives; the Cyboros persona executes
// any subagent directive and calls back. Control flow (plan/loop/stop/checkpoint) is 100%
// here — deterministic, replayable, fail-closed.
//
// CLI:
//   node tools/autopilot.js plan [--json]                 # dry-run: ordered directives + verdict, executes NOTHING
//   node tools/autopilot.js tick --yes [--json]           # execute the executable auto-tier set, ingest, checkpoint (Task 4)
//   node tools/autopilot.js status [--json]               # checkpoint + pending-intrusive + coverage (Task 5)
//   node tools/autopilot.js resume [--json]               # continue from checkpoint (Task 5)
//   node tools/autopilot.js approve --batch <id> --yes    # release a queued intrusive batch (Task 5)
'use strict';
const path = require('path');
const { spawnSync } = require('child_process');
const tm = require('./target-model');
const na = require('./next-actions');
const cl = require('./coverage-loop');
const lw = require('./loop-watch');
const cont = require('./continuation');
const cb = require('./circuit-breaker');
const ck = require('./autopilot-checkpoint');

const WS = path.join(__dirname, '..');
const stateDb = () => process.env.STATE_DB || path.join(WS, 'reports', 'state.db');
const auditFile = () => process.env.RUN_AUDIT_FILE || path.join(WS, 'reports', 'tmp', 'run-audit.jsonl');

// Partition next-actions output by the approved two-tier gate. An action is EXECUTABLE only if
// it is not blocked (scope fail-closed), not already covered, and not intrusive (requires_optin).
function classify(actions) {
  const executable = [], intrusive = [], blocked = [], covered = [];
  for (const a of (actions || [])) {
    if (a.blocked) { blocked.push(a); continue; }
    if (a.requires_optin) { intrusive.push(a); continue; }
    if (a.covered) { covered.push(a); continue; }
    executable.push(a);
  }
  return { executable, intrusive, blocked, covered };
}

// Assemble every signal the circuit-breaker needs — WITHOUT executing anything.
function gatherInputs() {
  let snapshot = { generated_at: null, targets: [] };
  let gapReports = [];
  // Fail-closed scope signal for the circuit breaker: an unloadable scope.json halts the loop.
  let scopeOk = true;
  try { require('./scope-guard').loadScope(); } catch { scopeOk = false; }
  try {
    const db = tm.open(stateDb());
    snapshot = tm.snapshot(db);
    gapReports = cl.gapsFromDb(db, {});
    if (db && typeof db.close === 'function') db.close();
  } catch { /* fail-safe: empty state -> nothing executable */ }
  // ALWAYS pass the real scope predicate: plan() defaults to "everything in scope"
  // when inScope is omitted, which would silently execute out-of-scope hosts.
  const planned = na.plan(snapshot, { inScope: na.scopePredicate() });
  const parts = classify(planned.actions);
  const remaining = cl.remaining(gapReports);
  let events = [];
  try { const r = lw.readEvents([auditFile()]); events = Array.isArray(r.events) ? r.events : []; } catch { events = []; }
  const loopWatch = lw.analyze(events, { minRepeat: 5, totalRepeat: 10 });
  const advice = cont.advise({ logFile: auditFile(), tail: 8 });
  return {
    snapshot, actions: planned.actions, summary: planned.summary,
    gapReports, remaining, loopWatch, continuation: advice.analysis, scopeOk,
    targetsCount: (snapshot.targets || []).length, ...parts,
  };
}

// Build the verdict for the current tick from a checkpoint + gathered inputs.
function verdictFor(inputs, cp, budgetHalted) {
  const prevRemaining = (cp.prev_remaining == null) ? inputs.remaining : cp.prev_remaining;
  return cb.decide({
    loopWatch: inputs.loopWatch,
    continuation: inputs.continuation,
    remaining: inputs.remaining,
    prevRemaining,
    dryStreak: cp.dry_streak || 0,
    executableCount: inputs.executable.length,
    targetsCount: inputs.targetsCount,
    budgetHalted: !!budgetHalted,
    scopeOk: inputs.scopeOk,
    opts: { dryK: 2 },
  });
}

function budgetHalted() {
  // Fail-closed: an unreadable budget verdict HALTS the loop (conservative), mirroring
  // scope-guard semantics — "unknown" is never treated as "keep going".
  try {
    // Point budget.js at an isolated state when the caller set STATE_DB: without this, a
    // hermetic test (or a second engagement) would read the real workspace opstate.
    // (budget.js already reads RUN_AUDIT_FILE from the env, so the audit follows the caller.)
    const env = Object.assign({}, process.env);
    if (env.STATE_DB && !env.BUDGET_STATE_FILE) env.BUDGET_STATE_FILE = env.STATE_DB + '.opstate.json';
    const res = spawnSync(process.execPath, [path.join(__dirname, 'budget.js'), 'check'],
      { cwd: WS, env, encoding: 'utf8', timeout: 30000 });
    if (res.error || res.status !== 0) return true; // spawn failure / signal / non-zero = halt (fail-closed)
    try { const j = JSON.parse(res.stdout || '{}'); return !!(j.halt || j.halted); }
    catch { return true; } // unreadable output = halt (fail-closed)
  } catch { return true; }
}

// Run ONE executable auto-tier action. Actions carry a `cmd` string produced by
// next-actions ("node tools/run.js <bin> ..." or "node tools/workflow.js run <yaml> ...").
// This never runs intrusive actions: the caller only ever passes items from the
// `executable` set (requires_optin === false). Defense-in-depth: only cmds targeting
// the guarded entrypoints are ever spawned. llm-inject.js joins run.js/workflow.js on the
// allowlist: it is deterministic and zero-dep, and routes EVERY probe through repeater.js
// (hard scope-guard: DNS pinning, ssrf-guard B9, pacing, egress chain) — so it cannot bypass
// any control the autopilot itself enforces.
const guardedCmd = /^(node\s+)?tools\/(run|workflow|llm-inject)\.js\b/;

function cmdParts(cmd) {
  return String(cmd || '').replace(/^node\s+/, '').trim().split(/\s+/).filter(Boolean);
}

// loop-watch-compatible signature for a cmd string (bin + normalized args).
function cmdSignature(cmd) {
  const parts = cmdParts(cmd);
  if (parts[0] === 'tools/run.js') return lw.signatureOf({ bin: parts[1] || '', args: parts.slice(2) });
  return lw.signatureOf({ bin: path.basename(parts[0] || ''), args: parts.slice(1) });
}

function actionTimeout() {
  const ms = parseInt(process.env.AUTOPILOT_ACTION_TIMEOUT, 10);
  return Number.isFinite(ms) && ms > 0 ? ms : 600000; // scans are slow; run.js has its own --run-timeout
}

function executeAction(action) {
  const cmd = String(action.cmd || '');
  if (!guardedCmd.test(cmd)) return { ok: false, exit: null, signature: cmd, err: 'cmd not via guarded entrypoint' };
  const argv = cmdParts(cmd).map((x) => (x.startsWith('tools/') ? path.join(WS, x) : x));
  const res = spawnSync(process.execPath, argv,
    { cwd: WS, env: process.env, encoding: 'utf8', timeout: actionTimeout(), maxBuffer: 64 * 1024 * 1024 });
  return { ok: res.status === 0, exit: res.status, signature: cmd };
}

function cmdTick(json) {
  const cp = ck.read();
  const inputs = gatherInputs();
  const halted = budgetHalted();
  const prevRemaining = (cp.prev_remaining == null) ? inputs.remaining : cp.prev_remaining;
  const verdict = cb.decide({
    loopWatch: inputs.loopWatch, continuation: inputs.continuation,
    remaining: inputs.remaining, prevRemaining, dryStreak: cp.dry_streak || 0,
    executableCount: inputs.executable.length, targetsCount: inputs.targetsCount,
    budgetHalted: halted, scopeOk: inputs.scopeOk, opts: { dryK: 2 },
  });

  // Always enqueue newly-seen intrusive actions for one human approval (dedup by signature).
  const batchId = 'batch-' + ((cp.tick || 0) + 1); // one batch per tick, addressable via approve --batch
  const seen = new Set(cp.pending_intrusive.map((a) => a.signature));
  for (const a of inputs.intrusive) {
    const sig = String(a.cmd || '');
    if (!seen.has(sig)) { cp.pending_intrusive.push(Object.assign({ signature: sig, batch: batchId }, a)); seen.add(sig); }
  }

  const ran = [];
  const terminal = { DONE: 0, BARRIER: 3, BUDGET: 4, STUCK: 5 };
  if (!(verdict.verdict in terminal)) {
    // PROCEED or SKIP: execute the executable set, skipping the blocked signature on SKIP.
    for (const a of inputs.executable) {
      if (verdict.verdict === 'SKIP' && verdict.blockedSignature && cmdSignature(a.cmd) === verdict.blockedSignature) continue;
      ran.push(executeAction(a));
    }
  }

  // Update rolling state.
  cp.dry_streak = (inputs.remaining >= prevRemaining) ? (cp.dry_streak || 0) + 1 : 0;
  cp.prev_remaining = inputs.remaining;
  cp.tick = (cp.tick || 0) + 1;
  cp.last_verdict = verdict.verdict;
  ck.write(cp);

  // Subagent directives: an executable action tagged type:'subagent' becomes a directive the
  // PERSONA executes (autopilot cannot call the DSH subagent primitive itself). next-actions
  // does not emit this shape yet: today this is always [] (v1 = purely deterministic, option a).
  const directives = inputs.executable
    .filter((a) => a.type === 'subagent' && a.subagent_id)
    .map((a) => ({ kind: 'subagent', id: a.subagent_id, task: a.task || '' }));
  if (verdict.verdict === 'BUDGET' || verdict.verdict === 'STUCK' || cp.pending_intrusive.length) {
    directives.push({ kind: 'approval_needed', count: cp.pending_intrusive.length });
  }

  const out = { verdict: verdict.verdict, reasons: verdict.reasons, ran, directives, remaining: inputs.remaining, tick: cp.tick };
  if (json) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`[autopilot tick ${cp.tick}] verdict=${out.verdict} remaining=${out.remaining} ran=${ran.length} pending_intrusive=${cp.pending_intrusive.length}`);
    out.reasons.forEach((r) => console.log('  · ' + r));
    directives.forEach((d) => console.log('  → ' + JSON.stringify(d)));
  }
  process.exit(verdict.verdict in terminal ? terminal[verdict.verdict] : 0);
}

function cmdPlan(json) {
  const cp = ck.read();
  const inputs = gatherInputs();
  const verdict = verdictFor(inputs, cp);
  const directives = inputs.executable.map((a) => ({ kind: 'run', action: a }));
  const out = {
    verdict: verdict.verdict, reasons: verdict.reasons, remaining: inputs.remaining,
    executable: inputs.executable.length, intrusive_queued: inputs.intrusive.length,
    directives, pending_intrusive: inputs.intrusive,
  };
  if (json) { console.log(JSON.stringify(out, null, 2)); return; }
  console.log(`[autopilot plan] verdict=${out.verdict} remaining=${out.remaining} executable=${out.executable} intrusive=${out.intrusive_queued}`);
  out.reasons.forEach((r) => console.log('  · ' + r));
  inputs.executable.forEach((a, i) => console.log(`  ${i + 1}. RUN  [${a.tier}] ${a.host || ''} ${a.ref || ''} — ${a.reason || ''}`.trimEnd()));
  inputs.intrusive.forEach((a) => console.log(`  [QUEUED-INTRUSIVE] [${a.tier}] ${a.host || ''} ${a.ref || ''} — needs approval`));
}

function releaseBatch(cp, batchId) {
  const q = Array.isArray(cp.pending_intrusive) ? cp.pending_intrusive : [];
  const approved = (batchId === 'all') ? q.slice() : q.filter((a) => a.batch === batchId);
  cp.pending_intrusive = (batchId === 'all') ? [] : q.filter((a) => a.batch !== batchId);
  return { approved, remaining: cp.pending_intrusive.length };
}

function cmdStatus(json) {
  const cp = ck.read();
  const inputs = gatherInputs();
  const covPct = inputs.gapReports.length
    ? Math.round(inputs.gapReports.reduce((s, r) => s + (r.coverage_pct || 0), 0) / inputs.gapReports.length) : 100;
  const out = { tick: cp.tick, last_verdict: cp.last_verdict, remaining: inputs.remaining,
    pending_intrusive: cp.pending_intrusive, coverage_pct: covPct };
  if (json) { console.log(JSON.stringify(out, null, 2)); return; }
  console.log(`[autopilot status] tick=${out.tick} last=${out.last_verdict} remaining=${out.remaining} coverage=${out.coverage_pct}% pending_intrusive=${out.pending_intrusive.length}`);
  out.pending_intrusive.forEach((a) => console.log(`  [PENDING] ${a.signature} (batch ${a.batch || '-'})`));
}

function cmdApprove(batchId, json) {
  const fs = require('fs');
  const cp = ck.read();
  const { approved, remaining } = releaseBatch(cp, batchId || 'all');
  const outFile = path.join(WS, 'reports', 'autopilot', 'approved-intrusive.jsonl');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  for (const a of approved) fs.appendFileSync(outFile, JSON.stringify(a) + '\n');
  ck.write(cp);
  const out = { approved: approved.length, remaining, file: outFile };
  console.log(json ? JSON.stringify(out, null, 2)
    : `[autopilot approve] released ${out.approved} intrusive action(s) to ${outFile}; ${out.remaining} still pending. Run each approved action via its saved .cmd field (e.g. node tools/run.js sqlmap -u <url> --batch --dbs) — autopilot never auto-fires intrusive.`);
}

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const json = args.includes('--json');
  if (cmd === 'plan') { cmdPlan(json); }
  else if (cmd === 'tick') {
    if (!args.includes('--yes')) { console.error('tick executes actions: pass --yes to confirm'); process.exit(2); }
    cmdTick(json);
  }
  else if (cmd === 'status') { cmdStatus(json); }
  else if (cmd === 'resume') { cmdTick(json); } // a resume is a tick over the persisted checkpoint
  else if (cmd === 'approve') {
    if (!args.includes('--yes')) { console.error('approve releases intrusive actions: pass --yes'); process.exit(2); }
    const bi = args.indexOf('--batch'); cmdApprove(bi >= 0 ? args[bi + 1] : 'all', json);
  }
  else {
    console.error('usage: node tools/autopilot.js <plan [--json] | tick --yes [--json] | status [--json] | resume [--json] | approve --batch <id|all> --yes>');
    process.exit(2);
  }
}

module.exports = { classify, gatherInputs, verdictFor, budgetHalted, executeAction, cmdSignature, cmdTick, releaseBatch, cmdStatus, cmdApprove };

if (require.main === module) main();
