#!/usr/bin/env node
// WP6 — Coverage: matrice classi per host (coverage-loop) + matrice ATT&CK (attack-coverage).
//
// Read-only: entrambi i moduli sono misure, non esecutori. La vista Coverage della SPA mostra
// i gap e le tecniche eseguite; i numeri coincidono con l'output CLI perché sono gli stessi moduli.
//
// CLI: node tools/cc-coverage.js [--json]
'use strict';
const path = require('path');
const u = require('./cc-util');

function hostsCoverage() {
  try {
    const tm = require('./target-model');
    const cl = require('./coverage-loop');
    const db = tm.open();
    try { return cl.gapsFromDb(db, {}); }
    finally { if (db && typeof db.close === 'function') db.close(); }
  } catch (e) { return { error: String((e && e.message) || e), rows: [] }; }
}

function attackCoverage() {
  const r = u.runToolJson([path.join('tools', 'attack-coverage.js'), '--json']);
  if (!r.json) return { error: 'attack-coverage unavailable', raw: (r.raw || '').slice(0, 400) };
  return r.json;
}

function build() {
  const cov = hostsCoverage();
  const rows = Array.isArray(cov) ? cov : [];
  const attack = attackCoverage();
  return {
    generated_at: u.nowIso(),
    hosts: rows,
    remaining: rows.reduce((n, r) => n + (r.gaps ? r.gaps.length : 0), 0),
    attack: {
      planned: attack.plannedTechniques != null ? attack.plannedTechniques : null,
      executed: attack.executedTechniques != null ? attack.executedTechniques : null,
      covered: attack.covered != null ? attack.covered : null,
      rows: attack.rows || [],
      error: attack.error || null,
    },
  };
}

if (require.main === module) console.log(JSON.stringify(build(), null, 2));

module.exports = { build };
