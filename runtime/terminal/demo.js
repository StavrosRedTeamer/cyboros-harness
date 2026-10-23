// runtime/terminal/demo.js — the scripted walkthrough behind --demo and /demo.
//
// Synthetic scope, synthetic target, no provider call, no network: what is real is the
// shape of a turn — scope check, replay, a suspected finding, the confirm-tier approval,
// the triggered finding, the todo block. It exists to rehearse the surface, not to prove
// anything about a host.
'use strict';

const { dim } = require('./theme');
const { state, ev, addFinding, enterDemo } = require('./state');
const { sayUser, assistant, tool, finding, updateTodos } = require('./surfaces');
const { approval } = require('./approval');
const { runTurn } = require('./turn');

// ── scripted turns ─────────────────────────────────────────────────────────
async function runSqlDemo() {
  state.phase = 'web-test';
  state.klass = 'sqli';
  ev('run_start', `${state.target} · ${state.phase}/${state.klass}`);
  await sayUser('Test SQL injection on /api/orders. Benign marker first.');
  await assistant('Map is ready: 18 endpoints, 4 with parameters. I will check scope, recall the technique, then probe `id` with a benign quote before anything intrusive.');

  await updateTodos([
    { text: 'Map the target surface', status: 'done' },
    { text: 'Probe /api/orders?id for SQL injection', status: 'active' },
    { text: 'Prove the hypothesis with a timing oracle', status: 'pending' },
    { text: 'Cover authz (IDOR) on the same object', status: 'pending' },
    { text: 'Close the report gate', status: 'pending' },
  ]);

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

    await updateTodos([
      { text: 'Map the target surface', status: 'done' },
      { text: 'Probe /api/orders?id for SQL injection', status: 'done' },
      { text: 'Prove the hypothesis with a timing oracle', status: 'done' },
      { text: 'Cover authz (IDOR) on the same object', status: 'active' },
      { text: 'Close the report gate', status: 'pending' },
    ]);

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
  return runTurn(() => (kind === 'idor' ? runIdorDemo() : runSqlDemo()));
}

module.exports = { runDemo };
