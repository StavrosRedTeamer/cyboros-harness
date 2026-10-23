// runtime/terminal/theme.js — colour, glyphs and the text primitives.
//
// Every surface prints through these functions, so the palette and the 100-column
// wrap are decided once. Spec §11: NO_COLOR / TERM=dumb drop colour AND box-drawing;
// the transform is applied at the stream, so the box, the transcript and the readline
// prompt degrade the same way without a second rendering path.
'use strict';

const { OPTS } = require('./args');

// ── ANSI (basic, terminal-safe) ────────────────────────────────────────────
const COLOR = !!process.stdout.isTTY && !OPTS.noColor;
const a = (n) => `\x1b[${n}m`;
const paint = (n, s) => (COLOR ? `${a(n)}${s}${a(0)}` : String(s));
// Claude Code's palette: neutral chrome, one warm accent, semantic green/yellow/red.
const dim = (s) => paint(2, s);
const bold = (s) => paint(1, s);
const gray = (s) => paint('38;2;110;110;122', s);
const cyan = (s) => paint('38;2;108;160;214', s);
const mag = (s) => paint('38;2;217;119;87', s);
const grn = (s) => paint('38;2;152;195;121', s);
const ylw = (s) => paint('38;2;229;192;123', s);
const red = (s) => paint('38;2;224;108;117', s);
const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Spec §11: NO_COLOR / TERM=dumb drop colour AND box-drawing. The transform is
// applied at the stream, so every surface (box, transcript, readline prompt)
// degrades the same way without a second rendering path.
const ASCII = !!OPTS.noColor || !!OPTS.ascii;
const GLYPHS = {
  '╭': '+', '╮': '+', '╰': '+', '╯': '+', '─': '-', '│': '|',
  '⏺': '*', '⎿': '|', '◆': '*', '◈': '@', '›': '>', '❯': '>', '⏵': '>',
  '✻': '*', '✢': '*', '✳': '*', '✶': '*', '✽': '*', '●': 'o', '▎': '|',
  '→': '->', '←': '<-', '↑': '^', '↓': 'v', '✔': 'OK', '✓': 'OK', '✖': 'X', '⚠': '!',
  '■': '#', '█': '#', '░': '.', '…': '...', '·': '.', '—': '-', '–': '-',
  '’': "'", '‘': "'", '☒': '[x]', '☐': '[ ]', '◐': '[~]',
};
const toAscii = (s) => String(s).replace(/[\u2500-\u259F\u25A0-\u26FF\u2700-\u27BF\u23B0-\u23FF\u276F\u2026\u2014\u2013\u2019\u2018\u00B7\u2190-\u2193]/g, (c) => GLYPHS[c] || c);
if (ASCII) {
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, enc, cb) => write(typeof chunk === 'string' ? toAscii(chunk) : chunk, enc, cb);
}

// ── text helpers ───────────────────────────────────────────────────────────
const W = () => Math.max(60, Math.min(process.stdout.columns || 100, 100));

function wrap(text, width) {
  const out = [];
  for (const para of String(text == null ? '' : text).split('\n')) {
    if (!para.trim()) { out.push(''); continue; }
    let line = '';
    for (const word of para.trim().split(/\s+/)) {
      if (word.length > width) {
        if (line) { out.push(line); line = ''; }
        for (let i = 0; i < word.length; i += width) out.push(word.slice(i, i + width));
        continue;
      }
      if (!line) line = word;
      else if ((line + ' ' + word).length <= width) line += ' ' + word;
      else { out.push(line); line = word; }
    }
    if (line) out.push(line);
  }
  return out.length ? out : [''];
}

const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - stripAnsi(s).length));

// One labelled field that wraps instead of breaking the 100-column rule.
function field(label, text) {
  const prefix = `  ${dim(label)}  `;
  const lines = wrap(text, Math.max(20, W() - stripAnsi(prefix).length));
  console.log(prefix + lines[0]);
  for (const line of lines.slice(1)) console.log(' '.repeat(stripAnsi(prefix).length) + line);
}

function box(title, lines, color = gray) {
  const w = W();
  const t = title ? ` ${title} ` : '';
  const dash = Math.max(0, w - 3 - stripAnsi(t).length);
  const out = [color(t ? `╭─${t}${'─'.repeat(dash)}╮` : `╭${'─'.repeat(w - 2)}╮`)];
  for (const raw of lines) {
    const parts = wrap(raw, w - 6);
    parts.forEach((line, i) => {
      out.push(color('│') + ' ' + pad(i === 0 ? line : '  ' + line, w - 4) + ' ' + color('│'));
    });
  }
  out.push(color(`╰${'─'.repeat(w - 2)}╯`));
  console.log(out.join('\n'));
}

function meter(pct, width = 24) {
  const p = Math.max(0, Math.min(100, pct));
  const n = Math.max(p > 0 ? 1 : 0, Math.min(width, Math.round((p / 100) * width)));
  return '█'.repeat(n) + '░'.repeat(width - n);
}
const ANSWER_W = () => Math.max(20, W() - 6);

module.exports = {
  COLOR, dim, bold, gray, cyan, mag, grn, ylw, red, stripAnsi, sleep,
  W, wrap, pad, field, box, meter, ANSWER_W,
};
