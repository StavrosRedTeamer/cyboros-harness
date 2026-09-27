#!/usr/bin/env node
// Offline self-check for api-authz.js. No network: injected send(). Run: node tools/test-api-authz.js
'use strict';
const assert = require('assert');
const api = require('./api-authz');
let pass = 0, fail = 0;
function ok(name, fn) { try { fn(); pass++; console.log(`  PASS ${name}`); } catch (e) { fail++; console.log(`  FAIL ${name}: ${e.message}`); } }
async function okA(name, fn) { try { await fn(); pass++; console.log(`  PASS ${name}`); } catch (e) { fail++; console.log(`  FAIL ${name}: ${e.message}`); } }

// ---- mutation generation ----------------------------------------------------
ok('injectPrivilegedFields adds role/isAdmin over the base', () => {
  const muts = api.injectPrivilegedFields({ name: 'x' });
  const role = muts.find((m) => m.field === 'role');
  assert.ok(role); assert.strictEqual(role.body.name, 'x'); assert.strictEqual(role.body.role, 'admin');
  assert.ok(muts.find((m) => m.field === 'isAdmin'));
});
ok('massAssignVerdict High when reflected + 2xx', () => {
  const v = api.massAssignVerdict('isAdmin', true, { status: 200, body: '{"id":5,"isAdmin":true}' });
  assert.strictEqual(v.accepted, true); assert.strictEqual(v.severity, 'High');
});
ok('massAssignVerdict Low when not reflected', () => {
  const v = api.massAssignVerdict('isAdmin', true, { status: 200, body: '{"id":5,"isAdmin":false}' });
  assert.strictEqual(v.accepted, false);
});
ok('sensitiveFieldsIn finds nested password/token', () => {
  const s = api.sensitiveFieldsIn({ user: { name: 'x', passwordHash: 'abc' }, token: 't' });
  assert.ok(s.includes('passwordHash')); assert.ok(s.includes('token'));
});

// ---- orchestration ----------------------------------------------------------
(async () => {
  await okA('massAssign flags accepted privileged field', async () => {
    const send = async (url, method, headers, body) => {
      const b = JSON.parse(body);
      // server echoes back whatever it stored, but only "role" is (wrongly) trusted
      const stored = { id: 7, name: b.name };
      if ('role' in b) stored.role = b.role;
      return { status: 200, body: JSON.stringify(stored) };
    };
    const res = await api.massAssign('https://api.example/users', { data: '{"name":"x"}', send });
    assert.strictEqual(res.ok, true);
    const role = res.candidates.find((c) => c.field === 'role');
    assert.ok(role && role.accepted, 'role mass-assignment detected');
    assert.ok(!res.candidates.find((c) => c.field === 'isAdmin' && c.accepted), 'isAdmin correctly not accepted');
  });

  await okA('bfla flags 2xx for low-priv on admin fn', async () => {
    const res = await api.bfla('https://api.example/admin/users', { send: async () => ({ status: 200, body: '[]' }) });
    assert.ok(res.finding && res.finding.id === 'bfla');
  });
  await okA('bfla no finding on 403', async () => {
    const res = await api.bfla('https://api.example/admin/users', { send: async () => ({ status: 403, body: '' }) });
    assert.strictEqual(res.finding, null);
  });

  await okA('bopla flags sensitive-field leak', async () => {
    const res = await api.bopla('https://api.example/me', { send: async () => ({ status: 200, body: '{"id":1,"password":"x","email":"a@b"}' }) });
    assert.ok(res.leaks.find((l) => l.id === 'bopla-read' && l.fields.includes('password')));
  });
  await okA('bopla flags no-gating when two identities get identical objects', async () => {
    const body = '{"id":1,"email":"a@b","name":"same"}';
    const res = await api.bopla('https://api.example/orders/1', { headersA: { a: 1 }, headersB: { b: 1 }, send: async () => ({ status: 200, body }) });
    assert.ok(res.leaks.find((l) => l.id === 'bopla-no-gating'));
  });

  console.log(`\napi-authz: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
