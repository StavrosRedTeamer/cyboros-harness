#!/usr/bin/env node
// Offline self-check per tools/distiller.js. Hermetico: temp CYBOROS_MEMORY_DIR + SCOPE_JSON
// fixture + findings.jsonl fixture, nessuna rete, nessun memory/ o reports/ reale toccato.
// Verifica il contratto centrale: FAIL-CLOSED (i dati di engagement non entrano mai negli store).
// Run: node tools/test-distiller.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'distiller-test-'));
process.env.CYBOROS_MEMORY_DIR = dir;
const scopeFile = path.join(dir, 'scope.json');
fs.writeFileSync(scopeFile, JSON.stringify({ allowed_hosts: ['acme-scope.test'], allowed_ips: [] }));
process.env.SCOPE_JSON = scopeFile; // fixture sanitizer: 'acme-scope.test' e' un host in-scope da rifiutare

const dist = require('./distiller');
const mem = require('./memory');
const rag = require('./memory-rag');

// ---------- fixture findings (copre ogni ramo di select + gate) ----------
const findings = [
  { // F1: proven_impact -> lesson(worked) + RAG; host solo dentro URL -> generalizzato, PASSA
    severity: 'High', title: 'IDOR: unauth order read via API on Spring Boot', class: 'idor',
    verify_level: 'proven_impact', impact: 'anonymous can read live orders',
    poc: 'GET https://acme-scope.test/api/orders/1 -> 200 JSON order_head_id',
    evidence_quote: 'order_head_id present in response', cwe: 'CWE-639',
  },
  { // F2: triggered -> solo lesson(worked)
    severity: 'Medium', title: 'Reflected XSS in error page, WordPress theme', class: 'xss',
    verify_level: 'triggered', poc: 'payload in q parameter reflected unencoded',
  },
  { // F3: verify_failed -> lesson(failed) con cause
    severity: 'Low', title: 'SQLi attempt on login form', class: 'sqli',
    verify_failed: true, verify_reason: 'payload riflesso ma parametrizzato dal driver, nessuna injection',
    poc: "' OR 1=1 -- -",
  },
  { // F4: suspected -> SCARTATO
    severity: 'Info', title: 'possible open redirect', class: 'config', verify_level: 'suspected',
  },
  { // F5: triggered ma host in-scope NUDO nel title -> gate BLOCCA -> review
    severity: 'Medium', title: 'Reflected XSS on acme-scope.test search box', class: 'xss',
    verify_level: 'triggered', poc: 'reflected in search results',
  },
];
const findingsFile = path.join(dir, 'findings.jsonl');
fs.writeFileSync(findingsFile, findings.map((f) => JSON.stringify(f)).join('\n') + '\n');

// ---------- 1) surface(): mapping vuln-class -> surface-class ----------
assert.strictEqual(dist.surface('idor'), 'api', 'idor -> api');
assert.strictEqual(dist.surface('sqli'), 'web', 'sqli -> web');
assert.strictEqual(dist.surface('kerberos'), 'ad', 'kerberos -> ad');
assert.strictEqual(dist.surface('nonsense'), 'generic', 'ignoto -> generic');

// ---------- 2) generalize(): scrubbing dei secret strutturati ----------
const g = dist.generalize;
assert.ok(!/acme-scope\.test/.test(g('GET https://acme-scope.test/api/x?y=1 done')), 'URL con host scrubbato');
assert.ok(/\{\{TARGET\}\}/.test(g('see https://x.example/p')), 'URL -> {{TARGET}}');
assert.ok(/\{\{IP\}\}/.test(g('pivot via 192.0.2.235 ssh')), 'IP -> {{IP}}');
assert.ok(/127\.0\.0\.1/.test(g('bind 127.0.0.1')), 'loopback preservato');
assert.ok(/\{\{EMAIL\}\}/.test(g('contact admin@lumen.trading')), 'email -> {{EMAIL}}');
assert.ok(/\{\{JWT\}\}/.test(g('token eyJhbGciOiJIUzI1NiJ9abcdef')), 'JWT -> {{JWT}}');
assert.ok(/\{\{SECRET\}\}/.test(g('key ' + 'a'.repeat(40))), 'blob lungo -> {{SECRET}}');
// FQDN nudo (host di engagement passato, non in scope): scrub gated su TLD pubblico
assert.ok(!/mailchef\.4dem\.it/.test(g('leak su mailchef.4dem.it panel')), 'host nudo con TLD pubblico scrubbato');
assert.ok(/\{\{HOST\}\}/.test(g('leak su spf.webapps.net record')), 'host nudo -> {{HOST}}');
assert.strictEqual(g('vedi main.dart.js e localita.class.php'), 'vedi main.dart.js e localita.class.php', 'token di codice (TLD non-pubblico) preservati');

// ---------- 3) toStack(): dai segnali tech, MAI dall'host ----------
const st = dist.toStack(findings[0]);
assert.ok(st.includes('spring boot'), 'stack estrae "spring boot" dal title');
assert.ok(!st.some((s) => /acme-scope/.test(s)), 'stack non contiene mai l\'host');
assert.deepStrictEqual(dist.toStack({ title: 'boh', class: 'x' }), ['generic'], 'nessun tech -> ["generic"]');

// ---------- 4) selectFindings(): rami di selezione ----------
const sel = dist.selectFindings(findings);
assert.strictEqual(sel.rag.length, 1, 'solo F1 (proven_impact) -> RAG');
assert.strictEqual(sel.rag[0].idx, 0, 'il RAG e\' F1');
// lessons: F1(worked) + F2(worked) + F3(failed) + F5(worked) = 4 ; F4(suspected) escluso
assert.strictEqual(sel.lessons.length, 4, 'F4 suspected scartato, gli altri 4 selezionati');
assert.ok(sel.lessons.find((s) => s.idx === 2).outcome === 'failed', 'F3 -> outcome failed');
assert.ok(!sel.lessons.some((s) => s.idx === 3), 'F4 mai selezionato');

// ---------- 5) gate(): pulito passa, host in-scope blocca ----------
const clean = dist.buildLessonCandidate(sel.lessons.find((s) => s.idx === 0));
assert.ok(dist.gate(clean).ok, 'candidato F1 generalizzato passa il gate');
const dirty = dist.buildLessonCandidate(sel.lessons.find((s) => s.idx === 4)); // F5 host nudo
assert.ok(!dist.gate(dirty).ok, 'F5 con host in-scope nudo e\' bloccato');
assert.ok(dist.gate(dirty).violations.some((v) => /acme-scope\.test/.test(v)), 'la violazione nomina l\'host');

// ---------- 6) run() DRY-RUN: non scrive nulla negli store ----------
const dry = dist.run({ dir, findingsFile, apply: false });
assert.strictEqual(dry.mode, 'dry-run');
assert.strictEqual(dry.written.lessons, 0, 'dry-run non scrive lezioni');
assert.strictEqual(dry.written.rag, 0, 'dry-run non scrive RAG');
assert.strictEqual(dry.would_write.lessons, 3, 'scriverebbe 3 lezioni (F1,F2,F3; F5 in review)');
assert.strictEqual(dry.would_write.rag, 1, 'scriverebbe 1 RAG (F1)');
assert.strictEqual(dry.needs_review, 1, 'F5 in review');
assert.ok(!fs.existsSync(path.join(dir, mem.LESSONS_FILE)), 'dry-run: nessun lessons.jsonl creato');
assert.ok(!fs.existsSync(path.join(dir, rag.STORE_FILE)), 'dry-run: nessun rag-store.jsonl creato');

// ---------- 7) run() APPLY: scrive gli store + review file ----------
const ap = dist.run({ dir, findingsFile, apply: true });
assert.strictEqual(ap.mode, 'apply');
assert.strictEqual(ap.written.lessons, 3, 'apply scrive 3 lezioni');
assert.strictEqual(ap.written.rag, 1, 'apply scrive 1 RAG');
assert.strictEqual(ap.needs_review, 1, 'F5 resta in review');
const lessons = mem.readJsonl(path.join(dir, mem.LESSONS_FILE));
assert.strictEqual(lessons.length, 3, '3 lezioni persistite');
assert.ok(lessons.every((l) => l.sanitized === true), 'tutte le lezioni marcate sanitized');
assert.ok(lessons.every((l) => mem.sanitizeViolations({ ...l, id: undefined, ts: undefined }).length === 0),
  'INVARIANTE: nessuna lezione scritta contiene dati di engagement');
const store = mem.readJsonl(path.join(dir, rag.STORE_FILE));
assert.strictEqual(store.length, 1, '1 soluzione RAG persistita');
assert.ok(store[0].vec && store[0].vec.length, 'la voce RAG ha il vettore');
assert.ok(!JSON.stringify(store).includes('acme-scope.test'), 'INVARIANTE: host mai nel RAG store');
const reviewFile = path.join(dir, dist.REVIEW_FILE);
assert.ok(fs.existsSync(reviewFile), 'review file creato');
assert.ok(/acme-scope\.test/.test(fs.readFileSync(reviewFile, 'utf8')), 'review file spiega il blocco');

// ---------- 8) DEDUP: un secondo apply non duplica ----------
const ap2 = dist.run({ dir, findingsFile, apply: true });
assert.strictEqual(ap2.written.lessons, 0, 'secondo run: nessuna lezione nuova');
assert.strictEqual(ap2.written.rag, 0, 'secondo run: nessun RAG nuovo');
assert.strictEqual(ap2.duplicates.lessons, 3, '3 lezioni riconosciute come duplicate');
assert.strictEqual(ap2.duplicates.rag, 1, '1 RAG riconosciuto come duplicato');
assert.strictEqual(mem.readJsonl(path.join(dir, mem.LESSONS_FILE)).length, 3, 'store lezioni invariato');
assert.strictEqual(mem.readJsonl(path.join(dir, rag.STORE_FILE)).length, 1, 'store RAG invariato');

// ---------- 9) CLI E2E: shim dry-run + apply + --json ----------
const env = { ...process.env, CYBOROS_MEMORY_DIR: dir, SCOPE_JSON: scopeFile };
const cli = spawnSync(process.execPath,
  [path.join(ROOT, 'tools', 'distiller.js'), '--file', findingsFile, '--json'],
  { cwd: ROOT, env, encoding: 'utf8', timeout: 20000 });
assert.strictEqual(cli.status, 0, 'CLI dry-run esce 0: ' + cli.stderr);
const out = JSON.parse(cli.stdout);
assert.strictEqual(out.mode, 'dry-run', 'CLI default = dry-run (non scrive)');
assert.strictEqual(out.written.lessons, 0, 'CLI dry-run non scrive');
// gli store restano quelli del run apply precedente (dedup): 3 lezioni, 1 RAG
assert.strictEqual(mem.readJsonl(path.join(dir, mem.LESSONS_FILE)).length, 3, 'CLI dry-run non ha toccato gli store');

const cliHelp = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'distiller.js'), '--help'],
  { cwd: ROOT, env, encoding: 'utf8', timeout: 20000 });
assert.strictEqual(cliHelp.status, 0, 'CLI --help esce 0');
assert.ok(/FAIL-CLOSED/.test(cliHelp.stdout), 'CLI --help mostra l\'header');

fs.rmSync(dir, { recursive: true, force: true });
console.log('test-distiller.js: ALL PASS');
