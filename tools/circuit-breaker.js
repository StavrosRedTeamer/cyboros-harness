#!/usr/bin/env node
// tools/circuit-breaker.js — deterministic control verdict for the autopilot loop.
//
// Composes the EXISTING guard signals (loop-watch, continuation, coverage-loop, budget) into
// ONE verdict the driver MUST obey. Pure function: no I/O, no execution, no time. Same input
// ALWAYS yields the same verdict (testable, replayable).
//
// verdict precedence (first match wins): BUDGET > scope-broken(STUCK) > DONE > STUCK > SKIP > BARRIER > PROCEED
'use strict';

const DEFAULT_DRY_K = 2;

function decide(input) {
  input = input || {};
  const reasons = [];
  const lw = input.loopWatch || { loop: false, signature: null };
  const cont = input.continuation || { loop: false, all_failed: false, error_classes: [] };
  const remaining = Number.isFinite(input.remaining) ? input.remaining : 0;
  const prevRemaining = Number.isFinite(input.prevRemaining) ? input.prevRemaining : remaining;
  const dryStreak = Number.isFinite(input.dryStreak) ? input.dryStreak : 0;
  const executableCount = Number.isFinite(input.executableCount) ? input.executableCount : 0;
  const dryK = (input.opts && Number.isFinite(input.opts.dryK)) ? input.opts.dryK : DEFAULT_DRY_K;
  const dry = remaining >= prevRemaining;
  // Fail-closed anti-false-DONE: an engagement with NO target in state/scope has remaining==0
  // by construction (gapsFromDb=[] on an empty model). That must be STUCK ("seed the
  // engagement first"), never DONE — otherwise the autopilot declares victory before starting.
  const targetsCount = Number.isFinite(input.targetsCount) ? input.targetsCount : null;

  const out = (verdict, blockedSignature = null) => ({ verdict, reasons, remaining, dry, blockedSignature });

  if (input.budgetHalted) { reasons.push('budget ceiling reached'); return out('BUDGET'); }
  if (input.scopeOk === false) {
    reasons.push('scope.json unloadable — fail-closed halt');
    return out('STUCK');
  }
  if (targetsCount === 0) {
    reasons.push('nessun target in stato/scope: fai il seed prima (stavros recon/scan o target-model ingest)');
    return out('STUCK');
  }
  if (remaining === 0) { reasons.push('coverage complete: no gaps remain'); return out('DONE'); }
  if ((cont.all_failed || cont.loop) && executableCount === 0) {
    reasons.push(cont.all_failed ? 'recent rounds all failed and no executable action remains' : 'continuation loop and no executable action remains');
    return out('STUCK');
  }
  if (lw.loop && lw.mode === 'consecutive' && lw.signature) {
    reasons.push(`loop-watch: repeating signature "${lw.signature}" x${lw.count} — skipping it`);
    return out('SKIP', lw.signature);
  }
  if (dry && dryStreak >= dryK) {
    reasons.push(`no gap reduction for ${dryStreak} rounds (>= ${dryK}) — barrier`);
    return out('BARRIER');
  }
  reasons.push('forward progress');
  return out('PROCEED');
}

module.exports = { decide, DEFAULT_DRY_K };

if (require.main === module) {
  // debug: read one JSON input object from stdin, print the verdict
  let raw = '';
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', () => {
    try { console.log(JSON.stringify(decide(JSON.parse(raw || '{}')), null, 2)); }
    catch (e) { console.error('bad input: ' + e.message); process.exit(2); }
  });
}
