#!/usr/bin/env node
// tools/autopilot-checkpoint.js — durable driver state for the autopilot loop.
// Single JSON file, atomic tmp+rename (same discipline as tools/sessions.js). Fail-safe reads:
// a missing or corrupt checkpoint yields a fresh default (the loop can always restart clean).
'use strict';
const fs = require('fs');
const path = require('path');

const WS = path.join(__dirname, '..');

function cpPath(file) {
  return file || process.env.AUTOPILOT_CHECKPOINT || path.join(WS, 'reports', 'autopilot', 'checkpoint.json');
}

function defaultCheckpoint() {
  return {
    version: 1,
    engagement_id: null,
    tick: 0,
    phase: 'recon',
    budget_spent: 0,
    prev_remaining: null, // set on first tick
    dry_streak: 0,
    plan_cursor: 0,
    findings_cursor: 0,
    pending_intrusive: [],
    last_verdict: null,
    updated_at: null,
  };
}

function read(file) {
  try {
    const cp = JSON.parse(fs.readFileSync(cpPath(file), 'utf8'));
    if (!cp || cp.version !== 1) return defaultCheckpoint();
    if (!Array.isArray(cp.pending_intrusive)) cp.pending_intrusive = [];
    return cp;
  } catch {
    return defaultCheckpoint();
  }
}

function write(cp, file) {
  const p = cpPath(file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  cp.updated_at = new Date().toISOString();
  const tmp = p + '.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(cp, null, 2));
  fs.renameSync(tmp, p);
  return cp;
}

module.exports = { cpPath, defaultCheckpoint, read, write };

if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === 'show') { console.log(JSON.stringify(read(), null, 2)); }
  else if (cmd === 'reset') { console.log(JSON.stringify(write(defaultCheckpoint()), null, 2)); }
  else { console.error('usage: node tools/autopilot-checkpoint.js show|reset'); process.exit(2); }
}
