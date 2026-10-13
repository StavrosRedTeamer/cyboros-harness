#!/usr/bin/env node
// Command Center — additive router for /api/cc/* (WP3..WP7, zero-dep).
//
// gui-server.js calls handle() for every /api/cc/ request AFTER its own Host/Origin + token
// guards have run, so nothing here can bypass hardening. Every write goes through the existing
// tool wrappers (run.js / workflow.js / stavros.js / budget.js / gate.js / report-html.js).
// All modules are required lazily so a plain dashboard start does not pay for node:sqlite etc.
'use strict';
const fs = require('fs');
const path = require('path');
const u = require('./cc-util');

function redact(obj) {
  if (obj == null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(redact);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object') out[k] = redact(v);
    else if (typeof v === 'string' && /(pass|secret|token|key|pwd|hash)/i.test(k)) out[k] = '<redacted:' + String(v).length + '>';
    else out[k] = v;
  }
  return out;
}

function readJson(ctx, file, fallback) {
  return u.readJson(path.join(process.env.CC_ROOT || ctx.root, file), fallback);
}

async function handle(req, res, ctx) {
  const url = ctx.url;
  const q = ctx.query || {};
  const send = ctx.sendJson;
  const body = () => ctx.bodyJson(req);
  const lazy = (m) => require('./' + m);

  // ── campaign (WP3) ────────────────────────────────────────────────────────
  if (url === '/api/cc/campaign' && req.method === 'GET') {
    const cc = lazy('cc-campaign');
    const active = cc.loadActive();
    return send(res, 200, {
      active,
      validation: active ? cc.validate(active) : null,
      drift: active ? cc.drift(active) : null,
      list: cc.listCampaigns().map((c) => ({ id: c.id, name: c.name, client: c.client, status: c.status, active: !!c._active })),
      templates: cc.listTemplates().map((t) => t.name),
    });
  }
  if (url === '/api/cc/campaign/history' && req.method === 'GET') {
    return send(res, 200, { rows: lazy('cc-campaign').history(100) });
  }
  if (url === '/api/cc/campaign/rollup' && req.method === 'GET') {
    return send(res, 200, lazy('cc-campaign').rollup());
  }
  if (url.startsWith('/api/cc/campaign/') && req.method === 'POST') {
    if (ctx.readOnly) return send(res, 403, { error: 'read-only mode' });
    const cc = lazy('cc-campaign');
    const b = await body();
    const action = url.split('/').pop();
    if (action === 'create') {
      const r = cc.fromTemplate(b.template, { client: b.client, name: b.name, id: b.id });
      if (!r.ok) return send(res, 400, r);
      return send(res, 200, r);
    }
    if (action === 'activate') {
      const r = cc.activate(b.campaign, { actor: b.actor || 'operator' });
      return send(res, r.ok ? 200 : 400, r);
    }
    if (action === 'update') {
      const patch = b.patch || {};
      const r = cc.update(b.id || null, patch, { actor: b.actor || 'operator' });
      return send(res, r.ok ? 200 : 400, r);
    }
    if (action === 'archive') {
      const r = cc.archive(b.id || null, { actor: b.actor || 'operator' });
      return send(res, r.ok ? 200 : 400, r);
    }
    if (action === 'resign') {
      const r = cc.resign(b.actor || 'operator');
      return send(res, r.ok ? 200 : 400, r);
    }
    return send(res, 404, { error: 'unknown campaign action' });
  }

  // ── approvals (WP4) ───────────────────────────────────────────────────────
  if (url === '/api/cc/approvals' && req.method === 'GET') {
    try { return send(res, 200, { rows: lazy('cc-approvals').list({ all: q.all === '1' }) }); }
    catch (e) { return send(res, 500, { error: String((e && e.message) || e) }); }
  }
  if (url.startsWith('/api/cc/approvals/') && req.method === 'POST') {
    if (ctx.readOnly) return send(res, 403, { error: 'read-only mode' });
    const A = lazy('cc-approvals');
    const b = await body();
    const action = url.split('/').pop();
    let r;
    if (action === 'request') r = A.request({ host: b.host, actionClass: b.action_class, command: b.command, reason: b.reason, by: b.by, ttl: b.ttl });
    else if (action === 'grant') r = A.grant(b.id, { actor: b.actor, note: b.note });
    else if (action === 'deny') r = A.deny(b.id, { actor: b.actor, note: b.note });
    else if (action === 'revoke') r = A.revoke(b.id, { actor: b.actor, note: b.note });
    else if (action === 'consume') r = A.consume(b.id, { host: b.host, actionClass: b.action_class, command: b.command, actor: b.actor });
    else if (action === 'expire') r = A.expire();
    else return send(res, 404, { error: 'unknown approvals action' });
    return send(res, r.ok ? 200 : 400, r);
  }
  if (url === '/api/cc/approvals/verify' && req.method === 'POST') {
    const A = lazy('cc-approvals');
    const b = await body();
    const r = A.verify(b.id, { host: b.host, actionClass: b.action_class, command: b.command });
    return send(res, r.ok ? 200 : 403, r);
  }

  // ── mission (WP5) ─────────────────────────────────────────────────────────
  if (url === '/api/cc/mission' && req.method === 'GET') {
    try { return send(res, 200, lazy('cc-mission').build()); }
    catch (e) { return send(res, 500, { error: String((e && e.message) || e) }); }
  }
  if (url === '/api/cc/dispatch' && req.method === 'POST') {
    if (ctx.readOnly) return send(res, 403, { error: 'read-only mode' });
    const mission = lazy('cc-mission');
    const b = await body();
    const spec = mission.dispatchSpec(b);
    if (!spec.ok) return send(res, 400, spec);
    // Confirm-tier requires a valid consent token; consumed on dispatch (single-use).
    if (spec.confirmTier) {
      const A = lazy('cc-approvals');
      const scope = lazy('scope-guard').loadScope();
      const command = b.command || spec.argv.join(' ');
      const v = A.requireToken(scope, { id: b.approval || spec.approval, host: spec.host || b.host, command });
      if (!v.ok) return send(res, 403, { error: v.reason, approvalRequired: true });
      if (spec.approval || b.approval) A.consume(spec.approval || b.approval, { host: spec.host || b.host, actor: 'app', command });
    }
    const name = String(b.name || path.basename(spec.argv[0], '.js')).slice(0, 40);
    const id = ctx.runJob(name, spec.argv, {});
    return send(res, 202, { jobId: id, argv: spec.argv, tier: spec.confirmTier ? 'confirm' : 'auto' });
  }

  // ── ledger / graph / coverage (WP6) ───────────────────────────────────────
  if (url === '/api/cc/ledger' && req.method === 'GET') {
    try { return send(res, 200, lazy('cc-ledger').build({ tail: parseInt(q.tail, 10) || 200 })); }
    catch (e) { return send(res, 500, { error: String((e && e.message) || e) }); }
  }
  if (url === '/api/cc/ledger/chain' && req.method === 'GET') {
    const c = lazy('cc-ledger').chain();
    return send(res, c.ok ? 200 : 409, c);
  }
  if (url === '/api/cc/ledger/evidence' && req.method === 'POST') {
    if (ctx.readOnly) return send(res, 403, { error: 'read-only mode' });
    const b = await body();
    return send(res, 200, lazy('cc-ledger').evidenceBundle({ outFile: b.out }));
  }
  if (url === '/api/cc/ledger/export-pdf' && req.method === 'POST') {
    if (ctx.readOnly) return send(res, 403, { error: 'read-only mode' });
    const b = await body();
    const r = lazy('cc-ledger').exportPdf(b.src, b.out);
    return send(res, r.ok ? 200 : 500, r);
  }
  if (url === '/api/cc/graph' && req.method === 'GET') {
    try { return send(res, 200, lazy('cc-graph').build()); }
    catch (e) { return send(res, 500, { error: String((e && e.message) || e) }); }
  }
  if (url === '/api/cc/coverage' && req.method === 'GET') {
    try { return send(res, 200, lazy('cc-coverage').build()); }
    catch (e) { return send(res, 500, { error: String((e && e.message) || e) }); }
  }

  // ── 360° control (WP7) — read-mostly, all through existing modules ─────────
  if (url === '/api/cc/config' && req.method === 'GET') {
    return send(res, 200, {
      scope: readJson(ctx, 'scope.json', null),
      auth: redact(readJson(ctx, 'auth.json', null)),
      wifi_scope: readJson(ctx, 'wifi-scope.json', null),
      mobile_scope: readJson(ctx, 'mobile-scope.json', null),
      c2: redact(readJson(ctx, 'c2.json', null)),
    });
  }
  if (url === '/api/cc/config/validate' && req.method === 'POST') {
    const b = await body();
    const kind = String(b.kind || 'scope');
    const content = b.content;
    const problems = [];
    if (kind === 'scope') {
      if (!content || typeof content !== 'object') problems.push('scope must be an object');
      else {
        try {
          const sg = lazy('scope-guard');
          const norm = sg.normalizeScope(content);
          if (!(norm.allowed_hosts.length + norm.allowed_url_prefixes.length + norm.allowed_ips.length)) problems.push('scope is empty (fail-closed: nothing authorized)');
        } catch (e) { problems.push(String((e && e.message) || e)); }
      }
    } else if (!content || typeof content !== 'object') {
      problems.push(kind + ' must be an object');
    }
    return send(res, 200, { ok: problems.length === 0, problems });
  }
  if (url === '/api/cc/team' && req.method === 'GET') {
    const r = u.runToolJson([path.join('tools', 'fleet.js'), 'plan']);
    return send(res, r.json ? 200 : 500, r.json || { error: 'fleet plan failed', raw: (r.raw || '').slice(0, 400) });
  }
  if (url === '/api/cc/arsenal' && req.method === 'GET') {
    const plane = u.runToolJson([path.join('tools', 'tool-plane.js'), 'table']);
    const doctor = u.runToolJson([path.join('tools', 'doctor.js'), '--json']);
    // One doctor call feeds both the legacy `doctor` block and the structured inventory.
    const inventory = doctor.json ? lazy('cc-arsenal').build({ doctor: doctor.json }) : lazy('cc-arsenal').build();
    return send(res, 200, {
      tool_plane: plane.json || { raw: (plane.raw || '').slice(0, 400) },
      doctor: doctor.json || null,
      inventory,
    });
  }
  // Install / plan the missing tooling. The argv comes from the module (fixed), never from
  // the request; the typed confirmation is enforced here, not only in the UI.
  if (url === '/api/cc/arsenal/install' && req.method === 'POST') {
    if (ctx.readOnly) return send(res, 403, { error: 'read-only mode' });
    const A = lazy('cc-arsenal');
    const b = await body();
    const mode = b.mode === 'plan' ? 'plan' : b.mode === 'run' ? 'run' : null;
    if (!mode) return send(res, 400, { error: "mode must be 'plan' or 'run'", hint: 'POST {"mode":"plan"|"run","confirm":"' + A.CONFIRM_PHRASE + '"}' });
    // A read-only preview needs no confirmation; installing does, and it is checked HERE.
    if (mode === 'run') {
      const conf = A.confirmOk(b.confirm);
      if (!conf.ok) return send(res, 400, { error: conf.error, expected: conf.expected, hint: 'type ' + A.CONFIRM_PHRASE + ' in the Arsenal tab, then press install' });
    }
    const spec = A.installSpec(mode);
    if (!spec.ok) return send(res, 400, spec);
    const id = ctx.runJob('arsenal-install', spec.argv, {});
    return send(res, 202, { jobId: id, argv: spec.argv, mode, confirm_phrase: A.CONFIRM_PHRASE });
  }
  if (url === '/api/cc/knowledge' && req.method === 'GET') {
    if (!q.q) return send(res, 400, { error: 'missing ?q=' });
    const r = u.runTool([path.join('tools', 'kb-search.js'), String(q.q)], { timeoutMs: 15000 });
    return send(res, r.ok ? 200 : 500, { query: q.q, stdout: r.stdout, error: r.ok ? null : (r.stderr || '').slice(0, 400) });
  }
  if (url === '/api/cc/radar' && req.method === 'GET') {
    try { return send(res, 200, { cache: lazy('radar').loadCache(), egress: 'github.com (declared)' }); }
    catch (e) { return send(res, 500, { error: String((e && e.message) || e) }); }
  }
  if (url === '/api/cc/doctor' && req.method === 'GET') {
    const r = u.runToolJson([path.join('tools', 'doctor.js'), '--json']);
    return send(res, r.json ? 200 : 500, r.json || { error: 'doctor failed', raw: (r.raw || '').slice(0, 400) });
  }

  // ── war room (WP10) — board live read-only + panic ─────────────────────────
  if (url === '/api/cc/warroom' && req.method === 'GET') {
    try {
      return send(res, 200, lazy('cc-warroom').build({
        jobs: typeof ctx.jobs === 'function' ? ctx.jobs() : [],
        tail: parseInt(q.tail, 10) || 120,
      }));
    } catch (e) { return send(res, 500, { error: String((e && e.message) || e) }); }
  }
  // Kill switch: esegue SOLO cc-panic.js (processi registrati + PTY bridge di questo
  // workspace). La conferma tipizzata è verificata qui, non solo nella UI.
  if (url === '/api/cc/warroom/panic' && req.method === 'POST') {
    if (ctx.readOnly) return send(res, 403, { error: 'read-only mode' });
    const b = await body();
    if (String(b.confirm || '').trim().toUpperCase() !== 'PANIC') {
      return send(res, 400, { error: 'type PANIC to confirm', expected: 'PANIC' });
    }
    const r = u.runToolJson([path.join('tools', 'cc-panic.js'), '--json'], { timeoutMs: 20000 });
    return send(res, r.json ? 200 : 500, r.json || { error: 'panic failed', raw: (r.raw || '').slice(0, 400) });
  }
  // Focus host della board: scrive SOLO campaign.host (via cc-campaign.update, che valida e
  // scrive lo storico). `host: null`/'' toglie il focus e la board torna sullo scope intero.
  if (url === '/api/cc/warroom/focus' && req.method === 'POST') {
    if (ctx.readOnly) return send(res, 403, { error: 'read-only mode' });
    const b = await body();
    const W = lazy('cc-warroom');
    if (!lazy('cc-campaign').loadActive()) return send(res, 400, { error: 'no active campaign to focus' });
    const host = W.normalizeHost(b.host);
    const r = lazy('cc-campaign').update(null, { host });
    if (!r.ok) return send(res, 400, { error: r.error || 'update failed', validation: r.validation || null });
    return send(res, 200, W.build({ jobs: typeof ctx.jobs === 'function' ? ctx.jobs() : [] }));
  }

  return false;
}

module.exports = { handle, redact };
