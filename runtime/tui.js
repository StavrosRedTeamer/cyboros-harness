#!/usr/bin/env node
// runtime/tui.js — Cyboros Harness interactive CLI (prototype).
//
// A Claude Code-shaped terminal surface for the harness: welcome box, inline
// transcript, tool calls, confirm-tier approval, slash commands and a status
// line. It is deliberately a SHELL for the model loop: no provider is wired,
// no network call is made, and nothing is written to disk. What is real is the
// authorization: outside `--demo` the REPL reads scope.json through
// tools/scope-guard.js and refuses out-of-scope targets fail-closed. `/findings`
// and `/sessions` read the existing ledgers, read-only. The scripted turns use
// synthetic `.example` data so the interaction can be reviewed before M0/M1.
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

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { loadScope, inScope } = require('../tools/scope-guard');
const { renderMarkdown, createStream } = require('./render');
const { createInput } = require('./inputline');

const VERSION = '0.1.0-draft';
const argv = process.argv.slice(2);

function argValue(flag) {
  const i = argv.indexOf(flag);
  if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('-')) return argv[i + 1];
  const pref = flag + '=';
  const hit = argv.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length) : null;
}

function firstPositional() {
  for (let i = 0; i < argv.length; i += 1) {
    if (['--scope', '--task', '--profile', '--config', '--phase', '--class'].includes(argv[i])) { i += 1; continue; }
    if (!argv[i].startsWith('-')) return argv[i];
  }
  return null;
}

const OPTS = {
  demo: argv.includes('--demo'),
  demoApprove: argv.includes('--demo-approve'),
  live: argv.includes('--live'),
  task: argValue('--task'),
  profile: argValue('--profile'),
  config: argValue('--config'),
  phase: argValue('--phase'),
  klass: argValue('--class'),
  allowCloud: argv.includes('--allow-cloud'),
  fast: argv.includes('--fast') || !process.stdout.isTTY,
  script: argv.includes('--script'),
  scope: argValue('--scope'),
  target: firstPositional(),
  ascii: argv.includes('--ascii'),
  help: argv.includes('--help') || argv.includes('-h'),
  version: argv.includes('--version') || argv.includes('-v'),
  noColor: argv.includes('--no-color') || process.env.NO_COLOR != null || process.env.TERM === 'dumb',
};
if (OPTS.task) OPTS.live = true;
// Authorizing cloud egress is meaningless without a provider call: treat the flag as
// an explicit "connect at launch" too, so `cyboros --allow-cloud` is not a shell.
if (OPTS.allowCloud && !OPTS.demo) OPTS.live = true;
// The child tools (run.js, record-finding.js, …) read SCOPE_JSON themselves:
// the --scope flag must reach them, not just this process.
if (OPTS.scope) process.env.SCOPE_JSON = OPTS.scope;

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
  '→': '->', '←': '<-', '✔': 'OK', '✓': 'OK', '✖': 'X', '⚠': '!',
  '■': '#', '█': '#', '░': '.', '…': '...', '·': '.', '—': '-', '–': '-',
  '’': "'", '‘': "'",
};
const toAscii = (s) => String(s).replace(/[\u2500-\u259F\u25A0-\u25FF\u2700-\u27BF\u23B0-\u23FF\u276F\u2026\u2014\u2013\u2019\u2018\u00B7\u2192\u2190]/g, (c) => GLYPHS[c] || c);
if (ASCII) {
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, enc, cb) => write(typeof chunk === 'string' ? toAscii(chunk) : chunk, enc, cb);
}

// ── scope: real by default, synthetic only in the scripted demo ────────────
const DEMO_HOSTS = ['app.example.com', 'api.example.com'];
const SCOPE_FILE = OPTS.scope || process.env.SCOPE_JSON || path.join(__dirname, '..', 'scope.json');
let demoScope = !!OPTS.demo;
let realScope = { allowed_hosts: [], allowed_url_prefixes: [], allowed_ips: [], exclusions: [] };
let scopeHasRules = false;
let scopeReadError = null;

function reloadScope() {
  if (demoScope) return;
  try {
    realScope = loadScope(OPTS.scope || undefined);
    scopeHasRules = !!((realScope.allowed_hosts || []).length
      || (realScope.allowed_url_prefixes || []).length
      || (realScope.allowed_ips || []).length);
    scopeReadError = null;
  } catch (e) {
    realScope = { allowed_hosts: [], allowed_url_prefixes: [], allowed_ips: [], exclusions: [] };
    scopeHasRules = false;
    scopeReadError = String((e && e.message) || e);
  }
}
reloadScope();

// --config wins over the default, so /model and the live loop always report the same file.
const PROVIDER_FILE = OPTS.config ? path.resolve(OPTS.config) : path.join(__dirname, 'providers.json');

function loadProviderInfo() {
  const file = PROVIDER_FILE;
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    const name = cfg.default_profile || Object.keys(cfg.profiles || {})[0] || null;
    const p = name && cfg.profiles ? cfg.profiles[name] : null;
    if (p) return { file, profile: name, model: p.model || 'unknown', egress: p.egress || 'unknown', keyEnv: p.api_key_env || null, config: cfg };
  } catch { /* absent or invalid: the TUI still starts, it just says so */ }
  return null;
}
const PROVIDER = OPTS.demo ? null : loadProviderInfo();

// ── state ──────────────────────────────────────────────────────────────────
const state = {
  target: OPTS.demo ? 'app.example.com' : null,
  phase: OPTS.phase || (OPTS.demo || OPTS.live ? 'web-test' : 'recon-map'),
  klass: OPTS.klass || (OPTS.demo ? 'sqli' : null),
  profile: OPTS.demo ? 'openrouter' : (PROVIDER ? PROVIDER.profile : 'unwired'),
  model: OPTS.demo ? 'vendor/model' : (PROVIDER ? PROVIDER.model : 'no provider'),
  egress: OPTS.demo ? 'cloud' : (PROVIDER ? PROVIDER.egress : '—'),
  mode: 'ask',
  session: OPTS.demo ? '01J8Z…' : 'not started',
  contextPct: OPTS.demo ? 12 : 0,
  details: true,
  blocked: false,
  budget: OPTS.demo
    ? { req: 6, maxReq: 240, minutes: 0.7, maxMinutes: 90, tokens: 20300, maxTokens: 500000, cost: 0.041 }
    : { req: 0, maxReq: 240, minutes: 0, maxMinutes: 90, tokens: 0, maxTokens: 500000, cost: 0 },
  findings: OPTS.demo
    ? [{ sev: 'LOW', title: 'SQL injection — error-based', endpoint: '/api/orders?id', verify: 'suspected', ceiling: 'Low' }]
    : [],
  live: null,
  liveHistory: null,
  cloudConsent: false,   // in-session authorization for a cloud profile
  liveDeclined: false,   // asked once; /live still works
  liveUsage: { tokens_in: 0, tokens_out: 0, cost: 0 },
  thinking: true,
  events: [],
};

const PROFILES = {
  openrouter: { model: 'vendor/model', egress: 'cloud', key: 'OPENROUTER_API_KEY' },
  llama: { model: 'qwen36-35b-abliterated', egress: 'local', key: 'CYBOROS_LOCAL_KEY' },
};
const PHASES = ['recon-map', 'web-test', 'host', 'wireless', 'report'];
const CLASSES = ['sqli', 'xss', 'authz', 'authn', 'csrf', 'ssrf', 'injection', 'cloud', 'llm', 'idor'];
const FINDINGS_FILE = process.env.FINDINGS_JSONL || path.join(__dirname, '..', 'reports', 'findings.jsonl');
const SESSIONS_DIR = process.env.CYBOROS_SESSIONS_DIR || path.join(__dirname, '..', 'reports', 'agent', 'sessions');

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

function ev(type, detail) {
  state.events.push({
    seq: state.events.length + 1,
    time: new Date().toISOString().slice(11, 19),
    type,
    detail,
  });
}

function addFinding(f) {
  if (!state.findings.some((x) => x.title === f.title)) state.findings.push(f);
}

function meter(pct, width = 24) {
  const p = Math.max(0, Math.min(100, pct));
  const n = Math.max(p > 0 ? 1 : 0, Math.min(width, Math.round((p / 100) * width)));
  return '█'.repeat(n) + '░'.repeat(width - n);
}

function modeTag(mode = state.mode) {
  if (mode === 'plan') return ylw('[plan]');
  if (mode === 'auto') return grn('[auto]');
  return cyan('[ask]');
}

const targetLabel = () => state.target || '—';
const phaseTag = () => (state.klass ? `${state.phase}/${state.klass}` : state.phase);

function scopeBadge() {
  if (demoScope) return ylw('DEMO');
  if (scopeReadError) return red('ERROR');
  if (!fs.existsSync(SCOPE_FILE)) return red('MISSING');
  if (!scopeHasRules) return red('EMPTY');
  return grn('REAL');
}

function scopeDetail() {
  if (demoScope) return OPTS.demo
    ? 'synthetic allowlist · --demo'
    : 'synthetic allowlist · /scope real to leave the demo';
  if (scopeReadError) return `scope.json unreadable · ${scopeReadError}`;
  if (!fs.existsSync(SCOPE_FILE)) return 'scope.json missing · nothing is authorized';
  if (!scopeHasRules) return 'scope.json empty · nothing is authorized';
  return `${path.relative(process.cwd(), SCOPE_FILE) || SCOPE_FILE} · fail-closed`;
}

// ── live loop (providers.json → local/llm.js → guarded tools) ──────────────
function clipJson(obj, n = 160) {
  const s = JSON.stringify(obj == null ? {} : obj);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function initLive(profile) {
  try {
    const { createLive } = require('./live');
    const live = createLive({
      profile: profile || OPTS.profile || undefined,
      configPath: OPTS.config || undefined,
      allowCloud: OPTS.allowCloud || !!state.cloudConsent,
      target: state.target,
      phase: state.phase,
      klass: state.klass,
      approve: (spec) => approval(spec),
    });
    state.live = live;
    state.liveHistory = null;
    state.profile = live.info.profile;
    state.model = live.info.model;
    state.egress = live.info.egress;
    return live;
  } catch (e) {
    console.log('');
    console.log(`  ${red('✖')} ${e.message}`);
    if (e.code === 'config_missing') console.log(dim('  template: runtime/providers.example.json'));
    if (e.code === 'provider_key_missing') console.log(dim('  the key is read from the environment, never from argv or a file'));
    console.log('');
    return null;
  }
}

function resetLive(reason) {
  if (!state.live) return;
  state.live.finish(reason || 'reset');
  state.live = null;
  state.liveHistory = null;
}

// The transcript's vertical rhythm is Claude Code's: two columns of margin, the
// bullet at column three, prose aligned under it at column five.
const money = (n) => (n >= 0.01 ? `$${n.toFixed(3)}` : `$${n.toFixed(6)}`);
const ANSWER_W = () => Math.max(20, W() - 6);

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

// The Claude Code spinner: one line, rewritten in place, only on a real terminal.
function spinner(label) {
  if (!process.stdout.isTTY || OPTS.fast) return { stop() {} };
  const frames = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
  const t0 = Date.now();
  let i = 0;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    const secs = Math.round((Date.now() - t0) / 1000);
    process.stdout.write(`\r\x1b[2K  ${mag(frames[i++ % frames.length])} ${dim(label)} ${dim(secs + 's')}`);
  };
  const timer = setInterval(tick, 90);
  tick();
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      process.stdout.write('\r\x1b[2K');
    },
  };
}

// "FINAL:" is protocol, not prose: strip it even when the text arrives token by token.
function finalPrefixStripper(feed) {
  let pending = '';
  let done = false;
  return (chunk) => {
    if (done) { feed(chunk); return; }
    pending += chunk;
    const m = pending.match(/^\s*FINAL:\s*/i);
    if (m) { done = true; feed(pending.slice(m[0].length)); pending = ''; return; }
    if (pending.length > 12) { done = true; feed(pending); pending = ''; }
  };
}

async function liveTurn(text) {
  if (!state.live) {
    const live = initLive();
    if (!live) return;
  }
  reloadScope();

  const t0 = Date.now();

  // One block per model turn: a tool call closes the current answer/thinking block.
  let answer = null;
  let thinking = null;
  let answerPrinted = false;
  let thinkingStarted = 0;
  let sawThinking = false;
  let feedAnswer = null;
  let spin = spinner('Thinking…');

  const stopSpin = () => { if (spin) { spin.stop(); spin = null; } };
  const closeBlocks = () => {
    if (answer) { answer.end(); answer = null; }
    if (thinking) { thinking.end(); thinking = null; }
    stopSpin();
  };
  const startThinking = () => {
    if (thinking) return thinking;
    thinkingStarted = Date.now();
    sawThinking = true;
    thinking = createStream({
      width: ANSWER_W(),
      color: COLOR,
      onLine: (line, meta) => console.log(meta.first ? `  ${dim('✻')} ${dim(line)}` : `    ${dim(line)}`),
    });
    return thinking;
  };
  const startAnswer = () => {
    if (!answer) {
      answer = createStream({
        width: ANSWER_W(),
        color: COLOR,
        onLine: (line, meta) => console.log(meta.first ? `  ${bold('⏺')} ${line}` : `    ${line}`),
      });
      answerPrinted = false;
      const write = answer.push.bind(answer);
      feedAnswer = finalPrefixStripper((chunk) => { answerPrinted = true; write(chunk); });
    }
    return feedAnswer;
  };

  let res;
  try {
    res = await state.live.run(text, {
      mode: state.mode,
      history: state.liveHistory,
      onThinkingDelta: (chunk) => {
        if (!state.thinking) return;
        stopSpin();
        startThinking().push(chunk);
      },
      onThinkingDone: (full) => {
        if (thinking) { thinking.end(); thinking = null; }
        // Provider senza delta (risposta JSON): mostra il blocco una volta, a fine giro.
        if (!sawThinking && state.thinking && full) {
          startThinking().push(full);
          if (thinking) { thinking.end(); thinking = null; }
          sawThinking = true;
        }
        if (sawThinking) {
          const secs = Math.max(1, Math.round((Date.now() - thinkingStarted) / 1000));
          if (state.thinking) console.log('');
          else console.log(`  ${dim(`✻ Thought for ${secs}s`)}`);
        }
        sawThinking = false;
        stopSpin();
      },
      onToken: (chunk) => {
        // Reasoning often has no newline until the end: close it before the answer so the
        // transcript keeps the true order (thinking first, then prose).
        stopSpin();
        if (thinking) { thinking.end(); thinking = null; }
        startAnswer()(chunk);
      },
      onStep: (s) => {
        closeBlocks();
        console.log('');
        console.log(`  ${bold('⏺')} ${bold(s.tool)}${s.args && Object.keys(s.args).length ? dim('(' + clipJson(s.args) + ')') : ''}${s.viaText ? dim(' (text protocol)') : ''}`);
      },
      onToolResult: (r) => {
        const lines = String(r.out == null ? '' : r.out).replace(/\r/g, '').split('\n').filter((l) => l.trim());
        const tone = r.blocked ? ylw : (s) => s;
        console.log(`    ${dim('⎿')}  ${tone((lines[0] || '(empty)').slice(0, 300))}`);
        // Skip transport headers so a curl probe shows the body that proves the claim.
        const body = lines.slice(1).filter((l) => !/^(HTTP\/|content-|cache-control|x-|date:|connection:|keep-alive:|transfer-encoding:|server:|vary:|set-cookie:|strict-transport|content-security|permissions-policy|referrer-policy|x-frame|alt-svc|location:)/i.test(l));
        const shown = state.details ? body.slice(0, 10) : body.slice(0, 2);
        for (const line of shown) console.log(`       ${dim(line.slice(0, 300))}`);
        if (body.length > shown.length) console.log(`       ${dim(`… +${body.length - shown.length} lines (/details to expand)`)}`);
      },
      onUsage: (u) => {
        state.liveUsage.tokens_in += u.tokens_in || 0;
        state.liveUsage.tokens_out += u.tokens_out || 0;
        if (u.cost) state.liveUsage.cost += Number(u.cost) || 0;
        state.budget.tokens = state.liveUsage.tokens_in + state.liveUsage.tokens_out;
        state.budget.cost = state.liveUsage.cost;
        state.budget.req += 1;
      },
    });
  } catch (e) {
    closeBlocks();
    console.log('');
    console.log(`  ${red('✖')} ${e.message}`);
    console.log(dim('  session and events are on disk; fix the provider/config and retry'));
    console.log('');
    process.exitCode = 1;
    return;
  }

  closeBlocks();
  state.liveHistory = res.messages;
  if (!answerPrinted) {
    const md = renderMarkdown(res.text || '(empty)', { width: ANSWER_W(), color: COLOR });
    console.log('');
    md.forEach((line, i) => console.log(i === 0 ? `  ${bold('⏺')} ${line}` : `    ${line}`));
  }
  console.log('');
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const cost = state.liveUsage.cost > 0 ? ` · ${money(state.liveUsage.cost)}` : '';
  const tokens = state.liveUsage.tokens_in + state.liveUsage.tokens_out;
  console.log(dim(`  ✻ Worked for ${secs}s · ${tokens} tokens${cost}`));
  console.log('');
}

function cmdLive(arg) {
  console.log('');
  let rest = String(arg || '').trim();
  if (/(^|\s)--allow-cloud(\s|$)/.test(rest)) {
    state.cloudConsent = true;
    rest = rest.replace(/(^|\s)--allow-cloud(\s|$)/, ' ').trim();
  }
  arg = rest;
  if (arg === 'off') {
    if (state.live) state.live.finish('operator_off');
    state.live = null;
    state.liveHistory = null;
    console.log(dim('  live off · scripted turns only'));
    console.log('');
    return;
  }
  if (state.live && !arg) {
    console.log(`  live ${grn('on')} · ${state.live.info.profile}/${state.live.info.model} · egress ${state.live.info.egress}`);
    console.log(`  key ${state.live.info.keyMasked} · session ${state.live.session.id}`);
    console.log('');
    return;
  }
  resetLive('profile_change');
  const live = initLive(arg || undefined);
  if (live) {
    console.log(`  live ${grn('on')} · ${live.info.profile}/${live.info.model} · egress ${live.info.egress}`);
    console.log(`  key ${live.info.keyMasked} · session ${live.session.id}`);
  }
  console.log('');
}

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
    row('session', live ? cyan(live.session.id) : dim(demoScope ? 'not started · synthetic walkthrough' : 'not started')),
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
    : demoScope
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
    dim(money(state.budget.cost)),
    dim(`${state.budget.req}/${state.budget.maxReq} req`),
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
  console.log(dim('  Shell: no model call, no network request, no file write. scope.json decides.'));
  console.log(dim('  --live: the provider request is real and tools run through tools/run.js.'));
  console.log('');
}

function sayUser(text) {
  userBlock(text);
}

async function assistant(text) {
  const lines = renderMarkdown(text, { width: ANSWER_W(), color: COLOR });
  console.log('');
  lines.forEach((line, i) => {
    console.log(i === 0 ? `  ${bold('⏺')} ${line}` : `    ${line}`);
  });
  console.log('');
  if (!OPTS.fast) await sleep(35);
}

// Claude Code's tool row: the call on the bullet, every result line hanging off a
// single ⎿, and the long tail collapsed into a count instead of flooding the log.
async function tool(name, args, result, ms, opts = {}) {
  console.log(`  ${bold('⏺')} ${bold(name)}${args ? dim('(' + args + ')') : ''}`);
  const tone = opts.tone === 'ok' ? grn : opts.tone === 'warn' ? ylw : opts.tone === 'bad' ? red : (s) => s;
  console.log(`    ${dim('⎿')}  ${tone(result)}${ms ? dim('  ' + ms) : ''}`);
  const details = opts.details || [];
  const shown = state.details ? details.slice(0, 8) : details.slice(0, 2);
  for (const d of shown) console.log(`       ${dim(d)}`);
  if (details.length > shown.length) console.log(`       ${dim(`… +${details.length - shown.length} lines (/details to expand)`)}`);
  if (!OPTS.fast) await sleep(130);
}

async function finding(f) {
  console.log('');
  const sev = f.sev === 'CRITICAL' ? red : f.sev === 'HIGH' ? mag : f.sev === 'MEDIUM' ? ylw : cyan;
  console.log(`  ${mag('◆')} ${bold('finding')} ${dim('·')} ${sev(f.sev)} ${dim('·')} ${bold(f.title)} ${dim(f.endpoint)}`);
  console.log(`    ${dim('⎿')}  verify_level ${f.verify} ${dim('→')} ceiling ${f.ceiling}${f.extra ? dim('  ·  ' + f.extra) : ''}`);
  if (f.note) {
    for (const line of wrap(f.note, W() - 9)) console.log(`       ${dim(line)}`);
  }
  if (!OPTS.fast) await sleep(160);
}

function printApprovalDetails(spec) {
  console.log('');
  console.log(`  ${bold('Command')}  ${spec.command}`);
  console.log(`  ${bold('Scope')}    ${grn('IN SCOPE')} · ${state.target} · ${demoScope ? 'demo allowlist' : 'scope.json'}`);
  console.log(`  ${bold('Token')}    single-use · host-bound · expires with the session`);
  console.log(`  ${bold('Effect')}   ${spec.effect || 'intrusive timing probes; no writes, no data extraction'}`);
  console.log('');
}

async function approval(spec) {
  // Arrow-key selection, the way Claude Code asks: one frame, four options,
  // numbers still work and Esc takes the safe exit.
  if (INPUT) {
    console.log('');
    for (;;) {
      const choice = await INPUT.select({
        title: `Permission required ${dim('· confirm-tier')}`,
        heading: spec.title,
        command: spec.command,
        lines: [
          `scope ${grn('IN SCOPE')} ${dim('· single-use · host-bound · ' + (demoScope ? 'demo allowlist' : 'scope.json'))}`,
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
  }

  // No TTY: the same frame, printed once, with no way to answer it.
  console.log('');
  box(`Permission required ${dim('· confirm-tier')}`, [
    bold(spec.title),
    `${dim('$')} ${spec.command}`,
    '',
    `scope ${grn('IN SCOPE')} ${dim('· single-use · host-bound · ' + (demoScope ? 'demo allowlist' : 'scope.json'))}`,
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

// ── scripted turns ─────────────────────────────────────────────────────────
async function runSqlDemo() {
  state.phase = 'web-test';
  state.klass = 'sqli';
  ev('run_start', `${state.target} · ${state.phase}/${state.klass}`);
  await sayUser('Test SQL injection on /api/orders. Benign marker first.');
  await assistant('Map is ready: 18 endpoints, 4 with parameters. I will check scope, recall the technique, then probe `id` with a benign quote before anything intrusive.');

  await tool('scope_check', state.target, 'IN SCOPE', '41 ms', { tone: 'ok' });
  ev('tool', 'scope_check · allow');

  await tool('memory_recall', '"spring boot jdbc sqli"', '3 techniques', '12 ms', {
    tone: 'ok',
    details: ['RAG-0012 union-based · RAG-0041 time-based · RAG-0090 WAF bypass'],
  });
  ev('tool', 'memory_recall · 3 techniques');

  await tool('repeater', "GET /api/orders?id=1'", '200 · SQL error in body', '310 ms', {
    tone: 'warn',
    details: ['SQLSTATE[42000] near "1\'\'" · marker absent', 'evidence: reports/app.example.com/req-8f21.txt'],
  });
  ev('tool', 'repeater · SQL error in body');

  await finding({
    sev: 'LOW',
    title: 'SQL injection — error-based',
    endpoint: '/api/orders?id',
    verify: 'suspected',
    ceiling: 'Low',
    note: 'The database reflects the injected quote. No marker yet, no data read: this is a hypothesis until an oracle re-derives it live.',
  });
  ev('finding', 'suspected · SQL injection · /api/orders');

  const choice = await approval({
    title: 'Escalate to time-based verification with sqlmap',
    command: 'node tools/run.js sqlmap -u "https://app.example.com/api/orders?id=1" --batch --level 2 --risk 2',
    reason: 'playbook web/sqli, step 4 — prove the hypothesis with a timing oracle',
    effect: 'intrusive timing probes; no writes, no data extraction at level 2',
  });

  if (choice === 'approve') {
    console.log(dim('  approved · single-use token 7c2e… · reports/approvals.jsonl'));
    ev('approval', 'granted · sqlmap');
    state.budget.req += 1;
    state.budget.tokens += 2500;
    state.budget.cost += 0.012;

    await tool('run_tool', 'sqlmap · level 2 · risk 2', 'exit 0 · time-based confirmed', '24.8 s', {
      tone: 'ok',
      details: ['baseline 0.31 s · injected 4.82 s · oracle 5/5', 'reports/app.example.com/oracle-9f2.json'],
    });
    ev('tool', 'sqlmap · time-based confirmed');

    await finding({
      sev: 'MEDIUM',
      title: 'SQL injection — time-based blind',
      endpoint: '/api/orders?id',
      verify: 'triggered',
      ceiling: 'Medium',
      extra: 'oracle 5/5',
      note: 'The condition is triggered and reproducible, but no data was read. Promote to High only with an exploited chain and an oracle that proves impact.',
    });
    addFinding({
      sev: 'MEDIUM', title: 'SQL injection — time-based blind', endpoint: '/api/orders?id',
      verify: 'triggered', ceiling: 'Medium',
    });
    ev('finding', 'triggered · SQL injection time-based · /api/orders');
    state.contextPct = 18;

    await assistant('Confirmed at `triggered`. Next class is authz. The report gate stays locked until coverage is complete and no finding is pending.');
  } else if (choice === 'notty') {
    ev('approval', 'refused · stdin is not a TTY');
    await assistant('The approval needs an interactive terminal. The run stopped before the intrusive step: nothing was executed and the hypothesis stays `suspected`.');
  } else if (choice === 'skip') {
    console.log(dim('  skipped · the hypothesis stays suspected'));
    ev('approval', 'skipped · sqlmap');
    await assistant('Skipped. The hypothesis stays `suspected`; the gate will ask again before the report.');
  } else {
    console.log(dim('  run stopped by the operator'));
    ev('run_end', 'stopped by operator');
    await assistant('Run stopped. The session is resumable with `cyboros agent resume 01J8Z…`.');
  }
}

async function runIdorDemo() {
  state.phase = 'web-test';
  state.klass = 'authz';
  ev('run_start', `${state.target} · authed pass`);
  await sayUser('Check whether user_b can read user_a\'s order 42.');
  await assistant('Authenticated pass with two identities. I will compare the same object as user_a and user_b, then look for a field that should not cross the tenant boundary.');

  await tool('scope_check', state.target, 'IN SCOPE', '38 ms', { tone: 'ok' });
  await tool('repeater', 'GET /api/orders/42 as user_b', '200 · body_similarity 0.98', '290 ms', {
    tone: 'warn',
    details: ['baseline user_a: 200 · 1.8 KB', 'user_b: 200 · 1.8 KB · same length, same fields'],
  });
  await finding({
    sev: 'MEDIUM',
    title: 'IDOR candidate — cross-tenant object read',
    endpoint: '/api/orders/42',
    verify: 'triggered',
    ceiling: 'Medium',
    extra: 'body_similarity_to 0.98',
    note: 'The object is reachable as user_b, but no field has been read yet. Proving impact requires reading a field owned by user_a, which is a confirm-tier action.',
  });
  addFinding({
    sev: 'MEDIUM', title: 'IDOR candidate — cross-tenant object read', endpoint: '/api/orders/42',
    verify: 'triggered', ceiling: 'Medium',
  });
  ev('finding', 'triggered · IDOR candidate · /api/orders/42');
  await assistant('This is a candidate, not an impact claim. To prove it I need to read one field that belongs to user_a; that is a confirm-tier action, so I will ask first.');
  state.contextPct = 16;
}

async function runDemo(kind) {
  enterDemo();
  if (kind === 'idor') return runIdorDemo();
  return runSqlDemo();
}

// ── commands ───────────────────────────────────────────────────────────────
const CMDS = [
  ['/help', 'this guide'],
  ['/demo [sqli|idor]', 'run a scripted turn'],
  ['/scope [host]', 'show or check the authorization'],
  ['/target <host>', 'set the target (fail-closed)'],
  ['/phase <p>', 'recon-map | web-test | host | wireless | report'],
  ['/class <c>', 'sqli | xss | authz | authn | ssrf | ...'],
  ['/model [profile]', 'openrouter | llama'],
  ['/live [profile|off]', 'real provider loop · guarded tools'],
  ['/plan | /auto | /ask', 'execution mode'],
  ['/budget', 'requests, time, tokens, cost'],
  ['/findings', 'current findings and proof levels'],
  ['/gate', 'coverage and report gate'],
  ['/trace', 'last events'],
  ['/status', 'session card'],
  ['/permissions', 'approval policy'],
  ['/details [on|off]', 'tool call details'],
  ['/thinking [on|off]', 'show or hide the model reasoning'],
  ['/compact', 'compact the context (prototype)'],
  ['/sessions', 'recent sessions'],
  ['/resume [id]', 'list or attach a session'],
  ['/clear', 'clear the screen'],
  ['/quit', 'exit'],
];

function hostOf(value) {
  return String(value || '')
    .replace(/^https?:\/\//i, '')
    .split('/')[0]
    .split(':')[0]
    .toLowerCase();
}

// Target keeps the port (127.0.0.1:8787) so a demo on a non-80 port is reachable;
// scope matching still reduces it to the hostname via scope-guard.
function targetOf(value) {
  const v = String(value == null ? '' : value).trim();
  if (!v) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(v) ? v : 'http://' + v);
    return u.host.toLowerCase();
  } catch {
    return hostOf(v);
  }
}

function allowed(target) {
  const t = String(target == null ? '' : target).trim();
  if (!t) return false;
  if (demoScope) {
    const h = hostOf(t);
    return DEMO_HOSTS.includes(h) || ['127.0.0.1', 'localhost'].includes(h);
  }
  return inScope(t, realScope).ok;
}

function scopeReason(target) {
  if (demoScope) return allowed(target) ? 'host allowlisted (demo)' : 'host not in the demo allowlist';
  return inScope(String(target || '').trim(), realScope).reason;
}

function allowedHosts() {
  return demoScope ? DEMO_HOSTS : (realScope.allowed_hosts || []);
}

function allowedSummary() {
  const hosts = allowedHosts();
  const ips = demoScope ? ['127.0.0.1', 'localhost'] : (realScope.allowed_ips || []);
  const parts = [];
  if (hosts.length) parts.push(hosts.join(', '));
  if (ips.length) parts.push(ips.join(', '));
  return parts.length ? parts.join(' · ') : '(none) · fail-closed';
}

function enterDemo() {
  demoScope = true;
  state.target = 'app.example.com';
  state.profile = 'openrouter';
  state.model = 'vendor/model';
  state.egress = 'cloud';
  state.session = '01J8Z…';
  state.contextPct = state.contextPct || 12;
  if (!state.findings.length) {
    state.findings = [{ sev: 'LOW', title: 'SQL injection — error-based', endpoint: '/api/orders?id', verify: 'suspected', ceiling: 'Low' }];
  }
  if (!state.budget.req && !state.budget.cost) {
    state.budget = { req: 6, maxReq: 240, minutes: 0.7, maxMinutes: 90, tokens: 20300, maxTokens: 500000, cost: 0.041 };
  }
}

function cmdScope(arg) {
  console.log('');
  if (arg === 'real') {
    if (OPTS.demo) {
      console.log(dim('  --demo keeps the synthetic allowlist for the whole process'));
      console.log('');
      return;
    }
    demoScope = false;
    reloadScope();
    console.log(`  scope ${scopeBadge()} ${dim('· ' + scopeDetail())}`);
    console.log('');
    return;
  }
  if (arg) {
    reloadScope();
    const ok = allowed(arg);
    console.log(`  scope_check ${bold(arg)}  ${ok ? grn('IN SCOPE') : red('OUT OF SCOPE')}`);
    field('verdict', dim(scopeReason(arg)));
    if (!ok) field('allowed', allowedSummary());
    console.log(dim(demoScope
      ? '  demo allowlist · the real gate is tools/scope-guard.js'
      : '  same decision as tools/scope-guard.js check'));
    console.log('');
    return;
  }
  reloadScope();
  if (demoScope) {
    console.log(`  ${bold('scope')}  ${scopeBadge()} ${dim('· synthetic allowlist for the walkthrough')}`);
    console.log(`  ${dim('allowed_hosts')}  ${DEMO_HOSTS.join(', ')}`);
    console.log(`  ${dim('allowed_ips')}    127.0.0.1, localhost`);
    console.log(`  ${dim('rate')}           2 req/s`);
    console.log(dim('  /scope real to read scope.json · empty scope = nothing runs'));
    console.log('');
    return;
  }
  console.log(`  ${bold('scope')}  ${scopeBadge()} ${dim('· ' + scopeDetail())}`);
  const hosts = realScope.allowed_hosts || [];
  const ips = realScope.allowed_ips || [];
  const prefixes = realScope.allowed_url_prefixes || [];
  const exclusions = realScope.exclusions || [];
  field('allowed_hosts', hosts.length ? hosts.join(', ') : dim('(none)'));
  field('allowed_ips', ips.length ? ips.join(', ') : dim('(none)'));
  if (prefixes.length) field('url_prefixes', prefixes.join(', '));
  if (exclusions.length) field('exclusions', exclusions.map((e) => e.value || e).join(', ') + ' ' + red('hard-deny'));
  console.log(`  ${dim('rate')}           ${realScope.max_requests_per_second || 2} req/s`);
  if (!hosts.length && !ips.length && !prefixes.length) {
    console.log(`  ${red('✖')} nothing is authorized · add the written authorization to scope.json`);
  }
  console.log(dim('  empty scope = nothing runs · no override flag'));
  console.log('');
}

function cmdTarget(host) {
  console.log('');
  if (!host) {
    console.log(`  target ${cyan(targetLabel())}`);
    console.log('');
    return;
  }
  reloadScope();
  if (!allowed(host)) {
    console.log(`  ${red('✖')} ${bold(host)} is out of scope`);
    field('verdict', dim(scopeReason(host)));
    field('allowed', allowedSummary());
    console.log(dim('  target unchanged · edit the authorization and re-check; there is no override'));
    console.log('');
    return;
  }
  state.target = targetOf(host);
  resetLive('target_changed');
  console.log(`  target ${cyan(state.target)} ${grn('IN SCOPE')}`);
  console.log('');
}

function cmdPhase(arg) {
  console.log('');
  if (!arg) {
    console.log(`  phase ${mag(state.phase)} · ${PHASES.join(' | ')}`);
    console.log('');
    return;
  }
  if (!PHASES.includes(arg)) {
    console.log(`  ${red('unknown phase')} ${arg} · ${PHASES.join(' | ')}`);
    console.log('');
    return;
  }
  state.phase = arg;
  resetLive('phase_changed');
  console.log(`  phase ${mag(arg)}`);
  console.log('');
}

function cmdClass(arg) {
  console.log('');
  if (!arg) {
    console.log(`  class ${mag(state.klass || '—')} · ${CLASSES.join(' | ')}`);
    console.log('');
    return;
  }
  if (!CLASSES.includes(arg)) {
    console.log(`  ${red('unknown class')} ${arg} · ${CLASSES.join(' | ')}`);
    console.log('');
    return;
  }
  state.klass = arg;
  resetLive('class_changed');
  console.log(`  class ${mag(arg)}`);
  console.log('');
}

function modelProfiles() {
  if (!demoScope && PROVIDER && PROVIDER.config && PROVIDER.config.profiles) return PROVIDER.config.profiles;
  return PROFILES;
}

function cmdModel(arg) {
  console.log('');
  const profiles = modelProfiles();
  if (!demoScope && !PROVIDER) {
    console.log(`  ${red('✖')} ${path.relative(path.join(__dirname, '..'), PROVIDER_FILE)} not found`);
    console.log(`  template  runtime/providers.example.json`);
    console.log(`  create    cp runtime/providers.example.json runtime/providers.json`);
    console.log(dim('  keys live in the environment, never in the file · /demo uses synthetic data'));
    console.log('');
    return;
  }
  if (arg) {
    if (!profiles[arg]) {
      console.log(`  ${red('unknown profile')} ${arg} · ${Object.keys(profiles).join(' | ')}`);
      console.log('');
      return;
    }
    state.profile = arg;
    state.model = profiles[arg].model || 'unknown';
    state.egress = profiles[arg].egress || '—';
    console.log(`  profile ${cyan(arg)} · ${state.model} · egress ${state.egress}`);
    console.log('');
    return;
  }
  for (const [name, p] of Object.entries(profiles)) {
    const cur = name === state.profile ? cyan('●') : dim('○');
    console.log(`  ${cur} ${pad(bold(name), 14)} ${pad(p.model || 'unknown', 28)} ${dim(p.egress || '—')} ${dim(p.api_key_env || p.key || '')}`);
  }
  console.log(dim('  /model <profile> to switch · keys stay in the environment'));
  console.log('');
}

function cmdThinking(arg) {
  console.log('');
  if (arg === 'on') state.thinking = true;
  else if (arg === 'off') state.thinking = false;
  else if (arg) {
    console.log(`  ${red('usage')} /thinking [on|off]`);
    console.log('');
    return;
  }
  console.log(`  thinking ${state.thinking ? grn('on') : dim('off')} ${dim('· reasoning is rendered dim as it arrives; it is never sent back to the model')}`);
  console.log('');
}

function cmdMode(arg) {
  console.log('');
  if (arg) {
    if (!['ask', 'auto', 'plan'].includes(arg)) {
      console.log(`  ${red('unknown mode')} ${arg} · ask | auto | plan`);
      console.log('');
      return;
    }
    state.mode = arg;
  }
  const desc = {
    ask: 'confirm-tier actions always ask; non-intrusive tools run',
    auto: 'non-intrusive tools run automatically; confirm-tier still asks',
    plan: 'read-only: no tool execution, only a proposed plan',
  }[state.mode];
  console.log(`  mode ${modeTag()} · ${desc}`);
  console.log('');
}

function cmdBudget() {
  const b = state.budget;
  console.log('');
  console.log(`  ${dim('requests')}  ${pad(`${b.req} / ${b.maxReq}`, 14)} ${meter((b.req / b.maxReq) * 100)} ${dim(((b.req / b.maxReq) * 100).toFixed(1) + '%')}`);
  console.log(`  ${dim('wall')}      ${pad(`${b.minutes} / ${b.maxMinutes} min`, 14)} ${meter((b.minutes / b.maxMinutes) * 100)} ${dim(((b.minutes / b.maxMinutes) * 100).toFixed(1) + '%')}`);
  console.log(`  ${dim('tokens')}    ${pad(`${(b.tokens / 1000).toFixed(1)}k / ${(b.maxTokens / 1000)}k`, 14)} ${meter((b.tokens / b.maxTokens) * 100)} ${dim(((b.tokens / b.maxTokens) * 100).toFixed(1) + '%')}`);
  console.log('');
  console.log(`  ${dim('cost')}      ${bold('$' + b.cost.toFixed(3))} ${dim('provider-reported · null when unavailable')}`);
  if (state.live) console.log(dim(`  live tokens ${state.liveUsage.tokens_in} in / ${state.liveUsage.tokens_out} out · session ${state.live.session.id}`));
  else if (!demoScope) console.log(dim('  prototype counters · M1 reads the real ledger and budget hook'));
  console.log('');
}

function readFindings() {
  try {
    return fs.readFileSync(FINDINGS_FILE, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch {
    return null;
  }
}

function severityPaint(sev) {
  const s = String(sev || 'INFO').toUpperCase();
  if (s === 'CRITICAL') return red(s);
  if (s === 'HIGH') return mag(s);
  if (s === 'MEDIUM' || s === 'MED') return ylw(s);
  if (s === 'LOW') return cyan(s);
  return dim(s);
}

function printFindingRow(sev, title, where, meta) {
  const head = `  ${severityPaint(sev)} `;
  const lines = wrap(`${title}${where ? ' · ' + where : ''}`, Math.max(20, W() - stripAnsi(head).length));
  console.log(head + bold(lines[0]));
  for (const line of lines.slice(1)) console.log(' '.repeat(stripAnsi(head).length) + dim(line));
  for (const line of wrap(meta, Math.max(20, W() - 11))) console.log('           ' + dim(line));
}

function cmdFindings() {
  console.log('');
  if (demoScope) {
    if (!state.findings.length) {
      console.log(dim('  no findings yet'));
      console.log('');
      return;
    }
    for (const f of state.findings) {
      printFindingRow(f.sev, f.title, f.endpoint, `verify_level ${f.verify} → ceiling ${f.ceiling}`);
    }
    console.log('');
    return;
  }
  const rows = readFindings();
  const rel = path.relative(process.cwd(), FINDINGS_FILE) || FINDINGS_FILE;
  if (rows == null) {
    console.log(dim(`  no readable findings ledger · ${rel}`));
    console.log('');
    return;
  }
  if (!rows.length) {
    console.log(dim(`  the ledger is empty · ${rel}`));
    console.log('');
    return;
  }
  console.log(dim(`  ${rows.length} finding(s) · ${rel} · read-only`));
  for (const f of rows.slice(-12)) {
    const title = f.title || f.class || 'finding';
    const where = f.endpoint || f.url || f.host || '';
    printFindingRow(f.severity, title, where, `verify_level ${f.verify_level || 'unclassified'} · status ${f.status || '—'}`);
  }
  if (rows.length > 12) console.log(dim(`  … ${rows.length - 12} more`));
  console.log('');
}

function cmdGate() {
  console.log('');
  if (demoScope) {
    const covered = 4;
    const total = 9;
    const pending = state.findings.filter((f) => f.verify === 'suspected').length;
    console.log(`  coverage  ${bold(covered + ' / ' + total)} classes  ${meter((covered / total) * 100)}`);
    console.log(`  pending   ${pending} finding(s)`);
    console.log(`  report    ${ylw('LOCKED')} ${dim('· opens only when coverage is complete and no finding is pending')}`);
    console.log('');
    return;
  }
  const rows = readFindings() || [];
  const pending = rows.filter((f) => f.verify_level === 'suspected').length;
  console.log(`  coverage  ${dim('unknown · tools/coverage-loop.js owns it')}`);
  console.log(`  pending   ${pending} finding(s) at verify_level suspected`);
  console.log(`  report    ${ylw('LOCKED')} ${dim('· prototype gate · M1 wires tools/gate.js and coverage-loop.js')}`);
  console.log('');
}

function cmdCost() {
  console.log('');
  console.log(`  session ${cyan(state.live ? state.live.session.id : state.session)}`);
  if (state.live) {
    console.log(`  tokens  ${state.liveUsage.tokens_in} in / ${state.liveUsage.tokens_out} out · provider-reported`);
    console.log(`  cost    ${bold(money(state.budget.cost))} ${dim('null when the provider does not report a price')}`);
  } else if (demoScope) {
    console.log(`  tokens  ${(state.budget.tokens / 1000).toFixed(1)}k in/out · ${dim('18.2k in / 2.1k out last turn')}`);
    console.log(`  cost    ${bold('$' + state.budget.cost.toFixed(3))} ${dim('provider-reported')}`);
  } else {
    console.log(`  tokens  ${dim('no provider call yet · M1 writes usage to the ledger')}`);
    console.log(`  cost    ${bold('$0.000')} ${dim('null when the provider does not report a price')}`);
  }
  console.log('');
}

function cmdStatus() {
  const liveLine = state.live
    ? `${dim('live:')} ${grn('on')} · key ${state.live.info.keyMasked} · session ${state.live.session.id}`
    : `${dim('live:')} off`;
  box('SESSION STATUS', [
    `${dim('target:')} ${cyan(targetLabel())}`,
    `${dim('phase:')} ${mag(phaseTag())}`,
    `${dim('provider:')} ${state.profile} · ${state.model} · egress ${state.egress}`,
    `${dim('scope:')} ${scopeBadge()} · ${scopeDetail()}`,
    `${dim('mode:')} ${modeTag()}`,
    liveLine,
    `${dim('session:')} ${state.live ? state.live.session.id : state.session}${demoScope ? ' · prompt 9c1e… · config 4a7d…' : ''}`,
    `${dim('budget:')} ${state.budget.req}/${state.budget.maxReq} req · $${state.budget.cost.toFixed(3)} · ctx ${state.contextPct}%`,
  ]);
  console.log('');
}

function cmdTrace() {
  console.log('');
  if (!state.events.length) {
    console.log(dim('  no events yet'));
    console.log('');
    return;
  }
  console.log(`  ${dim('seq  time      type            detail')}`);
  for (const e of state.events.slice(-10)) {
    console.log(`  ${pad(String(e.seq), 4)} ${pad(e.time, 9)} ${pad(e.type, 15)} ${dim(e.detail)}`);
  }
  console.log('');
}

function cmdCompact() {
  console.log('');
  if (!demoScope && !state.contextPct) {
    console.log(dim('  nothing to compact · no model context is loaded (M1)'));
    console.log('');
    return;
  }
  state.contextPct = Math.max(4, Math.round(state.contextPct * 0.35));
  console.log(`  ${grn('✓')} context compacted · 18.2k → 6.4k tokens · ${state.contextPct}% used`);
  console.log(dim('  the next turn keeps the contract, the target map and the last findings'));
  console.log('');
}

function cmdClear() {
  if (process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[H');
  console.log(dim('  screen cleared · the session continues'));
  console.log('');
}

function cmdPermissions() {
  console.log('');
  console.log(`  ${bold('Approval policy')}`);
  console.log(`  ${grn('auto')}      non-intrusive tools: scope_check, read_file, memory_recall`);
  console.log(`  ${ylw('confirm')}   intrusive tools: sqlmap, netexec, coercion, brute force`);
  console.log(`  ${red('never')}     out-of-scope hosts · no override flag`);
  console.log(dim('  a confirm-tier token is single-use, host-bound and append-only'));
  console.log('');
}

function cmdDetails(arg) {
  if (arg === 'on') state.details = true;
  else if (arg === 'off') state.details = false;
  else state.details = !state.details;
  console.log(`  tool details ${state.details ? grn('on') : dim('off')}`);
}

function readSessions() {
  try {
    return fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const base = { id: d.name };
        try { return Object.assign(base, JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, d.name, 'meta.json'), 'utf8'))); }
        catch { return base; }
      });
  } catch {
    return null;
  }
}

function cmdSessions(arg) {
  console.log('');
  if (arg) {
    if (!demoScope && !fs.existsSync(path.join(SESSIONS_DIR, arg))) {
      console.log(`  ${red('✖')} ${arg} is not a session under reports/agent/sessions`);
      console.log(dim('  /resume without an id lists what exists'));
      console.log('');
      return;
    }
    state.session = arg;
    console.log(`  attached ${cyan(arg)} ${dim(demoScope ? '(prototype)' : '(read-only · resume lands in M1)')}`);
    console.log('');
    return;
  }
  if (!demoScope) {
    const rows = readSessions();
    if (rows == null || !rows.length) {
      console.log(dim('  no agent sessions yet · reports/agent/sessions/<id>/ meta.json'));
      console.log(dim('  M1 writes them; /demo shows the shape of a live one'));
      console.log('');
      return;
    }
    console.log(`  ${dim('id        when              phase               state')}`);
    for (const s of rows.slice(0, 10)) {
      const when = String(s.started_at || '').slice(0, 16).replace('T', ' ');
      const phase = [s.phase, s.class].filter(Boolean).join('/') || '—';
      const status = s.status === 'halted' ? ylw('halted') : s.status === 'ok' ? grn('ok') : dim(s.status || 'unknown');
      console.log(`  ${cyan(pad(s.id, 10))} ${pad(when || '—', 17)} ${pad(phase, 19)} ${status}`);
    }
    console.log('');
    console.log(dim('  read-only view · resume lands in M1'));
    console.log('');
    return;
  }
  console.log(`  ${dim('id        when              phase               state')}`);
  for (const s of [
    ['01J8Z…', 'Oct 19 10:02', 'web-test/sqli', grn('live')],
    ['01J7Q…', 'Oct 18 16:40', 'recon-map', ylw('halted')],
    ['01J6M…', 'Oct 17 09:10', 'web-test/authz', grn('ok')],
  ]) {
    console.log(`  ${cyan(pad(s[0], 9))} ${pad(s[1], 17)} ${pad(s[2], 19)} ${s[3]}`);
  }
  console.log(dim('  /resume <id> to attach · /resume without an id lists'));
  console.log('');
}

async function handleCommand(line) {
  const parts = line.trim().split(/\s+/);
  const cmd = parts[0];
  const arg = parts.slice(1).join(' ');

  switch (cmd) {
    case '/help': printHelp(); return;
    case '/demo': await runDemo(arg === 'idor' ? 'idor' : 'sqli'); return;
    case '/scope': cmdScope(arg); return;
    case '/target': cmdTarget(arg); return;
    case '/phase': cmdPhase(arg); return;
    case '/class': cmdClass(arg); return;
    case '/model':
    case '/profile': cmdModel(arg); return;
    case '/live': cmdLive(arg); return;
    case '/mode': cmdMode(arg); return;
    case '/plan': cmdMode('plan'); return;
    case '/auto': cmdMode('auto'); return;
    case '/ask': cmdMode('ask'); return;
    case '/budget': cmdBudget(); return;
    case '/findings': cmdFindings(); return;
    case '/gate': cmdGate(); return;
    case '/cost': cmdCost(); return;
    case '/status': cmdStatus(); return;
    case '/trace': cmdTrace(); return;
    case '/compact': cmdCompact(); return;
    case '/clear': cmdClear(); return;
    case '/permissions': cmdPermissions(); return;
    case '/details': cmdDetails(arg); return;
    case '/thinking': cmdThinking(arg); return;
    case '/sessions': cmdSessions(); return;
    case '/resume': cmdSessions(arg); return;
    case '/quit':
    case '/exit': return 'quit';
    case '/version': console.log(`  ${VERSION}`); return;
    default:
      console.log(`  ${red('unknown command')} ${cmd} · ${cyan('/help')}`);
      return;
  }
}

// Changing the egress gate at the point of use: a cloud profile used to need a
// flag typed at launch. The consent frame names the provider, the egress and what
// leaves the host, it is per session, and it is recorded in the session events.
// Declining is remembered, so the question is asked once, not on every message.
async function offerLive() {
  if (!INPUT || !PROVIDER || state.liveDeclined) return 'skip';
  const keyEnv = PROVIDER.keyEnv;
  const { resolveKey, keyFileFor } = require('./live');
  let resolved;
  try {
    resolved = resolveKey(PROVIDER.profile, keyEnv);
  } catch (e) {
    console.log('');
    console.log(`  ${red('✖')} ${e.message}`);
    console.log('');
    return 'unavailable';
  }
  if (!resolved.key) {
    console.log('');
    console.log(`  ${red('✖')} ${PROVIDER.profile} is configured, but ${keyEnv} is not set`);
    console.log(dim(`  export ${keyEnv} in this shell, or put it in ${keyFileFor(PROVIDER.profile)} (chmod 600)`));
    console.log('');
    return 'unavailable';
  }

  const choice = await INPUT.select({
    title: 'Connect the model',
    heading: `${PROVIDER.profile} · ${PROVIDER.model}`,
    lines: [
      `egress ${PROVIDER.egress === 'cloud' ? ylw('cloud') : grn('local')} · prompts, tool output and file excerpts leave this host`,
      dim('scope.json stays the only authorization for target traffic'),
      dim(`${keyEnv || 'key'} · consent is for this session only`),
    ],
    question: 'Send this turn to the model?',
    options: ['Yes, for this session', 'No, stay in shell mode'],
  });

  if (choice !== 0) {
    state.liveDeclined = true;
    console.log(dim('  shell mode · /live to connect later'));
    console.log('');
    return 'declined';
  }

  state.cloudConsent = true;
  ev('cloud_consent', `${PROVIDER.profile}/${PROVIDER.model} · ${PROVIDER.egress}`);
  const live = initLive();
  if (!live) return 'unavailable';
  console.log(dim(`  connected · ${live.info.profile}/${live.info.model} · egress ${live.info.egress} · session ${live.session.id}`));
  console.log('');
  return 'connected';
}

async function handleMessage(text) {
  ev('user', text);
  if (state.live) return liveTurn(text);
  // No magic keywords: a sentence about SQL injection is a message, not a command.
  // The scripted demo stays behind /demo, where it cannot be mistaken for a real run.
  const status = await offerLive();
  if (status === 'connected') return liveTurn(text);
  if (status === 'declined') return;
  if (status === 'unavailable') return;

  console.log('');
  console.log(`  ${bold('⏺')} No model is connected, so nothing was sent.`);
  console.log(`    provider ${dim(state.profile + '/' + state.model)} ${dim('·')} target ${cyan(targetLabel())} ${dim('·')} scope ${scopeBadge()}`);
  console.log(`    ${dim('start with')} ${cyan('cyboros --live --allow-cloud')} ${dim('· or /live inside the session')}`);
  console.log(`    ${dim('/demo sqli')} ${dim('·')} ${dim('/scope')} ${dim('·')} ${dim('/findings')} ${dim('·')} ${dim('/help')}`);
  console.log('');
}

// ── input queue ────────────────────────────────────────────────────────────
let rl = null;
let INPUT = null;
let closed = false;
let waiting = null;
const buf = [];
let sigints = 0;

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
    ['esc', 'dismiss the command menu'],
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
    hint: () => `${state.live ? '⏵⏵ live' : '⏵⏵ ' + state.mode} · shift+tab to cycle · ${targetLabel()} · $${state.budget.cost.toFixed(3)}`,
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

function setupRL() {
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
    sigints = 0;
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

// ── main ───────────────────────────────────────────────────────────────────
async function main() {
  if (OPTS.version) { console.log(VERSION); return; }
  if (OPTS.help) { printUsage(); return; }
  if (OPTS.demo && OPTS.live) {
    console.error('cyboros tui: choose --demo (scripted) or --live (provider), not both.');
    process.exitCode = 2;
    return;
  }

  if (!process.stdin.isTTY && !OPTS.demo && !OPTS.script && !OPTS.task) {
    console.error('cyboros tui: interactive mode needs a TTY. Use --demo, --script or --task.');
    process.exitCode = 2;
    return;
  }

  if (process.stdin.isTTY) initInput();
  else setupRL();

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
      if (INPUT) INPUT.destroy();
      closeRL();
      return;
    }
    state.target = targetOf(OPTS.target);
  }

  if (OPTS.live) {
    const live = initLive();
    if (!live) {
      process.exitCode = 5;
      if (INPUT) INPUT.destroy();
      closeRL();
      return;
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
    if (INPUT) INPUT.destroy();
    closeRL();
    return;
  }

  if (OPTS.demo) {
    await runDemo('sqli');
    if (!process.stdin.isTTY) {
      console.log('');
      statusLine();
      if (state.blocked) process.exitCode = 1;
      if (INPUT) INPUT.destroy();
      closeRL();
      return;
    }
  }

  for (;;) {
    if (!INPUT) statusLine();

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
  if (INPUT) INPUT.destroy();
  closeRL();
  console.log(dim(state.live
    ? `\n  session closed · ${state.live.session.id} · events under ${path.relative(process.cwd(), state.live.session.dir) || state.live.session.dir}\n`
    : demoScope
      ? '\n  session closed · resume with cyboros agent resume 01J8Z…\n'
      : '\n  session closed · nothing was persisted (M1 writes reports/agent/sessions)\n'));
}

process.on('SIGINT', () => {
  sigints += 1;
  if (sigints >= 2) {
    if (state.live) state.live.finish('interrupted');
    console.log(dim('\n  bye.\n'));
    process.exit(0);
  }
  console.log(dim('\n  interrupted · ctrl+c again to exit · /quit\n'));
  if (process.stdin.isTTY && rl) rl.prompt();
});

main().catch((err) => {
  console.error(red('fatal: ' + (err && (err.stack || err.message) || err)));
  process.exitCode = 1;
});
