#!/usr/bin/env node
// tools/embeddings.js — backend di embedding SEMANTICO opzionale per il RAG locale.
//
// Il RAG (memory-rag.js) usa di base un embedding lessicale (feature-hashing, zero-dep, offline).
// Questo modulo aggiunge, SU RICHIESTA, embedding densi semantici da un modello locale servito
// via API OpenAI (`/v1/embeddings`) — es. bge-m3 / multilingual-e5 su un secondo llama-server.
// Serve a matchare per SIGNIFICATO (parafrasi, sinonimi, IT/EN/ZH), non solo per parole comuni.
//
// È completamente OPZIONALE e a prova di fallimento: se non configurato o irraggiungibile,
// ritorna null e il RAG resta lessicale (nessuna regressione). Zero dipendenze npm (fetch nativo).
//
// Config (env):
//   STAVROS_EMBED_URL     endpoint, es. http://127.0.0.1:8081/v1/embeddings  (abilita il dense)
//   STAVROS_EMBED_MODEL   nome modello (default: "bge-m3")
//   STAVROS_EMBED_KEY     api key (llama.cpp la ignora; default "sk-local")
//   STAVROS_EMBED_ALLOW_REMOTE=1   consenti un URL non-locale (default: solo 127.0.0.1/localhost)
//   STAVROS_EMBED_TIMEOUT_MS       (default 60000)
'use strict';

function cfg() {
  return {
    url: process.env.STAVROS_EMBED_URL || '',
    model: process.env.STAVROS_EMBED_MODEL || 'bge-m3',
    key: process.env.STAVROS_EMBED_KEY || 'sk-local',
    allowRemote: process.env.STAVROS_EMBED_ALLOW_REMOTE === '1',
    timeout: parseInt(process.env.STAVROS_EMBED_TIMEOUT_MS || '60000', 10),
  };
}

function isEnabled() { return !!cfg().url; }

// Difesa OPSEC: la memoria non deve uscire verso un endpoint remoto per sbaglio. Di default
// accetta solo host locali; per un endpoint remoto serve STAVROS_EMBED_ALLOW_REMOTE=1.
function assertLocalOrAllowed(url, allowRemote) {
  let host;
  try { host = new URL(url).hostname; } catch { throw new Error(`STAVROS_EMBED_URL non valido: ${url}`); }
  const local = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (!local && !allowRemote) {
    throw new Error(`STAVROS_EMBED_URL è remoto (${host}). La memoria RAG resterebbe esposta a un servizio esterno. Imposta STAVROS_EMBED_ALLOW_REMOTE=1 solo se è ciò che vuoi.`);
  }
}

function l2normalize(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => +(x / n).toFixed(6));
}

// Embedda un array di testi. Ritorna number[][] (L2-normalizzati) oppure null se disabilitato/errore.
async function embedTexts(texts) {
  const c = cfg();
  if (!c.url) return null;
  if (!Array.isArray(texts) || !texts.length) return [];
  assertLocalOrAllowed(c.url, c.allowRemote);

  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), c.timeout);
  try {
    const r = await fetch(c.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.key}` },
      body: JSON.stringify({ model: c.model, input: texts }),
      signal: ctrl.signal,
    });
    clearTimeout(to);
    if (!r.ok) { process.stderr.write(`[embeddings] HTTP ${r.status} da ${c.url} — fallback lessicale\n`); return null; }
    const j = await r.json();
    const data = (j && j.data) || [];
    if (data.length !== texts.length) { process.stderr.write('[embeddings] risposta incompleta — fallback lessicale\n'); return null; }
    // preserva l'ordine per index
    return data.slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => l2normalize(d.embedding || []));
  } catch (e) {
    clearTimeout(to);
    process.stderr.write(`[embeddings] endpoint non raggiungibile (${c.url}): ${e.message} — fallback lessicale\n`);
    return null;
  }
}

async function embedOne(text) {
  const v = await embedTexts([String(text || '')]);
  return v && v[0] ? v[0] : null;
}

// coseno tra due vettori DENSI L2-normalizzati (== dot product)
function denseCosine(a, b) {
  if (!a || !b || a.length !== b.length || !a.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

module.exports = { isEnabled, embedTexts, embedOne, denseCosine, l2normalize, cfg };

// CLI di diagnostica: node tools/embeddings.js "testo di prova"
if (require.main === module) {
  (async () => {
    const c = cfg();
    if (!c.url) { console.log('dense DISABILITATO (STAVROS_EMBED_URL non impostato). RAG resta lessicale.'); return; }
    console.log(`endpoint: ${c.url}  model: ${c.model}`);
    const v = await embedOne(process.argv[2] || 'spring boot waf union select bypass');
    if (!v) { console.log('embedding fallito (vedi stderr). RAG userà il fallback lessicale.'); process.exit(1); }
    console.log(`OK: dim=${v.length}  |v|≈${Math.sqrt(v.reduce((s, x) => s + x * x, 0)).toFixed(4)}  head=${v.slice(0, 5).map((x) => x.toFixed(3)).join(', ')}`);
  })();
}
