// runtime/render.js — the transcript's typography.
//
// Claude Code's terminal look is mostly three things: assistant prose is Markdown
// rendered (bold, inline code, lists, tables), tool output hangs off a single `⎿`,
// and every block is indent-aligned under its bullet. This module owns the first
// piece so the TUI stays about layout and the model loop.
//
// Zero dependencies, no ANSI when `color` is false, and every function takes the
// width it must fit in — the TUI's 100-column rule is enforced by the caller.
'use strict';

const S = {
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',
  cyan: '\x1b[36m',
  reset: '\x1b[0m',
};

const paint = (code, text, color) => (color && text !== '' ? code + text + S.reset : String(text));

function visible(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '');
}

function len(s) {
  return visible(s).length;
}

// Word wrap that never splits a word unless it is longer than the line itself.
function wrap(text, width) {
  const w = Math.max(8, width);
  const out = [];
  for (const para of String(text == null ? '' : text).split('\n')) {
    if (!para.trim()) { out.push(''); continue; }
    let line = '';
    for (const word of para.trim().split(/\s+/)) {
      if (len(word) > w) {
        if (line) { out.push(line); line = ''; }
        let rest = word;
        while (len(rest) > w) { out.push(rest.slice(0, w)); rest = rest.slice(w); }
        line = rest;
        continue;
      }
      if (!line) line = word;
      else if (len(line) + 1 + len(word) <= w) line += ' ' + word;
      else { out.push(line); line = word; }
    }
    if (line) out.push(line);
  }
  return out.length ? out : [''];
}

// Inline Markdown: **bold**, *italic*, `code`, [text](url), and the escapes that
// survive a model that likes to write ** rather a lot.
function inline(text, color) {
  let s = String(text == null ? '' : text);
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, code) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => (color ? `${label} ${S.dim}${url}${S.reset}` : `${label} (${url})`));
  s = s.replace(/\*\*([^*]+)\*\*/g, (_, t) => paint(S.bold, t, color));
  s = s.replace(/__([^_]+)__/g, (_, t) => paint(S.bold, t, color));
  s = s.replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,;:!?]|$)/g, (_, pre, t) => pre + paint(S.italic, t, color));
  s = s.replace(/(^|[\s(])_([^_\s][^_]*?)_(?=[\s).,;:!?]|$)/g, (_, pre, t) => pre + paint(S.italic, t, color));
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => paint(S.cyan, codes[Number(i)], color));
  // Anything the rules above did not consume is literal asterisks/underscores.
  return s;
}

const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_RE = /^\s*\|/;
const FENCE_RE = /^\s*(```|~~~)/;

function isTableSeparator(line) {
  return /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes('-');
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

// Columns are padded to the widest cell, then narrowed proportionally if the
// table would cross the width. Cells that no longer fit WRAP inside their column
// instead of overflowing it — an overflowing cell is what makes a terminal table
// unreadable, and the model writes long titles. No outer border: the table is text.
function table(rows, width, color) {
  const header = splitRow(rows[0]);
  const body = rows.slice(1).filter((r) => !isTableSeparator(r)).map(splitRow);
  const cols = Math.max(header.length, ...body.map((r) => r.length));
  const cells = [header, ...body].map((r) => Array.from({ length: cols }, (_, i) => r[i] || ''));
  const widths = Array.from({ length: cols }, (_, i) => Math.max(1, ...cells.map((r) => len(r[i]))));
  const gap = 2;
  const total = () => widths.reduce((a, b) => a + b, 0) + gap * (cols - 1);
  while (total() > width) {
    let widest = 0;
    for (let i = 1; i < cols; i += 1) if (widths[i] > widths[widest]) widest = i;
    if (widths[widest] <= 4) break;
    widths[widest] -= 1;
  }
  const renderRow = (r, style) => {
    const wrapped = r.map((c, i) => wrap(c, Math.max(4, widths[i])));
    const height = Math.max(...wrapped.map((w) => w.length));
    const out = [];
    for (let li = 0; li < height; li += 1) {
      out.push(wrapped.map((w, i) => {
        const text = w[li] || '';
        const pad = ' '.repeat(Math.max(0, widths[i] - len(text)));
        const cellText = inline(text, color) + pad;
        return style ? style(cellText) : cellText;
      }).join(' '.repeat(gap)).replace(/\s+$/, ''));
    }
    return out;
  };
  const out = renderRow(cells[0], (t) => paint(S.bold, t, color));
  out.push(paint(S.dim, widths.map((w) => '─'.repeat(w)).join(' '.repeat(gap)), color));
  for (const r of cells.slice(1)) out.push(...renderRow(r));
  return out;
}

function renderMarkdown(text, opts = {}) {
  const width = Math.max(20, opts.width || 80);
  const color = !!opts.color;
  const out = [];
  const src = String(text == null ? '' : text).replace(/\r/g, '').split('\n');
  const blank = () => { if (out.length && out[out.length - 1] !== '') out.push(''); };

  for (let i = 0; i < src.length; i += 1) {
    const raw = src[i];
    const line = raw.replace(/\s+$/, '');

    if (!line.trim()) { blank(); continue; }

    const fence = line.match(FENCE_RE);
    if (fence) {
      blank();
      const marker = fence[1];
      i += 1;
      for (; i < src.length && !new RegExp('^\\s*' + marker).test(src[i]); i += 1) {
        const code = src[i].replace(/\t/g, '  ');
        out.push(paint(S.dim, '  ' + code.slice(0, width - 2), color));
      }
      blank();
      continue;
    }

    if (TABLE_RE.test(line)) {
      blank();
      const rows = [];
      for (; i < src.length && TABLE_RE.test(src[i]); i += 1) rows.push(src[i]);
      i -= 1;
      if (rows.length) out.push(...table(rows, width, color));
      blank();
      continue;
    }

    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
      blank();
      out.push(paint(S.dim, '─'.repeat(Math.min(width, 60)), color));
      blank();
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blank();
      for (const l of wrap(inline(heading[2], color), width)) out.push(paint(S.bold, l, color));
      blank();
      continue;
    }

    const list = line.match(LIST_RE);
    if (list) {
      const [, indent, marker, rest] = list;
      const bullet = /^\d/.test(marker) ? marker.replace(/[.)]$/, '.') : '•';
      const lead = ' '.repeat(Math.min(8, indent.length + (/^\d/.test(marker) ? bullet.length + 1 : 2)));
      const body = wrap(inline(rest, color), Math.max(10, width - lead.length));
      out.push(lead + (bullet === '•' ? paint(S.dim, '•', color) + ' ' : bullet + ' ') + body[0]);
      for (const l of body.slice(1)) out.push(' '.repeat(lead.length + (bullet === '•' ? 2 : bullet.length + 1)) + l);
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const body = wrap(inline(line.replace(/^\s*>\s?/, ''), color), Math.max(10, width - 2));
      for (const l of body) out.push(paint(S.dim, '▎ ', color) + paint(S.dim, l, color));
      continue;
    }

    for (const l of wrap(inline(line, color), width)) out.push(l);
  }

  while (out.length && out[out.length - 1] === '') out.pop();
  return out.length ? out : [''];
}

// Streaming renderer: prose comes a line at a time (wrapped at `width`), tables
// wait until the block ends because column widths are only known then, and a
// fenced block waits for its closing fence for the same reason.
//
// onLine(text, meta) is called per visual line; meta.first is true for the first
// line of the block so the caller can put ⏺ on it and indent the rest.
function createStream(opts = {}) {
  const width = Math.max(20, opts.width || 80);
  const color = !!opts.color;
  const emit = typeof opts.onLine === 'function' ? opts.onLine : () => {};
  let raw = '';
  let mode = 'prose';
  let tableRows = [];
  let fenceLines = [];
  let started = false;
  let firstEmitted = false;

  const pushLine = (text, meta = {}) => {
    const line = text == null ? '' : String(text);
    if (!line.trim()) return;
    emit(line, Object.assign({ first: !firstEmitted }, meta));
    firstEmitted = true;
    started = true;
  };

  const flushTable = () => {
    if (!tableRows.length) return;
    for (const l of table(tableRows, width, color)) pushLine(l, { table: true });
    tableRows = [];
  };

  const flushFence = () => {
    for (const l of fenceLines) pushLine(paint(S.dim, l, color), { code: true });
    fenceLines = [];
  };

  const endLine = () => {
    if (!raw.trim()) { raw = ''; return; }
    const line = raw;
    raw = '';
    if (TABLE_RE.test(line)) { tableRows.push(line); return; }
    flushTable();
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      for (const l of wrap(heading[2], width)) pushLine(paint(S.bold, inline(l, color), color), { heading: true });
      return;
    }
    const list = line.match(LIST_RE);
    if (list) {
      const [, indent, marker, rest] = list;
      const bullet = /^\d/.test(marker) ? marker.replace(/[.)]$/, '.') : '•';
      const lead = ' '.repeat(Math.min(8, indent.length + 2));
      const body = wrap(rest, Math.max(10, width - lead.length));
      pushLine(lead + paint(S.dim, bullet, color) + ' ' + inline(body[0], color), { list: true });
      for (const l of body.slice(1)) pushLine(' '.repeat(lead.length + 2) + inline(l, color), { list: true, continuation: true });
      return;
    }
    for (const l of wrap(line, width)) pushLine(inline(l, color));
  };

  return {
    push(chunk) {
      for (const ch of String(chunk)) {
        if (ch === '\n') {
          const line = raw;
          raw = '';
          const fence = line.match(FENCE_RE);
          if (mode === 'fence') {
            if (fence) {
              flushFence();
              mode = 'prose';
              continue;
            }
            fenceLines.push(line.slice(0, width));
            continue;
          }
          if (fence) {
            flushTable();
            mode = 'fence';
            continue;
          }
          if (mode === 'table' && !TABLE_RE.test(line) && line.trim()) {
            flushTable();
            mode = 'prose';
          }
          if (TABLE_RE.test(line)) { mode = 'table'; tableRows.push(line); continue; }
          // Re-run the closed line through the prose path.
          raw = line;
          endLine();
          continue;
        }
        raw += ch;
        if (mode === 'table' && !TABLE_RE.test(raw)) { flushTable(); mode = 'prose'; }
        // Prose wraps while it streams, so long paragraphs do not wait for a newline.
        if (mode === 'prose' && raw.length > width) {
          const cut = raw.lastIndexOf(' ', width);
          if (cut > width * 0.4) {
            const head = raw.slice(0, cut);
            const rest = raw.slice(cut + 1);
            raw = '';
            for (const l of wrap(head, width)) pushLine(inline(l, color));
            raw = rest;
          }
        }
      }
      return started;
    },
    end() {
      if (mode === 'table') { flushTable(); mode = 'prose'; }
      if (mode === 'fence') { flushFence(); mode = 'prose'; }
      if (raw.trim()) { const line = raw; raw = ''; for (const l of wrap(line, width)) pushLine(inline(l, color)); }
      return started;
    },
  };
}

// ── the "thinking" status line ─────────────────────────────────────────────
// Claude Code's spinner is a rotating verb, the elapsed time, an optional token
// counter and the interrupt hint — "✻ Simmering… (5s · ↑ 1.2k tokens · esc to
// interrupt)". This owns the text; the TUI owns the pulsing glyph in front of it.
// The verb pool mixes Claude Code's whimsy with the words this harness actually
// does, so a pentest run reads like one.
const THINKING_VERBS = [
  'Thinking', 'Pondering', 'Cogitating', 'Ruminating', 'Percolating',
  'Simmering', 'Noodling', 'Mulling', 'Deliberating', 'Reasoning',
  'Enumerating', 'Probing', 'Correlating', 'Triangulating', 'Reconnoitring',
  'Fingerprinting', 'Profiling', 'Sifting', 'Pivoting', 'Marshalling',
];

function formatTokens(n) {
  const v = Math.max(0, Math.round(Number(n) || 0));
  if (v < 1000) return String(v);
  if (v < 10000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return Math.round(v / 1000) + 'k';
}

// Returned WITHOUT the leading glyph (the animator pulses that) and without
// colour (the caller dims the whole thing): "Simmering… (5s · ↑ 1.2k tokens · esc
// to interrupt)". `tokens` is dropped when zero so an early turn is not noisy.
function thinkingLine(opts = {}) {
  const verb = opts.verb || THINKING_VERBS[0];
  const secs = Math.max(0, Math.round(opts.secs || 0));
  const bits = [`${secs}s`];
  const tok = Math.round(Number(opts.tokens) || 0);
  if (tok > 0) bits.push(`↑ ${formatTokens(tok)} tokens`);
  if (opts.interruptible) bits.push('esc to interrupt');
  return `${verb}… (${bits.join(' · ')})`;
}

// ── the todo / plan panel ──────────────────────────────────────────────────
// Claude Code renders TodoWrite as a checklist: a filled box for done, a half
// moon for the one in progress, an empty box for the rest. Here the checklist is
// the engagement plan — phases and classes — so the operator sees coverage the
// way they see the model's own task list. One styled string per item; the TUI
// hangs them off `⎿` the way it hangs a tool result.
const TODO_GLYPH = { done: '☒', active: '◐', pending: '☐' };

function todoLines(items, opts = {}) {
  const color = !!opts.color;
  return (items || []).map((it) => {
    const status = it && it.status ? it.status : 'pending';
    const glyph = TODO_GLYPH[status] || TODO_GLYPH.pending;
    const text = String(it && it.text != null ? it.text : '');
    if (status === 'done') return `${paint(S.dim, glyph, color)} ${paint(S.dim, text, color)}`;
    if (status === 'active') return `${paint(S.cyan, glyph, color)} ${paint(S.bold, text, color)}`;
    return `${glyph} ${text}`;
  });
}

module.exports = {
  renderMarkdown, createStream, wrap, len, visible, inline, paint, S,
  THINKING_VERBS, formatTokens, thinkingLine, todoLines, TODO_GLYPH,
};
