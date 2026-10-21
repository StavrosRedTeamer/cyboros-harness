// Console — chat sessions: the conversation the operator can come back to.
//
// Why a store of its own instead of reports/agent/sessions: those sessions are an
// append-only AUDIT of tool runs (meta.json + events.jsonl, written by runtime/live.js
// for the CLI). Resuming a conversation needs the model-shaped messages the loop fed
// back to itself — tool_calls, tool results, assistant turns — which the audit log
// stores only as summaries. So: one small JSON document per conversation, atomic
// writes (tmp + rename, the same discipline as tools/sessions.js), and a transcript
// next to the messages so the UI can redraw tool cards without replaying the model.
//
// Location is the data root (`app/chat/`), not the repository: conversations are
// engagement data and never belong in a checkout.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ID_RE = /^chat-[0-9]{14}-[0-9a-f]{6}$/;
const MAX_MESSAGES = 80;        // resume context, not an archive
const MAX_TRANSCRIPT = 400;
const CLIP_TOOL_CHARS = 4000;   // a raw response is already in reports/ when it matters

function clip(s, n) {
  const t = String(s == null ? '' : s);
  return t.length > n ? t.slice(0, n) + `… (+${t.length - n} chars)` : t;
}

function createChatSessions(opts = {}) {
  const dir = opts.dir;
  fs.mkdirSync(dir, { recursive: true });

  function newId() {
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    return `chat-${stamp}-${crypto.randomBytes(3).toString('hex')}`;
  }

  function fileFor(id) {
    if (!ID_RE.test(String(id || ''))) return null;
    return path.join(dir, `${id}.json`);
  }

  function create(meta = {}) {
    const id = newId();
    const now = new Date().toISOString();
    const doc = {
      id, created: now, updated: now,
      title: clip(meta.title || 'new conversation', 80),
      model: meta.model || null,
      preset: meta.preset || null,
      target: meta.target || null,
      usage: { tokens_in: 0, tokens_out: 0, cost: 0 },
      messages: [],
      transcript: [],
    };
    write(doc);
    return doc;
  }

  function write(doc) {
    const file = fileFor(doc.id);
    if (!file) throw new Error('invalid chat session id');
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n');
    fs.renameSync(tmp, file);
  }

  function get(id) {
    const file = fileFor(id);
    if (!file || !fs.existsSync(file)) return null;
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  }

  // Persist a finished turn. `messages` is the loop's own message array — the same
  // shape runAgent will accept back as `history` — so resume is a load, not a rebuild.
  function save(id, patch = {}) {
    const doc = get(id);
    if (!doc) return null;
    const now = new Date().toISOString();
    if (patch.messages) {
      doc.messages = patch.messages
        .filter((m) => m && m.role && m.role !== 'system')
        .map((m) => (m.role === 'tool'
          ? { role: 'tool', tool_call_id: m.tool_call_id || null, content: clip(m.content, CLIP_TOOL_CHARS) }
          : Object.assign({}, m)))
        .slice(-MAX_MESSAGES);
    }
    if (patch.transcript) doc.transcript = patch.transcript.slice(-MAX_TRANSCRIPT);
    if (patch.usage) doc.usage = patch.usage;
    if (patch.title && doc.title === 'new conversation') doc.title = clip(patch.title, 80);
    if (patch.model) doc.model = patch.model;
    if (patch.preset) doc.preset = patch.preset;
    if (patch.target) doc.target = patch.target;
    doc.updated = now;
    write(doc);
    return doc;
  }

  function list(limit) {
    let names;
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return []; }
    const rows = [];
    for (const name of names) {
      const id = name.replace(/\.json$/, '');
      const doc = get(id);
      if (!doc) continue;   // a broken file is skipped, not fatal
      rows.push({
        id: doc.id, created: doc.created, updated: doc.updated, title: doc.title,
        preset: doc.preset, model: doc.model, target: doc.target,
        turns: (doc.transcript || []).filter((e) => e.type === 'user').length,
      });
    }
    rows.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
    const n = Math.max(1, Math.min(Number(limit) || 30, 100));
    return rows.slice(0, n);
  }

  return { dir, create, save, get, list, fileFor };
}

module.exports = { createChatSessions };
