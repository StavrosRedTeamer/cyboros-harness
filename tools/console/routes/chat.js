// Console — the chat route family: the conversational LLM surface, kept apart
// from the engagement data routes because it talks to a provider instead of
// projecting engine-written state.
//
// Discovery is read-only (viewer and up); starting a turn and answering an approval
// are POSTs, so the existing role table keeps them operator-only without a new rule.
// The SSE contract each POST speaks is documented at the top of console/chat.js.
'use strict';

const SESSION_ID = /^\/api\/chat\/sessions\/([A-Za-z0-9-]{4,64})$/;

async function handle(ctx, req, res, url, query) {
  const { sendJson, bodyJson, chat } = ctx;

  if (req.method === 'GET') {
    if (url === '/api/chat/profiles') { sendJson(res, 200, chat.profiles()); return true; }
    if (url === '/api/chat/models') {
      const r = chat.models();
      sendJson(res, r.error ? 500 : 200, r);
      return true;
    }
    if (url === '/api/chat/presets') { sendJson(res, 200, chat.presets()); return true; }
    if (url === '/api/chat/settings') { sendJson(res, 200, chat.settings()); return true; }
    if (url === '/api/chat/sessions') {
      sendJson(res, 200, { sessions: chat.sessions.list(query && query.limit) });
      return true;
    }
    const m = url.match(SESSION_ID);
    if (m) {
      const s = chat.sessions.get(m[1]);
      sendJson(res, s ? 200 : 404, s || { error: 'unknown session' });
      return true;
    }
    return false;
  }

  if (req.method === 'POST') {
    // The model and preset a conversation is on are part of the conversation, so
    // selecting one is a write to the session, not a client-side preference.
    // Operator-only via the same role table as every other POST, and validated against
    // the same menus a turn resolves against.
    const sessionMatch = url.match(SESSION_ID);
    if (sessionMatch) {
      const r = chat.updateSession(sessionMatch[1], await bodyJson(req));
      sendJson(res, r.ok ? 200 : (r.status || 400), r);
      return true;
    }
    // Answering a parked approval. Resolving it is the whole point of the endpoint:
    // the turn is blocked on that promise and resumes with the operator's decision.
    if (url === '/api/chat/approval') {
      const r = chat.approve(await bodyJson(req));
      sendJson(res, r.ok ? 200 : (r.status || 400), r);
      return true;
    }
    // Settings are a write, so the existing role table makes them operator-only.
    if (url === '/api/chat/settings') {
      const r = chat.saveSettings(await bodyJson(req));
      sendJson(res, r.ok ? 200 : 400, r);
      return true;
    }
    if (url === '/api/chat') { await chat.stream(req, res, await bodyJson(req)); return true; }
  }

  return false;
}

module.exports = { handle };
