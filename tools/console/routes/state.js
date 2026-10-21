// Console — the state route family: engagement data, pipeline actions, and the
// generated report HTML served for in-browser viewing.
//
// Why it is one file: every route here is a projection of engine-written state, or a
// write that goes through an existing tool wrapper. Adding a view means adding one
// branch here and one method to the read model it calls; the transport, the gate and
// the streaming side are elsewhere.
'use strict';
const fs = require('fs');
const path = require('path');

async function handle(ctx, req, res, url, query, principal) {
  const { sendJson, bodyJson, engagement, findings, scope, pipeline, jobs } = ctx;

  if (req.method === 'GET') {
    if (url === '/api/overview') { sendJson(res, 200, engagement.overview()); return true; }
    if (url === '/api/findings') { sendJson(res, 200, findings.payload(query)); return true; }
    if (url === '/api/scope') { sendJson(res, 200, scope.load()); return true; }
    if (url === '/api/scope/check') {
      const u = query.url || '';
      if (!u) { sendJson(res, 400, { error: 'missing ?url=' }); return true; }
      sendJson(res, 200, scope.check(u));
      return true;
    }
    if (url === '/api/pipeline') { sendJson(res, 200, pipeline.payload()); return true; }
    if (url === '/api/sessions') { sendJson(res, 200, engagement.sessionsPayload()); return true; }
    if (url === '/api/loot/count') {
      sendJson(res, 200, { count: engagement.lootCount(), note: 'loot.jsonl rows are never shown (secrets)' });
      return true;
    }
    if (url === '/api/reports') { sendJson(res, 200, engagement.listReports()); return true; }
    return false;
  }

  if (req.method === 'POST') {
    if (url === '/api/scope') {
      const body = await bodyJson(req);
      const r = scope.save(body, principal.username);
      sendJson(res, r.ok ? 200 : 400, r);
      return true;
    }
    if (url === '/api/pipeline/resume') {
      // the engine lives with the code, the engagement data with the config:
      // absolute script path, cwd = data root.
      const id = jobs.run('resume', [path.join(ctx.toolsDir, 'cyboros.js'), 'resume']);
      sendJson(res, 202, { jobId: id });
      return true;
    }
    const closeRunMatch = url.match(/^\/api\/pipeline\/runs\/(\d+)\/close$/);
    if (closeRunMatch) {
      const r = pipeline.closeRun(Number(closeRunMatch[1]));
      sendJson(res, r.ok ? 200 : 404, r);
      return true;
    }
    if (url === '/api/reports/generate') {
      const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 14);
      const outName = 'report-' + stamp + '.html';
      // Absolute, under the CONFIGURED reports directory: a job runs with cwd = data
      // root, but reports need not be `<root>/reports` (paths.reports is a setting).
      const outFile = path.join(ctx.reportsDir, outName);
      const id = jobs.run('report-html', [path.join(ctx.toolsDir, 'report-html.js'), '--out', outFile], { out: '/reports/' + outName });
      sendJson(res, 202, { jobId: id });
      return true;
    }
    return false;
  }

  if (req.method === 'DELETE') {
    const delRunMatch = url.match(/^\/api\/pipeline\/runs\/(\d+)$/);
    if (delRunMatch) {
      const r = pipeline.deleteRun(Number(delRunMatch[1]));
      sendJson(res, r.ok ? 200 : 404, r);
      return true;
    }
  }

  return false;
}

// A generated report IS client data: viewer role or above, same rule as any other
// read. Handled before the /api prefix check because the URL is a document, not an
// API call — but the authorization decision is the data one (/api/reports).
async function serveArtifact(ctx, req, res, url) {
  const m = url.match(/^\/reports\/([^/]+)$/);
  if (!m) return false;
  if (!ctx.guardOk(req)) { ctx.sendText(res, 403, 'forbidden'); return true; }
  const principal = await ctx.gate.require(req, res, url, 'GET', '/api/reports');
  if (!principal) return true;
  const name = m[1];
  if (!/\.html$/.test(name) || name.includes('..')) { ctx.sendText(res, 404, 'not found'); return true; }
  const p = path.join(ctx.reportsDir, name);
  if (!fs.existsSync(p)) { ctx.sendText(res, 404, 'not found'); return true; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  fs.createReadStream(p).pipe(res);
  return true;
}

module.exports = { handle, serveArtifact };
