// Console — the findings read model.
//
// Why it is its own module: findings.jsonl is append-only engine output, and the
// console only ever folds it for display — severity rank, confidence, filters and
// the daily series for the overview sparkline. Keeping those rules here means a
// new view (or a different severity vocabulary) touches this file, not the routes.
'use strict';
const path = require('path');

const SEV_ORDER = { Critical: 5, High: 4, Medium: 3, Low: 2, Info: 1 };

function createFindings(opts) {
  const reportsDir = opts.reportsDir;
  const files = opts.files;

  function all() {
    return files.readJsonl(path.join(reportsDir, 'findings.jsonl'));
  }

  function enrich(rows) {
    let confidenceOf;
    try { confidenceOf = require('../report-html').confidenceOf; } catch { /* fallback below */ }
    return rows.map((f) => {
      const out = Object.assign({}, f);
      try {
        if (confidenceOf) out.confidence = confidenceOf(f);
      } catch { /* ignore */ }
      out.sevRank = SEV_ORDER[f.severity] || 0;
      return out;
    });
  }

  function payload(q) {
    let rows = enrich(all());
    const hosts = [...new Set(rows.map((f) => f.host).filter(Boolean))].sort();
    const query = (q && q.q || '').toString().toLowerCase();
    if (q) {
      if (q.host) rows = rows.filter((f) => String(f.host || '').includes(q.host));
      if (q.severity) rows = rows.filter((f) => f.severity === q.severity);
      if (q.status) rows = rows.filter((f) => (f.status || '') === q.status);
      if (query) rows = rows.filter((f) => [f.title, f.endpoint, f.host, f.cwe].join(' ').toLowerCase().includes(query));
    }
    rows.sort((a, b) => (b.sevRank - a.sevRank) || String(b.ts || '').localeCompare(String(a.ts || '')));
    const bySeverity = {};
    const byStatus = {};
    for (const f of rows) {
      bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
      byStatus[f.status] = (byStatus[f.status] || 0) + 1;
    }
    return { rows, hosts, bySeverity, byStatus, total: rows.length };
  }

  // findings-per-day for the overview sparkline. Read-only aggregation of the
  // findings.jsonl timestamps into a continuous daily series (UTC) ending today,
  // gaps filled with 0 so the sparkline has an even x-axis. No guard touched.
  function trend(rows, days) {
    const n = days || 14;
    const byDay = {};
    for (const f of rows) {
      if (!f || !f.ts) continue;
      const d = new Date(f.ts);
      if (Number.isNaN(d.getTime())) continue;
      const key = d.toISOString().slice(0, 10);
      byDay[key] = (byDay[key] || 0) + 1;
    }
    const out = [];
    const base = new Date();
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(base);
      d.setUTCDate(d.getUTCDate() - i);
      const key = d.toISOString().slice(0, 10);
      out.push({ day: key, count: byDay[key] || 0 });
    }
    return out;
  }

  return { all, enrich, payload, trend };
}

module.exports = { createFindings };
