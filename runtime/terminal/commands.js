// runtime/terminal/commands.js — the slash commands that change the session.
//
// Dispatch lives here, next to the handlers that mutate the run: scope, target, phase,
// class, profile, mode, thinking, details, compaction. The read-only views over what the
// engagement recorded are in ledger.js, so "show me the bill" and "change the target" are
// different files.
'use strict';

const path = require('node:path');
const { OPTS, VERSION } = require('./args');
const { dim, bold, cyan, mag, grn, ylw, red, pad, field } = require('./theme');
const {
  state, PROFILES, PHASES, CLASSES, PROVIDER, PROVIDER_FILE, DEMO_HOSTS, demo, setDemo,
  currentScope, reloadScope, allowed, targetOf, scopeReason, allowedSummary, scopeBadge, scopeDetail,
  modeTag, targetLabel,
} = require('./state');
const { initLive, resetLive } = require('./turn');
const { runDemo } = require('./demo');
const { printHelp } = require('./surfaces');
const {
  cmdBudget, cmdFindings, cmdGate, cmdCost, cmdStatus, cmdTrace, cmdTodos, cmdSessions,
} = require('./ledger');

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

function cmdScope(arg) {
  console.log('');
  if (arg === 'real') {
    if (OPTS.demo) {
      console.log(dim('  --demo keeps the synthetic allowlist for the whole process'));
      console.log('');
      return;
    }
    setDemo(false);
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
    console.log(dim(demo()
      ? '  demo allowlist · the real gate is tools/scope-guard.js'
      : '  same decision as tools/scope-guard.js check'));
    console.log('');
    return;
  }
  reloadScope();
  if (demo()) {
    console.log(`  ${bold('scope')}  ${scopeBadge()} ${dim('· synthetic allowlist for the walkthrough')}`);
    console.log(`  ${dim('allowed_hosts')}  ${DEMO_HOSTS.join(', ')}`);
    console.log(`  ${dim('allowed_ips')}    127.0.0.1, localhost`);
    console.log(`  ${dim('rate')}           2 req/s`);
    console.log(dim('  /scope real to read scope.json · empty scope = nothing runs'));
    console.log('');
    return;
  }
  console.log(`  ${bold('scope')}  ${scopeBadge()} ${dim('· ' + scopeDetail())}`);
  // Read after reloadScope(): the accessor returns the object the reload just built.
  const file = currentScope();
  const hosts = file.allowed_hosts || [];
  const ips = file.allowed_ips || [];
  const prefixes = file.allowed_url_prefixes || [];
  const exclusions = file.exclusions || [];
  field('allowed_hosts', hosts.length ? hosts.join(', ') : dim('(none)'));
  field('allowed_ips', ips.length ? ips.join(', ') : dim('(none)'));
  if (prefixes.length) field('url_prefixes', prefixes.join(', '));
  if (exclusions.length) field('exclusions', exclusions.map((e) => e.value || e).join(', ') + ' ' + red('hard-deny'));
  console.log(`  ${dim('rate')}           ${file.max_requests_per_second || 2} req/s`);
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
  if (!demo() && PROVIDER && PROVIDER.config && PROVIDER.config.profiles) return PROVIDER.config.profiles;
  return PROFILES;
}

// The adapter describes itself (local/adapters.js#describe.summary): this file formats the
// line, it does not know any capability's name, so a new capability never needs an edit
// here. Resolved by the same adapter the request builder consumes, so what /model shows is
// what a turn will actually be allowed to send.
function capsFor(name, p) {
  try { return require('../live').capabilitiesFor(p || {}, name); } catch { return null; }
}

function cmdModel(arg) {
  console.log('');
  const profiles = modelProfiles();
  if (!demo() && !PROVIDER) {
    console.log(`  ${red('✖')} ${path.relative(path.join(__dirname, '..', '..'), PROVIDER_FILE)} not found`);
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
    const caps = capsFor(arg, profiles[arg]);
    console.log(dim(`  ${caps ? caps.summary : 'capabilities unknown'}`));
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
  console.log(`  thinking ${state.thinking ? grn('on') : dim('off')} ${dim('· reasoning is rendered dim as it arrives; it goes back to the provider only where the profile requires it to continue a tool exchange')}`);
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

// Which budget the run is actually sized against. Printed, not assumed: a run on a
// 1M-token window sized by the legacy char field is using a sliver of it, and the
// operator should be able to see that rather than guess.
function budgetLabel(source) {
  if (source === 'window') return 'model window';
  if (source === 'legacy_chars') return 'legacy char budget · set context_window_tokens';
  return 'default';
}
const ktok = (n) => (Number(n) / 1000).toFixed(1) + 'k';

// The real compaction, the same one the next request applies (local/context.js).
// It rewrites the stored history, so what the TUI reports is what the loop will send.
function cmdCompact() {
  console.log('');
  if (!state.live || !Array.isArray(state.liveHistory) || !state.liveHistory.length) {
    console.log(dim('  nothing to compact · no model context in this session'));
    console.log(dim('  /live attaches a provider; compaction applies to that conversation'));
    console.log('');
    return;
  }
  let result;
  try {
    result = state.live.compact(state.liveHistory);
  } catch (e) {
    console.log(`  ${red('✖')} compaction failed: ${e.message}`);
    console.log(dim('  the history is unchanged'));
    console.log('');
    return;
  }
  const s = result.stats;
  const changed = s.droppedBlocks > 0 || s.clipped > 0 || s.repairs.length > 0;
  if (!changed) {
    console.log(dim(`  nothing to compact · ${ktok(s.after)} / ${ktok(s.budget)} tokens (${budgetLabel(s.source)})`));
    if (s.systemOverBudget) console.log(`  ${ylw('!')} the system contract alone exceeds the budget`);
    console.log('');
    return;
  }
  state.liveHistory = result.messages;
  // The file follows the operator's decision: a restart after /compact must resume the
  // trimmed conversation, not the one that was just compacted away.
  if (state.live.saveState) state.live.saveState(state.liveHistory);
  state.contextPct = s.budget > 0 ? Math.min(100, Math.round((s.after / s.budget) * 100)) : 0;
  console.log(`  ${grn('✓')} context compacted · ${ktok(s.before)} → ${ktok(s.after)} tokens · budget ${ktok(s.budget)} (${budgetLabel(s.source)}) · ctx ${state.contextPct}%`);
  const bits = [];
  if (s.droppedBlocks) bits.push(`${s.droppedBlocks} block(s) dropped (${s.droppedMessages} messages)`);
  if (s.clipped) bits.push(`${s.clipped} oversized message(s) clipped`);
  if (s.repairs.length) bits.push(`${s.repairs.length} invalid message(s) repaired`);
  if (s.digest) bits.push('state digest kept: targets, artifacts, findings');
  if (bits.length) console.log(dim(`  ${bits.join(' · ')}`));
  if (s.systemOverBudget) console.log(`  ${ylw('!')} the system contract alone exceeds the budget — history was dropped to keep it`);
  console.log(dim('  the next turn keeps the contract, the target/state digest and the most recent turn'));
  console.log('');
}

function cmdClear() {
  if (!process.stdout.isTTY) {
    console.log(dim('  nothing to clear · stdout is not a TTY'));
    console.log('');
    return;
  }
  process.stdout.write('\x1b[2J\x1b[H');
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

// ── dispatch ───────────────────────────────────────────────────────────────
async function handleCommand(line) {
  const parts = line.trim().split(/\s+/);
  const cmd = parts[0];
  const arg = parts.slice(1).join(' ');

  switch (cmd) {
    case '/help': printHelp(); return;
    case '/demo':
      if (arg && arg !== 'sqli' && arg !== 'idor') {
        console.log(`  ${red('usage')} /demo [sqli|idor]`);
        return;
      }
      await runDemo(arg === 'idor' ? 'idor' : 'sqli'); return;
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
    case '/todos': cmdTodos(); return;
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

module.exports = {
  handleCommand, cmdLive, cmdScope, cmdTarget, cmdPhase, cmdClass, cmdModel,
  cmdThinking, cmdMode, cmdDetails, cmdClear, cmdPermissions, cmdCompact,
};
