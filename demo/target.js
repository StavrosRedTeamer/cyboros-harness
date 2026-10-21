#!/usr/bin/env node
// demo/target.js — a deliberately vulnerable, loopback-only target for the live demo.
//
// Synthetic data, no persistence, no external network. Two real flaws on purpose:
//   · GET /api/users/:id          no authorization at all (IDOR)
//   · GET /api/orders/:id         checks that X-User exists, not that it owns the order (BOLA)
//   · GET /search?q=              reflects the query unescaped (reflected XSS)
//
// The point is not the bugs; it is watching the agent find them through the guarded
// tools and record a finding that quotes the exact request/response.
//
//   node demo/target.js            # http://127.0.0.1:8788
//   PORT=9000 node demo/target.js
//
// Test-only export: createServer() lets the suite bind an ephemeral port.
'use strict';

const http = require('node:http');
const { URL } = require('node:url');

const USERS = {
  1: { id: 1, username: 'alice', name: 'Alice Demo', email: 'alice@demo.example', role: 'admin', tenant: 'acme' },
  2: { id: 2, username: 'bob', name: 'Bob Demo', email: 'bob@demo.example', role: 'user', tenant: 'acme' },
  3: { id: 3, username: 'carol', name: 'Carol Demo', email: 'carol@other.example', role: 'user', tenant: 'globex' },
};

const ORDERS = {
  42: { id: 42, owner: 'alice', tenant: 'acme', item: 'Debug laptop', total: 129900, card_last4: '4242', status: 'shipped' },
  43: { id: 43, owner: 'bob', tenant: 'acme', item: 'USB hub', total: 2990, card_last4: '1881', status: 'processing' },
  44: { id: 44, owner: 'carol', tenant: 'globex', item: 'Monitor', total: 49900, card_last4: '9001', status: 'pending' },
};

function userByHeader(req) {
  const name = String(req.headers['x-user'] || '').trim().toLowerCase();
  return Object.values(USERS).find((u) => u.username === name) || null;
}

function json(res, status, obj, extra = {}) {
  const body = JSON.stringify(obj, null, 2) + '\n';
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-demo-target': 'cyboros',
    ...extra,
  });
  res.end(body);
}

function html(res, status, body) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-demo-target': 'cyboros',
  });
  res.end(body);
}

function page() {
  return `<!doctype html>
<html lang="en"><meta charset="utf-8"><title>Cyboros demo shop</title>
<h1>Cyboros demo shop</h1>
<p>Synthetic catalogue for a local, authorized lab run.</p>
<ul>
  <li><a href="/api/users">/api/users</a> — public user directory</li>
  <li><a href="/api/users/1">/api/users/1</a> — profile</li>
  <li><a href="/api/users/2">/api/users/2</a> — profile</li>
  <li><a href="/api/orders/42">/api/orders/42</a> — order (send <code>X-User: alice</code>)</li>
  <li><a href="/api/orders/43">/api/orders/43</a> — order (send <code>X-User: bob</code>)</li>
  <li><a href="/search?q=hello">/search?q=hello</a> — search</li>
  <li><a href="/health">/health</a></li>
</ul>
<p>Identities for the access-control pass: <code>alice</code>, <code>bob</code>, <code>carol</code>.</p>
</html>
`;
}

function createServer() {
  return http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    } catch {
      return json(res, 400, { error: 'bad_request' });
    }
    const method = String(req.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      return json(res, 405, { error: 'method_not_allowed' }, { allow: 'GET, HEAD' });
    }
    const path = url.pathname;

    if (path === '/' || path === '/index.html') return html(res, 200, page());
    if (path === '/health') return json(res, 200, { ok: true, service: 'cyboros-demo-shop' });

    if (path === '/api/users') {
      return json(res, 200, Object.values(USERS).map((u) => ({ id: u.id, username: u.username, name: u.name })));
    }
    const userMatch = path.match(/^\/api\/users\/(\d+)$/);
    if (userMatch) {
      const user = USERS[Number(userMatch[1])];
      if (!user) return json(res, 404, { error: 'user_not_found' });
      // VULN: no authorization check — any caller reads any profile.
      return json(res, 200, user);
    }

    if (path === '/api/orders') {
      const caller = userByHeader(req);
      if (!caller) return json(res, 401, { error: 'x_user_required', hint: 'send X-User: alice|bob|carol' });
      // VULN: lists every tenant's orders instead of the caller's.
      return json(res, 200, Object.values(ORDERS).map((o) => ({
        id: o.id, owner: o.owner, item: o.item, total: o.total, status: o.status,
      })));
    }
    const orderMatch = path.match(/^\/api\/orders\/(\d+)$/);
    if (orderMatch) {
      const caller = userByHeader(req);
      if (!caller) return json(res, 401, { error: 'x_user_required', hint: 'send X-User: alice|bob|carol' });
      const order = ORDERS[Number(orderMatch[1])];
      if (!order) return json(res, 404, { error: 'order_not_found' });
      // VULN: validates the identity but never checks order.owner === caller.username.
      return json(res, 200, { ...order, requested_by: caller.username });
    }

    if (path === '/search') {
      const q = url.searchParams.get('q') || '';
      // VULN: unescaped reflection (reflected XSS).
      return html(res, 200, `<!doctype html><meta charset="utf-8"><title>Search</title>
<h1>Search</h1><p>Results for: ${q}</p><p>No products matched.</p>
<p><a href="/">back</a></p>`);
    }

    return json(res, 404, { error: 'not_found', path });
  });
}

if (require.main === module) {
  // 8788, not 8787: the Command Center's default port is 8787, and the demo used to
  // fail to bind whenever the console was open on the same machine.
  // Explicit argv wins over PORT so `node demo/target.js 8788` is unambiguous.
  const port = Number(process.argv[2] || process.env.PORT || 8788);
  const server = createServer();
  server.listen(port, '127.0.0.1', () => {
    const actual = server.address().port;
    process.stderr.write(`[demo] synthetic target on http://127.0.0.1:${actual} · loopback only · no real data\n`);
    process.stderr.write('[demo] scope: SCOPE_JSON=demo/scope.demo.json\n');
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

module.exports = { createServer, USERS, ORDERS };
