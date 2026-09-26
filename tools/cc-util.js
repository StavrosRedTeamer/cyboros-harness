#!/usr/bin/env node
// Command Center — shared helpers for the cc-* modules (WP3..WP9, zero-dep).
//
// Why this exists: each cc-* module needs the same primitives — atomic JSON writes,
// JSONL append/read, hashing, slugging, and a bounded synchronous wrapper over the
// harness CLIs (so a module NEVER re-implements a guard/planner). Keeping them here
// avoids drift between modules and keeps every module testable by pointing the path
// resolvers at a tmpdir (env overrides), never the real engagement files.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function nowIso() { return new Date().toISOString(); }

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function atomicWriteJson(file, obj) {
  atomicWrite(file, JSON.stringify(obj, null, 2) + '\n');
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function appendJsonl(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

function sha256(data) {
  return crypto.createHash('sha256').update(typeof data === 'string' ? data : Buffer.from(data)).digest('hex');
}

function slug(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'campaign';
}

// Run a harness tool and capture its output. Never throws on non-zero exit: the
// caller decides (fail-closed is a policy, not an exception). Bounded so a stuck
// tool cannot hang the request thread forever.
function runTool(args, opts) {
  const o = opts || {};
  try {
    const stdout = execFileSync(process.execPath, args, {
      cwd: o.cwd || ROOT,
      env: Object.assign({}, process.env, o.env || {}),
      timeout: o.timeoutMs || 30000,
      maxBuffer: 32 * 1024 * 1024,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, code: 0, stdout: String(stdout), stderr: '' };
  } catch (e) {
    return {
      ok: false,
      code: typeof e.status === 'number' ? e.status : 1,
      stdout: e.stdout ? String(e.stdout) : '',
      stderr: e.stderr ? String(e.stderr) : String((e && e.message) || e),
      timeout: !!e.killed,
    };
  }
}

// Run a tool whose CLI emits a single JSON document; returns the parsed object or
// null when the tool failed / printed something unparseable (caller fails closed).
function runToolJson(args, opts) {
  const r = runTool(args, opts);
  const text = (r.stdout || '').trim();
  try { return { ok: r.ok, code: r.code, json: JSON.parse(text), raw: text }; }
  catch {
    // Some tools pretty-print with a banner before the JSON object; take the last
    // balanced-looking block as a fallback.
    const start = text.indexOf('{');
    if (start >= 0) {
      try { return { ok: r.ok, code: r.code, json: JSON.parse(text.slice(start)), raw: text }; }
      catch { /* fall through */ }
    }
    return { ok: r.ok, code: r.code, json: null, raw: text };
  }
}

module.exports = {
  ROOT, nowIso, readJson, atomicWrite, atomicWriteJson, readJsonl, appendJsonl,
  sha256, slug, runTool, runToolJson,
};
