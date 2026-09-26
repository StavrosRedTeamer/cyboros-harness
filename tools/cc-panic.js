#!/usr/bin/env node
// Panic switch (guardrail §2.8): stop ONLY processes the harness owns — registered scan tasks
// and the fbpty.py PTY bridges spawned from THIS workspace. Never arbitrary pids, never a
// wildcard kill. Idempotent: a second run with nothing to stop is a no-op. One audit-trail
// entry per run records exactly what was stopped.
//
// CLI: node tools/cc-panic.js [--json]
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const u = require('./cc-util');

const WS = process.env.CC_ROOT || u.ROOT;

function registeredTasks() {
  try {
    const reg = require('./proc-registry');
    const st = reg.load();
    return Object.values((st && st.tasks) || {}).filter((t) => t && t.pid && t.status === 'running');
  } catch { return []; }
}

// fbpty.py bridges are identified by BOTH the script name and this workspace path on the
// process's command line — a bare pattern match on "fbpty.py" alone would be too broad.
function fbptyPids() {
  const r = spawnSync('pgrep', ['-f', 'fbpty.py'], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return [];
  const out = [];
  for (const pid of r.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
    try {
      const cmd = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8');
      if (cmd.includes(path.join(WS, 'tools', 'fbpty.py')) || cmd.includes(WS + '/tools/fbpty.py')) out.push(Number(pid));
    } catch { /* process vanished */ }
  }
  return out;
}

function main(argv) {
  const asJson = argv.includes('--json');
  const stopped = [];
  const already = [];

  for (const t of registeredTasks()) {
    try {
      const r = require('./proc-registry').terminate(t.task_id);
      if (r && r.ok) stopped.push({ kind: 'task', task_id: t.task_id, pid: t.pid, bin: t.bin });
      else already.push({ kind: 'task', task_id: t.task_id, reason: (r && r.error) || 'not running' });
    } catch (e) { already.push({ kind: 'task', task_id: t.task_id, reason: String((e && e.message) || e) }); }
  }

  for (const pid of fbptyPids()) {
    try { process.kill(pid, 'SIGTERM'); stopped.push({ kind: 'pty', pid }); }
    catch (e) { already.push({ kind: 'pty', pid, reason: String((e && e.message) || e) }); }
  }

  const entry = { ts: new Date().toISOString(), tool: 'cc-panic', event: 'panic', stopped, already, idempotent: stopped.length === 0 };
  try { require('./audit-trail').append(entry); } catch { /* ledger best-effort */ }

  const out = { ok: true, stopped: stopped.length, already: already.length, details: stopped, note: 'only harness-owned processes (registered tasks + workspace PTY bridges) were touched' };
  if (asJson) console.log(JSON.stringify(out, null, 2));
  else console.log('panic: stopped ' + stopped.length + ' process(es); ' + already.length + ' already gone');
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { main, fbptyPids, registeredTasks };
