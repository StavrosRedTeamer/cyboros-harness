// permission-matrix: la campagna BOLA/BFLA deve dire solo ciò che le prove reggono. Test tutto
// offline: `exec` è iniettato, quindi nessuna richiesta esce dalla macchina.
// Run: node tools/test-permission-matrix.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ok, okAsync, summary, fixture } = require('./testkit');
const pm = require('./permission-matrix');

const EP = (method, url) => ({ method, url });

// exec finto: A vede tutto, B vede solo ciò che è `shared`.
function execFor(shared) {
  return async ({ url, headers }) => {
    if (headers === 'X-User: a') return { status: 200, body: 'PERSONAL-DATA-A' };
    if (shared.includes(url)) return { status: 200, body: 'PERSONAL-DATA-A' };
    return { status: 403, body: 'denied' };
  };
}

(async () => {
  await okAsync('matrice base: stessa risorsa a due identità → candidato BOLA', async () => {
    const m = await pm.buildMatrix({
      endpoints: [EP('GET', 'https://t.test/api/user/1'), EP('GET', 'https://t.test/api/admin/list')],
      identities: ['X-User: a', 'X-User: b'],
      baseline: 'X-User: a',
      exec: async ({ url, headers }) => (headers === 'X-User: a'
        ? { status: 200, body: 'PERSONAL-DATA-A' }
        : { status: url.includes('admin') ? 200 : 403, body: url.includes('admin') ? 'PERSONAL-DATA-A' : 'no' }),
    });
    assert.strictEqual(m.rows.length, 2);
    assert.strictEqual(m.rows[0].cells['X-User: a'].similarity, 1);
    assert.ok(m.candidates.some((c) => c.type === 'bola' && c.url.includes('admin')), JSON.stringify(m.candidates));
    assert.ok(!m.candidates.some((c) => c.url.includes('user/1')), 'un 403 sull\'altra identità non è un candidato');
    assert.strictEqual(m.candidates.every((c) => c.verify_level === 'suspected'), true, 'solo suspected: la registrazione è di record-finding');
  });

  await okAsync('endpoint che rispondono uguale a tutti (404/403) → nessun candidato', async () => {
    const m = await pm.buildMatrix({
      endpoints: [EP('GET', 'https://t.test/api/a'), EP('GET', 'https://t.test/api/b')],
      identities: ['X-User: a', 'X-User: b'],
      exec: async () => ({ status: 404, body: 'not found' }),
    });
    assert.deepStrictEqual(m.candidates, [], 'tutte le risposte uguali non sono un finding');
  });

  await okAsync('cella bloccata dallo scope-guard: registrata come BLOCKED, mai candidato', async () => {
    const m = await pm.buildMatrix({
      endpoints: [EP('GET', 'https://out.test/x')],
      identities: ['X-User: a', 'X-User: b'],
      exec: async ({ headers }) => (headers === 'X-User: a'
        ? { status: 200, body: 'ok' }
        : { blocked: true, status: 0, body: '', reason: 'out of scope' }),
    });
    assert.strictEqual(m.rows[0].cells['X-User: b'].blocked, true);
    assert.strictEqual(m.rows[0].cells['X-User: b'].flag, undefined);
    assert.deepStrictEqual(m.candidates, []);
  });

  await okAsync('identità che fallisce (login) → errore, NESSUNA richiesta anonima', async () => {
    let calls = 0;
    const m = await pm.buildMatrix({
      endpoints: [EP('GET', 'https://t.test/api/x')],
      identities: ['X-User: a', 'login'],
      baseline: 'X-User: a',
      exec: async ({ headers }) => {
        calls++;
        if (headers === 'login') throw new Error("identity 'login' resolved to no headers — refusing to send an anonymous request");
        return { status: 200, body: 'ok' };
      },
    });
    assert.strictEqual(calls, 2, 'una chiamata per cella: il fallimento non si trasforma in un retry anonimo');
    assert.strictEqual(m.errors.length, 1);
    assert.match(m.errors[0].error, /anonymous request/);
    assert.strictEqual(m.rows[0].cells.login.status, 0);
    assert.deepStrictEqual(m.candidates, []);
  });

  await okAsync('un candidato per cella: BFLA su path sensibile + BOLA sullo stesso endpoint', async () => {
    const m = await pm.buildMatrix({
      endpoints: [EP('GET', 'https://t.test/internal/panel')],
      identities: ['A', 'B'],
      baseline: 'A',
      exec: execFor(['https://t.test/internal/panel']),
    });
    const types = m.candidates.map((c) => c.type).sort();
    assert.deepStrictEqual(types, ['bfla', 'bola'], JSON.stringify(m.candidates));
  });

  await okAsync('ogni cella si chiede UNA volta (cache) e il rate limiter è rispettato', async () => {
    const seen = [];
    let paced = 0;
    const m = await pm.buildMatrix({
      endpoints: [EP('GET', 'https://t.test/x'), EP('GET', 'https://t.test/y')],
      identities: ['A', 'B'],
      baseline: 'A',
      rps: 3,
      pace: { waitAsync: async (rps) => { paced++; assert.strictEqual(rps, 3); } },
      exec: async ({ url, headers }) => { seen.push(`${url}|${headers}`); return { status: 200, body: 'same' }; },
    });
    assert.strictEqual(seen.length, 4, 'due endpoint × due identità, nessun duplicato');
    assert.strictEqual(paced, 4, 'pacing su OGNI richiesta');
    assert.strictEqual(m.rows.length, 2);
  });

  await okAsync('argomenti incoerenti → errore esplicito, non una matrice vuota', async () => {
    await assert.rejects(() => pm.buildMatrix({ endpoints: [], identities: ['A'], exec: async () => ({}) }), /no endpoints/);
    await assert.rejects(() => pm.buildMatrix({ endpoints: [EP('GET', 'u')], identities: [], exec: async () => ({}) }), /no identities/);
    await assert.rejects(() => pm.buildMatrix({ endpoints: [EP('GET', 'u')], identities: ['A'], baseline: 'Z', exec: async () => ({}) }), /baseline/);
  });

  ok('loadEndpoints: file urls (`METHOD url` o url nudo), commenti, dedup', () => {
    const dir = fixture('permission-matrix');
    const f = path.join(dir, 'urls.txt');
    fs.writeFileSync(f, '# commento\nhttps://t.test/a\nPOST https://t.test/b\nhttps://t.test/a\n\n');
    const eps = pm.loadEndpoints({ urlsFile: f });
    assert.deepStrictEqual(eps, [
      { method: 'GET', url: 'https://t.test/a' },
      { method: 'POST', url: 'https://t.test/b' },
    ]);
  });

  ok('loadEndpoints: dal target model (map.json)', () => {
    const dir = fixture('permission-matrix-map');
    const f = path.join(dir, 't-map.json');
    fs.writeFileSync(f, JSON.stringify({ endpoints: [{ method: 'get', url: 'https://t.test/z' }, { url: 'https://t.test/w' }, { method: 'GET' }] }));
    const eps = pm.loadEndpoints({ mapFile: f });
    assert.deepStrictEqual(eps, [
      { method: 'GET', url: 'https://t.test/z' },
      { method: 'GET', url: 'https://t.test/w' },
    ], 'un endpoint senza url non esiste');
  });

  ok('renderMarkdown: matrice + candidati + legenda, senza inventare finding', () => {
    const md = pm.renderMarkdown({
      identities: ['A', 'B'], baseline: 'A', generated_at: '2026-09-28T00:00:00Z',
      errors: [{ cell: 'GET u|B', error: 'boom' }],
      rows: [{ method: 'GET', url: 'https://t.test/a', cells: { A: { status: 200, bytes: 10, similarity: 1 }, B: { status: 200, bytes: 10, similarity: 1, flag: 'same-content' } } }],
      candidates: [{ type: 'bola', method: 'GET', url: 'https://t.test/a', identity: 'B', baseline: 'A', similarity: 1 }],
    });
    assert.match(md, /\| GET https:\/\/t\.test\/a \| 200 \(10B\) \| 200 \(10B\) ! \|/);
    assert.match(md, /BOLA/);
    assert.match(md, /suspected, da verificare e registrare con record-finding\.js/);
    assert.match(md, /## Errori per cella/);
    assert.ok(!/Critical|High/.test(md), 'la matrice non assegna severità');
  });

  ok('parseArgs: --confirm obbligatorio per un metodo state-changing (fail-closed nel CLI)', () => {
    const argv = ['--method-nope'];
    assert.deepStrictEqual(pm.parseArgs(argv)._, argv);
    const SAFE = pm.SAFE_METHODS, ALL = pm.ALL_METHODS;
    assert.deepStrictEqual(SAFE, ['GET', 'HEAD', 'OPTIONS']);
    assert.ok(ALL.includes('DELETE') && ALL.includes('PATCH'));
  });

  summary('permission-matrix');
})();
