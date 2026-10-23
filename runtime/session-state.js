#!/usr/bin/env node
// runtime/session-state.js — the durable handoff between one process and the next.
//
// Why it exists
// -------------
// A session log (`events.jsonl`) records what happened; it is not state you can resume
// from. The model conversation lived only in the TUI's memory, so a kill, a crash or a
// closed terminal meant the next process rediscovered the target from zero: re-scan the
// same host, re-read the same map, re-record the same findings. On a real engagement that
// is the difference between a usable harness and a demo.
//
// This module owns ONE file per session — `state.json`, next to `meta.json` and
// `events.jsonl` — holding the parts a continuation actually needs:
//
//   · the message history the loop would send next (already compacted if it was),
//   · the facts extracted from it: targets, artifacts, findings, actions taken,
//   · the run's identity (host, phase, class, profile, model), usage and turn count.
//
// `usage` is the bill (tokens, requests, cost with its source and its unpriced count). The
// rules for it and every rendering of it live in `runtime/usage.js`; this file only stores
// the rollup it is handed and normalises whatever an older file contains, so a resumed
// engagement continues its accounting rather than starting a second one.
//
// It owns no knowledge of what a target or a finding looks like: `extractFacts()` and
// `renderDigest()` in `local/context.js` already decide that for compaction, and a second
// copy here would drift from the one the model is shown. Facts are re-derived from the
// stored messages on every save and merged with the previous snapshot, so trimming old
// messages never forgets a finding that was recorded three turns ago.
//
// Honesty rules, same as the conformance probe:
//
//   1. A file that does not verify is REJECTED with the reason, never half-used. The
//      payload is hashed on write and re-hashed on read: a truncated write, an interrupted
//      rename or a hand-edited file fails loudly.
//   2. What was restored is reported as counts, and what was dropped or repaired is
//      reported too. A resume that silently loses the operator's instruction is the bug.
//   3. The loaded history is put through `validate()` — the same send-boundary check the
//      loop uses — and repaired with `compile()` if it fails, so a resumed history can
//      never reintroduce the orphaned-tool 400. A history that cannot be made valid is
//      rejected, not silently reduced to "system + last message".
//
// Staleness is a fact about the file, not a judgement: a session older than the limit is
// `stale` and unusable unless the caller says otherwise, because resuming a week-old
// engagement without noticing is how a stale map gets treated as current.

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  splitBlocks, validate, compile, extractFacts, renderDigest, FACT_LIMITS,
} = require('../local/context');
// The bill is its own module: this file stores it, it does not define it.
const { normalizeUsage } = require('./usage');

// One definition of where sessions live, because two would drift: `runtime/live.js`
// writes a session under one root while the TUI looked under another, so `/resume` said
// "not a session" for a directory the run had just created. Both env names are honoured
// (the console and the tests use `CYBOROS_AGENT_DIR`, older surfaces `CYBOROS_SESSIONS_DIR`).
function sessionsRoot() {
  return process.env.CYBOROS_AGENT_DIR
    || process.env.CYBOROS_SESSIONS_DIR
    || path.join(__dirname, '..', 'reports', 'agent', 'sessions');
}

const FILE = 'state.json';
const VERSION = 1;
// A resume context, not an archive: 8 MB is far more history than a model window holds,
// so this only ever trims a session whose tool output was enormous.
const MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_AGE_HOURS = 24 * 7;
// The repaired history must be sendable at any size; a budget this large means `compile`
// drops nothing for length and only applies its structural repairs.
const REPAIR_BUDGET = 10_000_000;

const sha = (text) => 'sha256:' + crypto.createHash('sha256').update(text).digest('hex');
const statePath = (dir) => path.join(dir, FILE);

function readDoc(dir) {
  try { return JSON.parse(fs.readFileSync(statePath(dir), 'utf8')); } catch { return null; }
}

// Facts, from the same extractor compaction uses. Nothing is invented here.
function factsFrom(messages) {
  return extractFacts(splitBlocks(Array.isArray(messages) ? messages : []).blocks);
}

// Union with the newest surviving the cap: over a long engagement the recent findings
// matter more than the first three hosts, and the per-category limits are the digest's.
function union(a, b, limit) {
  const seen = new Set();
  const out = [];
  for (const value of [...(a || []), ...(b || [])]) {
    const v = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v.slice(0, 160));
  }
  return out.length > limit ? out.slice(out.length - limit) : out;
}

function mergeFacts(a, b) {
  const x = a || {};
  const y = b || {};
  return {
    hosts: union(x.hosts, y.hosts, FACT_LIMITS.hosts),
    files: union(x.files, y.files, FACT_LIMITS.files),
    findings: union(x.findings, y.findings, FACT_LIMITS.findings),
    actions: union(x.actions, y.actions, FACT_LIMITS.actions),
  };
}

const factCount = (f) => (f ? f.hosts.length + f.files.length + f.findings.length + f.actions.length : 0);

// Trims by WHOLE blocks, from the front, until the payload fits. Cutting inside an
// exchange is how a stored history becomes unsendable.
function capMessages(messages, maxBytes) {
  const bytes = (list) => Buffer.byteLength(JSON.stringify(list));
  if (bytes(messages) <= maxBytes) return { messages, droppedBlocks: 0, droppedMessages: 0, bytes: bytes(messages) };
  const split = splitBlocks(messages);
  const blocks = split.blocks.slice();
  while (blocks.length > 1 && bytes([...split.system, ...blocks.flatMap((b) => b.messages)]) > maxBytes) {
    blocks.shift();
  }
  const out = [...split.system, ...blocks.flatMap((b) => b.messages)];
  return {
    messages: out,
    droppedBlocks: split.blocks.length - blocks.length,
    droppedMessages: split.blocks.slice(0, split.blocks.length - blocks.length)
      .reduce((n, b) => n + b.messages.length, 0),
    bytes: bytes(out),
  };
}

// Insert the digest of what the repair dropped, ahead of the kept history. Same renderer
// the compactor uses, so a resumed conversation reads like a compacted one.
function withDigest(messages, facts, meta) {
  const split = splitBlocks(messages);
  const text = renderDigest(facts, meta);
  return [...split.system, { role: 'user', content: text }, ...split.blocks.flatMap((b) => b.messages)];
}

// ── save ───────────────────────────────────────────────────────────────────
// Atomic: a reader never sees a half-written file, and the hash is over the exact bytes
// that follow it.
function save(dir, snapshot = {}, opts = {}) {
  const previous = opts.previous || readDoc(dir);
  const all = Array.isArray(snapshot.messages) ? snapshot.messages : [];
  const capped = capMessages(all, opts.maxBytes || MAX_BYTES);
  const prevFacts = previous && previous.payload ? previous.payload.facts : null;
  // The rollup accumulates: a save that does not carry usage keeps what the file already
  // reported, so a compaction or a metadata write can never reset the accounting.
  const usage = normalizeUsage(snapshot.usage
    || (previous && previous.payload && previous.payload.usage));
  const payload = {
    version: VERSION,
    id: snapshot.id || path.basename(dir),
    saved_at: snapshot.saved_at || new Date().toISOString(),
    host: snapshot.host || null,
    phase: snapshot.phase || null,
    class: snapshot.klass || null,
    profile: snapshot.profile || null,
    model: snapshot.model || null,
    egress: snapshot.egress || null,
    status: snapshot.status || 'open',
    turns: Number(snapshot.turns) || 0,
    last_user: snapshot.last_user ? String(snapshot.last_user).slice(0, 500) : null,
    usage,
    messages: capped.messages,
    // Recorded so a resume can say "this file is a trimmed view" and re-state what the
    // trim removed, instead of letting the model silently lose the early turns.
    trimmed: capped.droppedMessages > 0
      ? { dropped_blocks: capped.droppedBlocks, dropped_messages: capped.droppedMessages }
      : null,
    // From the FULL history, before the cap: facts are extracted once, here, so a turn
    // that gets trimmed on the way to disk still leaves its evidence in the snapshot.
    facts: mergeFacts(prevFacts, factsFrom(all)),
  };
  const body = JSON.stringify(payload);
  fs.mkdirSync(dir, { recursive: true });
  const file = statePath(dir);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify({ integrity: sha(body), payload }, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return {
    file,
    bytes: Buffer.byteLength(body),
    messages: payload.messages.length,
    droppedBlocks: capped.droppedBlocks,
    droppedMessages: capped.droppedMessages,
    facts: payload.facts,
    turns: payload.turns,
    usage: payload.usage,
  };
}

// ── load ───────────────────────────────────────────────────────────────────
function load(dir, opts = {}) {
  const file = statePath(dir);
  const reject = (reason) => ({ status: 'rejected', usable: false, reason, file });

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return {
      status: 'absent', usable: false, file,
      reason: 'no state.json for this session: it was never saved, or it was written before continuity existed',
    };
  }

  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    return reject('state.json is not valid JSON: the write was truncated or half-finished');
  }
  if (!doc || typeof doc !== 'object' || !doc.payload || typeof doc.integrity !== 'string') {
    return reject('state.json has no integrity/payload pair: it is not a state file this build wrote');
  }
  const body = JSON.stringify(doc.payload);
  if (sha(body) !== doc.integrity) {
    return reject('integrity mismatch: the file changed after it was written (truncated, or edited by hand)');
  }

  const p = doc.payload;
  if (p.version !== VERSION) {
    return reject(`unsupported state version ${p.version}: this build writes ${VERSION}, and guessing at another shape is not a resume`);
  }
  if (!Array.isArray(p.messages)) return reject('payload has no messages array');

  const report = {
    session: p.id || path.basename(dir),
    saved_at: p.saved_at || null,
    turns: Number(p.turns) || 0,
    last_user: p.last_user || null,
    repaired: [],
    droppedBlocks: 0,
    droppedMessages: 0,
    digestAdded: false,
  };

  let messages = p.messages;
  // The send-boundary check the loop applies, applied here first: a stored history that
  // would be rejected by a strict provider is repaired before it can be handed over.
  const before = validate(messages);
  if (before.length) {
    const fixed = compile(messages, { budget: REPAIR_BUDGET, scale: 1, digest: false });
    if (fixed.stats.invalidAfterFallback) {
      return reject(`history cannot be made sendable: ${fixed.stats.invalidAfterFallback.join('; ')}`);
    }
    messages = fixed.messages;
    report.repaired = fixed.stats.repairs;
    report.droppedBlocks = fixed.stats.droppedBlocks;
    report.droppedMessages = fixed.stats.droppedMessages;
  }

  // Whatever path the messages took, they must pass the same check before they are used.
  const afterRepair = validate(messages);
  if (afterRepair.length) return reject(`history is still unsendable after repair: ${afterRepair.join('; ')}`);

  let facts = mergeFacts(p.facts, factsFrom(messages));

  // A file that was trimmed on write is a partial view. The digest states what the kept
  // turns no longer contain — rendered by the compactor's own renderer, from the facts the
  // snapshot preserved — so the model resumes with the work, not just the tail.
  if (p.trimmed && p.trimmed.dropped_messages > 0 && messages.length) {
    report.trimmed = { droppedBlocks: p.trimmed.dropped_blocks || 0, droppedMessages: p.trimmed.dropped_messages };
    messages = withDigest(messages, facts, {
      droppedBlocks: p.trimmed.dropped_blocks || 0,
      keptBlocks: splitBlocks(messages).blocks.length,
    });
    report.digestAdded = true;
    const afterDigest = validate(messages);
    if (afterDigest.length) return reject(`history is unsendable after adding the digest: ${afterDigest.join('; ')}`);
  }
  const savedAt = Date.parse(p.saved_at || '');
  const ageHours = Number.isFinite(savedAt) ? (Date.now() - savedAt) / 36e5 : null;
  const maxAgeHours = Number(opts.maxAgeHours) || DEFAULT_MAX_AGE_HOURS;
  const stale = ageHours == null || ageHours > maxAgeHours;

  report.messages = messages.length;
  report.facts = {
    hosts: facts.hosts.length,
    files: facts.files.length,
    findings: facts.findings.length,
    actions: facts.actions.length,
  };
  report.ageHours = ageHours == null ? null : Math.round(ageHours * 10) / 10;

  const base = {
    file,
    id: report.session,
    host: p.host || null,
    phase: p.phase || null,
    // Written as `class` (the JSON key) and read under the same name: the snapshot field
    // is `klass` because `class` is reserved in a destructuring, the file is plain JSON.
    class: p.class || null,
    profile: p.profile || null,
    model: p.model || null,
    status: p.status || 'open',
    usage: normalizeUsage(p.usage),
    messages,
    facts,
    report,
  };

  if (stale) {
    const why = ageHours == null
      ? 'the saved_at timestamp is missing or unreadable'
      : `last saved ${report.ageHours}h ago (limit ${maxAgeHours}h)`;
    return {
      ...base,
      status: 'stale',
      usable: opts.allowStale === true,
      reason: `stale session: ${why} · resume with allowStale to continue anyway`,
    };
  }
  return {
    ...base,
    status: report.repaired.length || report.droppedMessages ? 'repaired' : 'ok',
    usable: true,
    reason: null,
  };
}

module.exports = {
  FILE,
  VERSION,
  MAX_BYTES,
  DEFAULT_MAX_AGE_HOURS,
  sessionsRoot,
  statePath,
  // The write/verify hash over a payload object, exported so a test can build a
  // well-formed file for a shape this build does not write (the version check needs one).
  integrity: (payload) => sha(JSON.stringify(payload)),
  save,
  load,
  factsFrom,
  mergeFacts,
  factCount,
};
