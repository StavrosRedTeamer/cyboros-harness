// Console — the request pipeline, in the order a request actually travels.
//
// Why it exists: the order IS the security model, and it was previously buried in a
// 400-line request callback. Stated once, top to bottom:
//   static shell → generated report → /api only → Host/Origin → public routes
//   → authenticate/authorize/audit → route families → 404/405
// A container start, a proxy in front, or a new route family changes one line of
// this file, and the gate can never be skipped by adding a handler.
'use strict';

function createApp(ctx) {
  return async function handle(req, res) {
    const url = req.url.split('?')[0];
    const query = Object.fromEntries(new URL(req.url, 'http://x').searchParams);
    try {
      // Static shell — public by design: it holds no data, and the login page has
      // to be reachable before there is a session. Data routes below are gated.
      if (ctx.static.serve(req, res, url, query)) return;

      // A report document is client data, so it is gated even though it is not /api.
      if (await ctx.routes.serveArtifact(ctx, req, res, url)) return;

      if (!url.startsWith('/api/')) { ctx.sendText(res, 404, 'not found'); return; }
      if (!ctx.guardOk(req)) { ctx.sendText(res, 403, 'forbidden'); return; }

      // Public API: handshake + login. Nothing below this line answers anonymously.
      if (await ctx.publicRoutes.handle(ctx, req, res, url, query)) return;

      const principal = await ctx.gate.require(req, res, url, req.method);
      if (!principal) return;   // the gate already wrote the refusal

      if (await ctx.routes.handle(ctx, req, res, url, query, principal)) return;

      if (req.method === 'GET' || req.method === 'POST' || req.method === 'DELETE') {
        ctx.sendJson(res, 404, { error: 'unknown endpoint' });
        return;
      }
      ctx.sendText(res, 405, 'method not allowed');
    } catch (e) {
      ctx.sendJson(res, 500, { error: String((e && e.message) || e) });
    }
  };
}

module.exports = { createApp };
