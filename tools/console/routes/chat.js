// Console — the chat route family: the conversational LLM surface, kept apart
// from the engagement data routes because it talks to a provider instead of
// projecting engine-written state.
'use strict';

async function handle(ctx, req, res, url, query) {
  const { sendJson, bodyJson, chat } = ctx;
  if (url === '/api/chat/profiles' && req.method === 'GET') { sendJson(res, 200, chat.profiles()); return true; }
  if (url === '/api/chat' && req.method === 'POST') { await chat.stream(req, res, await bodyJson(req)); return true; }
  return false;
}

module.exports = { handle };
