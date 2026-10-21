// Console — the single authorization choke point.
//
// Why it is one module: every /api request except the public handshake and
// login/logout passes through here before any handler runs — authenticate, then
// authorize by role, then audit. Handlers receive a principal and never see a
// credential, so swapping the identity backend changes this file and nothing else.
// Refusals have one shape, so a client can tell "log in" (401) from "your role is
// too low" (403) without parsing a message.
'use strict';

function isSecureReq(req) {
  return !!(req.socket && req.socket.encrypted) || String(req.headers['x-forwarded-proto'] || '') === 'https';
}

function clientIp(req) {
  return String((req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '-');
}

function denyAuth(sendJson, res, decision, principal) {
  return sendJson(res, decision.status, {
    error: decision.error,
    authRequired: !!decision.authRequired,
    role: principal ? principal.role : null,
    need: decision.need,
  });
}

function createGate(opts) {
  const identity = opts.identity;
  const sendJson = opts.sendJson;

  // Returns the authenticated principal, or null after having answered the request.
  // `authzPath` exists because the generated-report route is judged by the data rule
  // (/api/reports) while the URL on the wire is /reports/<file>.
  async function requirePrincipal(req, res, url, method, authzPath) {
    const principal = await identity.authenticate(req);
    const decision = identity.authorize(principal, authzPath || url, method);
    if (!decision.ok) {
      identity.audit({
        event: 'access.denied',
        actor: principal ? principal.username : 'anonymous',
        role: principal ? principal.role : null,
        provider: principal ? principal.provider : 'none',
        outcome: 'deny', ip: clientIp(req),
        detail: `${method} ${url} (requires ${decision.need})`,
      });
      denyAuth(sendJson, res, decision, principal);
      return null;
    }
    const isMutation = method === 'POST' || method === 'DELETE';
    if (isMutation) {
      identity.audit({
        event: 'console.write', actor: principal.username, role: principal.role,
        provider: principal.provider, outcome: 'allow', ip: clientIp(req),
        detail: `${method} ${url}`,
      });
    }
    return principal;
  }

  return { require: requirePrincipal };
}

module.exports = { createGate, isSecureReq, clientIp };
