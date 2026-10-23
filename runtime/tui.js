#!/usr/bin/env node
// runtime/tui.js — Cyboros Harness interactive CLI (prototype).
//
// A Claude Code-shaped terminal surface for the harness: welcome box, inline
// transcript, tool calls, confirm-tier approval, slash commands and a status
// line. Without `--live` it is a SHELL for the model loop: no provider call is
// made and the transcript is scripted. What is real is the authorization: outside
// `--demo` the REPL reads scope.json through tools/scope-guard.js and refuses
// out-of-scope targets fail-closed. `/findings` and `/sessions` read the existing
// ledgers. With `--live` each turn is persisted next to the session log
// (runtime/session-state.js), and `/resume` or `--resume <id>` continues it
// instead of rediscovering the target.
//
// This file is the entry point and the wiring. The pieces live in runtime/terminal/:
//   args.js           argv → OPTS (read once)
//   theme.js          palette, glyphs, the 100-column text primitives
//   state.js          session state, scope verdict, the spend accessor
//   input.js          the boxed/readline input, the command menu
//   command-table.js  the slash commands as data
//   surfaces.js       welcome, status, /help, transcript rows
//   turn.js           one live turn, the spinner, Esc, the connect offer
//   approval.js       the confirm-tier dialog
//   demo.js           the scripted walkthrough
//   commands.js       slash commands that change the session
//   ledger.js         read-only views over what the engagement recorded
//
// Uso:
//   node runtime/tui.js [host]           # REPL interattivo, scope.json reale
//   node runtime/tui.js --scope <file>   # altra autorizzazione (o SCOPE_JSON)
//   node runtime/tui.js --demo           # walkthrough SQLi scriptato
//   node runtime/tui.js --demo --demo-approve --fast --no-color
//   node runtime/tui.js --script         # comandi da stdin, senza TTY
//   node runtime/tui.js --help
//
// Zero dipendenze: node:readline, ANSI e il guard già presente nel repo.
'use strict';

const path = require('node:path');
// Loaded first: it installs the ASCII stream transform before any surface prints.
const { dim, bold, field, red } = require('./terminal/theme');
const { OPTS, VERSION } = require('./terminal/args');
const {
  state, demo, PHASES, CLASSES, reloadScope, allowed, targetOf, scopeReason, allowedSummary,
} = require('./terminal/state');
const { printUsage, welcome, statusLine, userBlock } = require('./terminal/surfaces');
const { initInput, setupRL, ask, closeRL, getInput, prompt } = require('./terminal/input');
const { initLive, liveTurn, handleMessage } = require('./terminal/turn');
const { runDemo } = require('./terminal/demo');
const { handleCommand } = require('./terminal/commands');
const { cmdSessions } = require('./terminal/ledger');

let sigints = 0;

function closeInput() {
  const input = getInput();
  if (input) input.destroy();
}

// ── main ───────────────────────────────────────────────────────────────────
async function main() {
  if (OPTS.version) { console.log(VERSION); return; }
  if (OPTS.help) { printUsage(); return; }
  if (OPTS.demo && OPTS.live) {
    console.error('cyboros tui: choose --demo (scripted) or --live (provider), not both.');
    process.exitCode = 2;
    return;
  }

  // The commands validate these; the flags must not be a way around that, or a typo
  // launches an engagement whose phase/class no command would accept.
  if (OPTS.phase && !PHASES.includes(OPTS.phase)) {
    console.error(`cyboros tui: unknown phase "${OPTS.phase}" · ${PHASES.join(' | ')}`);
    process.exitCode = 2;
    return;
  }
  if (OPTS.klass && !CLASSES.includes(OPTS.klass)) {
    console.error(`cyboros tui: unknown class "${OPTS.klass}" · ${CLASSES.join(' | ')}`);
    process.exitCode = 2;
    return;
  }

  if (!process.stdin.isTTY && !OPTS.demo && !OPTS.script && !OPTS.task) {
    console.error('cyboros tui: interactive mode needs a TTY. Use --demo, --script or --task.');
    process.exitCode = 2;
    return;
  }

  if (process.stdin.isTTY) initInput();
  else setupRL(() => { sigints = 0; });

  if (OPTS.target) {
    reloadScope();
    if (!allowed(OPTS.target)) {
      console.log('');
      console.log(`  ${red('✖')} ${bold(OPTS.target)} is out of scope`);
      field('verdict', dim(scopeReason(OPTS.target)));
      field('allowed', allowedSummary());
      console.log(dim('  nothing was run · edit the authorization and retry; there is no override'));
      console.log('');
      process.exitCode = 1;
      closeInput();
      closeRL();
      return;
    }
    state.target = targetOf(OPTS.target);
  }

  // `--resume` shows what it holds before connecting: if the provider is refused (no
  // consent, no key) the operator still learns what the session contained, and a session
  // that cannot be loaded stops here instead of quietly starting a fresh one.
  if (OPTS.resume) {
    cmdSessions(OPTS.resume);
    if (!state.resumeId) {
      process.exitCode = 1;
      closeInput();
      closeRL();
      return;
    }
  }

  if (OPTS.live) {
    const live = initLive();
    if (!live) {
      // initLive owns code → exit status and the text that goes with it. A null with no
      // recorded refusal is an internal fault, not a provider refusal, and says so by
      // exiting 1 instead of borrowing the refusal's status.
      process.exitCode = state.liveFailure ? state.liveFailure.exit : 1;
      closeInput();
      closeRL();
      return;
    }
    if (live.resumed()) {
      console.log(dim(`  continuing ${live.session.id} · ${(live.history() || []).length} message(s) in context`));
      console.log('');
    }
  }

  welcome();

  if (OPTS.task) {
    // A question about prior work needs no target; a target action will ask for scope_check.
    userBlock(OPTS.task);
    await liveTurn(OPTS.task);
    // One-shot run: a confirm-tier step that needed a TTY is a failed run (spec §11).
    // The interactive REPL is different — there the operator is still there and can continue.
    if (state.blocked && !process.exitCode) process.exitCode = 1;
    if (state.live) state.live.finish(process.exitCode ? 'error' : 'ok');
    closeInput();
    closeRL();
    return;
  }

  if (OPTS.demo) {
    await runDemo('sqli');
    if (!process.stdin.isTTY) {
      console.log('');
      statusLine();
      if (state.blocked) process.exitCode = 1;
      closeInput();
      closeRL();
      return;
    }
  }

  for (;;) {
    if (!getInput()) statusLine();

    const raw = await ask();
    if (raw == null) break;
    const line = raw.trim();
    if (!line) continue;

    userBlock(line);

    if (line.startsWith('/')) {
      const result = await handleCommand(line);
      if (result === 'quit') break;
      continue;
    }
    await handleMessage(line);
  }

  if (state.live) state.live.finish(process.exitCode ? 'error' : 'ok');
  closeInput();
  closeRL();
  console.log(dim(state.live
    ? `\n  session closed · ${state.live.session.id} · events under ${path.relative(process.cwd(), state.live.session.dir) || state.live.session.dir}\n`
    : demo()
      ? '\n  session closed · resume with cyboros agent resume 01J8Z…\n'
      : '\n  session closed · nothing was persisted (a --live session writes reports/agent/sessions)\n'));
}

process.on('SIGINT', () => {
  sigints += 1;
  if (sigints >= 2) {
    if (state.live) state.live.finish('interrupted');
    console.log(dim('\n  bye.\n'));
    process.exit(0);
  }
  console.log(dim('\n  interrupted · ctrl+c again to exit · /quit\n'));
  if (process.stdin.isTTY) prompt();
});

main().catch((err) => {
  console.error(red('fatal: ' + (err && (err.stack || err.message) || err)));
  process.exitCode = 1;
});