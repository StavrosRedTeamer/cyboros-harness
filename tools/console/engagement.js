// Console — the engagement read model: operation state, sessions, generated
// reports, the loot count, and the overview composed from all of them.
//
// Why it is its own module: these are read-only projections of files the engine
// writes, and the overview is the one place they are combined. The route layer only
// serializes what this returns, so a new summary field is added here once and shows
// up wherever the model is used.
'use strict';
const fs = require('fs');
const path = require('path');

function createEngagement(opts) {
  const files = opts.files;
  const scope = opts.scope;
  const findings = opts.findings;
  const pipeline = opts.pipeline;
  const reportsDir = opts.reportsDir;
  const opstateFile = opts.opstateFile;
  const sessionsFile = opts.sessionsFile;
  const lootFile = opts.lootFile;
  // Describes the process that answers the request (host, port, data root), so the
  // status rail can say which tree is being served. A caller without one (unit
  // tests) gets `instance: null` and the rail simply omits the line.
  const instance = opts.instance || null;

  function loadOpstate() {
    const raw = files.readJsonFile(opstateFile, null);
    if (!raw) return null;
    const criteria = Array.isArray(raw.criteria) ? raw.criteria : [];
    return {
      mode: raw.mode || 'pentest',
      goal: raw.goal || '',
      criteria,
      criteriaMet: criteria.filter((c) => c.status === 'met').length,
      criteriaTotal: criteria.length,
      gates: raw.gates || {},
      pending: Array.isArray(raw.pending) ? raw.pending : [],
      created_at: raw.created_at, updated_at: raw.updated_at, note: raw.note || '',
    };
  }

  function sessionsPayload() {
    const raw = files.readJsonFile(sessionsFile, null);
    const map = raw && raw.sessions ? raw.sessions : {};
    const rows = Object.values(map).map((s) => ({
      id: s.id, status: s.status, host: s.host, obtained_via: s.obtained_via,
      artifacts: Array.isArray(s.artifacts) ? s.artifacts : [],
      meta: s.meta || {},
    }));
    return {
      rows,
      active: rows.filter((r) => r.status === 'active').length,
      artifactsTotal: rows.reduce((n, r) => n + r.artifacts.length, 0),
      mtime: files.fileMtime(sessionsFile),
    };
  }

  function listReports() {
    const out = [];
    let entries = [];
    try { entries = fs.readdirSync(reportsDir); } catch { return out; }
    for (const name of entries) {
      if (!/\.(html|md)$/.test(name)) continue;
      const p = path.join(reportsDir, name);
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (!st.isFile()) continue;
      let kind = 'doc';
      if (/-report\.html$/.test(name)) kind = 'report';
      else if (/^report-.*\.html$/.test(name)) kind = 'report';
      else if (/^\d{2}-.*\.md$/.test(name)) kind = 'finding';
      else if (/^00-/.test(name)) kind = 'overview';
      out.push({ name, kind, size: st.size, mtime: st.mtime.toISOString() });
    }
    out.sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
    return out.slice(0, 80);
  }

  function lootCount() {
    try { return fs.readFileSync(lootFile, 'utf8').split('\n').filter((l) => l.trim()).length; } catch { return 0; }
  }

  function overview() {
    const op = loadOpstate();
    const sc = scope.load();
    const f = findings.payload({});
    const pipe = pipeline.payload();
    const sess = sessionsPayload();
    return {
      instance: instance ? instance() : null,
      opstate: op,
      scope: {
        hosts: sc.allowed_hosts.length, prefixes: sc.allowed_url_prefixes.length,
        ips: sc.allowed_ips.length, rps: sc.max_requests_per_second, failClosed: sc.failClosed, mtime: sc.mtime,
      },
      findings: { total: f.total, bySeverity: f.bySeverity, byStatus: f.byStatus, trend: findings.trend(f.rows) },
      pipeline: {
        db: pipe.db, hasRun: !!(pipe.lastRun), lastRunStatus: pipe.lastRun ? pipe.lastRun.status : null,
        runTarget: pipe.lastRun ? pipe.lastRun.target : null,
        phases: pipe.phases || [], resumePossible: pipe.resumePossible || false,
        unclosed: pipe.unclosed || false,
      },
      sessions: { active: sess.active, artifactsTotal: sess.artifactsTotal },
      lootCount: lootCount(),
      reportsRecent: listReports().filter((r) => r.kind === 'report').slice(0, 5),
      updatedAt: new Date().toISOString(),
    };
  }

  return { loadOpstate, sessionsPayload, listReports, lootCount, overview };
}

module.exports = { createEngagement };
