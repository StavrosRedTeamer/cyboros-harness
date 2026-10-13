#!/usr/bin/env node
// Daily harness maintenance (repo-vet churchofmalware follow-ups). Runs once per day from
// cron/systemd; safe to run manually. Idempotent, offline-tolerant: every step reports its
// own failure and never blocks the others.
//
//   node tools/daily-maintenance.js [--skip-vendor] [--skip-kb] [--skip-gc] [--rotate-temp]
//
// Steps:
//   1. threatintel: refresh the CISA KEV catalog + NVD/EPSS/KEV for every CVE found in
//      reports/findings.jsonl (+ optional extra ids in reports/ti-watchlist.txt, one per line).
//      After a refresh record-finding.js compiles kev:true/false, precise CWEs and references.
//   2. vendor-mirror: re-pull every repo already pinned in vendor/mirror/MANIFEST.jsonl
//      (unchanged SHA = cached no-op; new upstream commit = new pinned zip) + re-verify all
//      hashes + rebuild vendor/poc-archive/index.json.
//   3. kb-search: rebuild the FTS5 index over knowledge.md/docs (reports included).
//   4. temp rotation: report the stale entries of `temp/` (and archive them only with
//      --rotate-temp). `temp/` è il lavoro per-engagement — decompilati, pagine catturate,
//      cache — e su una macchina viva è la voce più grossa della workspace: senza una policy
//      cresceva finché qualcuno se ne accorgeva. Default = SOLO REPORT: una manutenzione
//      giornaliera non deve spostare dati di engagement senza una decisione. L'archiviazione
//      usa `workspace-gc.js`, che copia e verifica sha256 PRIMA di toccare la sorgente e annulla
//      se la verifica non torna (nessuna cancellazione, e un errore costa una copia, non i dati).
//      Soglia: --rotate-days N (default 7, oppure $CYBOROS_TEMP_ROTATE_DAYS).
const { env } = require('./env');
const fs = require('fs');
const path = require('path');
const TI = require('./threatintel');
const VM = require('./vendor-mirror');

const ROOT = path.join(__dirname, '..');
const FINDINGS = () => process.env.FINDINGS_JSONL || path.join(ROOT, 'reports', 'findings.jsonl');
const WATCHLIST = path.join(ROOT, 'reports', 'ti-watchlist.txt');

function cvesFromFindings() {
  const out = new Set();
  let text = '';
  try { text = fs.readFileSync(FINDINGS(), 'utf8'); } catch {}
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const f = JSON.parse(line);
      for (const c of Array.isArray(f.cves) ? f.cves : []) out.add(c);
    } catch {}
  }
  return [...out];
}

function cvesFromWatchlist() {
  let text = '';
  try { text = fs.readFileSync(WATCHLIST, 'utf8'); } catch {}
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

function reposFromManifest() {
  const seen = new Map();
  for (const e of VM.readManifest()) {
    if (!e.owner || !e.repo || !e.instance) continue;
    const slug = e.owner + '/' + e.repo;
    if (!seen.has(slug)) seen.set(slug, e.instance);
  }
  for (const slug of VM.POC_REPOS) {
    const [owner, repo] = slug.split('/');
    if (!seen.has(slug)) seen.set(slug, VM.DEFAULT_INSTANCE);
  }
  return [...seen].map(([slug, instance]) => ({ slug, instance }));
}

async function main() {
  const argv = process.argv.slice(2);
  const startedAt = new Date().toISOString();
  const report = { started_at: startedAt };

  // 1) threatintel refresh (KEV always + CVEs from findings/watchlist)
  try {
    const kev = await TI.refreshKevCatalog({});
    const cves = [...new Set([...cvesFromFindings(), ...cvesFromWatchlist()])];
    const results = cves.length ? await TI.refreshAll(cves, { delayMs: 1500 }) : [];
    report.threatintel = {
      ok: true,
      kev_catalog: kev,
      refreshed_cves: results.map((r) => ({ cve: r.cve, nvd: !!r.nvd, epss: !!r.epss, kev: r.kev ? true : false })),
    };
  } catch (e) {
    report.threatintel = { ok: false, error: e.message };
  }

  // 2) vendor mirror: re-pull pinned repos, verify hashes, rebuild the PoC index
  if (!argv.includes('--skip-vendor')) {
    try {
      const pulls = [];
      for (const { slug, instance } of reposFromManifest()) {
        const r = await VM.pull({}, slug, { instance });
        pulls.push({ repo: slug, sha: r.sha || null, cached: !!r.cached, ok: !!r.ok, error: r.error });
      }
      const verify = VM.verify();
      const index = VM.indexPoc({});
      report.vendor_mirror = { ok: verify.ok, pulls, verified: verify.checked, hash_ok: verify.ok, poc_index: index };
    } catch (e) {
      report.vendor_mirror = { ok: false, error: e.message };
    }
  }

  // 3) knowledge base index rebuild
  if (!argv.includes('--skip-kb')) {
    try {
      const KB = require('./kb-search');
      report.kb_index = KB.index({ includeReports: true });
    } catch (e) {
      report.kb_index = { ok: false, error: e.message };
    }
  }

  // 4) temp rotation (report di default; archivia solo su richiesta esplicita)
  if (!argv.includes('--skip-gc')) {
    try {
      const days = argv.includes('--rotate-days')
        ? Math.max(0, parseInt(argv[argv.indexOf('--rotate-days') + 1], 10) || ROTATE_DAYS())
        : ROTATE_DAYS();
      report.temp_rotation = rotateTemp({ apply: argv.includes('--rotate-temp'), days });
    } catch (e) {
      report.temp_rotation = { ok: false, error: e.message };
    }
  }

  report.finished_at = new Date().toISOString();
  console.log(JSON.stringify(report));
  // exit non-zero only if EVERYTHING failed — partial success still keeps the cache warm
  const allFailed = [report.threatintel, report.vendor_mirror, report.kb_index, report.temp_rotation]
    .filter(Boolean)
    .every((r) => r.ok === false);
  process.exit(allFailed ? 1 : 0);
}

const ROTATE_DAYS = () => Number(env('TEMP_ROTATE_DAYS') || 7);

// Rotazione di `temp/`: riporta le voci stantie, e le archivia solo su richiesta.
// `stale` è deciso da workspace-gc (mtime del file più recente dentro la voce, non della
// directory: una directory toccata ieri può contenere lavoro di un mese fa). I symlink sono
// esclusi per costruzione — spostarli sposterebbe un altro path.
function rotateTemp(opts) {
  const o = opts || {};
  const ws = o.ws || ROOT;
  const days = o.days != null ? o.days : ROTATE_DAYS();
  const GC = require('./workspace-gc');
  const scan = GC.scanWorkspace(ws, { days });
  const candidates = scan.candidates.filter((c) => c.root === 'temp' && c.stale && c.kind !== 'symlink');
  const planned = candidates.map((c) => ({ name: c.name, disk_bytes: c.disk_bytes, files: c.files, age_days: c.age_days }));
  if (!o.apply)
    return { ok: true, applied: false, days, candidates: planned, note: 'report only — pass --rotate-temp to archive (never deletes: copy + sha256 verify, rollback on mismatch)' };
  const archived = [];
  const failed = [];
  for (const c of candidates) {
    try {
      const r = GC.archive(ws, 'temp', c.name, {});
      archived.push({ name: c.name, to: r.to, files: r.files, bytes: r.bytes, digest: r.digest });
    } catch (e) {
      failed.push({ name: c.name, error: e && e.message ? e.message : String(e) });
    }
  }
  return { ok: failed.length === 0, applied: true, days, archived: archived.length, candidates: planned, moved: archived, failed };
}

// `main()` gira solo come CLI: prima di questa guardia un `require('./daily-maintenance')` avviava
// una manutenzione completa (refresh KEV, mirror, reindex) come effetto collaterale dell'import.
module.exports = { main, rotateTemp, cvesFromFindings, cvesFromWatchlist, reposFromManifest, ROTATE_DAYS };
if (require.main === module) main();
