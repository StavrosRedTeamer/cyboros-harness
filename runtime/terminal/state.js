// runtime/terminal/state.js — the session's state, the authorization, and the spend.
//
// One place owns "what the surface shows": the scope verdict (fail-closed, real by
// default), the target/phase/class, and the single spend accessor. It formats no
// bill — runtime/usage.js owns the rollup and every rendering of it — and it decides
// no tool may run: tools/scope-guard.js does, and this module reports its verdict.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadScope, inScope } = require('../../tools/scope-guard');
// The rollup and its formatting, shared with the console so both say the same number.
const bill = require('../usage');
const { OPTS } = require('./args');
const { cyan, grn, ylw, red } = require('./theme');

// ── scope: real by default, synthetic only in the scripted demo ────────────
const DEMO_HOSTS = ['app.example.com', 'api.example.com'];
const SCOPE_FILE = OPTS.scope || process.env.SCOPE_JSON || path.join(__dirname, '..', '..', 'scope.json');
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
const PROVIDER_FILE = OPTS.config ? path.resolve(OPTS.config) : path.join(__dirname, '..', 'providers.json');

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
  contextBudget: null,   // { tokens, source, window } once a live provider is attached
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
  // The turn's interrupt watcher while one is running. The approval dialog has to yield
  // the keyboard to its own prompt and take it back afterwards, and it is a different
  // module, so the watcher lives in the shared state rather than in a module global.
  irq: null,
  // A session chosen for continuation. It is loaded (and validated) at attach time, and
  // consumed by the NEXT live connection: swapping the history under a running loop would
  // split the session between two half-conversations.
  resumeId: null,        // set by /resume or --resume, after the file validates
  resumeReport: null,
  cloudConsent: false,   // in-session authorization for a cloud profile
  liveDeclined: false,   // asked once; /live still works
  // A copy of the loop's rollup (runtime/usage.js owns the accounting). The TUI
  // never adds to it: two accumulators drift, and the file would disagree with the screen.
  liveUsage: bill.emptyUsage(),
  // The provider refusal that stopped the last attach, as { exit, text }: the status
  // travels with the message instead of being re-decided by the entry point.
  liveFailure: null,
  thinking: true,
  todos: [],
  events: [],
};

const PROFILES = {
  openrouter: { model: 'vendor/model', egress: 'cloud', key: 'OPENROUTER_API_KEY' },
  llama: { model: 'qwen36-35b-abliterated', egress: 'local', key: 'CYBOROS_LOCAL_KEY' },
};
const PHASES = ['recon-map', 'web-test', 'host', 'wireless', 'report'];
const CLASSES = ['sqli', 'xss', 'authz', 'authn', 'csrf', 'ssrf', 'injection', 'cloud', 'llm', 'idor'];
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
// Precision comes from the rollup owner, so /cost, the status bar and the end-of-turn
// line cannot disagree: `$0.000004` and `$1.23` are the same function's answers.
const money = (n) => bill.formatMoney(n);
const costView = () => bill.costView(state.liveUsage);
// The spend the surfaces show. The rollup owns every number a live run produced; the
// scripted demo, which calls no provider, advances `state.budget` instead. One accessor
// decides, so a display can never read a mirror that drifted from the ledger (this used
// to be written into `state.budget` at three sites).
function budget() {
  const u = bill.normalizeUsage(state.liveUsage);
  if (u.requests) return { req: u.requests, tokens: u.tokens_in + u.tokens_out, cost: bill.costView(u).amount };
  return { req: state.budget.req, tokens: state.budget.tokens, cost: state.budget.cost };
}
// `+` marks a floor and the source is named; the label itself is the owner's, so the
// console chat prints the same badge for the same usage.
const costBadge = (view) => bill.costBadge(view);
// The demo makes no provider call, so it has no rollup: its scripted spend lives in
// state.budget.cost. Every other surface reads the rollup and nothing else.
const costFigure = () => {
  const v = costView();
  if (!v.known && demoScope) return money(state.budget.cost);
  return costBadge(v);
};
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
  // Say why it is empty: a wrong --scope path is not an authorization with no hosts in
  // it, and the badge above the verdict already distinguishes MISSING/ERROR from EMPTY.
  if (scopeReadError) return `scope.json unreadable · ${scopeReadError}`;
  if (!fs.existsSync(SCOPE_FILE)) return 'scope.json missing · nothing is authorized';
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
module.exports = {
  state, PROFILES, PHASES, CLASSES, PROVIDER, PROVIDER_FILE, DEMO_HOSTS,
  demo: () => demoScope, setDemo: (v) => { demoScope = !!v; },
  currentScope: () => realScope,
  reloadScope, allowed, targetOf, scopeReason, allowedSummary,
  scopeBadge, scopeDetail, modeTag, targetLabel, phaseTag, ev, addFinding, enterDemo,
  money, costView, budget, costBadge, costFigure,
};
