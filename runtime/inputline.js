// runtime/inputline.js — the Claude Code input box.
//
// readline cannot draw a box around what you type: it owns the line and redraws
// it itself. This is a small raw-mode REPL surface that renders what Claude Code
// renders: the rounded box with `> `, the slash-command menu above it, arrow-key
// selection for permission prompts, the hint row underneath, and the keys that
// go with them (history, tab, shift+tab, ctrl chords, backslash-newline).
//
// It is deliberately an input surface, not a text editor. Non-TTY callers keep
// using readline in runtime/tui.js.
'use strict';

// Claude Code's palette, not the neon one: neutral chrome, one warm accent.
const C = {
  border: '38;2;110;110;122',
  accent: '38;2;217;119;87',
  text: '38;2;232;230;236',
  dim: '2',
  bold: '1',
  reset: '\x1b[0m',
};

const RESET = C.reset;
const paint = (code, s, color) => (color && s !== '' ? `\x1b[${code}m${s}${RESET}` : String(s));

// Terminal columns for one code point. Enough for the scripts a pentest report
// actually contains; not a full UAX#11 table.
function charWidth(cp) {
  if (cp === 0) return 0;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp >= 0x0300 && cp <= 0x036f) return 0;
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf)
    || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60)
    || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f64f)
    || (cp >= 0x1f900 && cp <= 0x1f9ff) || (cp >= 0x20000 && cp <= 0x3fffd)) return 2;
  return 1;
}

function strWidth(s) {
  let n = 0;
  for (const ch of String(s)) n += charWidth(ch.codePointAt(0));
  return n;
}

const plain = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
const padRight = (s, n) => s + ' '.repeat(Math.max(0, n - strWidth(plain(s))));
const truncate = (s, n) => {
  const str = String(s);
  if (strWidth(str) <= n) return str;
  let out = '';
  for (const ch of str) {
    if (strWidth(out + ch) > Math.max(0, n - 1)) break;
    out += ch;
  }
  return out + '…';
};

// Wrap one logical line and keep the source offsets, so the cursor can be placed
// exactly and a space dropped at a break does not shift the count.
function wrapRows(line, width) {
  const rows = [];
  let col = 0;
  let rowStart = 0;
  for (let i = 0; i <= line.length; i += 1) {
    const ch = line[i];
    const atEnd = i === line.length;
    const cw = atEnd ? 0 : charWidth(ch.codePointAt(0));
    if (!atEnd && ch === ' ') {
      if (col + 1 > width && col > 0) {
        rows.push({ text: line.slice(rowStart, i), start: rowStart, end: i });
        rowStart = i + 1;
        col = 0;
        continue;
      }
      col += 1;
      continue;
    }
    if (col + cw > width && col > 0) {
      rows.push({ text: line.slice(rowStart, i), start: rowStart, end: i });
      rowStart = i;
      col = 0;
    }
    col += cw;
  }
  rows.push({ text: line.slice(rowStart), start: rowStart, end: line.length });
  if (!rows.length) rows.push({ text: '', start: 0, end: 0 });
  return rows;
}

// The slash menu, drawn above the box the way Claude Code does: one selection
// marker, the command, and its one-line description.
function layoutMenu(menu, width, color) {
  const items = (menu.items || []).slice(0, 10);
  if (!items.length) return [];
  const nameW = Math.min(22, Math.max(...items.map((i) => strWidth(i.name))) + 1);
  const lines = [paint(C.border, '╭' + '─'.repeat(width - 2) + '╮', color)];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const selected = i === menu.index;
    const marker = selected ? paint(C.accent, '❯', color) : ' ';
    const name = padRight(item.name, nameW);
    const descW = Math.max(4, width - 4 - nameW - 3);
    const desc = truncate(item.desc || '', descW);
    const row = marker + ' ' + (selected ? paint(C.bold, name, color) : name) + ' ' + paint(C.dim, desc, color);
    lines.push(paint(C.border, '│', color) + ' ' + padRight(row, width - 4) + ' ' + paint(C.border, '│', color));
  }
  lines.push(paint(C.border, '╰' + '─'.repeat(width - 2) + '╯', color));
  return lines;
}

// Pure layout so the box can be unit-tested without a terminal.
// lines: [menu…, top border, ...body, bottom border, hint row?]
// cursorRow/cursorCol are 0-based, 1-based column for the terminal.
function layoutBox(opts) {
  const width = Math.max(30, opts.width || 80);
  const color = !!opts.color;
  const text = String(opts.text == null ? '' : opts.text);
  const cursor = Math.max(0, Math.min(text.length, opts.cursor == null ? text.length : opts.cursor));
  const inner = width - 6;                       // '│ > ' … ' │'

  const logical = text.split('\n');
  const rows = [];
  let rowInBody = 0;
  let colInBody = 4;
  let pos = 0;

  logical.forEach((line, li) => {
    const parts = wrapRows(line, inner);
    let placed = false;
    parts.forEach((part, ri) => {
      const prefix = li === 0 && ri === 0 ? '> ' : '  ';
      rows.push(prefix + part.text);
      if (!placed && cursor >= pos + part.start && cursor <= pos + part.end) {
        const offset = Math.max(0, cursor - pos - part.start);
        rowInBody = rows.length - 1;
        colInBody = 3 + strWidth(prefix) + strWidth(part.text.slice(0, offset)) + 1;
        placed = true;
      }
    });
    pos += line.length + 1;
  });
  if (!rows.length) rows.push('> ');

  const empty = text === '';
  // Plan mode tints the frame, the way Claude Code's does; every other mode is neutral.
  const bc = opts.borderColor || C.border;
  const body = rows.map((r, i) => {
    const placeholderHere = i === 0 && empty && !!opts.placeholder;
    const asText = placeholderHere ? r + opts.placeholder : r;
    const content = placeholderHere ? r + paint(C.dim, opts.placeholder, color) : r;
    const pad = ' '.repeat(Math.max(0, width - 4 - strWidth(asText)));
    return paint(bc, '│ ', color) + content + pad + paint(bc, ' │', color);
  });

  const menuLines = opts.menu ? layoutMenu(opts.menu, width, color) : [];
  const lines = [
    ...menuLines,
    paint(bc, '╭' + '─'.repeat(width - 2) + '╮', color),
    ...body,
    paint(bc, '╰' + '─'.repeat(width - 2) + '╯', color),
  ];
  const left = opts.hintLeft || '';
  const right = opts.hintRight || '';
  if (left || right) {
    const gap = Math.max(1, width - 2 - strWidth(left) - strWidth(right));
    lines.push(paint(C.dim, '  ' + left + ' '.repeat(gap) + right, color));
  }
  return {
    lines,
    cursorRow: menuLines.length + 1 + rowInBody,
    cursorCol: Math.max(4, Math.min(width, colInBody)),
  };
}

// Permission prompt: the question and its options in the same frame, selected
// with the arrows (numbers still work, and so does Enter on the default).
function layoutSelect(opts) {
  const width = Math.max(40, opts.width || 80);
  const color = !!opts.color;
  const options = opts.options || [];
  const index = Math.max(0, Math.min(options.length - 1, opts.index || 0));
  const title = opts.title ? ` ${opts.title} ` : '';
  const dash = Math.max(0, width - 3 - strWidth(plain(title)));
  const lines = [paint(C.border, `╭─${title}${'─'.repeat(dash)}╮`, color)];

  const push = (text, style) => {
    const visible = plain(text);
    const row = style ? style(text) : text;
    lines.push(paint(C.border, '│', color) + ' ' + row + ' '.repeat(Math.max(0, width - 4 - strWidth(visible))) + ' ' + paint(C.border, '│', color));
  };

  if (opts.heading) push(opts.heading, (t) => paint(C.bold, t, color));
  if (opts.command) push('$ ' + opts.command);
  if (opts.heading || opts.command) push('');
  for (const line of opts.lines || []) push(line);
  if ((opts.lines || []).length) push('');
  push(opts.question || 'Do you want to proceed?', (t) => paint(C.bold, t, color));
  options.forEach((label, i) => {
    const marker = i === index ? paint(C.accent, '❯', color) : ' ';
    const text = `${i + 1}. ${label}`;
    push(marker + ' ' + (i === index ? paint(C.bold, text, color) : text));
  });
  lines.push(paint(C.border, '╰' + '─'.repeat(width - 2) + '╯', color));
  return { lines, cursorRow: lines.length - 1, cursorCol: 2 };
}

function layoutPlain(opts) {
  const prompt = String(opts.prompt || '');
  const text = String(opts.text == null ? '' : opts.text);
  return { lines: [prompt + text], cursorRow: 0, cursorCol: strWidth(prompt + text) + 1 };
}

function createInput(opts = {}) {
  const stdin = opts.stdin || process.stdin;
  const stdout = opts.stdout || process.stdout;
  const color = !!opts.color && !!stdout.isTTY;
  const history = [];
  let drawn = 0;
  let drawnRow = 0;          // cursor row inside the drawn block, 0-based
  let closed = false;
  let lastCtrlC = 0;

  const width = () => Math.max(40, Math.min(stdout.columns || 100, 100));

  // The cursor is left INSIDE the block, not on its last line: move back to the
  // first row before erasing, or the previous transcript line goes with it.
  function clear() {
    if (!drawn) return;
    stdout.write('\r');
    if (drawnRow > 0) stdout.write(`\x1b[${drawnRow}A`);
    stdout.write('\x1b[0J');
    drawn = 0;
    drawnRow = 0;
  }

  function draw(layout) {
    clear();
    // Full-width frames end exactly on the last column; without this the terminal
    // moves to the next row on the final character and every erase is off by one.
    stdout.write('\x1b[?7l');
    stdout.write(layout.lines.join('\n'));
    drawn = layout.lines.length;
    drawnRow = layout.cursorRow;
    const up = layout.lines.length - 1 - layout.cursorRow;
    if (up > 0) stdout.write(`\x1b[${up}A`);
    stdout.write(`\x1b[${Math.max(1, layout.cursorCol)}G`);
    stdout.write('\x1b[?7h');
  }

  // Resolve one line of input. `plain` keeps a prompt inline (legacy callers),
  // `select` renders the arrow-key choice frame.
  function read(startOpts = {}) {
    return new Promise((resolve) => {
      const plainMode = !!startOpts.plain;
      const select = startOpts.select || null;
      const prompt = startOpts.prompt || '';
      let text = '';
      let cursor = 0;
      let hIndex = history.length;
      let draft = '';
      let finished = false;
      let menuIndex = 0;
      let menuDismissed = false;
      let selIndex = 0;

      if (select) stdout.write('\x1b[?25l');

      const settle = (value) => {
        if (finished) return;
        finished = true;
        stdin.removeListener('data', onData);
        stdin.removeListener('end', onEnd);
        stdout.removeListener('resize', redraw);
        clear();
        if (select) stdout.write('\x1b[?25h');
        if (plainMode && value != null) stdout.write(prompt + value + '\n');
        resolve(value);
      };

      const menuItems = () => {
        if (plainMode || select || menuDismissed || typeof opts.menu !== 'function') return [];
        if (!text.startsWith('/') || text.includes(' ')) return [];
        return opts.menu(text) || [];
      };

      const render = () => {
        if (select) {
          draw(layoutSelect({
            width: width(),
            color,
            title: select.title,
            heading: select.heading,
            command: select.command,
            lines: select.lines,
            question: select.question,
            options: select.options,
            index: selIndex,
          }));
          return;
        }
        if (plainMode) {
          draw(layoutPlain({ prompt, text }));
          return;
        }
        const items = menuItems();
        if (items.length) menuIndex = Math.min(menuIndex, items.length - 1);
        draw(layoutBox({
          text,
          cursor,
          width: width(),
          color,
          placeholder: opts.placeholder || '',
          borderColor: typeof opts.borderColor === 'function' ? opts.borderColor() : opts.borderColor,
          menu: items.length ? { items, index: menuIndex } : null,
          hintLeft: '? for shortcuts',
          hintRight: typeof opts.hint === 'function' ? opts.hint() : (opts.hint || ''),
        }));
      };
      const redraw = () => render();

      const insert = (s) => {
        text = text.slice(0, cursor) + s + text.slice(cursor);
        cursor += s.length;
        menuDismissed = false;
        menuIndex = 0;
      };
      const deleteWord = () => {
        let i = cursor;
        while (i > 0 && text[i - 1] === ' ') i -= 1;
        while (i > 0 && text[i - 1] !== ' ') i -= 1;
        text = text.slice(0, i) + text.slice(cursor);
        cursor = i;
      };

      const complete = () => {
        const items = menuItems();
        if (items.length) {
          // Tab accepts the highlighted command and leaves the box open for its args.
          text = items[menuIndex].name + ' ';
          cursor = text.length;
          menuDismissed = true;
          return;
        }
        const hits = typeof opts.completer === 'function' ? (opts.completer(text, cursor) || []) : [];
        if (!hits.length) return;
        if (hits.length === 1) { text = hits[0]; cursor = text.length; return; }
        let shared = hits[0];
        for (const h of hits) while (!h.startsWith(shared)) shared = shared.slice(0, -1);
        if (shared.length > text.length) { text = shared; cursor = text.length; }
        else stdout.write('\n' + hits.map((h) => '  ' + paint(C.dim, h, color)).join('\n') + '\n');
      };

      const onData = (chunk) => {
        const s = chunk.toString('utf8');
        let i = 0;
        while (i < s.length) {
          const seq = s.slice(i, i + 3);

          if (s[i] === '\x1b') {
            if (seq === '\x1b[A') {
              if (select) { selIndex = (selIndex + (select.options || []).length - 1) % Math.max(1, (select.options || []).length); }
              else if (menuItems().length) { const n = menuItems().length; menuIndex = (menuIndex + n - 1) % n; }
              else if (hIndex > 0) { if (hIndex === history.length) draft = text; hIndex -= 1; text = history[hIndex] || ''; cursor = text.length; }
              i += 3; continue;
            }
            if (seq === '\x1b[B') {
              if (select) { selIndex = (selIndex + 1) % Math.max(1, (select.options || []).length); }
              else if (menuItems().length) { menuIndex = (menuIndex + 1) % menuItems().length; }
              else if (hIndex < history.length) { hIndex += 1; text = hIndex === history.length ? draft : history[hIndex]; cursor = text.length; }
              i += 3; continue;
            }
            if (seq === '\x1b[Z') {           // shift+tab: cycle the execution mode
              if (typeof opts.onCycleMode === 'function' && !select) opts.onCycleMode();
              i += 3; continue;
            }
            if (seq === '\x1b[C') { if (!select && cursor < text.length) cursor += 1; i += 3; continue; }
            if (seq === '\x1b[D') { if (!select && cursor > 0) cursor -= 1; i += 3; continue; }
            if (s.startsWith('\x1b[3~', i)) { if (!select && cursor < text.length) text = text.slice(0, cursor) + text.slice(cursor + 1); i += 4; continue; }
            if (seq === '\x1b[H' || s.startsWith('\x1b[1~', i)) { if (!select) cursor = 0; i += 3; continue; }
            if (seq === '\x1b[F' || s.startsWith('\x1b[4~', i)) { if (!select) cursor = text.length; i += 3; continue; }
            if (s[i + 1] === undefined || s[i + 1] === '\x1b') {   // bare Esc
              if (select) { settle((select.options || []).length - 1); return; }
              if (menuItems().length) menuDismissed = true;
              i += 1; continue;
            }
            i += 1;
            continue;
          }

          const ch = s[i];
          if (select) {
            if (ch >= '1' && ch <= '9' && Number(ch) <= (select.options || []).length) { settle(Number(ch) - 1); return; }
            if (ch === '\r' || ch === '\n') { settle(selIndex); return; }
            if (ch === '\x03') { settle((select.options || []).length - 1); return; }
            i += 1;
            continue;
          }
          if (ch === '\r' || ch === '\n') {
            if (plainMode) { settle(text); return; }
            // Claude Code's newline: a trailing backslash then Enter.
            if (text.endsWith('\\')) {
              text = text.slice(0, -1) + '\n';
              cursor = text.length;
              i += 1;
              continue;
            }
            const items = menuItems();
            if (items.length) { settle(items[menuIndex].name); return; }
            if (!text.trim()) { i += 1; continue; }
            history.push(text);
            settle(text);
            return;
          }
          if (ch === '\x03') {                       // ctrl+c
            if (text) { text = ''; cursor = 0; lastCtrlC = 0; render(); i += 1; continue; }
            const now = Date.now();
            if (now - lastCtrlC < 1500) { settle(null); return; }
            lastCtrlC = now;
            settledNotice();
            i += 1;
            continue;
          }
          if (ch === '\x04') {                       // ctrl+d
            if (text) { text = text.slice(0, cursor) + text.slice(cursor + 1); i += 1; continue; }
            settle(null);
            return;
          }
          if (ch === '\t') { complete(); i += 1; continue; }
          if (ch === '\x7f' || ch === '\b') {
            if (cursor > 0) { text = text.slice(0, cursor - 1) + text.slice(cursor); cursor -= 1; menuDismissed = false; }
            i += 1;
            continue;
          }
          if (ch === '\x01') { cursor = 0; i += 1; continue; }
          if (ch === '\x05') { cursor = text.length; i += 1; continue; }
          if (ch === '\x0b') { text = text.slice(0, cursor); i += 1; continue; }
          if (ch === '\x15') { text = ''; cursor = 0; menuDismissed = false; i += 1; continue; }
          if (ch === '\x17') { deleteWord(); i += 1; continue; }
          if (ch === '\x0c') { stdout.write('\x1b[2J\x1b[H'); drawn = 0; drawnRow = 0; render(); i += 1; continue; }
          if (ch < ' ') { i += 1; continue; }
          if (ch === '?' && text === '' && typeof opts.onShortcuts === 'function') {
            clear();
            opts.onShortcuts();
            render();
            i += 1;
            continue;
          }
          insert(ch);
          lastCtrlC = 0;
          i += 1;
        }
        render();
      };

      function settledNotice() {
        clear();
        stdout.write(paint(C.dim, '  ctrl+c again to exit · ctrl+d to quit', color) + '\n');
        drawn = 0;
        drawnRow = 0;
        render();
      }

      const onEnd = () => settle(null);

      if (stdin.isTTY && typeof stdin.setRawMode === 'function') stdin.setRawMode(true);
      stdin.on('data', onData);
      stdin.on('end', onEnd);
      stdout.on('resize', redraw);
      render();
    });
  }

  function destroy() {
    if (closed) return;
    closed = true;
    clear();
    if (stdin.isTTY && typeof stdin.setRawMode === 'function') stdin.setRawMode(false);
    stdin.pause();
  }

  return {
    read,
    select: (spec) => read({ select: spec }),
    destroy,
    clear: () => clear(),
    history,
  };
}

module.exports = { createInput, layoutBox, layoutMenu, layoutSelect, layoutPlain, wrapRows, strWidth };
