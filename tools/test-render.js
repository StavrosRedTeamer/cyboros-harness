#!/usr/bin/env node
// Offline tests for runtime/render.js and runtime/inputline.js — the typography
// layer behind the TUI.
//
// What is being protected:
//   · assistant prose is rendered, not echoed: ** ** and ` ` disappear, headings
//     lose their #, lists get a bullet, tables line up and drop the separator row;
//   · every rendered line fits the width the caller asked for;
//   · the streaming renderer emits markup already applied, buffers a table until
//     the block ends, and never prints an opening fence;
//   · the input box is exactly as wide as requested, shows the placeholder only
//     when empty, and keeps the cursor inside the box on a wrapped line.
//
// Run: node tools/test-render.js
'use strict';

const assert = require('assert');
const { ok, summary } = require('./testkit');
const { renderMarkdown, createStream, inline } = require('../runtime/render');
const { layoutBox, layoutMenu, layoutSelect, layoutPlain, wrapRows, strWidth } = require('../runtime/inputline');

const clean = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
const width = (s) => clean(s).length;

ok('inline markdown is rendered, not echoed', () => {
  const out = clean(inline('a **bold** word and `code` and *italic*', false));
  assert.ok(out.includes('bold') && !out.includes('**'), 'bold markers gone');
  assert.ok(out.includes('code') && !out.includes('`'), 'code ticks gone');
  assert.ok(out.includes('italic') && !out.includes('*italic*'), 'italic markers gone');
});

ok('headings, lists and rules lose their syntax', () => {
  const lines = renderMarkdown('## Findings\n\n- one\n- two\n\n---', { width: 40 }).map(clean);
  assert.ok(lines.includes('Findings'), 'heading text kept, # dropped');
  assert.ok(lines.some((l) => l.trimStart().startsWith('• one')), 'bullet rendered');
  assert.ok(lines.some((l) => l.trimStart().startsWith('• two')), 'every bullet rendered');
  assert.ok(lines.some((l) => /^─+$/.test(l)), 'rule rendered as a line');
});

ok('a table is aligned and its separator row is not data', () => {
  const lines = renderMarkdown('| seq | title |\n|---|---|\n| 1 | BOLA |\n| 2 | IDOR |', { width: 60 }).map(clean);
  const start = lines.findIndex((l) => l.includes('seq'));
  assert.ok(start >= 0, 'header is printed');
  const body = lines.slice(start, start + 4);
  assert.strictEqual(body.length, 4, 'header, rule, two rows');
  assert.ok(!body.some((l) => l.includes('---')), 'separator row is not printed');
  assert.strictEqual(body[0].indexOf('title'), body[2].indexOf('BOLA'), 'second column starts at the same place');
  assert.ok(body[0].trim().startsWith('seq'), 'header first');
});

ok('a cell longer than its column wraps instead of overflowing', () => {
  const md = '| seq | title |\n|---|---|\n| 1 | BOLA on GET /api/orders/{id}: any authenticated identity reads any order |';
  const lines = renderMarkdown(md, { width: 60 }).map(clean);
  for (const l of lines) assert.ok(width(l) <= 60, `fits 60: ${width(l)} ${JSON.stringify(l)}`);
  assert.ok(lines.length > 3, 'the long cell took more than one row');
});

ok('prose is wrapped to the requested width', () => {
  const text = 'The server echoes the identity without ever comparing it to the object owner, which is the whole bug.';
  for (const w of [30, 48, 72]) {
    const lines = renderMarkdown(text, { width: w });
    for (const l of lines) assert.ok(width(l) <= w, `line fits ${w}: ${width(l)}`);
  }
});

ok('a fenced block keeps its text and is not parsed as markdown', () => {
  const lines = renderMarkdown('before\n```\n**not bold**\n```\nafter', { width: 60 }).map(clean);
  assert.ok(lines.some((l) => l.includes('**not bold**')), 'code is literal');
  assert.ok(!lines.some((l) => l.includes('```')), 'fence not printed');
});

ok('the stream applies markup as it prints and marks the first line', () => {
  const got = [];
  const s = createStream({ width: 40, color: false, onLine: (line, meta) => got.push({ line: clean(line), first: meta.first }) });
  s.push('**Objects** ');
  s.push('are not owned by the caller.\n');
  s.end();
  assert.ok(got.length >= 1);
  assert.ok(got[0].first, 'first line is marked');
  assert.ok(!got[0].line.includes('**'), 'markers are already applied');
});

ok('the stream waits for the whole table before printing it', () => {
  const got = [];
  const s = createStream({ width: 60, color: false, onLine: (line) => got.push(clean(line)) });
  s.push('| a | b |\n| 1 | 2 |\n');
  assert.strictEqual(got.length, 0, 'nothing before the block ends');
  s.end();
  assert.strictEqual(got.length, 3, 'header, rule, one row');
});

ok('the box is the requested width and holds the placeholder when empty', () => {
  const box = layoutBox({ text: '', cursor: 0, width: 60, color: false, placeholder: 'Try something', hintLeft: '? for shortcuts', hintRight: 'ask' });
  for (const line of box.lines.slice(0, 3)) assert.strictEqual(strWidth(line), 60, 'border row is exactly 60');
  assert.ok(box.lines[1].includes('Try something'), 'placeholder shown');
  assert.ok(box.lines[1].includes('> '), 'cue shown');
  assert.strictEqual(box.cursorRow, 1, 'cursor on the input row');
});

ok('the placeholder disappears once there is text, and long input grows the box', () => {
  const short = layoutBox({ text: 'hi', cursor: 2, width: 40, color: false, placeholder: 'Try something' });
  assert.ok(!short.lines[1].includes('Try something'), 'no placeholder with text');
  const long = layoutBox({ text: 'x'.repeat(120), cursor: 120, width: 40, color: false });
  assert.ok(long.lines.length > 5, 'wrapped input grows the box');
  for (const line of long.lines) if (!/^\?/.test(line)) assert.strictEqual(strWidth(line), 40, 'every line stays 40 wide');
  assert.ok(long.cursorRow >= 2 && long.cursorRow < long.lines.length, 'cursor inside the body');
  assert.ok(long.cursorCol >= 1 && long.cursorCol <= 40, 'cursor column inside the box');
});

ok('the slash menu sits above the box and marks the selection', () => {
  const items = [
    { name: '/scope', desc: 'show or check the authorization' },
    { name: '/status', desc: 'session card' },
  ];
  const menu = layoutMenu({ items, index: 1 }, 60, false);
  assert.strictEqual(menu.length, 4, 'top border, two rows, bottom border');
  for (const line of menu) assert.strictEqual(strWidth(line), 60, 'menu is box-wide');
  assert.ok(menu[2].includes('❯') && menu[2].includes('/status'), 'selected row is marked');
  assert.ok(!menu[1].includes('❯'), 'only one marker');
  assert.ok(menu[1].includes('show or check'), 'descriptions are shown');

  const withMenu = layoutBox({ text: '/s', cursor: 2, width: 60, color: false, menu: { items, index: 0 } });
  assert.ok(withMenu.lines[0].startsWith('╭'), 'menu is the first thing drawn');
  assert.ok(withMenu.cursorRow > menu.length, 'the cursor stays in the input row');
});

ok('the permission frame is a selectable list', () => {
  const frame = layoutSelect({
    width: 60,
    color: false,
    title: 'Permission required',
    heading: 'Escalate with sqlmap',
    command: 'node tools/run.js sqlmap -u https://target',
    lines: ['scope IN SCOPE'],
    question: 'Do you want to proceed?',
    options: ['Yes', 'No, skip this step', 'Show details', 'No, stop the run'],
    index: 2,
  });
  for (const line of frame.lines) assert.strictEqual(strWidth(line), 60, 'frame is box-wide');
  const rows = frame.lines.join('\n');
  assert.ok(rows.includes('Permission required'), 'title in the border');
  assert.ok(rows.includes('Do you want to proceed?'), 'question shown');
  assert.ok(rows.includes('❯ 3. Show details'), 'index selects the third option');
  assert.ok(!rows.includes('❯ 1. Yes'), 'only the selected option is marked');
});

ok('a backslash newline keeps the prompt on multiple rows', () => {
  const box = layoutBox({ text: 'first line\nsecond line', cursor: 22, width: 50, color: false });
  assert.strictEqual(box.lines.length, 4, 'top border, two rows, bottom border');
  assert.ok(box.lines[2].includes('second line'), 'continuation rendered');
});

ok('the plain prompt keeps the question inline', () => {
  const p = layoutPlain({ prompt: '  Choice [1-4]: ', text: '2' });
  assert.strictEqual(p.lines.length, 1);
  assert.strictEqual(clean(p.lines[0]), '  Choice [1-4]: 2');
  assert.strictEqual(p.cursorRow, 0);
});

ok('wrapRows keeps source offsets stable across a break', () => {
  const rows = wrapRows('alpha beta gamma delta', 11);
  assert.ok(rows.length >= 2, 'wrapped');
  for (const r of rows) assert.ok(strWidth(r.text) <= 11, 'row fits');
  assert.strictEqual(rows[0].start, 0, 'first row starts at zero');
});

summary();
