#!/usr/bin/env node
// Offline self-check for the graphql.js depth extensions (A4). No network. Run: node tools/test-graphql.js
'use strict';
const assert = require('assert');
const gql = require('./graphql');
let pass = 0, fail = 0;
function ok(name, fn) { try { fn(); pass++; console.log(`  PASS ${name}`); } catch (e) { fail++; console.log(`  FAIL ${name}: ${e.message}`); } }

// ---- alias batching ---------------------------------------------------------
ok('buildAliasBatch packs N calls with distinct aliases', () => {
  const q = gql.buildAliasBatch('login', ['user', 'pass'], [['a', '1'], ['a', '2'], ['a', '3']], 'token');
  assert.ok(/k0: login\(user: "a", pass: "1"\)/.test(q));
  assert.ok(/k2: login\(user: "a", pass: "3"\)/.test(q));
  assert.strictEqual((q.match(/login\(/g) || []).length, 3, 'three batched calls in one operation');
});

// ---- field-suggestion harvest ----------------------------------------------
ok('parseFieldSuggestions harvests names from a single Did-you-mean', () => {
  const body = JSON.stringify({ errors: [{ message: 'Cannot query field "usr" on type "Query". Did you mean "user"?' }] });
  assert.deepStrictEqual(gql.parseFieldSuggestions(body), ['user']);
});
ok('parseFieldSuggestions harvests multiple suggestions', () => {
  const body = { errors: [{ message: 'Did you mean "user", "users", or "userRole"?' }] };
  const s = gql.parseFieldSuggestions(body);
  assert.ok(s.includes('user') && s.includes('users') && s.includes('userRole'));
});
ok('parseFieldSuggestions empty on clean response', () => {
  assert.deepStrictEqual(gql.parseFieldSuggestions('{"data":{}}'), []);
});

// ---- depth / DoS ------------------------------------------------------------
ok('queryDepth counts max nesting', () => {
  assert.strictEqual(gql.queryDepth('{ a { b { c } } }'), 3);
  assert.strictEqual(gql.queryDepth('{ a }'), 1);
});
ok('deepQuery builds bounded nested query', () => {
  const q = gql.deepQuery('me', 'friends', 5);
  assert.ok(gql.queryDepth(q) >= 5);
  assert.ok(/friends \{/.test(q));
});
ok('deepQuery clamps runaway depth', () => {
  // clamp caps the relation nesting at 20 (+2 for the outer/field braces) → never unbounded
  assert.ok(gql.queryDepth(gql.deepQuery('me', 'friends', 9999)) <= 23);
});

console.log(`\ngraphql: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
