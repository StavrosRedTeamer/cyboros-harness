// Console — route dispatch: the one place that knows which family answers a path.
//
// Why a table of families instead of one long if-chain: adding an endpoint means
// editing the family it belongs to and nothing else, while the order (cc router
// first, then accounts, state, streams) stays visible in one short file. Returns
// true when a family answered; the caller owns the 404/405 shapes so every family
// keeps the same contract.
'use strict';

const state = require('./state');
const families = [
  require('./accounts'),
  require('./chat'),
  state,
  require('./streams'),
];

async function handle(ctx, req, res, url, query, principal) {
  // Additive Command Center modules (WP3..WP7): same guards already applied above
  // (loopback Host/Origin + role). Never bypasses a guard — writes are wrappers
  // over the existing tools, and the actor is the authenticated identity.
  if (url.startsWith('/api/cc/')) {
    const handled = await ctx.ccRouter.handle(req, res, {
      url, query,
      sendJson: ctx.sendJson, sendText: ctx.sendText, bodyJson: ctx.bodyJson,
      runJob: ctx.jobs.run, jobs: ctx.jobs.snapshot,
      root: ctx.dataRoot, reports: ctx.reportsDir,
      scopeFile: ctx.scopeFile, opstateFile: ctx.opstateFile,
      token: ctx.token, readOnly: ctx.readOnly,
      actor: principal.username, role: principal.role,
    });
    if (handled !== false) return true;
  }

  for (const family of families) {
    if (await family.handle(ctx, req, res, url, query, principal)) return true;
  }
  return false;
}

// A document URL, but a data authorization decision — see routes/state.js.
function serveArtifact(ctx, req, res, url) {
  return state.serveArtifact(ctx, req, res, url);
}

module.exports = { handle, serveArtifact };
