#!/usr/bin/env node
// Zero-dependency test for tools/coverage.js.
// Run: node tools/test-coverage.js  → prints PASS/FAIL per case, exit 1 on any failure.

'use strict';
const { CLASSES, EXTRA_CLASSES, buildMatrix, classOf, matrixTable } = require('./coverage');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

// classOf classification
ok('sql → sqli', classOf({ title: 'SQL injection in search' }) === 'sqli');
ok('xss → xss', classOf({ title: 'Reflected XSS' }) === 'xss');
ok('idor → idor', classOf({ title: 'IDOR in profile' }) === 'idor');
ok('upload → file-upload', classOf({ title: 'Unrestricted file upload' }) === 'file-upload');
ok('unknown → other', classOf({ title: 'weird thing' }) === 'other');

// buildMatrix shape
const m = buildMatrix('__no_such_host__');
ok('matrix has rows', Array.isArray(m.rows) && m.rows.length === CLASSES.length);
ok('each row has status', m.rows.every((r) => ['tested', 'confirmed', 'n-a', 'missed'].includes(r.status)));
ok('matrixTable renders table', matrixTable(m).includes('| Class |'));

// Negative-result semantics: a class without candidates on an empty map = n-a or missed, never blank
const emptyStatuses = m.rows.map((r) => r.status);
ok('no blank statuses', emptyStatuses.every((s) => s !== ''));

// Extra surfaces (P1.4 container / M.4 mobile): ADDITIVE — a row appears only where the
// surface really exists, so a plain web host matrix stays byte-identical.
ok('EXTRA_CLASSES not in the base CLASSES list', EXTRA_CLASSES.every((c) => !CLASSES.includes(c)));
ok('no extra row without surface', !m.rows.some((r) => EXTRA_CLASSES.includes(r.class)));
const withPorts = buildMatrix('__no_such_host__', { ports: [{ port: 2375, state: 'open' }, { port: 443, state: 'open' }] });
ok('container row appears when a container port is present', withPorts.rows.some((r) => r.class === 'container'));
ok('container row is "missed" until tested (never a false "covered")', withPorts.rows.find((r) => r.class === 'container').status === 'missed');
const withMobile = buildMatrix('__no_such_host__', { mobile: true });
ok('mobile row appears only when opted in', withMobile.rows.some((r) => r.class === 'mobile'));
ok('classOf: docker/kubelet → container', classOf({ title: 'kubelet anonymous access' }) === 'container');
ok('classOf: android deeplink component → mobile', classOf({ title: 'Android deeplink handler' }) === 'mobile');

console.log(`\ncoverage: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);