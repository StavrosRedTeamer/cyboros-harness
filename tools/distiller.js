#!/usr/bin/env node
// distiller.js — chiude il loop memory/: distilla i findings di un engagement (episodico,
// gitignored) in lezioni trasferibili (lessons.jsonl) e soluzioni cristallizzate (rag-store.jsonl).
//
// Oggi lo step "distiller" del memory/README e' MANUALE ("a fine engagement distillare <=10
// lezioni"). Questo tool lo automatizza restando FAIL-CLOSED: nessun dato di engagement entra
// negli store: ogni candidato passa dal sanitizer di tools/memory.js (host in-scope, IP, email,
// JWT, blob, credenziali). Cio' che non e' generalizzabile in automatico NON viene scritto: va
// in coda a memory/distill-review.md con la ragione esatta del blocco.
//
// Pipeline (7 stadi):
//   1. HARVEST      leggi reports/findings.jsonl
//   2. SELECT       tieni solo il distillabile (proven_impact/triggered; failed/blocked con causa)
//   3. MAP          finding.class (vuln) -> lessons.class (surface) via VULN2SURFACE
//   4. GENERALIZE   URL/IP/email/JWT/secret -> marker; stack astratto dai segnali tech, MAI dall'host
//   5. GATE         mem.sanitizeViolations() fail-closed  ->  blocco = review, mai scrittura
//   6. STORE        lesson -> mem.addLesson()   |   soluzione verificata -> rag.storeEntry()
//   7. DEDUP+INDEX  skip di cio' che gia' esiste; gli add rigenerano gli indici
//
// Uso:
//   node tools/distiller.js                 # DRY-RUN: mostra cosa scriverebbe, non tocca gli store
//   node tools/distiller.js --apply         # scrive davvero in lessons.jsonl / rag-store.jsonl
//   node tools/distiller.js --file <path>   # sorgente findings alternativa (default reports/findings.jsonl)
//   node tools/distiller.js --json          # summary machine-readable
//   node tools/distiller.js --limit 10      # cap ai primi N candidati (default: tutti)
//
// Il seam LLM: generalize() qui e' DETERMINISTICO (scrubbing regex). La generalizzazione
// "semantica" (host->stack piu' ricco, poc->marker piu' pulito) e' il ruolo `reporter` del tuo
// model-routing.json: se un giorno la agganci, DEVE girare DOPO questo scrubbing, mai prima
// (mandare un poc grezzo con secret a un modello cloud e' esattamente il leak che il gate previene).
//
// Self-test: node tools/test-distiller.js
'use strict';

const { env } = require('./env');
const fs = require('fs');
const path = require('path');
const mem = require('./memory'); // fonte unica di sanitizer, addLesson, readJsonl

const ROOT = path.resolve(__dirname, '..');
const MEMORY_DIR = env('MEMORY_DIR') || path.join(ROOT, 'memory');
const DEFAULT_FINDINGS = path.join(ROOT, 'reports', 'findings.jsonl');
const REVIEW_FILE = 'distill-review.md';
const MAX_POC = 400; // i poc_snippet lunghi sono rumore per l'embedding: cap

// lazy: memory-rag esiste come modulo separato (stesso schema store->rag)
function ragMod() { return require('./memory-rag'); }

// ---------- 3. MAP: vuln-class (finding) -> surface-class (lessons enum) ----------
// lessons.class ∈ web|api|mobile|network|cloud|wifi|ad|generic (validateLesson lo impone).
const VULN2SURFACE = {
  idor: 'api', bola: 'api', bfla: 'api', 'mass-assignment': 'api', graphql: 'api',
  ssrf: 'web', sqli: 'web', xss: 'web', csrf: 'web', xxe: 'web', ssti: 'web',
  lfi: 'web', rce: 'web', authn: 'web', authz: 'web', session: 'web',
  config: 'web', info: 'web', 'open-redirect': 'web', deserialization: 'web',
  cloud: 'cloud', s3: 'cloud', iam: 'cloud',
  network: 'network', smb: 'network', dns: 'network',
  ad: 'ad', kerberos: 'ad', mobile: 'mobile',
};
function surface(cls) {
  return VULN2SURFACE[String(cls || '').toLowerCase()] || 'generic';
}

// ---------- 4. GENERALIZE: scrubbing deterministico (fail-closed friendly) ----------
// Rimuove i secret STRUTTURATI (URL/IP/email/JWT/blob). Gli host "nudi" (non dentro un URL)
// NON vengono toccati qui di proposito: se sono in-scope li becca il gate -> review. Meglio una
// voce in meno che un leak. Questo e' il seam dove un LLM alzerebbe la resa (vedi header).
// TLD pubblici comuni negli scope di pentest. Uno scrub di hostname *gated* su questo set
// becca gli host di engagement PASSATI (non piu' in scope.json, quindi invisibili al gate) senza
// toccare i token con estensione di codice (main.dart.js, localita.class.php: last-label non-TLD).
// Collaterale accettabile e SICURO: token tech che finiscono in un TLD reale (asp.net -> {{HOST}}).
const PUBLIC_TLDS = new Set([
  'com', 'net', 'org', 'io', 'co', 'info', 'biz', 'dev', 'app', 'shop', 'store', 'online',
  'site', 'xyz', 'tech', 'cloud', 'live', 'me', 'tv', 'cc', 'name', 'pro', 'mobi', 'eu', 'asia',
  'uk', 'de', 'fr', 'it', 'es', 'nl', 'ru', 'cn', 'jp', 'in', 'br', 'au', 'ca', 'ch', 'se',
  'no', 'dk', 'fi', 'pl', 'cz', 'at', 'be', 'pt', 'gr', 'ie', 'il', 'tr', 'kr', 'tw', 'hk',
  'sg', 'my', 'id', 'th', 'vn', 'ph', 'za', 'ae', 'sa', 'us', 'ua', 'ro', 'hu', 'sk', 'bg',
]);

function generalize(text) {
  let s = String(text == null ? '' : text);
  s = s.replace(/\bhttps?:\/\/[^\s"'<>)\]]+/gi, '{{TARGET}}');          // URL interi
  s = s.replace(/\beyj[a-z0-9_-]{10,}/gi, '{{JWT}}');                    // JWT
  s = s.replace(/\b[\w.+-]+@[\w-]+\.[\w.-]{2,}\b/g, '{{EMAIL}}');        // email (prima dell'host)
  s = s.replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, (m) =>                   // IP (loopback resta)
    (m === '127.0.0.1' || m === '0.0.0.0') ? m : '{{IP}}');
  // FQDN nudi: scrub solo se il TLD e' pubblico -> preserva file/token di codice (.js/.php/.class)
  s = s.replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi, (m) => {
    const tld = m.split('.').pop().toLowerCase();
    return PUBLIC_TLDS.has(tld) ? '{{HOST}}' : m;
  });
  s = s.replace(/\b[A-Fa-f0-9]{32,}\b/g, '{{SECRET}}');                  // blob hex
  s = s.replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, '{{SECRET}}');         // blob base64
  return s.replace(/\s+/g, ' ').trim();
}

// ---------- 4. toStack: stack ASTRATTO dai segnali tech, MAI dall'host ----------
// Deriva lo stack da title/oracle/evidence/standards con un dizionario di tecnologie note.
// Deliberatamente NON legge finding.host/endpoint: lo stack e' cross-engagement, l'host no.
const TECH = [
  'nginx', 'apache', 'iis', 'cloudflare', 'akamai', 'modsecurity', 'aws waf', 'azure',
  'spring boot', 'spring', 'express', 'node', 'nodejs', 'php', 'wordpress', 'drupal', 'joomla',
  'laravel', 'symfony', 'django', 'flask', 'rails', 'asp.net', '.net', 'tomcat', 'jetty',
  'react', 'angular', 'vue', 'next.js', 'graphql', 'grpc', 'kubernetes', 'docker', 'nginx',
  'mysql', 'postgres', 'postgresql', 'mongodb', 'redis', 'elasticsearch', 'keycloak', 'oauth',
];
function toStack(f) {
  const hay = [f.title, f.oracle, f.evidence_quote, f.impact,
    Array.isArray(f.standards) ? f.standards.join(' ') : f.standards]
    .filter(Boolean).join(' ').toLowerCase();
  const found = [];
  for (const t of TECH) {
    if (hay.includes(t) && !found.includes(t)) found.push(t);
  }
  return found.length ? found.slice(0, 4) : ['generic'];
}

// ---------- 2. SELECT: cosa merita distillazione ----------
// evidence_ref stabile e non-leaky: indice di riga (il title puo' contenere un host).
function evRef(idx) { return `reports/findings.jsonl#${idx + 1}`; }

function selectFindings(findings) {
  const ragC = [], lessonC = [];
  findings.forEach((f, idx) => {
    const vl = f.verify_level;
    const failed = !!f.verify_failed || f.status === 'blocked';
    if (vl === 'proven_impact') {
      ragC.push({ f, idx });                                   // soluzione verificata -> RAG
      lessonC.push({ f, idx, outcome: 'worked' });
    } else if (vl === 'triggered' && !failed) {
      lessonC.push({ f, idx, outcome: 'worked' });             // riproducibile ma impatto non provato
    } else if (failed) {
      lessonC.push({ f, idx, outcome: f.status === 'blocked' ? 'blocked' : 'failed' });
    }
    // suspected / inconclusive / verify_level assente -> scartati (rumore)
  });
  return { rag: ragC, lessons: lessonC };
}

// ---------- 4. build candidati (post-map, post-generalize) ----------
function buildLessonCandidate({ f, idx, outcome }) {
  const technique = generalize(`${f.title || ''} — ${f.poc || ''}`).slice(0, 500);
  const cause = outcome === 'worked' ? '' : generalize(f.verify_reason || f.impact || '').slice(0, 300);
  return {
    class: surface(f.class),
    stack: toStack(f),
    waf: 'unknown',
    technique,
    outcome,
    cause,
    evidence_ref: evRef(idx),
    tags: [String(f.class || '').toLowerCase(), String(f.cwe || '').toLowerCase()].filter(Boolean),
  };
}

function buildRagCandidate({ f, idx }) {
  return {
    target_stack: toStack(f).join(', '),
    vulnerability_class: String(f.class || 'generic').toUpperCase(),
    obstacle: generalize(f.verify_reason || '').slice(0, 300),
    solution: generalize(`${f.impact || f.title || ''} — ${f.poc || ''}`).slice(0, 600),
    poc_snippet: generalize(f.poc || '').slice(0, MAX_POC),
    source_ref: evRef(idx),
    tags: [String(f.class || '').toLowerCase()].filter(Boolean),
  };
}

// ---------- 5. GATE: fail-closed prima di qualunque scrittura ----------
function gate(candidate) {
  const v = mem.sanitizeViolations({ ...candidate, id: undefined, ts: undefined });
  return { ok: v.length === 0, violations: v };
}

// ---------- 6. DEDUP idempotente (ne' lessons.jsonl ne' rag-store dedup-ano nativamente) ----------
function lessonKey(c) { return `${c.class}|${c.technique}`.toLowerCase(); }
function ragKey(c) { return `${c.vulnerability_class}|${c.target_stack}|${c.solution.slice(0, 60)}`.toLowerCase(); }

// ---------- report review (candidati bloccati dal gate o dalla validazione) ----------
function writeReview(dir, review) {
  const file = path.join(dir, REVIEW_FILE);
  if (!review.length) {
    // niente da rivedere: se esiste un vecchio file, lascialo (storico), ma segnala pulito
    return null;
  }
  let md = '# distill-review — candidati NON scritti (da generalizzare a mano)\n\n';
  md += '> Prodotto da `tools/distiller.js`. Ogni voce e-stata bloccata dal sanitizer o dalla\n';
  md += '> validazione: generalizza il campo indicato e reinserisci con memory-store.js / memory.js add.\n\n';
  review.forEach((r, i) => {
    md += `## ${i + 1}. [${r.kind}] ${r.ref}\n`;
    md += `- **motivo**: ${r.violations.join(' · ')}\n`;
    md += '```json\n' + JSON.stringify(r.candidate, null, 2) + '\n```\n\n';
  });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, md);
  return file;
}

// ---------- run ----------
function run(opts = {}) {
  const dir = opts.dir || MEMORY_DIR;
  const findingsFile = opts.findingsFile || DEFAULT_FINDINGS;
  const apply = !!opts.apply;
  const limit = opts.limit || Infinity;
  const rag = ragMod();

  const findings = mem.readJsonl(findingsFile);
  const { rag: ragSel, lessons: lessonSel } = selectFindings(findings);

  // set di dedup dal contenuto attuale degli store
  const lessonSeen = new Set(mem.readJsonl(path.join(dir, mem.LESSONS_FILE))
    .map((r) => lessonKey({ class: r.class, technique: r.technique })));
  const ragSeen = new Set(mem.readJsonl(path.join(dir, rag.STORE_FILE))
    .map((r) => ragKey({ vulnerability_class: r.vulnerability_class, target_stack: r.target_stack, solution: r.solution || '' })));

  const review = [];
  const planned = { lessons: [], rag: [] };
  let addedL = 0, addedR = 0, dupL = 0, dupR = 0;

  // --- lessons ---
  for (const sel of lessonSel.slice(0, limit)) {
    const c = buildLessonCandidate(sel);
    const key = lessonKey(c);
    if (lessonSeen.has(key)) { dupL++; continue; }
    lessonSeen.add(key);
    const g = gate(c);
    if (!g.ok) { review.push({ kind: 'lesson', ref: evRef(sel.idx), candidate: c, violations: g.violations }); continue; }
    planned.lessons.push(c);
    if (apply) {
      try { mem.addLesson(dir, c); addedL++; }
      catch (e) { review.push({ kind: 'lesson', ref: evRef(sel.idx), candidate: c, violations: [`validazione: ${e.message}`] }); }
    }
  }

  // --- rag ---
  for (const sel of ragSel.slice(0, limit)) {
    const c = buildRagCandidate(sel);
    const key = ragKey(c);
    if (ragSeen.has(key)) { dupR++; continue; }
    ragSeen.add(key);
    const g = gate(c);
    if (!g.ok) { review.push({ kind: 'rag', ref: evRef(sel.idx), candidate: c, violations: g.violations }); continue; }
    planned.rag.push(c);
    if (apply) {
      try { rag.storeEntry(dir, c); addedR++; }
      catch (e) { review.push({ kind: 'rag', ref: evRef(sel.idx), candidate: c, violations: [`validazione: ${e.message}`] }); }
    }
  }

  const reviewFile = writeReview(dir, review);
  return {
    mode: apply ? 'apply' : 'dry-run',
    findings: findings.length,
    selected: { lessons: lessonSel.length, rag: ragSel.length },
    duplicates: { lessons: dupL, rag: dupR },
    would_write: { lessons: planned.lessons.length, rag: planned.rag.length },
    written: { lessons: addedL, rag: addedR },
    needs_review: review.length,
    review_file: reviewFile ? path.relative(ROOT, reviewFile) : null,
    planned: apply ? undefined : planned, // in dry-run mostra cosa scriverebbe
  };
}

// ---------- CLI ----------
function optValue(argv, flag, dflt) {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : dflt;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
    return;
  }
  try {
    const res = run({
      apply: argv.includes('--apply'),
      findingsFile: optValue(argv, '--file', null) || DEFAULT_FINDINGS,
      limit: parseInt(optValue(argv, '--limit', ''), 10) || Infinity,
    });
    if (argv.includes('--json')) { console.log(JSON.stringify(res, null, 2)); return; }
    // human summary
    const l = res.written.lessons || res.would_write.lessons;
    const r = res.written.rag || res.would_write.rag;
    console.log(`[distiller] ${res.mode} — ${res.findings} findings`);
    console.log(`  selezionati: ${res.selected.lessons} lezioni, ${res.selected.rag} soluzioni RAG`);
    console.log(`  ${res.mode === 'apply' ? 'scritti' : 'scriverebbe'}: ${l} lezioni, ${r} RAG` +
      `  (dup saltati: ${res.duplicates.lessons + res.duplicates.rag})`);
    if (res.needs_review) console.log(`  ⚠ ${res.needs_review} candidati bloccati dal gate -> ${res.review_file} (generalizza a mano)`);
    if (res.mode === 'dry-run') console.log('  (dry-run: niente scritto. Aggiungi --apply per scrivere)');
  } catch (e) {
    process.stderr.write(`[distiller] ERRORE: ${e.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  run, selectFindings, buildLessonCandidate, buildRagCandidate,
  generalize, toStack, surface, gate, lessonKey, ragKey,
  VULN2SURFACE, REVIEW_FILE,
};

if (require.main === module) main();
