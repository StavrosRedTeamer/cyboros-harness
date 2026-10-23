// runtime/terminal/approval.js — the confirm-tier approval dialog.
//
// One frame, four options, numbers always accepted and Esc taking the safe exit. The
// token is single-use and host-bound (the tool plane enforces that); this module only
// asks and returns the operator's decision. Without a TTY it prints the same frame and
// refuses, because an approval that cannot be answered is a blocked run, not consent.
'use strict';

const { OPTS } = require('./args');
const { dim, bold, gray, cyan, grn, red, box } = require('./theme');
const { state, demo } = require('./state');
const { getInput } = require('./input');

function printApprovalDetails(spec) {
  console.log('');
  console.log(`  ${bold('Command')}  ${spec.command}`);
  console.log(`  ${bold('Scope')}    ${grn('IN SCOPE')} · ${state.target} · ${demo() ? 'demo allowlist' : 'scope.json'}`);
  console.log(`  ${bold('Token')}    single-use · host-bound · expires with the session`);
  console.log(`  ${bold('Effect')}   ${spec.effect || 'intrusive timing probes; no writes, no data extraction'}`);
  console.log('');
}

async function approval(spec) {
  // Arrow-key selection, the way Claude Code asks: one frame, four options,
  // numbers still work and Esc takes the safe exit.
  const input = getInput();
  if (input) {
    // The approval owns the keyboard: yield the turn's interrupt watcher so the two
    // raw-mode readers do not fight over stdin, then take it back afterwards.
    const irq = state.irq;
    if (irq && irq.pause) irq.pause();
    console.log('');
    try {
      for (;;) {
        const choice = await input.select({
          title: `Permission required ${dim('· confirm-tier')}`,
          heading: spec.title,
          command: spec.command,
          lines: [
            `scope ${grn('IN SCOPE')} ${dim('· single-use · host-bound · ' + (demo() ? 'demo allowlist' : 'scope.json'))}`,
            dim(spec.reason || ''),
          ],
          question: 'Do you want to proceed?',
          options: ['Yes', 'No, skip this step', 'Show details', 'No, stop the run'],
        });
        if (choice === 0) return 'approve';
        if (choice === 1) return 'skip';
        if (choice === 2) { printApprovalDetails(spec); continue; }
        return 'stop';
      }
    } finally {
      if (irq && irq.resume) irq.resume();
    }
  }

  // No TTY: the same frame, printed once, with no way to answer it.
  console.log('');
  box(`Permission required ${dim('· confirm-tier')}`, [
    bold(spec.title),
    `${dim('$')} ${spec.command}`,
    '',
    `scope ${grn('IN SCOPE')} ${dim('· single-use · host-bound · ' + (demo() ? 'demo allowlist' : 'scope.json'))}`,
    dim(spec.reason),
    '',
    bold('Do you want to proceed?'),
    `${cyan('❯')} ${bold('1. Yes')}`,
    `  ${bold('2. No, skip this step')}`,
    `  ${bold('3. Show details')}`,
    `  ${bold('4. No, stop the run')}`,
  ], gray);
  console.log('');

  if (OPTS.demoApprove) {
    console.log(dim('  Choice [1-4]: 1 (--demo-approve)'));
    return 'approve';
  }
  console.log(`  ${red('✖')} approval required for a confirm-tier action, but stdin is not a TTY`);
  console.log(dim('  open a terminal, or grant the token from the Command Center inbox'));
  state.blocked = true;
  return 'notty';
}

module.exports = { approval, printApprovalDetails };
