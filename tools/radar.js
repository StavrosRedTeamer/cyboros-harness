#!/usr/bin/env node
'use strict';
// tools/radar.js — Stavros Radar: CLI orchestrator e report generator.
// Pipeline: profile -> scout -> analyze (OmniRoute) -> report md/json -> cache.
//
// Comandi:
//   node tools/radar.js run      esegue l'intera pipeline
//   node tools/radar.js profile  stampa l'inventario delle capacità locali
//   node tools/radar.js status   mostra lo stato della cache (repos visti, ultimo scan)
//
// Output: reports/radar/radar-YYYY-MM-DD.md|.json e reports/radar/cache.json

const fs = require('node:fs');
const path = require('node:path');
const { profileCodebase } = require('./radar-profiler.js');
const { scoutRepositories } = require('./radar-scout.js');
const { analyzeCandidates } = require('./radar-analyst.js');

const ROOT_DIR = path.resolve(__dirname, '..');
const RADAR_DIR = path.join(ROOT_DIR, 'reports', 'radar');
const CACHE_FILE = path.join(RADAR_DIR, 'cache.json');

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    }
  } catch { /* cache corrotta: riparti da zero */ }
  return { seen: {}, lastScan: null };
}

function saveCache(cache) {
  fs.mkdirSync(RADAR_DIR, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
}

/**
 * Genera il report markdown umano-leggibile.
 * @param {object} profile CapabilityProfile
 * @param {object[]} proposals AnalyzedProposal[]
 * @param {string} [dateStr]
 * @returns {string}
 */
const EFFORT_RANK = { LOW: 0, MEDIUM: 1, HIGH: 2 };

function generateMarkdownReport(profile, proposals, dateStr = new Date().toISOString().split('T')[0]) {
  let md = `# Stavros Radar Intelligence Report — ${dateStr}\n\n`;
  md += `> **Ecosystem Scanner & Capability Scout**\n`;
  md += `> Baseline: ${profile.agents.length} agenti, ${profile.tools.length} tool, ${profile.categories.length} categorie coperte.\n\n`;

  const accepted = proposals
    .filter(p => p.relevant !== false)
    .sort((a, b) =>
      (EFFORT_RANK[a.riskEffort] ?? 1) - (EFFORT_RANK[b.riskEffort] ?? 1) ||
      (b.stars || 0) - (a.stars || 0)
    );
  const rejected = proposals.filter(p => p.relevant === false);

  if (proposals.length === 0) {
    md += `*Nessuna nuova proposta rilevante identificata in questa sessione. La cache è aggiornata.*\n`;
    return md;
  }

  // Riepilogo dei gap per categoria (gap analysis sintetica)
  const catCounts = {};
  for (const p of accepted) {
    const cat = p.category || 'General';
    catCounts[cat] = (catCounts[cat] || 0) + 1;
  }
  const summary = Object.entries(catCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, n]) => `${n}× ${cat}`)
    .join(', ');
  if (accepted.length > 0) {
    md += `> **Gap coperti**: ${summary} — raccomandazione principale: \`${accepted[0].name}\` (priorità ${accepted[0].priority ?? 'N/A'}, sforzo ${accepted[0].riskEffort}).\n\n`;
  }

  if (accepted.length > 0) {
    md += `## Proposte di Potenziamento Selezionate (${accepted.length})\n\n`;
    for (const p of accepted) {
      md += `### [${p.name}](${p.htmlUrl}) ⭐ ${p.stars || 'N/A'}\n`;
      md += `- **Ambito/Categoria**: \`${p.category || 'General'}\`\n`;
      md += `- **Strategia**: \`${p.integrationStrategy}\` | **Sforzo**: \`${p.riskEffort}\` | **Priorità**: \`${p.priority ?? 'N/A'}\` | **Fonte**: \`${p.source}\`\n`;
      md += `- **Gap Colmato**: ${p.gapFilled}\n`;
      md += `- **Ricetta di Integrazione**: ${p.integrationRecipe}\n\n`;
    }
  }

  if (rejected.length > 0) {
    md += `## Valutati ma non raccomandati (${rejected.length})\n\n`;
    for (const p of rejected) {
      md += `- **[${p.name}](${p.htmlUrl})** ⭐ ${p.stars || 'N/A'} — ${p.gapFilled}\n`;
    }
    md += `\n`;
  }

  md += `---\n*Generato automaticamente da Stavros Radar via OmniRoute.*\n`;
  return md;
}

/**
 * Esegue l'intera pipeline (profile -> scout -> analyze -> report -> cache).
 * @param {{rootDir?: string, fetcher?: Function, githubToken?: string, queries?: string[], limit?: number}} opts
 */
async function runRadar(opts = {}) {
  const rootDir = opts.rootDir || ROOT_DIR;
  const cache = loadCache();

  console.log('[Radar] Profilazione della codebase StavrosRedTeamer...');
  const profile = profileCodebase(rootDir);
  console.log(`[Radar] Profilati ${profile.agents.length} agenti e ${profile.tools.length} tool in ${profile.categories.length} categorie.`);

  console.log('[Radar] Scansione nuovi repository su GitHub...');
  const candidates = await scoutRepositories(cache, opts);
  console.log(`[Radar] Trovati ${candidates.length} candidati qualificati non ancora analizzati.`);

  if (candidates.length === 0) {
    console.log('[Radar] Nessun nuovo candidato da valutare.');
    return { profile, proposals: [] };
  }

  console.log('[Radar] Analisi gap e strategie di integrazione via OmniRoute...');
  const proposals = await analyzeCandidates(profile, candidates, opts);

  const dateStr = new Date().toISOString().split('T')[0];
  const reportMd = generateMarkdownReport(profile, proposals, dateStr);

  fs.mkdirSync(RADAR_DIR, { recursive: true });
  const mdPath = path.join(RADAR_DIR, `radar-${dateStr}.md`);
  const jsonPath = path.join(RADAR_DIR, `radar-${dateStr}.json`);

  fs.writeFileSync(mdPath, reportMd, 'utf8');
  fs.writeFileSync(jsonPath, JSON.stringify({ date: dateStr, profile, proposals }, null, 2), 'utf8');

  // Aggiorna cache
  cache.lastScan = new Date().toISOString();
  for (const c of candidates) {
    cache.seen[c.id] = dateStr;
  }
  saveCache(cache);

  console.log(`\n✔ Report generato con successo:`);
  console.log(`  📄 Markdown: ${mdPath}`);
  console.log(`  📊 JSON:     ${jsonPath}`);

  return { profile, proposals, mdPath, jsonPath };
}

// CLI handler
if (require.main === module) {
  const cmd = process.argv[2] || 'run';
  if (cmd === 'profile') {
    const prof = profileCodebase(ROOT_DIR);
    console.log(JSON.stringify(prof, null, 2));
  } else if (cmd === 'status') {
    const cache = loadCache();
    const seenCount = Object.keys(cache.seen || {}).length;
    console.log('Stavros Radar Status:');
    console.log(`- Progetti archiviati in cache: ${seenCount}`);
    console.log(`- Ultima scansione: ${cache.lastScan || 'Mai eseguita'}`);
  } else {
    runRadar().catch(err => {
      console.error('[Radar Error]', err);
      process.exit(1);
    });
  }
}

module.exports = { loadCache, saveCache, generateMarkdownReport, runRadar };