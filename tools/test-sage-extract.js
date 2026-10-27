#!/usr/bin/env node
// test-sage-extract.js — il gate che rende un claim citabile.
//
// Tre comportamenti provati senza rete e senza modello:
//   1. `snapQuote` ricostruisce i byte REALI del file quando il modello cambia spaziature;
//   2. una citazione inventata viene rifiutata (e non "quasi accettata");
//   3. `extractClaims` distingue tenuto / scartato e non lancia mai su output spazzatura.
//
// Nota: serve un artefatto DENTRO il workspace, perché evidence-quote.js risolve i path
// dentro la radice del repo (giusto: una citazione non può puntare fuori). La fixture vive
// in artifacts/sage/, che è gitignored, e viene rimossa a fine test.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ok, okAsync, summary } = require('./testkit');
const { snapQuote, chunkText, extractClaims } = require('./sage/extract');
const { validateQuote } = require('./evidence-quote');

const ROOT = path.join(__dirname, '..');
const TAG = `test-extract-${process.pid}`;
const REL = path.join('artifacts', 'sage', TAG, 'doc.txt');
const ABS = path.join(ROOT, REL);

const TEXT = [
  'Il bypass del filtro avviene concatenando due richieste HTTP/1.1 nella stessa connessione: '
  + 'il secondo header block viene interpretato dal backend come appartenente alla richiesta '
  + 'precedente, quindi il controllo di autorizzazione vede solo la prima.',
  'La verifica richiede un diff delle due risposte e un marker univoco per ogni tentativo, '
  + 'altrimenti una cache intermedia può restituire la risposta della richiesta precedente e '
  + 'far sembrare riuscito un attacco che il server ha invece rifiutato.',
].join('\n\n');

fs.mkdirSync(path.dirname(ABS), { recursive: true });
fs.writeFileSync(ABS, TEXT, 'utf8');

ok('snapQuote: citazione esatta = byte del file', () => {
  const q = 'il controllo di autorizzazione vede solo la prima';
  assert.strictEqual(snapQuote(TEXT, q), q);
});

ok('snapQuote: spaziature diverse ricondotte al testo reale', () => {
  const snapped = snapQuote(TEXT, 'Il bypass del filtro avviene\nconcatenando   due richieste');
  assert.strictEqual(snapped, 'Il bypass del filtro avviene concatenando due richieste');
  assert.ok(TEXT.includes(snapped), 'il risultato deve essere una sottostringa reale');
});

ok('snapQuote: parafrasi → null (nessuna tolleranza semantica)', () => {
  assert.strictEqual(snapQuote(TEXT, 'Il filtro si aggira impacchettando due richieste insieme'), null);
  assert.strictEqual(snapQuote(TEXT, ''), null);
});

ok('snapQuote: le virgolette "raddrizzate" restano differenze', () => {
  const file = 'usa "virgolette" dritte nel documento';
  const quote = 'usa \u201cVirgolette\u201d dritte nel documento';
  assert.strictEqual(snapQuote(file, quote), null);
});

ok('chunkText: spezza e scarta i frammenti troppo corti', () => {
  const big = 'paragrafo tecnico con contenuto ripetuto. '.repeat(120);
  const chunks = chunkText(big, 1000);
  assert.ok(chunks.length > 1, `attesi più blocchi, trovati ${chunks.length}`);
  for (const c of chunks) assert.ok(c.length <= 1000, `blocco troppo lungo: ${c.length}`);
  assert.deepStrictEqual(chunkText('corto'), []);
});

function fakeLlm(replies) {
  let i = 0;
  return {
    async runAgent() {
      const r = replies[Math.min(i, replies.length - 1)];
      i += 1;
      return { text: typeof r === 'function' ? r() : r, messages: [], finish_reason: 'stop', unproven: false, actions: 0 };
    },
  };
}

(async () => {
  await okAsync('extractClaims: tiene la citazione reale, scarta inventata e troppo corta', async () => {
    const payload = JSON.stringify({
      claims: [
        {
          claim: 'Il bypass concatena due richieste sulla stessa connessione',
          quote: 'Il bypass del filtro avviene concatenando due richieste HTTP/1.1 nella stessa connessione',
          confidence: 'high',
        },
        {
          claim: 'Claim senza riscontro nella fonte',
          quote: 'Questa frase non esiste in nessun documento congelato di questo test, quindi va scartata.',
          confidence: 'high',
        },
        { claim: 'Citazione troppo corta per provare qualcosa', quote: 'HTTP/1.1', confidence: 'low' },
      ],
    });
    const res = await extractClaims({
      llm: fakeLlm([payload]), sourceRel: REL, text: TEXT, question: 'come si aggira il filtro?', maxChunks: 1,
    });
    assert.strictEqual(res.emitted, 3);
    assert.strictEqual(res.kept.length, 1, JSON.stringify(res.dropped));
    assert.strictEqual(res.dropped.length, 2);
    assert.strictEqual(res.kept[0].confidence, 'high');
    // Il claim tenuto deve passare il gate vero, riletto da disco.
    assert.strictEqual(validateQuote({ status: 'confirmed', evidence_quote: { file: REL, text: res.kept[0].quote } }), null);
    assert.ok(TEXT.includes(res.kept[0].quote), 'la quote deve essere un frammento reale');
    assert.ok(res.dropped.some((d) => /non trovata/.test(d.reason)));
  });

  await okAsync('extractClaims: output non-JSON non lancia e non produce claim', async () => {
    const res = await extractClaims({
      llm: fakeLlm(['non sono un JSON, mi dispiace']), sourceRel: REL, text: TEXT, question: 'x', maxChunks: 1,
    });
    assert.strictEqual(res.kept.length, 0);
    assert.strictEqual(res.emitted, 0);
    // Un guasto del modello non è una fonte che non parla: deve essere contato, altrimenti
    // nel report un 0-claim da JSON rotto sembra "fonte non pertinente".
    assert.strictEqual(res.dropped.length, 1);
    assert.ok(/non in formato JSON/.test(res.dropped[0].reason), JSON.stringify(res.dropped));
  });

  await okAsync('extractClaims: la quote viene riscritta con i byte del file', async () => {
    const payload = JSON.stringify({
      claims: [{
        claim: 'La cache può mascherare il risultato',
        quote: 'una cache intermedia può restituire   la risposta della richiesta precedente',
        confidence: 'med',
      }],
    });
    const res = await extractClaims({
      llm: fakeLlm([payload]), sourceRel: REL, text: TEXT, question: 'quali errori di verifica?', maxChunks: 1,
    });
    assert.strictEqual(res.kept.length, 1, JSON.stringify(res.dropped));
    assert.ok(!/\s{2,}/.test(res.kept[0].quote), 'la quote deve avere la spaziatura del file');
    assert.ok(TEXT.includes(res.kept[0].quote));
  });

  await okAsync('extractClaims: dichiara la copertura reale (blocchi letti / totali)', async () => {
    const long = Array.from({ length: 6 }, (_, i) => `Paragrafo ${i}. `
      + 'contenuto tecnico ripetuto per riempire il blocco e superare la soglia minima. '.repeat(30)).join('\n\n');
    const res = await extractClaims({
      llm: fakeLlm(['{"claims":[]}']), sourceRel: REL, text: long, question: 'x', maxChunks: 2,
    });
    assert.ok(res.chunks.total > 2, `attesi più di 2 blocchi, trovati ${res.chunks.total}`);
    assert.strictEqual(res.chunks.read, 2, 'con maxChunks 2 non si può leggere di più');

    // Fonte corta: copertura completa, e il report non deve suggerire un taglio che non c'è.
    const short = await extractClaims({
      llm: fakeLlm(['{"claims":[]}']), sourceRel: REL, text: TEXT, question: 'x', maxChunks: 2,
    });
    assert.deepStrictEqual(short.chunks, { read: 1, total: 1 });
  });

  fs.rmSync(path.dirname(ABS), { recursive: true, force: true });
  summary('sage-extract');
})();
