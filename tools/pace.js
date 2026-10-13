#!/usr/bin/env node
// Global cross-process rate limiter.
// Every network tool (repeater.js, cors.js, graphql.js, dom-check.js, oob.js clients, ...)
// calls pace.wait(rps) before each request. State lives in a file (tools/.pace.json), so
// the limit holds even when several agents/processes run in parallel — scope.json's
// max_requests_per_second becomes a true global ceiling instead of a per-process one.
//
// Best-effort: two processes can still race the file write; that's acceptable. If the
// state file is deleted the limiter resets (last=0).
const fs = require('fs');
const path = require('path');

const PACE_FILE = process.env.PACE_FILE || path.join(__dirname, '.pace.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(PACE_FILE, 'utf8'));
  } catch {
    return { last: 0 };
  }
}

// Sync sleep without deps (works in the main thread in Node).
function sleep(ms) {
  if (ms <= 0) return;
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
}

// Claim the next slot (sync, fast, temp+rename). Concurrent reservations serialize on the
// file and get sequential `next` values. Returns ms to wait (>= 0). Best-effort across
// processes (a lost race just relaxes the gap slightly), same guarantee as before.
function reserve(rps, opts) {
  const o = opts || {};
  const gap = Math.max(1000 / Math.max(0.1, rps || 2), o.minGap || 0);
  const state = load();
  const now = Date.now();
  const next = Math.max(state.last + gap, now);
  const tmp = PACE_FILE + '.' + process.pid;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ last: next }));
    fs.renameSync(tmp, PACE_FILE);
  } catch {}
  return Math.max(0, next - now);
}

// Legacy sync wait (blocks the thread). Keep for short-lived one-shot CLIs.
function wait(rps, opts) {
  const ms = reserve(rps, opts);
  if (ms > 0) sleep(ms);
  return ms;
}

// Non-blocking wait — for async orchestrators (cyboros.js). Same global ceiling, but the
// event loop stays live during the gap so concurrent work actually overlaps.
async function waitAsync(rps, opts) {
  const ms = reserve(rps, opts);
  if (ms > 0) await new Promise((r) => setTimeout(r, ms));
  return ms;
}

module.exports = { wait, waitAsync, reserve, PACE_FILE };
