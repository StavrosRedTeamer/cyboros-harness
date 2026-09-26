#!/usr/bin/env node
// WP4 — lato AGENTE: chiedi all'operatore il consenso per un'azione confirm-tier.
//
// L'agente NON esegue nulla qui: deposita una richiesta nella inbox (reports/approvals.jsonl)
// e riceve un id. L'operatore decide dall'app (o da cc-approvals.js); l'agente poi esegue con
// `node tools/run.js ... --approval <id>` (la policy require_approval la fa rispettare).
//
// CLI:
//   node tools/request-approval.js --host <h> --action <class> --command "<cmd>" [--reason s] [--ttl sec] [--by <agent>]
//   node tools/request-approval.js status <id>
'use strict';
const approvals = require('./cc-approvals');

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--host') o.host = argv[++i];
    else if (a === '--action' || a === '--action-class') o.actionClass = argv[++i];
    else if (a === '--command' || a === '--cmd') o.command = argv[++i];
    else if (a === '--reason') o.reason = argv[++i];
    else if (a === '--ttl') o.ttl = argv[++i];
    else if (a === '--by') o.by = argv[++i];
    else if (a === '--json') o.json = true;
    else o._.push(a);
  }
  return o;
}

function main(argv) {
  const cli = parseArgs(argv);
  const cmd = cli._[0] || 'request';

  if (cmd === 'status') {
    const id = cli._[1];
    const row = approvals.list({ all: true }).find((t) => t.id === id);
    if (!row) { console.error(JSON.stringify({ ok: false, error: 'unknown approval id' })); return 1; }
    // Determine effective status through the same fold used by verify.
    const eff = approvals.effective(row);
    console.log(JSON.stringify({ ok: true, id, status: eff.status, expires_at: eff.expires_at, granted_by: eff.granted_by }, null, 2));
    return eff.status === 'granted' ? 0 : 3;   // exit 3 = "waiting for the operator"
  }

  if (!cli.host || !cli.actionClass) {
    console.error('usage: node tools/request-approval.js --host <h> --action <class> --command "<cmd>" [--reason s] [--ttl sec] [--by <agent>]');
    console.error('       node tools/request-approval.js status <id>');
    return 2;
  }
  const r = approvals.request({
    host: cli.host, actionClass: cli.actionClass, command: cli.command,
    reason: cli.reason, by: cli.by || 'agent', ttl: cli.ttl,
  });
  console.log(JSON.stringify(Object.assign({ message: 'approval requested — approve it in the Command Center (Approvals) or with: node tools/cc-approvals.js grant ' + r.id }, r), null, 2));
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { main };
