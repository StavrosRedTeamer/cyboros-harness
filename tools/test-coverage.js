#!/usr/bin/env node
// Zero-dependency test for tools/coverage.js.
// Run: node tools/test-coverage.js  → prints PASS/FAIL per case, exit 1 on any failure.

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  CLASSES, CORE_CLASSES, HARNESS_ONLY, LEGACY_ALIASES, EXTRA_CLASSES,
  buildMatrix, classOf, matrixTable, displayName, candidatesFor, normalizeCandidates,
} = require('./coverage');
const REGISTRY = require('./test-registry.json');

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

// ── Tassonomia: il registry è la fonte unica, i display name storici restano alias ──────────
const regKeys = Object.keys(REGISTRY.classes);
ok('every registry class is a matrix row (aliases resolved)',
  regKeys.filter((k) => k !== 'other').every((k) => CLASSES.includes(displayName(k))));
ok("'other' is not a matrix row (it lives in otherFindings)", !CLASSES.includes('other'));
ok('no duplicate rows', new Set(CLASSES).size === CLASSES.length);
ok('every legacy alias points at a real registry key',
  Object.values(LEGACY_ALIASES).every((k) => regKeys.includes(k)));
ok('legacy display names are not duplicated by their registry key',
  Object.entries(LEGACY_ALIASES).every(([disp, key]) => CLASSES.includes(disp) && !CLASSES.includes(key)));
ok('harness-only classes have no registry key', HARNESS_ONLY.every((c) => !regKeys.includes(c)));
ok('CORE rows stay first and unchanged', CORE_CLASSES.every((c, i) => CLASSES[i] === c));
ok('newly added classes are present', ['cspt', 'data-api', 'h2-desync'].every((c) => CLASSES.includes(c)));

// Una map può chiavare i candidati per display name o per chiave di registry: entrambe contano.
ok('candidatesFor resolves the registry key for an aliased row',
  JSON.stringify(candidatesFor({ upload: ['f'] }, 'file-upload')) === JSON.stringify(['f']));
ok('candidatesFor prefers the display name when both exist',
  JSON.stringify(candidatesFor({ 'file-upload': ['a'], upload: ['b'] }, 'file-upload')) === JSON.stringify(['a']));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cyb-cov-'));
try {
  fs.writeFileSync(path.join(TMP, 'alias-map.example-map.json'), JSON.stringify({
    endpoints: [], candidates: { upload: ['avatar'], jwt: ['token'] },
  }));
  const aliasM = buildMatrix('alias-map.example', { reportsDir: TMP, findingsFile: path.join(TMP, 'none.jsonl') });
  const uploadRow = aliasM.rows.find((r) => r.class === 'file-upload');
  ok('map candidate under the registry key lands on the legacy row', uploadRow.candidates === 1 && uploadRow.status === 'tested');
  ok('registry key does not create a twin row', !aliasM.rows.some((r) => r.class === 'upload'));
  ok('registry-derived class row is tested from map candidates',
    aliasM.rows.find((r) => r.class === 'jwt').status === 'tested');
  ok('registry-derived class without candidates is n-a, never missed',
    aliasM.rows.find((r) => r.class === 'cors').status === 'n-a');

  fs.writeFileSync(path.join(TMP, 'f.jsonl'), [
    JSON.stringify({ host: 'legacy.example', class: 'upload', title: 'unrestricted upload' }),
    JSON.stringify({ host: 'legacy.example', class: 'jwt', title: 'JWT alg:none accepted' }),
  ].join('\n') + '\n');
  const fm = buildMatrix('legacy.example', { reportsDir: TMP, findingsFile: path.join(TMP, 'f.jsonl') });
  ok('a finding recorded with the registry key shows once, on the legacy row',
    fm.rows.find((r) => r.class === 'file-upload').findings === 1
    && fm.rows.find((r) => r.class === 'file-upload').status === 'confirmed');
  ok('an explicit new class wins over the text heuristic (jwt, not crypto)',
    fm.rows.find((r) => r.class === 'jwt').findings === 1
    && fm.rows.find((r) => r.class === 'crypto').findings === 0);

  // Le tre forme reali di map.json producono lo stesso segnale (prima la forma scritta da
  // map.js veniva letta come "zero candidati": matrice n-a su una mappa piena).
  const legacyShape = normalizeCandidates({ upload: 2, jwt: [{ path: '/x' }, { path: '/y' }] });
  const plannerShape = normalizeCandidates({ candidates: { upload: ['a', 'b'], jwt: ['t', 'u'] } });
  const mapJsShape = normalizeCandidates({ host: 'h', endpoints: [
    { path: '/a', candidates: { upload: ['avatar'], jwt: ['token'] } },
    { path: '/b', candidates: { upload: ['file'] } },
  ] });
  ok('normalizeCandidates: top-level class keys', legacyShape.upload === 2 && legacyShape.jwt === 2);
  ok('normalizeCandidates: planner .candidates object', plannerShape.upload === 2 && plannerShape.jwt === 2);
  ok('normalizeCandidates: map.js endpoints are summed, host is not a class',
    mapJsShape.upload === 2 && mapJsShape.jwt === 1 && mapJsShape.host === undefined);
  ok('normalizeCandidates: handoff skip_reason preserved',
    normalizeCandidates({ 'cache-poison': { candidates: 3, skip_reason: 'WAF' } })['cache-poison'].skip_reason === 'WAF');

  fs.writeFileSync(path.join(TMP, 'endpoints.example-map.json'), JSON.stringify({
    host: 'endpoints.example',
    endpoints: [{ method: 'GET', path: '/api', candidates: { upload: ['avatar'] } }],
  }));
  const epM = buildMatrix('endpoints.example', { reportsDir: TMP, findingsFile: path.join(TMP, 'none.jsonl') });
  ok('matrix reads candidates from the map.js endpoints shape',
    epM.rows.find((r) => r.class === 'file-upload').candidates === 1
    && epM.rows.find((r) => r.class === 'file-upload').status === 'tested');
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\ncoverage: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);