#!/usr/bin/env node
// Stavros api-authz — API object/function/property-level authorization differentials, built on
// repeater.js primitives (identity resolution + body_similarity). Covers the API-Top-10 classes the
// harness only touched by hand: mass assignment, BFLA (function-level), BOPLA (property-level).
//
//   node tools/api-authz.js massassign <url> --data '<json>' --as <identity>   inject privileged fields
//   node tools/api-authz.js bfla <url> --as <lowpriv> [--method POST]           low-priv hits admin fn
//   node tools/api-authz.js bopla <url> --as <a> --as2 <b>                      property-level leak/diff
//
// Detection-only: a mutated request PROVES nothing until the server ACCEPTS the change (privileged
// field reflected/persisted, or a low-priv identity gets a 2xx on an admin function). Record
// verify_level by what the server actually did. Reuses repeater.similarity for same-length diffs
// and repeater.resolveIdentity for --as. The HTTP `send` is injectable for offline tests.
'use strict';
const repeater = require('./repeater');

// Fields an over-permissive create/update endpoint may trust from the client (mass assignment).
const PRIVILEGED_FIELDS = [
  ['role', 'admin'], ['isAdmin', true], ['is_admin', true], ['admin', true],
  ['verified', true], ['isVerified', true], ['emailVerified', true],
  ['status', 'approved'], ['approved', true], ['active', true],
  ['price', 0], ['amount', 0], ['balance', 999999], ['credit', 999999], ['discount', 100],
  ['ownerId', 1], ['owner_id', 1], ['userId', 1], ['user_id', 1], ['tenantId', 1],
  ['permissions', ['*']], ['scopes', ['*']], ['plan', 'enterprise'],
];

// Field names that should generally NOT appear in a response to a normal user (BOPLA leak signal).
const SENSITIVE_RESPONSE_FIELDS = [
  'password', 'passwordHash', 'password_hash', 'hash', 'salt', 'ssn', 'creditCard', 'credit_card',
  'cardNumber', 'cvv', 'apiKey', 'api_key', 'secret', 'token', 'privateKey', 'isAdmin', 'role',
  'internalNotes', 'internal_notes', 'mfaSecret', 'totpSecret',
];

function injectPrivilegedFields(baseObj) {
  const base = baseObj && typeof baseObj === 'object' ? baseObj : {};
  return PRIVILEGED_FIELDS.map(([field, value]) => ({ field, value, body: Object.assign({}, base, { [field]: value }) }));
}

// Did the privileged field take effect? Reflected in the response body, or flipped the status to 2xx.
function massAssignVerdict(field, value, resp) {
  if (!resp) return { accepted: false };
  const body = typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body || '');
  const reflected = body.indexOf(`"${field}"`) !== -1 && new RegExp(`"${field}"\\s*:\\s*${JSON.stringify(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(body);
  const ok2xx = resp.status && resp.status >= 200 && resp.status < 300;
  return { accepted: !!(reflected && ok2xx), reflected, status: resp.status, severity: reflected && ok2xx ? 'High' : 'Low' };
}

function sensitiveFieldsIn(obj) {
  const found = new Set();
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    for (const k of Object.keys(o)) { if (SENSITIVE_RESPONSE_FIELDS.includes(k)) found.add(k); walk(o[k]); }
  };
  walk(obj);
  return [...found];
}

// ---- orchestration (send injectable) ----------------------------------------
async function massAssign(url, opts) {
  opts = opts || {};
  const send = opts.send;
  if (!send) return { ok: false, reason: 'massAssign requires a send(url,method,headers,body) function' };
  let base;
  try { base = opts.data ? JSON.parse(opts.data) : {}; } catch { return { ok: false, reason: 'invalid --data JSON' }; }
  const method = opts.method || 'POST';
  const headers = opts.headers || {};
  const mutations = injectPrivilegedFields(base);
  const candidates = [];
  for (const m of mutations) {
    const resp = await send(url, method, headers, JSON.stringify(m.body));
    const v = massAssignVerdict(m.field, m.value, resp);
    if (v.reflected || v.accepted) candidates.push({ field: m.field, value: m.value, ...v });
  }
  return { ok: true, url, tested: mutations.length, candidates };
}

async function bfla(url, opts) {
  opts = opts || {};
  const send = opts.send;
  if (!send) return { ok: false, reason: 'bfla requires a send function' };
  const method = opts.method || 'GET';
  const resp = await send(url, method, opts.headers || {}, opts.data);
  const ok2xx = resp && resp.status >= 200 && resp.status < 300;
  return {
    ok: true, url, method, status: resp && resp.status,
    finding: ok2xx ? { id: 'bfla', severity: 'High', note: 'low-privilege identity received 2xx on an admin/function endpoint — broken function-level authorization' } : null,
  };
}

async function bopla(url, opts) {
  opts = opts || {};
  const send = opts.send;
  if (!send) return { ok: false, reason: 'bopla requires a send function' };
  const rA = await send(url, 'GET', opts.headersA || {}, null);
  const leaks = [];
  let objA = null;
  try { objA = JSON.parse(typeof rA.body === 'string' ? rA.body : JSON.stringify(rA.body)); } catch {}
  const sens = sensitiveFieldsIn(objA);
  if (sens.length) leaks.push({ id: 'bopla-read', severity: 'High', fields: sens, note: 'response exposes sensitive properties to this identity' });
  // Optional cross-identity diff (same object, two roles): same bytes/high similarity = no property gating.
  if (opts.headersB) {
    const rB = await send(url, 'GET', opts.headersB, null);
    const sim = repeater.similarity(String(rA.body || ''), String(rB.body || ''));
    if (sim > 0.98) leaks.push({ id: 'bopla-no-gating', severity: 'Medium', similarity: sim, note: 'two different identities receive near-identical objects — no property-level gating' });
  }
  return { ok: true, url, leaks };
}

module.exports = { PRIVILEGED_FIELDS, SENSITIVE_RESPONSE_FIELDS, injectPrivilegedFields, massAssignVerdict, sensitiveFieldsIn, massAssign, bfla, bopla };

// ---- CLI (real runs go through repeater's scope-checked path) ---------------
async function main() {
  const [cmd, url] = process.argv.slice(2);
  if (!cmd || !url) { console.error('usage: node tools/api-authz.js <massassign|bfla|bopla> <url> [--data json] [--as id] [--method M]'); process.exit(2); }
  console.error('[i] api-authz CLI assembles the differential; wire the scope-checked sender via repeater.js');
  console.error('    e.g. node tools/repeater.js --url "<url>" --as <id> --data \'<mutated>\' --diff --show-body');
  console.log(JSON.stringify({ note: 'use the module API with an injected send(), or drive repeater.js with the mutations from injectPrivilegedFields()', privileged_fields: PRIVILEGED_FIELDS.map((f) => f[0]) }, null, 2));
}
if (require.main === module) main();
