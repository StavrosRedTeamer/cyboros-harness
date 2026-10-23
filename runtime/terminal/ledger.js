// runtime/terminal/ledger.js — the read-only views over what the engagement recorded.
//
// Budget, findings, the report gate, the bill, the session card, the event trace, the
// todo plan, and the session list/resume. These read state or disk and print; they do
// not change what the run will do next. /compact is not here: it rewrites the model
// context and lives with the commands that mutate the session.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { OPTS } = require('./args');
const {
  COLOR, dim, bold, cyan, mag, grn, ylw, red, stripAnsi, W, wrap, pad, box, meter,
} = require('./theme');
const { todoLines } = require('../render');
const sessionState = require('../session-state');
// What a findings ledger is, and every way it can fail to be one: one owner for the
// terminal and the CLI report.
const { readFindings } = require('../findings');
// The rollup and its formatting, shared with the console so both say the same number.
const bill = require('../usage');
const {
  state, demo, targetLabel, phaseTag, modeTag, scopeBadge, scopeDetail, budget, costView, costFigure, money,
  PHASES,
} = require('./state');

const FINDINGS_FILE = process.env.FINDINGS_JSONL || path.join(__dirname, '..', '..', 'reports', 'findings.jsonl');
// Same root `runtime/live.js` writes to: a session the run created must be a session
// `/sessions` and `/resume` can see.
const SESSIONS_DIR = sessionState.sessionsRoot();

function cmdBudget() {
  const b = state.budget;
  const spent = budget();
  console.log('');
  console.log(`  ${dim('requests')}  ${pad(`${spent.req} / ${b.maxReq}`, 14)} ${meter((spent.req / b.maxReq) * 100)} ${dim(((spent.req / b.maxReq) * 100).toFixed(1) + '%')}`);
  console.log(`  ${dim('wall')}      ${pad(`${b.minutes} / ${b.maxMinutes} min`, 14)} ${meter((b.minutes / b.maxMinutes) * 100)} ${dim(((b.minutes / b.maxMinutes) * 100).toFixed(1) + '%')}`);
  console.log(`  ${dim('tokens')}    ${pad(`${(spent.tokens / 1000).toFixed(1)}k / ${(b.maxTokens / 1000)}k`, 14)} ${meter((spent.tokens / b.maxTokens) * 100)} ${dim(((spent.tokens / b.maxTokens) * 100).toFixed(1) + '%')}`);
  console.log('');
  console.log(`  ${dim('cost')}      ${bold(costFigure())} ${dim('· ' + (costView().known ? 'accumulated from this session\'s calls' : demo() ? 'scripted walkthrough spend, not a provider bill' : 'no price was reported or declared'))}`);
  if (state.live) console.log(dim(`  live tokens ${state.liveUsage.tokens_in} in / ${state.liveUsage.tokens_out} out · session ${state.live.session.id}`));
  // A resumed session carries its own counters: the numbers above are that engagement's,
  // not a prototype's, and the next live turn continues them.
  else if (!demo()) console.log(dim(bill.normalizeUsage(state.liveUsage).requests
    ? '  carried from the resumed session · the next live turn continues them'
    : '  prototype counters · M1 reads the real ledger and budget hook'));
  console.log('');
}

function severityPaint(sev) {
  const s = String(sev || 'INFO').toUpperCase();
  if (s === 'CRITICAL') return red(s);
  if (s === 'HIGH') return mag(s);
  if (s === 'MEDIUM' || s === 'MED') return ylw(s);
  if (s === 'LOW') return cyan(s);
  return dim(s);
}

function printFinding(f) {
  const title = f.title || f.class || 'finding';
  const where = f.endpoint || f.url || f.host || '';
  printFindingRow(f.severity, title, where, `verify_level ${f.verify_level || 'unclassified'} · status ${f.status || '—'}`);
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
  if (demo()) {
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
  const res = readFindings(FINDINGS_FILE);
  const rel = path.relative(process.cwd(), FINDINGS_FILE) || FINDINGS_FILE;
  if (!res.ok) {
    if (res.kind === 'absent') {
      console.log(dim(`  no findings ledger yet · ${rel}`));
    } else if (res.kind === 'corrupt') {
      console.log(`  ${red('✖')} the findings ledger is corrupt · ${rel} · line ${res.line} ${res.detail}`);
      // The rows before the bad line are evidence, not a ledger: show them under a
      // heading that says the file is still not to be trusted.
      if (res.rows.length) {
        console.log(dim(`  ${res.rows.length} readable row(s) before it · shown as a warning, not a pass`));
        for (const f of res.rows.slice(-12)) printFinding(f);
      }
    } else {
      console.log(`  ${red('✖')} the findings ledger is unreadable · ${rel} · ${res.error}`);
    }
    console.log('');
    return;
  }
  const rows = res.rows;
  if (!rows.length) {
    console.log(dim(`  the ledger is empty · ${rel}`));
    console.log('');
    return;
  }
  console.log(dim(`  ${rows.length} finding(s) · ${rel} · read-only`));
  for (const f of rows.slice(-12)) printFinding(f);
  if (rows.length > 12) console.log(dim(`  … ${rows.length - 12} more`));
  console.log('');
}

function cmdGate() {
  console.log('');
  if (demo()) {
    const covered = 4;
    const total = 9;
    const pending = state.findings.filter((f) => f.verify === 'suspected').length;
    console.log(`  coverage  ${bold(covered + ' / ' + total)} classes  ${meter((covered / total) * 100)}`);
    console.log(`  pending   ${pending} finding(s)`);
    console.log(`  report    ${ylw('LOCKED')} ${dim('· opens only when coverage is complete and no finding is pending')}`);
    console.log('');
    return;
  }
  const res = readFindings(FINDINGS_FILE);
  // An absent ledger records nothing, so it counts zero; a corrupt or unreadable one
  // cannot be counted at all, and saying zero there would be an invented number. The
  // readable rows of a corrupt file are a warning, never a count.
  const rows = res.ok ? res.rows : (res.kind === 'absent' ? [] : null);
  const pending = rows ? `${rows.filter((f) => f.verify_level === 'suspected').length} finding(s) at verify_level suspected` : dim('unknown · the findings ledger cannot be read');
  console.log(`  coverage  ${dim('unknown · tools/coverage-loop.js owns it')}`);
  console.log(`  pending   ${pending}`);
  console.log(`  report    ${ylw('LOCKED')} ${dim('· prototype gate · M1 wires tools/gate.js and coverage-loop.js')}`);
  console.log('');
}

// The engagement's economics, not the last request's: one rollup, accumulated in the
// loop and persisted with the session, so a resume continues the total. Every amount
// says where it came from, and a total that cannot include every call says it is a floor.
function cmdCost() {
  const v = costView();
  const u = bill.normalizeUsage(state.liveUsage);
  console.log('');
  console.log(`  session ${cyan(state.live ? state.live.session.id : state.session)}`);
  if (demo()) {
    console.log(`  tokens  ${(state.budget.tokens / 1000).toFixed(1)}k in/out · ${dim('18.2k in / 2.1k out last turn')}`);
    console.log(`  cost    ${bold('$' + state.budget.cost.toFixed(3))} ${dim('provider-reported')}`);
    console.log('');
    return;
  }
  if (!state.live && !u.requests) {
    console.log(`  tokens  ${dim('no provider call yet · a --live turn records usage')}`);
    console.log(`  ${dim('cost')}    ${bold('unknown')} ${dim('· nothing has been spent in this session')}`);
    console.log('');
    return;
  }
  // Turns of the engagement, not of this process: a resumed session already has some.
  const turns = state.live ? state.live.turns() : (state.resumeReport && state.resumeReport.turns) || 0;
  console.log(`  requests ${u.requests}${v.partial ? dim(` (${v.pricedCalls} priced · ${v.unpriced} unpriced)`) : ''} · ${turns} turn(s)`);
  console.log(`  tokens  ${u.tokens_in} in / ${u.tokens_out} out · ${dim('provider-counted')}`);
  console.log(`  cost    ${bold(bill.costText(v))}`);
  if (u.cost.provider || u.cost.declared || u.cost.unattributed) {
    const parts = [];
    if (u.cost.provider) parts.push(`provider ${money(u.cost.provider)}`);
    if (u.cost.declared) parts.push(`declared ${money(u.cost.declared)}`);
    if (u.cost.unattributed) parts.push(`unrecorded ${money(u.cost.unattributed)}`);
    console.log(`  ${dim('split')}   ${dim(parts.join(' · '))}`);
  }
  if (v.partial) {
    console.log(`  ${ylw('!')} ${v.unpriced} call(s) had no price: the total is a floor, not the bill`);
    console.log(dim('  declare a price table in the profile (capabilities.pricing) to close the gap'));
  }
  if (state.live && state.live.lastSave && state.live.lastSave()) {
    const ls = state.live.lastSave();
    console.log(dim(`  saved   ${ls.error ? 'failed: ' + ls.error : path.relative(process.cwd(), state.live.stateFile())}`));
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
    `${dim('session:')} ${state.live ? state.live.session.id : state.session}${demo() ? ' · prompt 9c1e… · config 4a7d…' : ''}`,
    ...(state.resumeId ? [`${dim('resume:')} ${cyan(state.resumeId)} ${dim('pending — the next live turn continues it')}`] : []),
    ...(state.live && state.live.lastSave() ? [`${dim('state:')} ${state.live.lastSave().error ? red('save failed') : grn('saved')} ${dim(path.relative(process.cwd(), state.live.stateFile()) || state.live.stateFile())}`] : []),
    `${dim('budget:')} ${budget().req}/${state.budget.maxReq} req · ${costFigure()} · ctx ${state.contextPct}%`,
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

// The engagement plan as Claude Code's todo checklist. A run keeps its own list
// (the demo seeds one); otherwise the plan is the phase ladder, with the current
// phase in progress and the ones before it done.
function cmdTodos() {
  console.log('');
  let list = state.todos || [];
  if (!list.length) {
    const here = Math.max(0, PHASES.indexOf(state.phase));
    list = PHASES.map((p, i) => ({
      text: p,
      status: i < here ? 'done' : i === here ? 'active' : 'pending',
    }));
  }
  console.log(`  ${bold('⏺')} ${bold('Todos')} ${dim('· ' + phaseTag())}`);
  const rows = todoLines(list, { color: COLOR });
  rows.forEach((row, i) => console.log(i === 0 ? `    ${dim('⎿')}  ${row}` : `       ${row}`));
  console.log('');
  console.log(dim('  the plan the run is working; a scripted or live turn updates it'));
  console.log('');
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

// What a continuation restored, in the operator's terms: how much conversation, and which
// facts (targets, artifacts, findings, actions) came with it. Counts only — the file either
// verified or it did not, and this prints what the loop will actually send.
function printResumeReport(id, r) {
  const rep = r.report || {};
  const facts = rep.facts || {};
  const bits = [
    `${rep.messages || 0} message(s)`,
    `${facts.hosts || 0} target(s)`,
    `${facts.findings || 0} finding(s)`,
    `${facts.files || 0} artifact(s)`,
    `${facts.actions || 0} action(s)`,
  ];
  console.log(`  ${grn('✓')} ${cyan(id)} · ${bits.join(' · ')}${rep.turns ? dim(` · ${rep.turns} turn(s)`) : ''}`);
  if (rep.last_user) console.log(dim(`  last instruction: ${String(rep.last_user).slice(0, 120)}`));
  if (rep.trimmed && rep.trimmed.droppedMessages) {
    console.log(`  ${ylw('!')} ${rep.trimmed.droppedMessages} message(s) were trimmed when it was saved (size cap)`);
  }
  if (rep.repaired && rep.repaired.length) console.log(`  ${ylw('!')} ${rep.repaired.length} invalid message(s) repaired: ${rep.repaired.map((x) => x.reason).join(', ')}`);
  if (rep.digestAdded) console.log(dim('  a state digest was inserted for what the repair dropped'));
  if (rep.ageHours != null) console.log(dim(`  saved ${rep.ageHours}h ago`));
  // A resumed engagement continues its accounting, so the bill so far belongs in the
  // restore report, labelled exactly like the live one.
  const rollup = bill.normalizeUsage(r.usage);
  if (rollup.requests) {
    const v = bill.costView(rollup);
    console.log(dim(`  spent so far: ${rollup.requests} call(s) · ${rollup.tokens_in} in / ${rollup.tokens_out} out · ${bill.costText(v)}`));
  }
}

function cmdSessions(arg) {
  console.log('');
  if (arg) {
    // A session id names ONE directory under the sessions root. A separator or a `..`
    // is refused before path.join: it would otherwise load a state.json from outside the
    // root this command says it reads.
    if (arg === '.' || arg === '..' || /[\\/]/.test(arg)) {
      console.log(`  ${red('✖')} ${arg} is not a session id`);
      console.log(dim('  a session id is one directory name under reports/agent/sessions'));
      console.log('');
      return;
    }
    const dir = path.join(SESSIONS_DIR, arg);
    if (!demo() && !fs.existsSync(dir)) {
      console.log(`  ${red('✖')} ${arg} is not a session under reports/agent/sessions`);
      console.log(dim('  /resume without an id lists what exists'));
      console.log('');
      return;
    }
    if (demo()) {
      state.session = arg;
      console.log(`  attached ${cyan(arg)} ${dim('(prototype · no session file is read)')}`);
      console.log('');
      return;
    }
    // Validated at attach time, not at the next turn: a rejected or stale file must be a
    // refusal the operator sees now, with the reason, not a surprise mid-engagement.
    const loaded = sessionState.load(dir, { allowStale: OPTS.allowStale });
    if (!loaded.usable) {
      console.log(`  ${red('✖')} cannot resume ${arg}: ${loaded.reason}`);
      if (loaded.status === 'stale') console.log(dim('  --allow-stale (or /resume after checking the target) continues anyway'));
      console.log('');
      return;
    }
    if (state.live && state.live.session.id === arg) {
      state.session = arg;
      state.resumeReport = loaded.report;
      printResumeReport(arg, loaded);
      console.log(dim('  already attached to this session'));
      console.log('');
      return;
    }
    state.resumeId = arg;
    state.resumeReport = loaded.report;
    state.session = loaded.id || arg;
    state.target = loaded.host || state.target;
    state.phase = loaded.phase || state.phase;
    state.klass = loaded.class || state.klass;
    // The bill so far is part of what was restored: without this, /cost would report
    // "nothing has been spent" for an engagement that is already on the invoice, and the
    // next /live turn would start the total from zero. A running session's own rollup
    // stays authoritative — it is the one that will keep accumulating now.
    if (!state.live) {
      state.liveUsage = bill.normalizeUsage(loaded.usage);
    }
    printResumeReport(arg, loaded);
    console.log(dim(state.live
      ? '  the running session is still yours: /live reconnects into this one'
      : '  the next live turn continues this session (/live, or just type and accept consent)'));
    console.log('');
    return;
  }
  if (!demo()) {
    const rows = readSessions();
    if (rows == null || !rows.length) {
      console.log(dim('  no agent sessions yet · reports/agent/sessions/<id>/ meta.json'));
      console.log(dim('  a --live run writes them, with state.json for /resume; /demo shows the shape'));
      console.log('');
      return;
    }
    console.log(`  ${dim('id        when              phase               state      resumable')}`);
    for (const s of rows.slice(0, 10)) {
      const when = String(s.started_at || '').slice(0, 16).replace('T', ' ');
      const phase = [s.phase, s.class].filter(Boolean).join('/') || '—';
      // Pad the plain text, then colour it: padding counts escape characters too, so a
      // coloured string padded afterwards would break the column for every row below it.
      const statusText = s.status === 'halted' ? 'halted' : s.status === 'ok' ? 'ok' : (s.status || 'unknown');
      const tone = s.status === 'halted' ? ylw : s.status === 'ok' ? grn : dim;
      // The column is the state file, not a hope: what can be resumed says how much
      // conversation it holds; what cannot says why in one word.
      let resumeText = 'no state';
      let resumeTone = dim;
      const one = sessionState.load(path.join(SESSIONS_DIR, s.id), { maxAgeHours: 1e9 });
      if (one.usable) {
        resumeText = `${one.report.messages} msg · ${one.report.facts.findings} finding(s)`;
        resumeTone = grn;
      } else if (one.status === 'rejected') { resumeText = 'invalid'; resumeTone = red; }
      else if (one.status === 'stale') { resumeText = 'stale'; resumeTone = ylw; }
      console.log(`  ${cyan(pad(s.id, 10))} ${pad(when || '—', 17)} ${pad(phase, 19)} ${tone(pad(statusText, 10))} ${resumeTone(resumeText)}`);
    }
    console.log('');
    console.log(dim('  /resume <id> attaches it · the next live turn continues from the saved state'));
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


module.exports = {
  cmdBudget, cmdFindings, cmdGate, cmdCost, cmdStatus, cmdTrace, cmdTodos, cmdSessions,
};
