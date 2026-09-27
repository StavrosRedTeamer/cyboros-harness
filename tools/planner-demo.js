#!/usr/bin/env node
// Synthetic-but-realistic end-to-end planner demo for the red-team orchestration domain.
// Builds a representative initial state (a mix: some classes with surface+findings, one true
// authed identity to exercise the authenticated branch, and the injection/disclosure evidence
// the chain_takeover needs), runs the STRIPS planner, prints the optimized step sequence with
// human-readable reasoning, and finally triggers an INSOLVIBLE case to show failure detection.
//
//   node tools/planner-demo.js           # offline synthetic host
//   node tools/planner-demo.js <host>    # derive state from reports/<host>-map.json + findings.jsonl
//
// The planner only ORDERS test actions — it never executes them. Every test_class/verify step is
// a proposal the scope-guard/run.js gates still rule on at execution time, and the non-determinism
// of the real world (a test may not yield a finding) is resolved by regenerate-state after each
// action at RFW time, NOT inside the planner.
'use strict';
const path = require('path');
const {
  solveDisplay, buildRedteamDomain, stateFromHost, stateToArray,
} = require('./planner');

const REPORTS = path.join(__dirname, '..', 'reports');

// ─── Representative synthetic host state ───
// Mirrors the invariants coverage.js/map.js/gate.js derive from real artifacts:
//   surface(c)     from candidate counts in reports/<host>-map.json
//   found(c)       from findings.jsonl via classOf()
//   authed_available from reports/auth.json existence
// Here we pin a realistic instance by hand so the demo is deterministic offline.
const syntheticState = [
  'surface(sqli)', 'found(sqli)',     // already found -> planner must NOT re-test it
  'surface(xss)',                     // reflective param candidate, untested
  'surface(authz)',                   // IDOR/BOLA endpoint -> authed branch (cheaper than generic)
  'surface(injection)',               // command/expression injection candidate (chain amplifier)
  'surface(ssrf)',                    // URL-input candidate, untested
  'surface(file-upload)',             // multipart upload candidate, untested
  'surface(crypto)',                  // weak-hash endpoint candidate, untested
  'surface(idor)',                    // object-ID endpoint candidate, untested
  'found(info-disclosure)',           // pre-existing finding (no surface listed here)
  'authed_available',                 // reports/auth.json exists -> authenticated surface in scope
];

function run(hostArg) {
  const ctx = hostArg
    ? stateFromHost(hostArg, { reportsDir: REPORTS })
    : { host: 'demo-stage.invalid', synthetic: true, state: new Set(syntheticState) };
  const host = ctx.host;
  console.log('# Planner demo — host ' + host + (ctx.synthetic ? '  (synthetic offline state)' : '  (state from reports/)'));
  console.log('\ninitial state:');
  console.log('  ' + stateToArray(ctx.state).join('\n  '));

  // Goal: every surfaced class must end up found (kills the coverage "missed" that blocks the
  // report gate) AND authz must be exploited (verified) — maximize impact per class.
  const goal = [];
  for (const a of ctx.state) {
    const m = /^surface\(([a-z0-9-]+)\)$/.exec(a);
    if (m) goal.push('found(' + m[1] + ')');
  }
  goal.push('exploited(authz)');
  console.log('\ngoal: ' + goal.join(' AND '));

  const dom = buildRedteamDomain();
  const r = solveDisplay(dom, stateToArray(ctx.state), goal);
  console.log('\n=== plan (cost=' + r.cost + ', explored=' + r.explored + ' nodes) ===');
  if (!r.solvable) {
    console.log('insolvibile — reason: ' + r.reason);
    return;
  }
  console.log('step-by-step:');
  for (const p of r.plan) {
    const why = reasonText(p);
    console.log('  [' + p.step + ']  ' + p.name);
    console.log('        ' + why);
    console.log('        pre: ' + p.pre.join(', ') + '   -> +' + p.add.join(',+'));
    if (p.action === 'chain_takeover_injection') {
      console.log('        ^ deterministic chain (was built by hand in chain.js) — now discovered by the planner');
    }
  }

  // ─── Insolvable case: a goal no action can produce ───
  console.log('\n\n=== INSOLVIBLE case: goal exploited(llm) — no llm surface, no route to it ===');
  const badGoal = ['exploited(llm)'];
  const bad = solveDisplay(dom, stateToArray(ctx.state), badGoal);
  console.log('goal: ' + badGoal.join(' AND '));
  console.log(bad.solvable ? 'soluble (unexpected!)' : 'insolvibile — reason: ' + bad.reason + '  (explored ' + bad.explored + ' nodes)');
  if (bad.solvable) process.exit(1);
  console.log('\nDemo complete. The planner PROPOSES a sequence; execution + real-world finding\nnon-determinism stay with the harness (regenerate state after each action, scope-guard decides).');
}

function reasonText(p) {
  if (!p.reason) return p.name;
  const i = p.action.indexOf('_');
  const cls = i > 0 ? p.action.slice(i + 1) : '';
  return p.reason.replace(/\{(\d)\}/g, (_, n) => (p.params && p.params[n] != null ? p.params[n] : cls));
}

const hostArg = process.argv[2];
run(hostArg);