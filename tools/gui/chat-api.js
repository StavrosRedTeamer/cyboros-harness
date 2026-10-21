/* Cyboros Console — chat transport.
   The only place in the client that knows how a chat turn is spoken: the JSON routes and
   the SSE pump shared by a new question, a regenerate and an edit.

   Errors carry what the caller needs to react: `.notAccepted` for a request the server
   refused before the stream started (reload the stored truth), `.status === 401` for an
   expired session (the tab is already redirecting).

   Uses app.js's global `api()` for JSON (it already handles 401 and non-2xx). */
(function () {
  'use strict';

  function jsonPost(path, body) {
    return api(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
  }

  // Pumps one turn. `onFrame` is called for every parsed frame, in order; the promise
  // resolves when the server ends the stream and rejects on a transport/HTTP failure.
  async function stream(body, opts) {
    var o = opts || {};
    var res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
      signal: o.signal
    });
    if (res.status === 401) {
      location.replace('/login?next=' + encodeURIComponent(location.pathname + location.search));
      var gone = new Error('session expired — sign in again');
      gone.status = 401;                 // the caller skips its error toast for this one
      throw gone;
    }
    if (!res.ok || !res.body) {
      var payload = null;
      try { payload = await res.json(); } catch (e) { /* not JSON */ }
      var refused = new Error((payload && payload.error) || ('HTTP ' + res.status));
      refused.notAccepted = true;        // a rewrite the server refused never happened
      throw refused;
    }
    var reader = res.body.getReader();
    var dec = new TextDecoder();
    var buf = '';
    for (;;) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      var idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        var frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        var line = frame.split('\n').find(function (x) { return x.indexOf('data:') === 0; });
        if (!line) continue;
        var ev;
        try { ev = JSON.parse(line.slice(5).trim()); } catch (e2) { continue; }
        if (o.onFrame) o.onFrame(ev);
      }
    }
  }

  window.ChatApi = {
    models: function () { return api('/api/chat/models'); },
    presets: function () { return api('/api/chat/presets'); },
    settings: function () { return api('/api/chat/settings'); },
    saveSettings: function (patch) { return jsonPost('/api/chat/settings', patch); },
    sessions: function (limit) { return api('/api/chat/sessions?limit=' + encodeURIComponent(limit || 50)); },
    session: function (id) { return api('/api/chat/sessions/' + encodeURIComponent(id)); },
    // `{model}` or `{preset}` — the two choices that belong to the conversation.
    patchSession: function (id, patch) {
      return jsonPost('/api/chat/sessions/' + encodeURIComponent(id), patch);
    },
    approval: function (id, decision) { return jsonPost('/api/chat/approval', { id: id, decision: decision }); },
    stream: stream
  };
})();
