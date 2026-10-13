#!/usr/bin/env node
// Offline self-check for the web-cache-attack tool (cachepoison.js). No network: a fake `send`
// returns canned responses and we assert cache-signal analysis, the poisoning/deception logic and
// detection-only discipline. Run: node tools/test-cachepoison.js
'use strict';
const assert = require('assert');
const cache = require('./cachepoison');
let pass = 0, fail = 0;
function ok(name, fn) { try { fn(); pass++; console.log(`  PASS ${name}`); } catch (e) { fail++; console.log(`  FAIL ${name}: ${e.message}`); } }
async function okA(name, fn) { try { await fn(); pass++; console.log(`  PASS ${name}`); } catch (e) { fail++; console.log(`  FAIL ${name}: ${e.message}`); } }

// ---- cache signal analysis --------------------------------------------------
ok('isCacheable true on X-Cache HIT', () => assert.strictEqual(cache.isCacheable({ 'x-cache': 'HIT' }), true));
ok('isCacheable true on Age header', () => assert.strictEqual(cache.isCacheable({ age: '100' }), true));
ok('isCacheable true on public max-age', () => assert.strictEqual(cache.isCacheable({ 'cache-control': 'public, max-age=60' }), true));
ok('isCacheable false on no-store', () => assert.strictEqual(cache.isCacheable({ 'cache-control': 'no-store' }), false));
ok('isCacheable false on private', () => assert.strictEqual(cache.isCacheable({ 'cache-control': 'private' }), false));
ok('cacheIndicators picks cf-cache-status', () => assert.strictEqual(cache.cacheIndicators({ 'CF-Cache-Status': 'HIT' }).cf_cache_status, 'HIT'));
ok('reflects finds marker', () => assert.strictEqual(cache.reflects('<a href=http://x.example>', 'x.example'), true));
ok('deceptionPaths appends static suffixes', () => { const p = cache.deceptionPaths('https://t.example/account'); assert.ok(p.some((u) => u.endsWith('/cyboros.css'))); assert.ok(p.some((u) => u.includes(';.css'))); });
ok('UNKEYED_HEADERS includes X-Forwarded-Host', () => assert.ok(cache.UNKEYED_HEADERS.includes('X-Forwarded-Host')));

// ---- poisoning probe with injected send -------------------------------------
(async () => {
  await okA('probe flags High when marker reflects AND cacheable', async () => {
    const send = async (url, method, headers) => {
      const xfh = headers['X-Forwarded-Host'];
      if (xfh) return { status: 200, headers: { 'x-cache': 'HIT', 'cache-control': 'public, max-age=60' }, body: `<script src=//${xfh}/a.js>` };
      return { status: 200, headers: {}, body: 'baseline' };
    };
    const res = await cache.runProbe('https://t.example/', { send });
    assert.strictEqual(res.ok, true);
    const hit = res.candidates.find((c) => c.header === 'X-Forwarded-Host');
    assert.ok(hit, 'X-Forwarded-Host candidate present');
    assert.strictEqual(hit.cacheable, true);
    assert.strictEqual(hit.severity, 'High');
  });

  await okA('probe marks reflected-but-not-cacheable as Low', async () => {
    const send = async (url, method, headers) => headers['X-Forwarded-Host']
      ? { status: 200, headers: { 'cache-control': 'no-store' }, body: `x ${headers['X-Forwarded-Host']} y` }
      : { status: 200, headers: {}, body: 'baseline' };
    const res = await cache.runProbe('https://t.example/', { send, headers: ['X-Forwarded-Host'] });
    assert.strictEqual(res.candidates[0].severity, 'Low');
  });

  await okA('probe returns blocked reason when baseline out of scope', async () => {
    const res = await cache.runProbe('https://t.example/', { send: async () => ({ blocked: 'out of scope' }) });
    assert.strictEqual(res.ok, false);
    assert.match(res.reason, /out of scope/);
  });

  await okA('deception flags cacheable dynamic static-suffix path', async () => {
    const send = async (url) => url.includes('cyboros.css')
      ? { status: 200, headers: { 'cache-control': 'public, max-age=300' }, body: 'user=marco balance=1000' }
      : { status: 404, headers: {}, body: '' };
    const res = await cache.runDeception('https://t.example/account', { send });
    assert.ok(res.candidates.length >= 1);
    assert.strictEqual(res.candidates[0].severity, 'Medium');
  });

  console.log(`\ncachepoison: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
