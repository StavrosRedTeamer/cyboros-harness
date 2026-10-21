// Console — chat settings: the knobs the chat's settings menu owns.
//
// Why the server owns them instead of the browser: every value here changes what the
// model receives or what a tool is allowed to do, so a stale tab, a second operator or
// a reload must not silently change the answer. The file lives under the data root
// (`app/chat/settings.json`, atomic write); the UI reads it, writes it, and renders
// what comes back — it keeps no copy of its own beyond the current form.
//
// Deliberately absent: anything that authorizes a target. Scope stays in scope.json
// (scope-guard), the tool risk tiers stay in tools/tool-registry.json, and account
// roles stay in users.json. A settings menu that could widen those would be a
// second authorization path, which is exactly what this harness does not have.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = Object.freeze({
  model: null,                 // null = the availability default from /api/chat/models
  preset: null,                // null = the built-in default preset
  temperature: 0.2,
  max_tokens: 2048,
  streaming: true,
  approval_policy: 'ask',      // ask = every intrusive tool waits for the operator
});

const APPROVAL_POLICIES = ['ask', 'deny'];
const KEYS = Object.keys(DEFAULTS);
const LIMITS = {
  temperature: { min: 0, max: 2 },
  max_tokens: { min: 64, max: 32768 },
};

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// Validation returns problems instead of throwing: the settings form needs to show
// every offending field at once, not the first one.
function validate(raw) {
  const problems = [];
  const out = {};
  if (!isPlainObject(raw)) return { problems: ['settings must be an object'], settings: null };

  for (const key of Object.keys(raw)) {
    if (!KEYS.includes(key)) problems.push(`unknown setting: ${key}`);
  }

  if (raw.model === undefined) out.model = null;
  else if (raw.model === null || raw.model === '') out.model = null;
  else if (typeof raw.model === 'string' && raw.model.length <= 120) out.model = raw.model;
  else problems.push('model must be a model id or null');

  if (raw.preset === undefined) out.preset = null;
  else if (raw.preset === null || raw.preset === '') out.preset = null;
  else if (typeof raw.preset === 'string' && raw.preset.length <= 40) out.preset = raw.preset;
  else problems.push('preset must be a preset id or null');

  if (raw.temperature === undefined) out.temperature = DEFAULTS.temperature;
  else {
    const n = Number(raw.temperature);
    if (!Number.isFinite(n) || n < LIMITS.temperature.min || n > LIMITS.temperature.max) {
      problems.push(`temperature must be a number between ${LIMITS.temperature.min} and ${LIMITS.temperature.max}`);
    } else out.temperature = Math.round(n * 100) / 100;
  }

  if (raw.max_tokens === undefined) out.max_tokens = DEFAULTS.max_tokens;
  else {
    const n = Number(raw.max_tokens);
    if (!Number.isInteger(n) || n < LIMITS.max_tokens.min || n > LIMITS.max_tokens.max) {
      problems.push(`max_tokens must be an integer between ${LIMITS.max_tokens.min} and ${LIMITS.max_tokens.max}`);
    } else out.max_tokens = n;
  }

  if (raw.streaming === undefined) out.streaming = DEFAULTS.streaming;
  else if (typeof raw.streaming === 'boolean') out.streaming = raw.streaming;
  else problems.push('streaming must be a boolean');

  if (raw.approval_policy === undefined) out.approval_policy = DEFAULTS.approval_policy;
  else if (APPROVAL_POLICIES.includes(raw.approval_policy)) out.approval_policy = raw.approval_policy;
  else problems.push(`approval_policy must be one of ${APPROVAL_POLICIES.join('|')}`);

  return { problems, settings: problems.length ? null : out };
}

function createChatSettings(opts = {}) {
  const file = opts.file;
  const defaults = Object.assign({}, DEFAULTS, isPlainObject(opts.defaults) ? opts.defaults : {});

  function get() {
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* missing or corrupt: defaults */ }
    const merged = Object.assign({}, defaults, isPlainObject(raw) ? raw : {});
    const { problems, settings } = validate(merged);
    // A stale/corrupt file must not brick the chat: fall back to the defaults and say
    // so, rather than handing a half-valid object to the turn.
    return problems.length ? Object.assign({}, defaults) : settings;
  }

  function save(patch) {
    if (!isPlainObject(patch)) return { ok: false, error: 'settings must be an object', problems: ['settings must be an object'] };
    const next = Object.assign({}, get(), patch);
    const { problems, settings } = validate(next);
    if (problems.length) return { ok: false, error: problems[0], problems };
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
      fs.renameSync(tmp, file);
    } catch (e) {
      return { ok: false, error: `cannot write settings: ${String((e && e.message) || e)}`, problems: [] };
    }
    return { ok: true, settings };
  }

  return { file, get, save, defaults: Object.assign({}, defaults), policies: APPROVAL_POLICIES.slice() };
}

module.exports = { createChatSettings, DEFAULTS, APPROVAL_POLICIES, KEYS, LIMITS, validate };
