// runtime/terminal/input.js — the keyboard surface.
//
// The boxed editor owns stdin on a TTY (runtime/inputline.js draws it); readline owns it
// everywhere else, so --script and a pipe behave exactly like a terminal for the parts
// that matter. The command menu is built from command-table.js, and the module exposes
// the live editor so the approval dialog and the connect offer can take the keyboard.
'use strict';

const readline = require('node:readline');
const { createInput } = require('../inputline');
const { COLOR, dim, bold, cyan, pad } = require('./theme');
const { state, targetLabel, costFigure, ev } = require('./state');
const { CMDS } = require('./command-table');

// ── input queue ────────────────────────────────────────────────────────────
let rl = null;
let INPUT = null;
let closed = false;
let waiting = null;
const buf = [];

function ask(promptStr) {
  // The boxed editor owns stdin on a TTY; readline owns it everywhere else.
  // A prompt string means an inline question (approvals); no prompt means the box.
  if (INPUT) return INPUT.read(promptStr ? { plain: true, prompt: promptStr } : {});
  if (promptStr) process.stdout.write(promptStr);
  if (buf.length) return Promise.resolve(buf.shift());
  if (closed) return Promise.resolve(null);
  return new Promise((resolve) => { waiting = resolve; });
}

function closeRL() {
  if (rl && !closed) rl.close();
}

// One entry per real command: CMDS writes aliases as `/plan | /auto | /ask` and
// the menu needs them separately.
const MENU = [];
function buildMenu() {
  for (const [raw, desc] of CMDS) {
    for (const part of raw.split('|')) {
      const name = part.trim().split(/\s+/)[0];
      if (name && !MENU.some((m) => m.name === name)) MENU.push({ name, desc });
    }
  }
}
buildMenu();

// shift+tab cycles the execution mode, like Claude Code's accept-edits toggle.
function cycleMode() {
  const order = ['ask', 'plan', 'auto'];
  const next = order[(order.indexOf(state.mode) + 1) % order.length];
  state.mode = next;
  ev('mode', next);
  return next;
}

function printShortcuts() {
  console.log('');
  console.log(`  ${bold('Shortcuts')}`);
  for (const [key, desc] of [
    ['ctrl+c', 'clear the input · twice to exit'],
    ['ctrl+d', 'exit'],
    ['↑ / ↓', 'history · move in the menu'],
    ['tab', 'complete · next command'],
    ['shift+tab', 'cycle mode (ask → plan → auto)'],
    ['\\ + enter', 'newline in the prompt'],
    ['esc', 'interrupt a turn · dismiss the menu'],
    ['/', 'command menu · ? this panel'],
  ]) {
    console.log('  ' + cyan(pad(key, 12)) + dim(desc));
  }
  console.log('');
}

function initInput() {
  INPUT = createInput({
    color: COLOR,
    placeholder: 'Try "what did we find on this target?" · /help for commands',
    hint: () => `${state.live ? '⏵⏵ live' : '⏵⏵ ' + state.mode} · shift+tab to cycle · ${targetLabel()} · ${costFigure()}`,
    menu: (line) => {
      const q = line.trim().split(/\s+/)[0];
      if (!q.startsWith('/')) return [];
      return MENU.filter((m) => m.name.startsWith(q));
    },
    onCycleMode: cycleMode,
    onShortcuts: printShortcuts,
    borderColor: () => (state.mode === 'plan' ? '38;2;108;160;214' : undefined),
    completer: (line) => {
      if (!line.startsWith('/')) return [];
      const names = MENU.map((m) => m.name);
      const hits = names.filter((n) => n.startsWith(line));
      return hits.length ? hits : names;
    },
  });
}

function setupRL(onLine) {
  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: !!process.stdin.isTTY,
    history: [],
    historySize: 200,
    removeHistoryDuplicates: true,
    completer: (line) => {
      if (!line.startsWith('/')) return [[], line];
      const names = CMDS.map((c) => c[0].split(' ')[0]);
      const hits = names.filter((n) => n.startsWith(line));
      return [hits.length ? hits : names, line];
    },
  });

  rl.on('line', (line) => {
    if (onLine) onLine();
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(line);
    } else {
      buf.push(line);
    }
  });

  rl.on('close', () => {
    closed = true;
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(null);
    }
  });
}
module.exports = {
  ask, closeRL, initInput, setupRL, getInput: () => INPUT,
  prompt: () => { if (rl) rl.prompt(); },
};
