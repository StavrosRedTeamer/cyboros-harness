#!/usr/bin/env node
'use strict';
// tools/sage/sources.js — da dove arrivano i fatti.
//
// Due strade: il corpus locale dell'harness (autorevole per noi, zero egress) e il web.
// Ogni fonte viene CONGELATA in artifacts/sage/<run>/sources/<sha256>.txt: una citazione
// non punta a un URL che domani cambia, punta ai byte che il modello ha letto davvero.
// È la stessa disciplina di evidence-quote.js — solo che qui l'artefatto lo costruiamo noi.
//
// Il fetch è aperto (decisione dell'operatore) ma non ingenuo: IP privati/link-local
// rifiutati a ogni hop di redirect (un 302 verso 169.254.169.254 è il classico modo per
// trasformare una ricerca in un SSRF), corpo limitato, un dominio per volta a 1 req/s.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { checkTarget } = require('../ssrf-guard');
const state = require('./state');

const UA = 'cyboros-sage/0.1 (local authorized research; github.com/stavrosredteamer/cyboros-harness)';
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_SOURCE_CHARS = 60000;
const TIMEOUT_MS = 20000;

const lastHit = new Map();

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

async function sleep(ms) { if (ms > 0) await new Promise((r) => setTimeout(r, ms)); }

async function pace(url) {
  const host = new URL(url).hostname;
  const prev = lastHit.get(host) || 0;
  await sleep(1000 - (Date.now() - prev));
  lastHit.set(host, Date.now());
}

// ── HTML → testo ────────────────────────────────────────────────────────────────
// Non serve un parser: serve che il testo contenga le frasi che il modello citerà. Quindi
// via script/style/nav (rumore e trappole), poi i tag di blocco diventano righe.
function htmlToText(html) {
  let s = String(html == null ? '' : html);
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<(nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<\/(p|div|li|tr|h[1-6]|section|article|pre|blockquote)>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'" };
  s = s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => entities[e.toLowerCase()] ?? ' ');
  return s
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n').map((l) => l.trim()).join('\n')
    .trim();
}

// ── fetch con guardia a ogni hop ───────────────────────────────────────────────
async function fetchRaw(url) {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    const guard = checkTarget(current);
    if (!guard.ok) {
      throw new Error(`fetch rifiutato${hop ? ` (redirect hop ${hop})` : ''}: ${guard.why}`);
    }
    const u = new URL(current);
    if (!/^https?:$/.test(u.protocol)) throw new Error(`schema non ammesso: ${u.protocol}`);
    await pace(current);
    const res = await fetch(current, {
      redirect: 'manual',
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml,application/json,application/atom+xml;q=0.9,*/*;q=0.5',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      current = new URL(loc, current).toString();
      continue;
    }
    const declared = Number(res.headers.get('content-length') || 0);
    if (Number.isFinite(declared) && declared > 8 * 1024 * 1024) {
      throw new Error(`risposta troppo grande (${declared} byte dichiarati)`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      url: current,
      status: res.status,
      contentType: String(res.headers.get('content-type') || ''),
      body: buf.subarray(0, MAX_BODY_BYTES).toString('utf8'),
    };
  }
  throw new Error('troppi redirect (>4)');
}

/**
 * Congela una fonte su disco e restituisce il path workspace-relative (quello che
 * evidence-quote.js accetta come `evidence_quote.file`).
 */
function freeze(runId, key, text, meta = {}) {
  const d = state.ensure(runId);
  const hash = sha256(key).slice(0, 16);
  const body = String(text == null ? '' : text).slice(0, MAX_SOURCE_CHARS);
  const file = path.join(d.sources, `${hash}.txt`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, body, 'utf8');
  const metaFile = path.join(d.sources, `${hash}.json`);
  if (!fs.existsSync(metaFile)) {
    state.atomicWriteJson(metaFile, {
      ...meta, key, sha256: sha256(body), bytes: Buffer.byteLength(body), frozenAt: new Date().toISOString(),
    });
  }
  return { rel: path.relative(state.ROOT, file), hash, bytes: Buffer.byteLength(body) };
}

/** Scarica una URL e la congela. Restituisce null se il contenuto non è testo utile. */
async function fetchSource(runId, url, meta = {}) {
  const r = await fetchRaw(url);
  if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
  const isJson = /json/i.test(r.contentType);
  let text;
  if (isJson) {
    try { text = JSON.stringify(JSON.parse(r.body), null, 2); } catch { text = r.body; }
  } else {
    text = htmlToText(r.body);
  }
  if (text.trim().length < 200) return null;   // pagina vuota/consenso cookie: non è una fonte
  const frozen = freeze(runId, r.url, text, { url: r.url, origin: 'web', contentType: r.contentType, ...meta });
  return { ...frozen, url: r.url, title: meta.title || r.url, provider: meta.provider || 'web' };
}

// ── motori di ricerca (keyless) ────────────────────────────────────────────────
function decodeDdg(href) {
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    const target = u.searchParams.get('uddg');
    return target || href;
  } catch { return href; }
}

async function searchWeb(query, limit = 6) {
  const r = await fetchRaw(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
  const out = [];
  const re = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(r.body)) && out.length < limit) {
    const url = decodeDdg(m[1]);
    if (!/^https?:\/\//i.test(url)) continue;
    const title = htmlToText(m[2]).replace(/\s+/g, ' ').trim();
    if (!title) continue;
    out.push({ url, title, provider: 'ddg' });
  }
  return out;
}

async function searchNvd(query, limit = 4) {
  const url = `https://services.nvd.nist.gov/rest/json/cves/2.0?keywordSearch=${encodeURIComponent(query)}&resultsPerPage=${limit}`;
  const r = await fetchRaw(url);
  let json;
  try { json = JSON.parse(r.body); } catch { return []; }
  return (json.vulnerabilities || []).slice(0, limit).map((v) => {
    const c = v.cve || {};
    const desc = ((c.descriptions || []).find((d) => d.lang === 'en') || {}).value || '';
    return {
      url: `https://nvd.nist.gov/vuln/detail/${c.id}`,
      title: `${c.id} — ${desc.slice(0, 120)}`,
      provider: 'nvd',
      // Il testo che il modello leggerà e citerà: lo costruiamo noi, quindi è già congelato.
      text: [`${c.id} (published ${c.published || '?'}, status ${c.vulnStatus || '?'})`, desc,
        `References: ${(c.references || []).slice(0, 5).map((x) => x.url).join(' ')}`].join('\n'),
    };
  });
}

async function searchArxiv(query, limit = 4) {
  const url = `http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&max_results=${limit}`;
  const r = await fetchRaw(url);
  const entries = r.body.split(/<entry>/i).slice(1);
  return entries.map((e) => {
    const title = (e.match(/<title>([\s\S]*?)<\/title>/i) || [, ''])[1].replace(/\s+/g, ' ').trim();
    const summary = (e.match(/<summary>([\s\S]*?)<\/summary>/i) || [, ''])[1].replace(/\s+/g, ' ').trim();
    const id = (e.match(/<id>([\s\S]*?)<\/id>/i) || [, ''])[1].trim();
    return {
      url: id, title, provider: 'arxiv',
      text: `${title}\n\n${summary}`,
    };
  }).filter((x) => x.url && x.title);
}

async function searchGithub(query, limit = 4) {
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&per_page=${limit}`;
  const r = await fetchRaw(url);
  let json;
  try { json = JSON.parse(r.body); } catch { return []; }
  return (json.items || []).slice(0, limit).map((it) => ({
    url: it.html_url,
    title: it.full_name,
    provider: 'github',
    text: [
      `${it.full_name} — ${it.description || '(nessuna descrizione)'}`,
      `stars ${it.stargazers_count} · updated ${it.updated_at} · license ${(it.license && it.license.spdx_id) || 'unknown'} · language ${it.language || '?'}`,
      `topics: ${(it.topics || []).join(', ')}`,
      it.html_url,
    ].join('\n'),
  }));
}

// ── corpus locale ──────────────────────────────────────────────────────────────
const LOCAL_ROOTS = ['knowledge.md', 'docs', 'refs', 'skills'];
const STOPWORDS = new Set(['che', 'con', 'per', 'della', 'delle', 'degli', 'come', 'quali', 'cosa', 'the', 'and', 'for', 'with', 'how', 'what', 'are', 'del', 'dei', 'una', 'uno']);

function walkMd(p, out, depth = 0) {
  if (depth > 4) return;
  let st;
  try { st = fs.statSync(p); } catch { return; }
  if (st.isFile()) { if (/\.md$/i.test(p) && st.size > 800) out.push(p); return; }
  let entries = [];
  try { entries = fs.readdirSync(p); } catch { return; }
  for (const e of entries) walkMd(path.join(p, e), out, depth + 1);
}

function tokens(s) {
  return (String(s).toLowerCase().match(/[a-zà-ù0-9][a-zà-ù0-9._-]{3,}/g) || [])
    .filter((t) => !STOPWORDS.has(t));
}

/** Ricerca lessicale sul corpus dell'harness. Grep-first: nessun indice da tenere caldo. */
function searchLocal(runId, question, limit = 3) {
  const terms = [...new Set(tokens(question))].slice(0, 12);
  if (!terms.length) return [];
  const files = [];
  for (const rel of LOCAL_ROOTS) walkMd(path.join(state.ROOT, rel), files);

  const scored = [];
  for (const file of files) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const lower = text.toLowerCase();
    let score = 0;
    for (const t of terms) {
      const inHeading = lower.indexOf(`# ${t}`) >= 0 || lower.indexOf(`## ${t}`) >= 0;
      const n = (lower.split(t).length - 1);
      score += Math.min(n, 4) + (inHeading ? 3 : 0);
    }
    if (score > 0) scored.push({ file, text, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ file, text }) => {
    const rel = path.relative(state.ROOT, file);
    const frozen = freeze(runId, rel, text, { origin: 'local', path: rel });
    return { ...frozen, url: rel, title: rel, provider: 'local', text };
  });
}

/**
 * Raccoglie candidate per una domanda. La lane decide i motori: un paper su arXiv non
 * risponde a «come si sfrutta X», e una CVE non dice quale capacità manchi all'harness.
 * @param {{runId: string, question: string, queries: string[], lane: string, limit?: number}} opts
 * @returns {Promise<object[]>} candidate con {url, title, provider, text?}
 */
async function gather({ runId, question, queries, lane, limit = 6 }) {
  const out = [];
  const seen = new Set();
  const push = (c) => {
    if (!c || !c.url) return;
    const key = String(c.url).replace(/[#?].*$/, '').replace(/\/$/, '');
    if (seen.has(key)) return;
    seen.add(key);
    out.push(c);
  };

  // Quota, non priorità assoluta: il corpus locale è ottimo quando parla della domanda, ma
  // se riempie tutto il budget il web non viene mai raggiunto e la ricerca diventa un grep
  // nel repo con la pretesa di essere deep research.
  const localCap = Math.max(1, Math.ceil(limit / 3));
  for (const local of searchLocal(runId, question, localCap)) push(local);

  for (const q of queries) {
    if (out.length >= limit) break;   // niente rete se il budget di fonti è già pieno
    if (lane !== 'capability') {
      try { for (const c of await searchNvd(q, 3)) push(c); } catch { /* provider giù: si prosegue */ }
    }
    try { for (const c of await searchWeb(q, 5)) push(c); } catch { /* idem */ }
    if (lane === 'capability') {
      try { for (const c of await searchGithub(q, 3)) push(c); } catch { /* idem */ }
      try { for (const c of await searchArxiv(q, 3)) push(c); } catch { /* idem */ }
    }
  }
  return out.slice(0, limit);
}

module.exports = {
  UA, MAX_SOURCE_CHARS,
  sha256, htmlToText, freeze, fetchRaw, fetchSource,
  searchWeb, searchNvd, searchArxiv, searchGithub, searchLocal, gather,
};
