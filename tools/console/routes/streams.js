// Console — the streaming route family: job event feeds and the terminal bridge.
//
// Why these routes are apart from the data routes: a streaming response never
// returns a JSON body — it owns the socket until the producer ends it. Keeping them
// in one file makes the lifecycle (open, replay, live frames, close) auditable
// without scrolling past the read models, and lets the terminal or job backend be
// replaced behind these four entry points.
'use strict';

async function handle(ctx, req, res, url, query) {
  const { sendJson, bodyJson, jobs, terminals } = ctx;

  if (req.method === 'GET') {
    if (url === '/api/jobs') { sendJson(res, 200, jobs.snapshot()); return true; }

    const jobMatch = url.match(/^\/api\/jobs\/(job\d+)\/events$/);
    if (jobMatch) {
      if (!jobs.stream(req, res, sendJson, jobMatch[1])) sendJson(res, 404, { error: 'unknown job' });
      return true;
    }

    if (url === '/api/term/status') { sendJson(res, 200, await terminals.status(query.name)); return true; }
    if (url === '/api/term/stream') {
      const st = await terminals.status(query.name);
      if (!st.available) { sendJson(res, 409, { error: st.reason || 'terminal unavailable' }); return true; }
      terminals.stream(res, query.name);
      return true;
    }
    return false;
  }

  if (req.method === 'POST') {
    if (url === '/api/term/start') {
      const body = await bodyJson(req);
      const r = await terminals.start(body.name, body);
      sendJson(res, r.ok ? 200 : 409, r);
      return true;
    }
    if (url === '/api/term/stop') {
      const body = await bodyJson(req);
      const r = await terminals.stop(body.name);
      sendJson(res, r.ok ? 200 : 409, r);
      return true;
    }
    if (url === '/api/term/input') {
      const body = await bodyJson(req);
      sendJson(res, 200, terminals.input(body.name, body.data));
      return true;
    }
    if (url === '/api/term/resize') {
      const body = await bodyJson(req);
      sendJson(res, 200, terminals.resize(body.name, body.cols, body.rows));
      return true;
    }
  }

  return false;
}

module.exports = { handle };
