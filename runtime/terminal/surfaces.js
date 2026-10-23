// runtime/terminal/surfaces.js — what the operator reads: the welcome box, the status row,
// /help and /usage, and the transcript primitives (a user turn, an answer, a tool row,
// a finding, the todo block).
//
// Rendering only: the numbers come from state.js, the command list from
// command-table.js, the markdown from render.js. `aborted()` is honoured so a
// scripted or live turn that Esc already took back stops printing mid-block.
'use strict';

const { VERSION } = require('./args');
const {
  COLOR, dim, bold, cyan, mag, grn, ylw, red, wrap, pad, box, W, ANSWER_W,
} = require('./theme');
const { renderMarkdown, todoLines } = require('../render');
const { CMDS } = require('./command-table');
const {
  state, demo, scopeBadge, scopeDetail, targetLabel, phaseTag, modeTag, budget, costFigure,
} = require('./state');
const { aborted, pace } = require('./turn');

// ── surfaces ───────────────────────────────────────────────────────────────
function welcome() {
  console.log('');
  const row = (label, value) => `  ${dim(label.padEnd(9))}${value}`;
  const live = state.live;
  box('', [
    `${mag('✻')} ${bold('Cyboros Harness')} ${dim(VERSION)}${state.live ? dim(' · live') : ''}`,
    dim('Authorized engagement assistant · guarded tools · scope.json is the authorization'),
    '',
    row('cwd', process.cwd()),
    row('scope', `${scopeBadge()} ${dim('· ' + scopeDetail())}`),
    row('target', `${cyan(targetLabel())} ${dim('· ' + phaseTag())}`),
    row('model', `${dim(state.profile + '/' + state.model)}${state.egress && state.egress !== '—' ? dim(' · ' + state.egress + (state.egress === 'cloud' ? ' (authorized)' : '')) : ''}`),
    row('session', live ? cyan(live.session.id) : dim(demo() ? 'not started · synthetic walkthrough' : 'not started')),
    '',
    bold('Tips for getting started'),
    `${dim('1.')} Ask what the ledger already proves — findings, sessions, scope`,
    `${dim('2.')} Ask it to test a class on the target; ${dim('scope_check')} runs before any probe`,
    `${dim('3.')} ${dim('/help')} lists every command, ${dim('/status')} the session card`,
    '',
    dim('/help for help · /status for your current setup'),
  ]);
  console.log(dim(state.live
    ? `  live · thinking ${state.thinking ? 'shown' : 'hidden'} · nothing leaves the host except the provider request`
    : demo()
      ? '  Synthetic walkthrough · no model calls · no network · no disk writes.'
      : '  Shell only · no model is called · scope.json is real, findings are read-only.'));
  console.log('');
}

// Non-TTY status row: the transcript's footer when there is no input box to sit under.
function statusLine() {
  const parts = [
    cyan(targetLabel()),
    dim(phaseTag()),
    dim(`${state.profile}/${state.model}`),
    dim(`ctx ${state.contextPct}%`),
    dim(costFigure()),
    dim(`${budget().req}/${state.budget.maxReq} req`),
    modeTag(),
  ];
  if (state.live) parts.push(grn('live'));
  console.log('');
  console.log('  ' + parts.join(dim(' · ')));
}

function printHelp() {
  console.log('');
  console.log('  ' + bold('Commands'));
  for (const [cmd, desc] of CMDS) {
    console.log('  ' + cyan(pad(cmd, 30)) + dim(desc));
  }
  console.log('');
  console.log('  ' + bold('Keys'));
  for (const [key, desc] of [
    ['ctrl+c', 'clear the input · twice to exit'],
    ['ctrl+d', 'exit'],
    ['↑ / ↓', 'history · move in the menu'],
    ['tab', 'complete the highlighted command'],
    ['shift+tab', 'cycle mode (ask → plan → auto)'],
    ['\\ + enter', 'newline in the prompt'],
    ['esc', 'interrupt the running turn'],
    ['?', 'shortcuts, when the input is empty'],
  ]) {
    console.log('  ' + cyan(pad(key, 30)) + dim(desc));
  }
  console.log('');
  console.log(dim('  /live calls a real OpenAI-compatible provider and runs the guarded tools;'));
  console.log(dim('  without it the transcript is scripted. scope.json is always real.'));
  console.log('');
}

function printUsage() {
  console.log('');
  console.log(`  ${bold('cyboros tui')} ${dim('· ' + VERSION)}`);
  console.log('');
  console.log(`  ${bold('Usage')}    node runtime/tui.js [host] [options]`);
  console.log('');
  console.log(`  ${bold('Options')}`);
  for (const [flag, desc] of [
    ['--demo', 'run the scripted SQLi walkthrough (synthetic scope)'],
    ['--live', 'call a real provider from runtime/providers.json'],
    ['--resume <id>', 'continue a saved session, then stay in the REPL (implies --live)'],
    ['--allow-stale', 'resume a session older than the staleness limit'],
    ['--task <text>', 'one live turn, then exit (implies --live)'],
    ['--profile <name>', 'provider profile for the live loop'],
    ['--config <file>', 'provider config (default runtime/providers.json)'],
    ['--phase <p>', 'live phase (default web-test)'],
    ['--class <c>', 'live class (optional)'],
    ['--allow-cloud', 'authorize a cloud-egress profile for this run'],
    ['--demo-approve', 'approve the demo confirm-tier action (no TTY)'],
    ['--scope <file>', 'authorization file (default scope.json / SCOPE_JSON)'],
    ['--fast', 'no typing delays'],
    ['--script', 'read commands from stdin, no TTY'],
    ['--ascii', 'no Unicode drawing (implied by --no-color)'],
    ['--no-color', 'no ANSI colour and no Unicode drawing'],
    ['--help', 'this guide'],
    ['--version', 'print the version'],
  ]) {
    console.log('  ' + cyan(pad(flag, 18)) + dim(desc));
  }
  console.log('');
  console.log(`  ${bold('Exit')}    0 done · 1 blocked (scope or approval) · 2 usage · 5 provider config/key`);
  console.log('');
  console.log(`  ${bold('Examples')}`);
  console.log(dim('    node runtime/tui.js'));
  console.log(dim('    node runtime/tui.js app.example.com'));
  console.log(dim('    node runtime/tui.js --demo --fast'));
  console.log(dim('    node runtime/tui.js --live --allow-cloud app.example.com'));
  console.log(dim("    printf '/help\\n/scope\\n/quit\\n' | node runtime/tui.js --script --no-color"));
  console.log('');
  console.log(dim('  Shell: no model call, no network request. scope.json decides; sessions write their log.'));
  console.log(dim('  --live: the provider request is real and tools run through tools/run.js.'));
  console.log(dim('  --resume: state.json next to the session log is validated, then continued.'));
  console.log('');
}

// User input in the transcript: `> ` and a subtle band, the way the box you typed
// into reads once it is history.
function userBlock(text) {
  console.log('');
  const width = W() - 2;
  for (const line of wrap(text, width - 4)) {
    // Truecolor, not 256: the band must read the same in every terminal theme.
    if (COLOR) console.log(`\x1b[48;2;45;45;48m\x1b[38;2;232;230;236m${pad('  > ' + line, width)}\x1b[0m`);
    else console.log(`  > ${line}`);
  }
}

function sayUser(text) {
  userBlock(text);
}

async function assistant(text) {
  if (aborted()) return;
  const lines = renderMarkdown(text, { width: ANSWER_W(), color: COLOR });
  console.log('');
  lines.forEach((line, i) => {
    console.log(i === 0 ? `  ${bold('⏺')} ${line}` : `    ${line}`);
  });
  console.log('');
  await pace(35);
}

// Claude Code's tool row: the call on the bullet, every result line hanging off a
// single ⎿, and the long tail collapsed into a count instead of flooding the log.
async function tool(name, args, result, ms, opts = {}) {
  if (aborted()) return;
  console.log(`  ${bold('⏺')} ${bold(name)}${args ? dim('(' + args + ')') : ''}`);
  const tone = opts.tone === 'ok' ? grn : opts.tone === 'warn' ? ylw : opts.tone === 'bad' ? red : (s) => s;
  console.log(`    ${dim('⎿')}  ${tone(result)}${ms ? dim('  ' + ms) : ''}`);
  const details = opts.details || [];
  const shown = state.details ? details.slice(0, 8) : details.slice(0, 2);
  for (const d of shown) console.log(`       ${dim(d)}`);
  if (details.length > shown.length) console.log(`       ${dim(`… +${details.length - shown.length} lines (/details to expand)`)}`);
  await pace(130);
}

async function finding(f) {
  if (aborted()) return;
  console.log('');
  const sev = f.sev === 'CRITICAL' ? red : f.sev === 'HIGH' ? mag : f.sev === 'MEDIUM' ? ylw : cyan;
  console.log(`  ${mag('◆')} ${bold('finding')} ${dim('·')} ${sev(f.sev)} ${dim('·')} ${bold(f.title)} ${dim(f.endpoint)}`);
  console.log(`    ${dim('⎿')}  verify_level ${f.verify} ${dim('→')} ceiling ${f.ceiling}${f.extra ? dim('  ·  ' + f.extra) : ''}`);
  if (f.note) {
    for (const line of wrap(f.note, W() - 9)) console.log(`       ${dim(line)}`);
  }
  await pace(160);
}

// Claude Code's TodoWrite block: the plan as a checklist, done/active/pending.
// Here the plan is the engagement's own coverage, so the operator reads it the
// way they read the model's task list. `state.todos` is the source of truth.
async function updateTodos(items, opts = {}) {
  if (aborted()) return;
  if (items) state.todos = items;
  const list = state.todos || [];
  if (!list.length) return;
  console.log('');
  console.log(`  ${bold('⏺')} ${bold(opts.title || 'Update Todos')}`);
  const rows = todoLines(list, { color: COLOR });
  rows.forEach((row, i) => console.log(i === 0 ? `    ${dim('⎿')}  ${row}` : `       ${row}`));
  await pace(120);
}

module.exports = {
  welcome, statusLine, printHelp, printUsage,
  userBlock, sayUser, assistant, tool, finding, updateTodos,
};
