// Console — HTTP transport: reply shapes, capped body parsing, the Host/Origin
// allowlist, and the static shell served from tools/gui.
//
// Why it is its own module: the shell is public by design (it holds no engagement
// data, and /login has to be reachable before there is a session), while everything
// it calls is gated. Keeping "how a byte is written" apart from "who may ask" and
// from "what the data says" is what lets the identity or job backend be swapped
// without touching the transport.
'use strict';
const fs = require('fs');
const path = require('path');

const CT = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function sendText(res, code, text) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

// Request body, always JSON, capped: a dashboard write is small, and an unbounded
// read here would be a memory footgun reachable before any handler runs.
function bodyJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

// ── Host/Origin guard (rebinding + CSRF) ───────────────────────────────────
function hostIsLoopback(hostHeader) {
  const h = String(hostHeader || '');
  if (!h) return false;
  let name = h;
  if (h.startsWith('[')) { const end = h.indexOf(']'); if (end < 0) return false; name = h.slice(1, end); }
  else name = h.split(':')[0];
  return name === '127.0.0.1' || name === 'localhost' || name === '::1';
}

// A container or a reverse proxy presents its own hostname, so the guard accepts the
// loopback names plus the hostnames the operator declared in http.allowed_hosts. It is
// still an allowlist, still fail-closed.
function createHostGuard(allowedHosts) {
  const allowed = Array.isArray(allowedHosts) ? allowedHosts : [];
  function hostAllowed(hostHeader) {
    if (hostIsLoopback(hostHeader)) return true;
    const h = String(hostHeader || '');
    let name = h;
    if (h.startsWith('[')) { const end = h.indexOf(']'); if (end < 0) return false; name = h.slice(1, end); }
    else name = h.split(':')[0];
    return allowed.includes(name.toLowerCase());
  }
  function guardOk(req) {
    if (!hostAllowed(req.headers.host)) return false;
    const origin = req.headers.origin;
    if (origin) {
      try {
        const u = new URL(origin);
        if (!hostIsLoopback(u.hostname) && !allowed.includes(u.hostname.toLowerCase())) return false;
      } catch { return false; }
    }
    return true;
  }
  return { hostIsLoopback, hostAllowed, guardOk };
}

// ── the public shell ───────────────────────────────────────────────────────
// Serves static assets only; returns true when it answered. `exchangeServiceToken`
// is injected because turning a launcher token into a session cookie is an identity
// decision, not a transport one.
function createStatic(opts) {
  const guiDir = opts.guiDir;
  const guardOk = opts.guardOk;
  const exchangeServiceToken = opts.exchangeServiceToken;

  function serve(req, res, url, query) {
    // The launcher opens /?token=<service token>: exchange it for a session cookie
    // and redirect, so the credential stops travelling in page JS.
    if (url === '/' || url === '/index.html') {
      if (!guardOk(req)) { sendText(res, 403, 'forbidden'); return true; }
      if (query.token) {
        const boot = exchangeServiceToken(query.token);
        if (!boot) { sendText(res, 401, 'invalid service token'); return true; }
        res.writeHead(302, { Location: '/', 'Set-Cookie': boot.cookie, 'Cache-Control': 'no-store' });
        res.end();
        return true;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(fs.readFileSync(path.join(guiDir, 'index.html')));
      return true;
    }
    if (url === '/login' || url === '/login.html') {
      if (!guardOk(req)) { sendText(res, 403, 'forbidden'); return true; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(fs.readFileSync(path.join(guiDir, 'login.html')));
      return true;
    }
    if (url === '/app.css' || url === '/app.js' || url === '/login.js') {
      if (!guardOk(req)) { sendText(res, 403, 'forbidden'); return true; }
      const ext = path.extname(url);
      res.writeHead(200, { 'Content-Type': CT[ext] || 'text/plain', 'Cache-Control': 'no-store' });
      res.end(fs.readFileSync(path.join(guiDir, path.basename(url))));
      return true;
    }
    // Progressive view split: extra zero-build assets under tools/gui served by
    // basename with an extension allowlist (no path traversal: the pattern forbids '/').
    const assetMatch = url.match(/^\/([\w.-]+)$/);
    if (assetMatch && ['.js', '.css', '.svg', '.json'].includes(path.extname(assetMatch[1]))) {
      if (!guardOk(req)) { sendText(res, 403, 'forbidden'); return true; }
      const p = path.join(guiDir, assetMatch[1]);
      if (assetMatch[1].includes('..') || !fs.existsSync(p)) { sendText(res, 404, 'not found'); return true; }
      res.writeHead(200, { 'Content-Type': CT[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(fs.readFileSync(p));
      return true;
    }
    // vendored static assets (xterm.js terminal): /vendor/<file>.{js,css}
    const vendMatch = url.match(/^\/vendor\/([\w.-]+)$/);
    if (vendMatch) {
      if (!guardOk(req)) { sendText(res, 403, 'forbidden'); return true; }
      const name = vendMatch[1];
      const p = path.join(guiDir, 'vendor', name);
      if (name.includes('..') || !fs.existsSync(p)) { sendText(res, 404, 'not found'); return true; }
      const ext = path.extname(name);
      res.writeHead(200, { 'Content-Type': CT[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(fs.readFileSync(p));
      return true;
    }
    if (url === '/favicon.ico') { res.writeHead(204); res.end(); return true; }
    return false;
  }

  return { serve };
}

module.exports = { sendJson, sendText, bodyJson, createHostGuard, createStatic };
