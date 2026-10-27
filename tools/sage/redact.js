#!/usr/bin/env node
'use strict';
// tools/sage/redact.js — cosa NON deve uscire da un run di ricerca.
//
// Perché esiste: la ricerca ha egress aperto (decisione dell'operatore), ma "aperto"
// significa «posso chiedere a un motore di ricerca novità su SSRF», non «posso chiedere
// novità su SSRF su <host del cliente>». Host in scope, IP autorizzati e segreti sono
// dati di engagement: il loro posto non è una query verso l'esterno. Questo modulo li
// toglie prima che escano e lascia traccia di QUANTO è stato tolto (mai il valore).
//
// Non è un guardrail di scope — quello resta in tools/scope-guard.js — ed è per questo che
// non ha un flag "fail-closed": una query ripulita resta utile, una query bloccata no.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

const HOST_MARK = '[host-in-scope]';
const IP_MARK = '[ip-in-scope]';
const ENGAGEMENT_MARK = '[engagement]';

// Nomi di campagna e cliente sono identità dell'engagement quanto un host: in una query verso
// un motore di ricerca non hanno niente da fare. Sono termini LETTERALI (non pattern), ma
// alcune parole sono troppo comuni per essere raschiate senza distruggere la query.
const GENERIC_TERMS = new Set([
  'pentest', 'engagement', 'security', 'sicurezza', 'research', 'ricerca', 'harness',
  'mobile', 'wireless', 'web', 'host', 'test', 'audit', 'project', 'progetto', 'platform',
  'full', 'internal', 'external', 'cliente', 'client', 'default', 'copy', 'template',
  'assessment', 'trading', 'group', 'systems', 'server', 'cloud', 'network', 'retest',
]);

// Un valore che sembra un host può arrivare come URL completa, `host:porta`, wildcard o
// nome nudo (`scope.json` ammette tutte le forme): normalizziamo alla forma confrontabile.
function normalizeHost(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  let host = s;
  try { host = new URL(s).hostname; } catch { /* nome nudo o pattern: resta com'è */ }
  return host
    .toLowerCase()
    .replace(/^\*\./, '')   // *.example.com copre i sottodomini, non solo la radice
    .replace(/^\.+|\.+$/g, '');
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Pattern di host: cattura anche i sottodomini (`sub.example.com`), perché tagliare solo
// `example.com` lascerebbe `sub.[host-in-scope]` — metà informazione, che è peggio di zero.
function hostPattern(host) {
  return new RegExp(`(?<![\\w.-])(?:[\\w-]+\\.)*${escapeRe(host)}(?![\\w-])`, 'gi');
}

// Pattern di IP: niente cifre/punti di continuazione ai bordi, così 10.0.0.1 non matcha
// dentro 110.0.0.10, ma SÌ a fine frase ("…l'IP 10.0.0.1." ha un punto, non un ottetto).
function ipPattern(ip) {
  return new RegExp(`(?<![\\d.])${escapeRe(ip)}(?!\\d|\\.\\d)`, 'g');
}

// Segreti che non hanno bisogno di essere "in scope" per non dover uscire: email (identità),
// credenziali in URL, token di ogni famiglia riconoscibile. Il rimpiazzo conserva la forma
// della stringa: se serve ancora contesto, il modello lo vede.
const SECRET_PATTERNS = [
  { name: 'url-credential', re: /\/\/[^\s/:@]+:[^\s/@]+@/g, rep: '//[credential]@' },
  { name: 'email', re: /[\w.+-]+@[\w-]+\.[\w.-]+/g, rep: '[email]' },
  { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, rep: 'Bearer [token]' },
  { name: 'openai-key', re: /\bsk-[A-Za-z0-9_-]{12,}/g, rep: 'sk-[token]' },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, rep: '[jwt]' },
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, rep: '[github-token]' },
  { name: 'aws-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, rep: '[aws-key]' },
];

/**
 * Estrae le stringhe da ripulire da un oggetto scope/campagna. Pura: nessun I/O, così il
 * test può verificarla senza costruire un workspace.
 * @param {object} scope contenuto di scope.json (o simile)
 * @param {...(object|string)} extra altri oggetti con le stesse chiavi, o host nudi
 * @returns {{hosts: string[], ips: string[]}} valori ordinati dal più lungo (prima i match specifici)
 */
function collectHints(scope, ...extra) {
  const hosts = new Set();
  const ips = new Set();
  const terms = new Set();
  const seenTerm = new Set();   // dedupe case-insensitive: "NOA" e "noa" sono lo stesso termine

  const addHost = (v) => { const h = normalizeHost(v); if (h) hosts.add(h); };
  const addIp = (v) => {
    const s = String(v == null ? '' : v).trim();
    if (!s) return;
    ips.add(s);
    const base = s.split('/')[0];      // un CIDR: si ripulisce la forma scritta e la base
    if (base && base !== s) ips.add(base);
  };
  // Solo le chiavi che NOMINANO l'engagement: `description` e `objectives` sono testo lungo e
  // raschiarli renderebbe illeggibile ogni query senza togliere identità.
  const addTerm = (raw) => {
    const s = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
    if (s.length < 3) return;
    const add = (t) => {
      const k = t.toLowerCase();
      if (seenTerm.has(k)) return;
      seenTerm.add(k);
      terms.add(t);
    };
    if (s.length >= 4 && !GENERIC_TERMS.has(s.toLowerCase())) add(s);
    // Anche le parole distintive del nome: un brief scrive "noa", non "noa full platform".
    // Si spezza su tutto ciò che non è lettera/numero, così "S.p.A." non produce sigle.
    for (const w of s.split(/[^\p{L}\p{N}]+/u)) {
      if (w.length >= 3 && !GENERIC_TERMS.has(w.toLowerCase())) add(w);
    }
  };

  const addFrom = (o) => {
    if (!o) return;
    if (typeof o === 'string') { addHost(o); return; }
    if (typeof o !== 'object') return;
    for (const k of ['name', 'client', 'engagement', 'engagement_name', 'campaign']) {
      if (typeof o[k] === 'string') addTerm(o[k]);
    }
    // Superfici wireless/mobile: un SSID o un seriale identificano il bersaglio quanto un host.
    for (const k of ['essids', 'bssids', 'stations', 'allowed_serials']) {
      const v = o[k];
      if (Array.isArray(v)) v.forEach(addTerm);
      else if (typeof v === 'string') addTerm(v);
    }
    for (const k of ['allowed_hosts', 'hosts', 'targets', 'allowed_url_prefixes', 'url_prefixes']) {
      const v = o[k];
      if (Array.isArray(v)) v.forEach(addHost);
      else if (typeof v === 'string') addHost(v);
    }
    for (const k of ['allowed_ips', 'ips']) {
      const v = o[k];
      if (Array.isArray(v)) v.forEach(addIp);
      else if (typeof v === 'string') addIp(v);
    }
  };

  addFrom(scope);
  extra.forEach(addFrom);

  return {
    hosts: [...hosts].sort((a, b) => b.length - a.length),
    ips: [...ips].sort((a, b) => b.length - a.length),
    terms: [...terms].sort((a, b) => b.length - a.length),
  };
}

/**
 * Legge le fonti di verità locali e ne ricava le stringhe da ripulire. File mancanti o
 * corrotti non fermano la ricerca: si degrada a "meno redazione", non a "nessuna ricerca".
 * @param {string} [root] radice del workspace (default: repo)
 * @returns {{hosts: string[], ips: string[]}}
 */
function loadHints(root = ROOT) {
  const read = (rel) => {
    try { return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')); } catch { return null; }
  };
  return collectHints(
    read('scope.json'),
    read('campaign.json'),
    read('wifi-scope.json'),
    read('mobile-scope.json'),
  );
}

/**
 * Ripulisce un testo destinato all'esterno.
 * @param {string} text
 * @param {{hosts?: string[], ips?: string[]}} hints
 * @returns {{text: string, hits: {kind: string, count: number}[], redacted: boolean}}
 *   `hits` riporta solo la categoria e il numero: il valore rimosso non viene mai loggato.
 */
function scrubText(text, hints = {}) {
  let out = String(text == null ? '' : text);
  const hits = [];
  const note = (kind, n) => { if (n > 0) hits.push({ kind, count: n }); };

  // Segreti per primi: un'email su un host in scope deve diventare [email], non [email]@[host-in-scope].
  for (const p of SECRET_PATTERNS) {
    const found = out.match(p.re);
    if (found) { note(p.name, found.length); out = out.replace(p.re, p.rep); }
  }
  for (const host of hints.hosts || []) {
    if (!host || host.length < 4) continue;   // 'a.io' genererebbe falsi positivi ovunque
    const found = out.match(hostPattern(host));
    if (found) { note('host', found.length); out = out.replace(hostPattern(host), HOST_MARK); }
  }
  for (const ip of hints.ips || []) {
    if (!ip) continue;
    const found = out.match(ipPattern(ip));
    if (found) { note('ip', found.length); out = out.replace(ipPattern(ip), IP_MARK); }
  }
  for (const term of hints.terms || []) {
    if (!term) continue;
    // Confini di parola: "NOA" non deve toccare "NOAH" né finire dentro un'altra parola.
    const re = new RegExp(`(?<![\\w-])${escapeRe(term)}(?![\\w-])`, 'gi');
    const found = out.match(re);
    if (found) { note('engagement-name', found.length); out = out.replace(re, ENGAGEMENT_MARK); }
  }
  return { text: out, hits, redacted: hits.length > 0 };
}

module.exports = {
  ROOT, HOST_MARK, IP_MARK, ENGAGEMENT_MARK, GENERIC_TERMS,
  normalizeHost, collectHints, loadHints, scrubText, hostPattern, ipPattern,
};
