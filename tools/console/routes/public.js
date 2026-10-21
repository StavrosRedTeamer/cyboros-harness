// Console — the public route family: handshake and sign-in.
//
// Why these are separate from every other route: they are the only /api endpoints
// that answer before a session exists. The handshake carries no engagement data
// (the launcher and cc-instance.js need it to find the process), and login has to be
// reachable in order to create the session everything else requires. Nothing here
// may read engagement files.
'use strict';
const { isSecureReq, clientIp } = require('../gate');

async function handle(ctx, req, res, url, query) {
  const { identity, sendJson, bodyJson } = ctx;

  if (url === '/api/health' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, version: 1, port: ctx.instance.port() });
    return true;
  }

  if (url === '/api/instance' && req.method === 'GET') {
    sendJson(res, 200, {
      instance: true, version: 1, pid: process.pid, host: ctx.instance.host, port: ctx.instance.port(),
      startedAt: ctx.instance.startedAt, tokenRequired: ctx.instance.tokenRequired,
    });
    return true;
  }

  if (url === '/api/auth/login' && req.method === 'POST') {
    const b = await bodyJson(req);
    const r = identity.login(b.username, b.password, { ip: clientIp(req), secure: isSecureReq(req) });
    if (!r.ok) {
      if (r.retryAfter) res.setHeader('Retry-After', String(r.retryAfter));
      sendJson(res, r.status || 401, { error: r.error, retryAfter: r.retryAfter || null });
      return true;
    }
    res.setHeader('Set-Cookie', r.cookie);
    sendJson(res, 200, { user: r.user, role: r.user.role });
    return true;
  }

  if (url === '/api/auth/logout' && req.method === 'POST') {
    const r = identity.logout(req, { ip: clientIp(req), secure: isSecureReq(req) });
    res.setHeader('Set-Cookie', r.cookie);
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}

module.exports = { handle };
