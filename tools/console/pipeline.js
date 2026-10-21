// Console — the deterministic pipeline state (reports/state.db).
//
// Why it is its own module: this is the only place the console speaks SQL, opens the
// database read-only for the dashboard and writes two narrow things (close a stale
// run, delete a junk run). Isolating it keeps node:sqlite optional — a clone without
// it still serves every other view — and gives the run lifecycle one owner.
'use strict';
const fs = require('fs');

function createPipeline(opts) {
  const stateDb = opts.stateDb;

  // Only the module require is optional (older Node); a corrupt database is a real
  // error and must surface as one, not be relabelled "unavailable".
  function sqlite() {
    return require('node:sqlite').DatabaseSync;
  }

  function payload() {
    if (!fs.existsSync(stateDb)) return { db: false };
    let DatabaseSync;
    try { DatabaseSync = sqlite(); } catch { return { db: false, error: 'node:sqlite unavailable (node >= 22.5 required)' }; }
    const db = new DatabaseSync(stateDb, { readOnly: true });
    try {
      const lastRun = db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 1').get() || null;
      const phases = lastRun ? db.prepare('SELECT * FROM phases WHERE run_id = ? ORDER BY id').all(lastRun.id) : [];
      const runs = db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 8').all();
      const targets = db.prepare('SELECT * FROM targets ORDER BY last_seen DESC LIMIT 60').all().map((t) => {
        const hostRows = db.prepare('SELECT id FROM hosts WHERE target_id = ?').all(t.id);
        let ports = 0;
        for (const h of hostRows) ports += db.prepare('SELECT COUNT(*) c FROM ports WHERE host_id = ?').get(h.id).c;
        const endpoints = db.prepare('SELECT COUNT(*) c FROM endpoints WHERE target_id = ?').get(t.id).c;
        return {
          host: t.host, first_seen: t.first_seen, last_seen: t.last_seen,
          hosts: hostRows.length, ports, endpoints,
        };
      });
      // A run is genuinely resumable only when there is unfinished work:
      // - a phase is still running/failed/pending, or
      // - the recorded done phases form a prefix of the pipeline order
      //   (recon → scan → enumerate). A single-phase `scan` run whose scan is
      //   done is NOT incomplete — it was a deliberate standalone command.
      //   `fuzz` is deliberate (never auto-resumed), so it never counts.
      const AUTO_PHASES = ['recon', 'scan', 'enumerate'];
      const doneNames = new Set(phases.filter((p) => p.status === 'done').map((p) => p.name));
      const hasOpenWork = phases.some((p) => p.status === 'running' || p.status === 'failed' || p.status === 'pending');
      let gap = false;
      let prefixOk = true;
      for (const name of AUTO_PHASES) {
        if (doneNames.has(name)) { if (gap) { prefixOk = false; break; } }
        else gap = true;
      }
      const resumePossible = !!(lastRun && lastRun.status !== 'done' && (hasOpenWork || prefixOk));
      // run finished its recorded phases but the process never closed it (status stuck at 'running')
      const unclosed = !!(lastRun && lastRun.status === 'running' && phases.length > 0 && !resumePossible
        && phases.every((p) => p.status === 'done' || p.status === 'failed'));
      return { db: true, lastRun, phases, runs, targets, resumePossible, unclosed };
    } finally { db.close(); }
  }

  function deleteRun(id) {
    if (!fs.existsSync(stateDb)) return { ok: false, error: 'no state.db yet' };
    let DatabaseSync;
    try { DatabaseSync = sqlite(); } catch { return { ok: false, error: 'node:sqlite unavailable' }; }
    const db = new DatabaseSync(stateDb);
    try {
      const run = db.prepare('SELECT id FROM runs WHERE id = ?').get(id);
      if (!run) return { ok: false, error: 'run not found' };
      db.prepare('DELETE FROM phases WHERE run_id = ?').run(id);
      db.prepare('DELETE FROM runs WHERE id = ?').run(id);
      return { ok: true, removed: id };
    } finally { db.close(); }
  }

  function closeRun(id) {
    if (!fs.existsSync(stateDb)) return { ok: false, error: 'no state.db yet' };
    let DatabaseSync;
    try { DatabaseSync = sqlite(); } catch { return { ok: false, error: 'node:sqlite unavailable' }; }
    const db = new DatabaseSync(stateDb);
    try {
      const run = db.prepare('SELECT id FROM runs WHERE id = ?').get(id);
      if (!run) return { ok: false, error: 'run not found' };
      db.prepare('UPDATE runs SET finished_at = ?, status = ? WHERE id = ?').run(new Date().toISOString(), 'done', id);
      return { ok: true, closed: id };
    } finally { db.close(); }
  }

  return { payload, deleteRun, closeRun };
}

module.exports = { createPipeline };
