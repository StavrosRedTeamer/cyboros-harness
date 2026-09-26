#!/usr/bin/env node
// WP6 — Graph: proiezione read-only del target-model (reports/state.db) in nodi/archi.
//
// Non apre scritture su state.db (target-model.open è read-only rispetto al modello: nessuna
// tabella viene alterata) e non tocca scope/guard. Serve la vista Graph della SPA: target →
// host → porta/endpoint → vulnerabilità, con i finding collegabili.
//
// CLI: node tools/cc-graph.js [--json]   (env STATE_DB)
'use strict';
const u = require('./cc-util');

function build() {
  let snap = { targets: [] };
  try {
    const tm = require('./target-model');
    const db = tm.open();
    try { snap = tm.snapshot(db); }
    finally { if (db && typeof db.close === 'function') db.close(); }
  } catch (e) {
    return { nodes: [], edges: [], counts: {}, error: String((e && e.message) || e) };
  }
  const nodes = [];
  const edges = [];
  const push = (n) => { nodes.push(n); return n.id; };
  const link = (from, to, kind) => edges.push({ from, to, kind });

  for (const t of (snap.targets || [])) {
    const tid = push({ id: 'target:' + t.host, kind: 'target', label: t.host, host: t.host });
    for (const h of (t.hosts || [])) {
      const hid = push({ id: 'host:' + h.host, kind: 'host', label: h.host, host: h.host, state: h.state || null });
      link(tid, hid, 'contains');
      for (const p of (h.ports || [])) {
        const pid = push({ id: `port:${h.host}:${p.port}`, kind: 'port', label: String(p.port), host: h.host, port: p.port, service: p.service || null, state: p.state || null });
        link(hid, pid, 'exposes');
      }
    }
    for (const e of (t.endpoints || [])) {
      const eid = push({ id: 'endpoint:' + e.url, kind: 'endpoint', label: e.url, host: t.host, url: e.url, status: e.status || null });
      link('host:' + (e.host || t.host), eid, 'serves');
    }
    (t.vulns || []).forEach((v, i) => {
      const vid = push({ id: `vuln:${t.host}:${v.template_id || v.class}:${i}`, kind: 'vuln', label: v.name || v.template_id || v.class, host: t.host, class: v.class, severity: v.severity || null, url: v.url || null });
      if (v.url && nodes.some((n) => n.id === 'endpoint:' + v.url)) link('endpoint:' + v.url, vid, 'affected_by');
      else link('host:' + t.host, vid, 'affected_by');
    });
  }
  // Drop edges whose endpoints are not materialized (e.g. endpoint host without a host node).
  const ids = new Set(nodes.map((n) => n.id));
  const clean = edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  const counts = {};
  for (const n of nodes) counts[n.kind] = (counts[n.kind] || 0) + 1;
  return { nodes, edges: clean, counts, targets: (snap.targets || []).length };
}

if (require.main === module) {
  console.log(JSON.stringify(build(), null, 2));
}

module.exports = { build };
