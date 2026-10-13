// OpenAPI/Swagger → endpoint: parse fail-soft e ingest idempotente nel target model.
// Il valore di questo ingest è dare alla campagna di autorizzazione (BOLA/BFLA) l'elenco REALE
// degli endpoint invece di indovinarli: se il parser inventa, la campagna misura bugie.
// Run: node tools/test-openapi.js
'use strict';
const assert = require('assert');
const path = require('path');
const { ok, summary, fixture } = require('./testkit');
const { parseOpenApi } = require('./parsers');
const tm = require('./target-model');

const SPEC3 = JSON.stringify({
  openapi: '3.0.3',
  paths: {
    '/users/{id}': { get: { operationId: 'getUser', parameters: [{ name: 'id', in: 'path' }, { name: 'verbose', in: 'query' }] } },
    '/users': { post: { operationId: 'createUser' } },
  },
});

ok('OpenAPI 3.x: un endpoint per metodo, path relativo', () => {
  const eps = parseOpenApi(SPEC3);
  assert.deepStrictEqual(eps.map((e) => `${e.method} ${e.path}`).sort(), ['GET /users/{id}', 'POST /users']);
  assert.strictEqual(eps.find((e) => e.method === 'GET').operationId, 'getUser');
});

ok('i parametri arrivano dai `parameters[]`', () => {
  const g = parseOpenApi(SPEC3).find((e) => e.method === 'GET');
  assert.deepStrictEqual(g.params, ['id', 'verbose']);
  assert.deepStrictEqual(parseOpenApi(SPEC3).find((e) => e.method === 'POST').params, []);
});

ok('Swagger 2.0: il basePath è prefissato al path', () => {
  const sw2 = JSON.stringify({ swagger: '2.0', host: 't.test', basePath: '/api', schemes: ['https'], paths: { '/ping': { get: {} } } });
  assert.strictEqual(parseOpenApi(sw2)[0].path, '/api/ping');
  assert.strictEqual(parseOpenApi(JSON.stringify({ basePath: '/api/', paths: { '/x': { get: {} } } }))[0].path, '/api/x', 'slash finale non raddoppiato');
});

ok('input degradato → [] (fail-soft, mai throw)', () => {
  for (const bad of ['not json', '', null, undefined, 42, '[]', JSON.stringify({ openapi: '3.0.0' }), JSON.stringify({ paths: [] }), JSON.stringify({ paths: { '/x': 'nope' } })]) {
    assert.deepStrictEqual(parseOpenApi(bad), [], `input ${JSON.stringify(bad)} deve dare []`);
  }
});

ok('parametri `$ref` non risolti: params resta vuoto (non si inventa)', () => {
  const doc = JSON.stringify({ openapi: '3.0.0', paths: { '/x': { get: { parameters: [{ $ref: '#/components/parameters/Id' }] } } } });
  assert.deepStrictEqual(parseOpenApi(doc)[0].params, []);
});

ok('requestBody JSON: proprietà top-level in params (senza duplicati)', () => {
  const doc = JSON.stringify({
    openapi: '3.0.0',
    paths: {
      '/x': {
        post: {
          parameters: [{ name: 'id', in: 'query' }],
          requestBody: { content: { 'application/json': { schema: { properties: { id: {}, name: {}, role: {} } } } } },
        },
      },
    },
  });
  assert.deepStrictEqual(parseOpenApi(doc)[0].params, ['id', 'name', 'role']);
});

ok('ingest: --target obbligatorio (un path relativo non inventa un host)', () => {
  const db = tm.open(path.join(fixture('openapi-notarget'), 'state.db'));
  const r = tm.ingest(db, 'openapi', SPEC3, {});
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.counts.endpoints, 0);
  assert.match(r.counts.note, /--target/);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM endpoints').get().n, 0, 'nessun endpoint inventato');
});

ok('ingest: endpoint nel target model, idempotente (due ingest = stesse righe)', () => {
  const db = tm.open(path.join(fixture('openapi'), 'state.db'));
  const a = tm.ingest(db, 'openapi', SPEC3, { target: 't.test' });
  const b = tm.ingest(db, 'openapi', SPEC3, { target: 't.test' });
  assert.strictEqual(a.counts.endpoints, 2, JSON.stringify(a));
  assert.strictEqual(b.counts.endpoints, 2);
  const rows = db.prepare('SELECT method, url, params FROM endpoints ORDER BY url').all();
  assert.strictEqual(rows.length, 2, 'il secondo ingest non duplica (upsert su target_id/method/url)');
  const get = rows.find((r) => r.method === 'GET');
  assert.strictEqual(get.url, 'https://t.test/users/{id}');
  assert.deepStrictEqual(JSON.parse(get.params), ['id', 'verbose']);
});

ok('`openapi` è un tool noto per il dispatcher', () => {
  assert.ok(tm.KNOWN_TOOLS.includes('openapi'), tm.KNOWN_TOOLS.join('/'));
  assert.strictEqual(tm.ingest(null, 'openapi-nope', '{}', {}).ok, false);
});

summary('openapi');
