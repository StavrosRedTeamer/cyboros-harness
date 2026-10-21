/* Cyboros Console — Chat view.
   An OpenAI-style conversational surface that talks to the SAME providers the
   agent runtime uses (runtime/providers.json), through the server's /api/chat
   SSE endpoint. Plain conversation: no tools, no guards. Local profiles (llama
   on loopback) are the default, in line with the harness's zero-cloud-egress
   opsec; cloud profiles appear only when the config opts in and a key is set.

   Reuses app.js globals at call-time: el, byId, esc, toast, api, can. Exposes
   renderChat() on window so app.js's renderTab() can mount the tab. Conversation
   state lives here and is preserved across tab switches (the pane is only
   mounted once). The session travels as an HttpOnly cookie — nothing here
   reads or stores a token. */
(function () {
  'use strict';

  var state = {
    messages: [],          // { role: 'user'|'assistant', content, thinking }
    profiles: [],
    profile: null,
    allowCloud: false,
    streaming: false,
    abort: null,
    refs: null,            // live DOM refs during a stream
  };

  // ── minimal, XSS-safe markdown ─────────────────────────────────────────────
  // Escape first, then apply a small, closed set of transforms. Fenced code is
  // pulled out behind placeholders so newline→<br> never leaks into <pre>.
  function renderMarkdown(src) {
    var escaped = esc(src);
    var blocks = [];
    escaped = escaped.replace(/```([\s\S]*?)```/g, function (_m, code) {
      var inner = code.replace(/^\n/, '').replace(/^[a-zA-Z0-9_.+-]{1,15}\n/, '');  // drop optional ```lang label
      blocks.push('<pre class="chat-code">' + inner + '</pre>');
      return '\u0000B' + (blocks.length - 1) + '\u0000';
    });
    escaped = escaped.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    escaped = escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    escaped = escaped.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    escaped = escaped.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    escaped = escaped.replace(/\n/g, '<br>');
    escaped = escaped.replace(/\u0000B(\d+)\u0000/g, function (_m, i) { return blocks[Number(i)]; });
    return escaped;
  }

  function listEl() { return byId('chat-list'); }
  function scrollBottom() { var l = listEl(); if (l) l.scrollTop = l.scrollHeight; }

  // ── message bubbles ────────────────────────────────────────────────────────
  function bubble(msg) {
    var isUser = msg.role === 'user';
    var kids = [];
    var thinkEl = null;
    if (!isUser && msg.thinking) {
      thinkEl = thinkingBlock(msg.thinking);
      kids.push(thinkEl);
    }
    var contentEl = el('div', { class: 'chat-bubble', html: isUser ? esc(msg.content).replace(/\n/g, '<br>') : renderMarkdown(msg.content || '') });
    kids.push(contentEl);
    var row = el('div', { class: 'chat-msg ' + (isUser ? 'user' : 'assistant') }, [
      el('div', { class: 'chat-avatar', title: isUser ? 'you' : (state.profile || 'model') }, isUser ? 'you' : '◈'),
      el('div', { class: 'chat-col' }, kids),
    ]);
    return { row: row, contentEl: contentEl, thinkWrap: row.querySelector('.chat-col') };
  }

  function thinkingBlock(text) {
    var pre = el('div', { class: 'chat-think-body', html: esc(text).replace(/\n/g, '<br>') });
    var head = el('button', { class: 'chat-think-toggle', type: 'button' }, 'thinking ▾');
    var wrap = el('details', { class: 'chat-think', open: true }, null);
    var summary = el('summary', { class: 'chat-think-sum' }, 'reasoning');
    wrap.appendChild(summary);
    wrap.appendChild(pre);
    wrap._body = pre;
    return wrap;
  }

  function repaintMessages() {
    var l = listEl(); if (!l) return;
    l.innerHTML = '';
    if (!state.messages.length) {
      l.appendChild(el('div', { class: 'chat-empty' }, [
        el('div', { class: 'chat-empty-glyph' }, '◈'),
        el('div', { class: 'chat-empty-title' }, 'Chat with the model'),
        el('div', { class: 'chat-empty-sub' }, 'Conversation only — no tools, no scope actions. Routed through the selected provider.'),
      ]));
      return;
    }
    state.messages.forEach(function (m) { l.appendChild(bubble(m).row); });
    scrollBottom();
  }

  // ── composer state ─────────────────────────────────────────────────────────
  function setComposer(streaming) {
    var send = byId('chat-send'), stop = byId('chat-stop'), input = byId('chat-input');
    if (send) send.classList.toggle('hidden', streaming);
    if (stop) stop.classList.toggle('hidden', !streaming);
    if (input) input.disabled = false;
  }
  function autoGrow() {
    var t = byId('chat-input'); if (!t) return;
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 220) + 'px';
  }

  // ── send + stream ──────────────────────────────────────────────────────────
  async function send() {
    var input = byId('chat-input');
    if (!input || state.streaming) return;
    if (!state.profile) { toast('still loading providers…', 'err'); return; }
    var text = input.value.trim();
    if (!text) return;

    state.messages.push({ role: 'user', content: text });
    input.value = ''; autoGrow();

    var l = listEl();
    if (l.querySelector('.chat-empty')) l.innerHTML = '';
    l.appendChild(bubble(state.messages[state.messages.length - 1]).row);

    var asst = { role: 'assistant', content: '', thinking: '' };
    state.messages.push(asst);
    var b = bubble(asst);
    l.appendChild(b.row);
    // live refs
    b.contentEl.classList.add('streaming');
    b.contentEl.innerHTML = '<span class="chat-cursor">▍</span>';
    var thinkEl = null;
    function ensureThink() {
      if (!thinkEl) { thinkEl = thinkingBlock(''); b.thinkWrap.insertBefore(thinkEl, b.contentEl); }
      return thinkEl;
    }
    scrollBottom();

    state.streaming = true; state.abort = new AbortController(); setComposer(true);
    setMeta('…');

    var history = state.messages.slice(0, -1).map(function (m) { return { role: m.role, content: m.content }; });
    try {
      var res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ profile: state.profile, messages: history }),
        signal: state.abort.signal,
      });
      if (res.status === 401) { location.replace('/login?next=' + encodeURIComponent(location.pathname + location.search)); return; }
      if (!res.ok || !res.body) {
        var j = null; try { j = await res.json(); } catch (e) {}
        throw new Error((j && j.error) || ('HTTP ' + res.status));
      }
      var reader = res.body.getReader(), dec = new TextDecoder(), buf = '';
      for (;;) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buf += dec.decode(chunk.value, { stream: true });
        var idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          var evt = buf.slice(0, idx); buf = buf.slice(idx + 2);
          var line = evt.split('\n').find(function (x) { return x.indexOf('data:') === 0; });
          if (!line) continue;
          var ev; try { ev = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }
          if (ev.type === 'token') {
            asst.content += ev.t;
            b.contentEl.innerHTML = renderMarkdown(asst.content) + '<span class="chat-cursor">▍</span>';
            scrollBottom();
          } else if (ev.type === 'thinking') {
            asst.thinking += ev.t;
            ensureThink()._body.innerHTML = esc(asst.thinking).replace(/\n/g, '<br>');
            scrollBottom();
          } else if (ev.type === 'meta') {
            setMeta(ev.profile + ' · ' + ev.model + ' · ' + ev.egress);
          } else if (ev.type === 'timings') {
            var tps = ev.timings && (ev.timings.genPerSec || ev.timings.predicted_per_second);
            if (tps) setFoot(Math.round(tps) + ' tok/s');
          } else if (ev.type === 'done') {
            if (ev.usage) setFoot((ev.usage.total_tokens || (ev.usage.prompt_tokens + ev.usage.completion_tokens) || '') + ' tokens');
          } else if (ev.type === 'error') {
            throw new Error(ev.message);
          }
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') {
        toast(String((e && e.message) || e), 'err');
        asst.content += (asst.content ? '\n\n' : '') + '⚠ ' + String((e && e.message) || e);
      }
    } finally {
      state.streaming = false; state.abort = null; setComposer(false);
      b.contentEl.classList.remove('streaming');
      if (!asst.content && !asst.thinking) {
        state.messages.pop();                 // nothing came back → drop the placeholder
        if (b.row.parentNode) b.row.parentNode.removeChild(b.row);
      } else {
        b.contentEl.innerHTML = renderMarkdown(asst.content || '');
      }
      if (thinkEl) thinkEl.open = false;       // collapse reasoning once the answer is in
      scrollBottom();
      if (input) input.focus();
    }
  }

  function stop() { if (state.abort) { try { state.abort.abort(); } catch (e) {} } }

  function setMeta(txt) { var m = byId('chat-meta'); if (m) m.textContent = txt; }
  function setFoot(txt) { var f = byId('chat-foot'); if (f) f.textContent = txt; }

  function newChat() {
    if (state.streaming) stop();
    state.messages = [];
    repaintMessages();
    setFoot('');
    var input = byId('chat-input'); if (input) { input.value = ''; autoGrow(); input.focus(); }
  }

  // ── profile selector ───────────────────────────────────────────────────────
  function buildProfileSelect() {
    var sel = byId('chat-profile');
    if (!sel) return;
    sel.innerHTML = '';
    state.profiles.forEach(function (p) {
      var label = p.name + ' · ' + p.model + ' · ' + p.egress + (p.available ? '' : ' (' + (p.reason || 'n/d') + ')');
      var opt = el('option', { value: p.name }, label);
      if (!p.available) opt.disabled = true;
      if (p.name === state.profile) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.onchange = function () { state.profile = sel.value; updateEgressTag(); };
    updateEgressTag();
  }
  function updateEgressTag() {
    var tag = byId('chat-egress');
    if (!tag) return;
    var p = state.profiles.find(function (x) { return x.name === state.profile; });
    var cloud = p && p.cloud;
    tag.textContent = cloud ? 'cloud egress' : 'local';
    tag.className = 'chat-egress ' + (cloud ? 'cloud' : 'local');
  }

  // ── mount ──────────────────────────────────────────────────────────────────
  function mount(pane) {
    pane.innerHTML = '';
    var toolbar = el('div', { class: 'chat-toolbar' }, [
      el('div', { class: 'chat-tb-left' }, [
        el('label', { class: 'chat-tb-label', for: 'chat-profile' }, 'model'),
        el('select', { id: 'chat-profile', class: 'chat-select', 'aria-label': 'Provider profile' }),
        el('span', { id: 'chat-egress', class: 'chat-egress local' }, 'local'),
      ]),
      el('div', { class: 'chat-tb-right' }, [
        el('span', { id: 'chat-meta', class: 'chat-meta' }, ''),
        el('button', { id: 'chat-new', class: 'btn btn-sm', type: 'button', title: 'Start a new conversation' }, '＋ new chat'),
      ]),
    ]);

    var list = el('div', { id: 'chat-list', class: 'chat-list', role: 'log', 'aria-live': 'polite' });

    var input = el('textarea', {
      id: 'chat-input', class: 'chat-input', rows: '1', spellcheck: 'false',
      placeholder: 'Message the model…  (Enter to send · Shift+Enter for newline)',
      'aria-label': 'Message',
    });
    var composer = el('div', { class: 'chat-composer' }, [
      input,
      el('div', { class: 'chat-composer-actions' }, [
        el('span', { id: 'chat-foot', class: 'chat-foot' }, ''),
        el('button', { id: 'chat-send', class: 'btn btn-primary btn-sm', type: 'button' }, 'Send'),
        el('button', { id: 'chat-stop', class: 'btn btn-danger btn-sm hidden', type: 'button' }, '■ Stop'),
      ]),
    ]);

    pane.appendChild(el('div', { class: 'chat-root' }, [toolbar, list, composer]));
    pane.dataset.mounted = '1';

    // wiring
    byId('chat-send').disabled = true;   // enabled once providers load
    if (!can('operator')) {
      byId('chat-send').disabled = true;
      byId('chat-send').title = 'requires the operator role';
    }
    byId('chat-send').addEventListener('click', send);
    byId('chat-stop').addEventListener('click', stop);
    byId('chat-new').addEventListener('click', newChat);
    input.addEventListener('input', autoGrow);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });

    repaintMessages();

    // load providers
    api('/api/chat/profiles')
      .then(function (d) {
        if (d.error) { toast('chat: ' + d.error, 'err'); setMeta(d.error); }
        state.profiles = d.profiles || [];
        state.allowCloud = !!d.allowCloud;
        if (!state.profile) {
          var defAvail = state.profiles.find(function (p) { return p.name === d.default && p.available; });
          var firstAvail = state.profiles.find(function (p) { return p.available; });
          state.profile = (defAvail && defAvail.name) || (firstAvail && firstAvail.name) || d.default || null;
        }
        buildProfileSelect();
        var sb = byId('chat-send'); if (sb) sb.disabled = !state.profile || !can('operator');
      })
      .catch(function (e) { toast('chat: ' + (e.message || e), 'err'); setMeta('provider list unavailable'); });

    setTimeout(autoGrow, 0);
    setTimeout(function () { var i = byId('chat-input'); if (i) i.focus(); }, 0);
  }

  function renderChat() {
    var pane = byId('tab-chat');
    if (!pane) return;
    if (pane.dataset.mounted === '1') {       // keep conversation + scroll across tab switches
      var i = byId('chat-input'); if (i) i.focus();
      return;
    }
    mount(pane);
  }

  window.renderChat = renderChat;
})();
