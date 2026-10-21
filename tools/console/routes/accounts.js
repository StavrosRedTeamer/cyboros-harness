// Console — the account route family: who am I, and user administration.
//
// Why it is its own file: these routes are the only ones that manage credentials,
// and the role rule (admin for writes) is enforced once by the gate via the
// authorization table in tools/identity.js. Every response here is about accounts,
// so replacing the identity backend should not require opening a data route.
'use strict';
const path = require('path');

async function handle(ctx, req, res, url, query, principal) {
  const { identity, sendJson, bodyJson } = ctx;

  if (url === '/api/auth/me' && req.method === 'GET') {
    sendJson(res, 200, {
      user: { username: principal.username, role: principal.role, display_name: principal.display_name || '' },
      provider: principal.provider,
      roles: identity.ROLE_NAMES,
    });
    return true;
  }

  if (url === '/api/users' && req.method === 'GET') {
    const r = identity.listUsers();
    sendJson(res, 200, {
      users: r.users,
      store: path.relative(ctx.dataRoot, identity.usersFile) || identity.usersFile,
      error: r.error || null,
    });
    return true;
  }

  if (url === '/api/users' && req.method === 'POST') {
    const b = await bodyJson(req);
    const meta = { actor: principal.username, role: principal.role };
    const r = identity.addUser(b, meta);
    sendJson(res, r.ok ? 201 : 400, r);
    return true;
  }

  const userMatch = url.match(/^\/api\/users\/([^/]+)$/);
  if (userMatch && req.method === 'POST') {
    const b = await bodyJson(req);
    const meta = { actor: principal.username, role: principal.role };
    const r = identity.updateUser(decodeURIComponent(userMatch[1]), b, meta);
    sendJson(res, r.ok ? 200 : 400, r);
    return true;
  }
  if (userMatch && req.method === 'DELETE') {
    const r = identity.removeUser(decodeURIComponent(userMatch[1]), { actor: principal.username, role: principal.role });
    sendJson(res, r.ok ? 200 : 400, r);
    return true;
  }

  return false;
}

module.exports = { handle };
