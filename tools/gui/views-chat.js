/* Cyboros Console — Chat view.
   The operator's turn against the real agent loop: the server's /api/chat drives
   local/llm.js#runAgent with the guarded tool dispatch, so the model answers AND acts.
   The preset decides what it may do and the SERVER enforces it; this view only renders
   the frames it receives — including refusals, which always arrive as a tool_result
   with blocked:true, never as prose we would have to interpret.

   Layout follows the DeepSeek harness web client: a collapsible rail of past
   conversations, a centred narrow transcript, and a composer whose control row owns the
   model and preset seats.

   This file owns the conversation and nothing else: the transcript model (S), the frame
   → state reducer, and the wiring. Transport is ChatApi, transcript → DOM is ChatRender,
   the settings surface is ChatSettings (the split is recorded in docs/ARCHITECTURE.md).

   Reuses app.js globals at call-time: el, byId, esc, toast, api, can.
   Exposes renderChat() on window so app.js's renderTab() can mount the tab. The
   conversation is resumed from the server on mount; the session travels as an HttpOnly
   cookie. */
(function () {
  'use strict';

  var S = {
    // conversation — the only mutable truth this view owns
    turns: [],                 // user turns + assistant turns (parts: text|tool|approval)
    current: null,             // the assistant turn being streamed
    sessionId: null,
    title: null,
    userCount: 0,              // user turns in this conversation = edit/regenerate ordinals
    // catalog and server config — read from the server, never guessed here
    models: [],
    modelId: null,
    presets: [],
    presetId: null,
    settings: null,            // saved defaults (/api/chat/settings)
    context: null,
    sessions: [],
    me: null,
    // derived readout for the header/chrome
    readonly: false,
    egress: null,
    profile: null,
    model: null,
    defaultModel: null,
    defaultPreset: null,
    // turn mechanics + chrome
    usage: null,
    streaming: false,
    abort: null,
    sidebar: false,
    booted: false
  };

  function listEl() { return byId('chat-list'); }
  // The scroller is `.chat-scroll`, not the list inside it: setting scrollTop on a
  // non-overflowing list does nothing, which is why a new answer used to land below
  // the fold in any conversation taller than the panel.
  function scrollPane() { return document.querySelector('.chat-scroll'); }
  function scrollBottom() { var s = scrollPane(); if (s) s.scrollTop = s.scrollHeight; }
  function nearBottom() {
    var s = scrollPane(); if (!s) return true;
    return (s.scrollHeight - s.scrollTop - s.clientHeight) < 120;
  }

  // ── labels / formatting ────────────────────────────────────────────────────
  function modelEntry(id) {
    for (var i = 0; i < S.models.length; i++) if (S.models[i].id === id) return S.models[i];
    return null;
  }
  function modelLabel(id) {
    var m = modelEntry(id);
    return m ? m.model : (id || 'model');
  }
  function presetEntry(id) {
    for (var i = 0; i < S.presets.length; i++) if (S.presets[i].id === id) return S.presets[i];
    return null;
  }
  function presetLabel(id) {
    var p = presetEntry(id);
    return p ? p.label : (id || 'preset');
  }
  function relTime(iso) {
    var t = Date.parse(iso || '');
    if (!t) return '';
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return 'now';
    if (s < 3600) return Math.round(s / 60) + 'm';
    if (s < 86400) return Math.round(s / 3600) + 'h';
    return new Date(t).toLocaleDateString();
  }

  // ── transcript model ───────────────────────────────────────────────────────
  function pushUser(text) {
    var turn = { role: 'user', content: text, ordinal: S.userCount };
    S.userCount += 1;
    S.turns.push(turn);
    return turn;
  }
  function ensureAssistant() {
    if (S.current) return S.current;
    var turn = { role: 'assistant', parts: [], thinking: '', status: 'streaming' };
    S.turns.push(turn);
    S.current = turn;
    appendTurn(turn);
    return turn;
  }
  function textPart(turn) {
    var last = turn.parts[turn.parts.length - 1];
    if (last && last.type === 'text' && last.open) return last;
    var part = { type: 'text', content: '', open: true };
    turn.parts.push(part);
    return part;
  }
  function findPart(id) {
    for (var i = 0; i < S.turns.length; i++) {
      var ps = S.turns[i].parts || [];
      for (var j = 0; j < ps.length; j++) if (ps[j].id === id) return ps[j];
    }
    return null;
  }
  // The node a streamed part must be inserted before: the action row always stays last.
  function actionsAnchor(turn) { return turn.body.querySelector('.chat-actions'); }

  // ── rendering: empty state ─────────────────────────────────────────────────
  function hero() {
    var wrap = el('div', { class: 'chat-hero' });
    wrap.appendChild(el('div', { class: 'chat-hero-ring' }, [
      el('img', { class: 'chat-hero-mark', src: '/img/ouroboros.webp', alt: '', width: '190', height: '190' })
    ]));
    wrap.appendChild(el('h2', { class: 'chat-hero-title', html: 'Ask.<br>Then watch the loop close.' }));
    wrap.appendChild(el('p', { class: 'chat-hero-sub' },
      'One turn, the same loop the CLI runs: the model answers, calls the guarded tools and records evidence. Scope is decided in code before any call leaves this page.'));
    var cards = el('div', { class: 'chat-hero-presets' });
    (S.presets.length ? S.presets : [{ id: 'pentest', label: 'Pentest', description: '' }]).forEach(function (p) {
      var active = p.id === S.presetId;
      var card = el('button', {
        type: 'button', class: 'chat-hero-card' + (active ? ' is-active' : ''),
        'aria-pressed': active ? 'true' : 'false',
        onclick: function () { setPreset(p.id); }
      }, [
        el('span', { class: 'chat-hero-card-name' }, p.label),
        el('span', { class: 'chat-hero-card-desc' }, p.description || '')
      ]);
      cards.appendChild(card);
    });
    wrap.appendChild(cards);
    wrap.appendChild(el('p', { class: 'chat-hero-hint' },
      'Target authorization lives in scope.json · intrusive tools ask before they run'));
    return wrap;
  }

  function renderAll() {
    var l = listEl(); if (!l) return;
    l.innerHTML = '';
    if (!S.turns.length) {
      l.appendChild(hero());
      // The empty state opens at its own top. Without this the pane keeps the previous
      // conversation's scroll offset and the mark and title start above the fold.
      var s = scrollPane(); if (s) s.scrollTop = 0;
      return;
    }
    S.turns.forEach(function (t) { l.appendChild(ChatRender.turn(t)); });
    scrollBottom();
  }

  function appendTurn(turn) {
    var l = listEl(); if (!l) return;
    var empty = l.querySelector('.chat-hero');
    if (empty) empty.parentNode.removeChild(empty);
    var node = ChatRender.turn(turn);
    turn.node = node;
    l.appendChild(node);
    scrollBottom();
  }

  // ── edit-and-resend / regenerate (both are server rewrites) ────────────────
  function reRender(turn) {
    var fresh = ChatRender.turn(turn);
    if (turn.node && turn.node.parentNode) turn.node.parentNode.replaceChild(fresh, turn.node);
    turn.node = fresh;
  }

  function startEdit(turn) {
    if (S.streaming) { toast('wait for the running turn to finish', ''); return; }
    if (!S.sessionId) { toast('this message is not stored yet — send it first', ''); return; }
    if (!turn.node) return;
    turn.node.classList.add('is-editing');
    var ta = el('textarea', { class: 'chat-edit-input', rows: '3', 'aria-label': 'Edit message' });
    ta.value = turn.content;
    var save = el('button', { type: 'button', class: 'btn btn-primary btn-sm' }, 'Save & resend');
    var cancel = el('button', { type: 'button', class: 'btn btn-sm' }, 'Cancel');
    var box = el('div', { class: 'chat-edit-box' }, [
      ta,
      el('div', { class: 'chat-edit-row' }, [cancel, save])
    ]);
    turn.node.innerHTML = '';
    turn.node.appendChild(box);
    ta.style.height = Math.max(58, Math.min(ta.scrollHeight, 200)) + 'px';
    ta.focus();
    cancel.addEventListener('click', function () { reRender(turn); });
    save.addEventListener('click', function () {
      var text = ta.value.trim();
      if (!text) return;
      if (text === turn.content) { reRender(turn); return; }
      rewriteFrom(turn, text);
    });
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); reRender(turn); }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save.click(); }
    });
  }

  // The rewrite is applied to the STORE: the client drops the turns after the edited
  // question and asks the server to cut the same point, so a reload shows exactly this.
  function rewriteFrom(turn, text) {
    if (!S.sessionId || S.streaming) return;
    var at = S.turns.indexOf(turn);
    if (at < 0) return;
    S.turns = S.turns.slice(0, at);
    turn.content = text;
    S.turns.push(turn);
    S.userCount = turn.ordinal + 1;
    S.current = null; S.usage = null; setFoot('');
    renderAll();
    runTurn({
      session: S.sessionId, model: S.modelId, preset: S.presetId,
      edit: { user: turn.ordinal, content: text }
    }, { resync: true });
  }

  function regenerate(turn) {
    if (S.streaming) { toast('the answer is still streaming', ''); return; }
    if (!S.sessionId) return;
    if (S.turns[S.turns.length - 1] !== turn) {
      toast('only the latest answer can be regenerated', '');
      return;
    }
    var at = S.turns.indexOf(turn);
    if (at < 0) return;
    S.turns = S.turns.slice(0, at);
    S.current = null; S.usage = null; setFoot('');
    renderAll();
    runTurn({
      session: S.sessionId, model: S.modelId, preset: S.presetId, regenerate: true
    }, { resync: true });
  }

  // ── header / sidebar / composer chrome ─────────────────────────────────────
  function newChat() {
    if (S.streaming) stop();
    S.turns = []; S.current = null; S.sessionId = null; S.title = null;
    S.usage = null; S.userCount = 0;
    setFoot('');
    // A new conversation starts from the server's defaults, which is what the settings
    // dialog promises; an in-conversation switch must not leak into the next one.
    applyDefaultModel();
    applyDefaultPreset();
    renderAll();
    updateHead();
    var input = byId('chat-input'); if (input) { input.value = ''; autoGrow(); input.focus(); }
  }

  function applyDefaultModel() {
    // An explicit settings default wins; otherwise the server's availability default.
    // Either way the pill must not keep the previous conversation's model.
    var st = S.settings || {};
    var id = st.model || S.defaultModel;
    if (id && modelEntry(id)) setModel(id);
  }

  function applyDefaultPreset() {
    var preset = (S.settings || {}).preset || S.defaultPreset;
    if (preset && presetEntry(preset)) applyPresetId(preset);
  }

  // One place decides what a preset id means for the chrome; `readonly` is derived from
  // the preset table, except on a `meta` frame where the server states it directly.
  function applyPresetId(id) {
    var p = presetEntry(id);
    S.presetId = id;
    S.readonly = !!(p && p.readonly);
  }

  function updateHead() {
    var t = byId('chat-title');
    if (t) t.textContent = S.title || (S.turns.length ? 'Conversation' : 'New conversation');
    var sub = byId('chat-sub');
    if (sub) {
      var bits = [];
      if (S.profile) bits.push(S.profile);
      if (S.model) bits.push(S.model);
      if (S.presetId) bits.push(presetLabel(S.presetId));
      sub.textContent = bits.join(' · ');
    }
    var chip = byId('chat-preset-chip');
    if (chip) {
      chip.textContent = presetLabel(S.presetId);
      chip.className = 'chat-chip' + (S.readonly ? ' chat-chip-ro' : '');
      chip.title = S.readonly ? 'read-only preset: no active tools' : 'active preset: guarded tools available';
    }
    var mb = byId('chat-model-label');
    if (mb) mb.textContent = modelLabel(S.modelId);
    var pb = byId('chat-preset-label');
    if (pb) pb.textContent = presetLabel(S.presetId);
    var eg = byId('chat-egress');
    if (eg) {
      var local = S.egress !== 'cloud';
      eg.textContent = S.egress || (S.models.length ? '…' : 'offline');
      eg.className = 'chat-egress ' + (local ? 'local' : 'cloud');
    }
    var send = byId('chat-send');
    if (send) send.disabled = S.streaming || !S.modelId;
    var role = byId('chat-role');
    if (role) role.textContent = S.me ? (S.me.user.username + ' · ' + S.me.user.role) : '';
    paintSessionList();
  }

  function paintSessionList() {
    var box = byId('chat-sessions');
    if (!box) return;
    box.innerHTML = '';
    if (!S.sessions.length) {
      box.appendChild(el('div', { class: 'chat-side-empty' }, 'no past conversations'));
      return;
    }
    S.sessions.forEach(function (s) {
      var active = s.id === S.sessionId;
      box.appendChild(el('button', {
        type: 'button',
        class: 'chat-session' + (active ? ' is-active' : ''),
        title: s.title,
        onclick: function () { openSession(s.id); }
      }, [
        el('span', { class: 'chat-session-title' }, s.title || 'conversation'),
        el('span', { class: 'chat-session-meta' }, [
          el('span', null, relTime(s.updated)),
          s.preset ? el('span', { class: 'chat-session-preset' }, presetLabel(s.preset)) : null
        ])
      ]));
    });
  }

  function refreshSessions() {
    return ChatApi.sessions(50)
      .then(function (d) { S.sessions = (d && d.sessions) || []; paintSessionList(); })
      .catch(function () { /* sidebar is not worth an error toast */ });
  }

  function setSidebar(collapsed) {
    S.sidebar = !!collapsed;
    var root = byId('chat-root');
    if (root) root.classList.toggle('is-collapsed', S.sidebar);
    var b = byId('chat-side-toggle');
    if (b) b.setAttribute('aria-expanded', S.sidebar ? 'false' : 'true');
  }

  // The one place the drawer breakpoint lives. The stylesheet keys off `.is-narrow`,
  // which this listener sets from the same query, so there is no second copy of the
  // number to drift; the styles no longer carry a width of their own. Mounting narrow
  // starts the rail closed, and crossing in either direction re-applies the right
  // state — a mount-time check alone leaves the drawer covering the answer after a
  // resize.
  var NARROW_MAX = 860;
  var NARROW = '(max-width: ' + NARROW_MAX + 'px)';
  var narrowMq = null;
  function syncSidebarToWidth() {
    var narrow = narrowMq ? narrowMq.matches : window.innerWidth <= NARROW_MAX;
    var root = byId('chat-root');
    if (root) root.classList.toggle('is-narrow', narrow);
    setSidebar(narrow);
  }
  function watchWidth() {
    if (narrowMq || !window.matchMedia) { syncSidebarToWidth(); return; }
    narrowMq = window.matchMedia(NARROW);
    if (narrowMq.addEventListener) narrowMq.addEventListener('change', syncSidebarToWidth);
    else if (narrowMq.addListener) narrowMq.addListener(syncSidebarToWidth); // older engines
    syncSidebarToWidth();
  }

  // ── model / preset menus ───────────────────────────────────────────────────
  function closeMenus() {
    ['model', 'preset'].forEach(function (k) {
      var pop = byId('chat-' + k + '-pop');
      var btn = byId('chat-' + k + '-btn');
      if (pop) pop.hidden = true;
      if (btn) btn.setAttribute('aria-expanded', 'false');
    });
  }

  function toggleMenu(kind) {
    var pop = byId('chat-' + kind + '-pop');
    var btn = byId('chat-' + kind + '-btn');
    if (!pop || !btn) return;
    var opening = pop.hidden;
    closeMenus();
    if (!opening) return;
    pop.innerHTML = '';
    if (kind === 'model') paintModelMenu(pop);
    else paintPresetMenu(pop);
    pop.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
  }

  function paintModelMenu(pop) {
    if (!S.models.length) { pop.appendChild(el('div', { class: 'chat-pop-empty' }, 'no provider configured')); return; }
    S.models.forEach(function (m) {
      var b = el('button', {
        type: 'button',
        class: 'chat-pop-item' + (m.id === S.modelId ? ' is-active' : ''),
        role: 'option',
        'aria-selected': m.id === S.modelId ? 'true' : 'false',
        disabled: !m.available,
        title: m.available ? (m.profile + ' · ' + m.egress) : (m.reason || 'unavailable')
      }, [
        el('span', { class: 'chat-pop-main' }, m.model),
        el('span', { class: 'chat-pop-sub' }, m.profile + ' · ' + m.egress + (m.available ? '' : ' · ' + (m.reason || 'unavailable')))
      ]);
      b.addEventListener('click', function () { setModel(m.id); closeMenus(); });
      pop.appendChild(b);
    });
  }

  function paintPresetMenu(pop) {
    S.presets.forEach(function (p) {
      var b = el('button', {
        type: 'button',
        class: 'chat-pop-item' + (p.id === S.presetId ? ' is-active' : ''),
        role: 'option',
        'aria-selected': p.id === S.presetId ? 'true' : 'false'
      }, [
        el('span', { class: 'chat-pop-main' }, [p.label, p.readonly ? el('span', { class: 'chat-chip chat-chip-ro' }, 'read-only') : null]),
        el('span', { class: 'chat-pop-sub' }, p.description || '')
      ]);
      b.addEventListener('click', function () { setPreset(p.id); closeMenus(); });
      pop.appendChild(b);
    });
  }

  function setModel(id) {
    if (S.streaming) { toast('the model applies from the next turn', ''); return; }
    var previousId = S.modelId;
    var previous = modelEntry(previousId) || {};
    S.modelId = id;
    var e = modelEntry(id);
    S.model = e ? e.model : S.model;
    S.profile = e ? e.profile : S.profile;
    S.egress = e ? e.egress : S.egress;
    updateHead();
    // The choice belongs to the conversation, so it is written to the session now, not
    // when a turn happens to complete. A failed write is reverted loudly: the pill must
    // never claim a model the store does not have.
    if (!S.sessionId) return;
    ChatApi.patchSession(S.sessionId, { model: id }).then(function () {
      refreshSessions();
    }).catch(function (err) {
      if (S.modelId !== id) return;      // a newer choice already won
      S.modelId = previousId;
      S.model = previous.model || S.model;
      S.profile = previous.profile || S.profile;
      S.egress = previous.egress || S.egress;
      updateHead();
      toast('model not saved: ' + (err.message || err), 'err');
    });
  }

  function setPreset(id) {
    if (S.streaming) { toast('the preset applies from the next turn', ''); return; }
    var previousId = S.presetId;
    applyPresetId(id);
    updateHead();
    renderAll();
    // Same rule as the model: the choice is part of the conversation, so it is written
    // to the session now. A failed write is reverted loudly — the chip must not claim a
    // preset the store does not have.
    if (!S.sessionId) return;
    ChatApi.patchSession(S.sessionId, { preset: id }).then(function () {
      refreshSessions();
    }).catch(function (err) {
      if (S.presetId !== id) return;           // a newer choice already won
      applyPresetId(previousId);
      updateHead();
      renderAll();
      toast('preset not saved: ' + (err.message || err), 'err');
    });
  }

  // ── composer ───────────────────────────────────────────────────────────────
  function autoGrow() {
    var t = byId('chat-input'); if (!t) return;
    t.style.height = '0px';
    t.style.height = Math.max(24, Math.min(t.scrollHeight, 200)) + 'px';
  }

  function setFoot(txt, title) {
    var f = byId('chat-foot');
    if (!f) return;
    f.textContent = txt;
    // The full sentence (source, floor, unpriced count) hangs off the footer: the short
    // label stays readable, the detail is one hover away. Clearing the footer clears it
    // too, so a new conversation cannot inherit the last bill's sentence.
    if (title !== undefined) f.title = title;
    else if (!txt) f.title = '';
  }

  function uiBusy(busy) {
    S.streaming = !!busy;
    var send = byId('chat-send'), stopBtn = byId('chat-stop');
    if (send) { send.hidden = busy; send.disabled = busy || !S.modelId; }
    if (stopBtn) stopBtn.hidden = !busy;
    // rewrite controls act on the store; a second click while a turn runs would race it
    var idle = document.querySelectorAll('.chat-action[data-needs-idle]');
    for (var i = 0; i < idle.length; i += 1) idle[i].disabled = !!busy;
  }

  function stop() { if (S.abort) { try { S.abort.abort(); } catch (e) {} } }

  // A card left "running" belongs to a turn nobody is driving any more. Saying so is not
  // cosmetic: a spinner in a closed conversation looks like work still in flight.
  function markInterrupted(turn) {
    if (!turn) return;
    (turn.parts || []).forEach(function (p) {
      if (p.type !== 'tool' || p.status !== 'running') return;
      p.status = 'error';
      p.interrupted = true;
      if (!p.output) p.output = 'turn stopped — no result recorded';
      ChatRender.paintTool(p);
    });
  }

  // The answer the server persisted, painted now. A dropped frame, a transport that ends
  // without `done`, or a turn the page joined late must not leave the operator with an
  // empty bubble that only a reload fills: the store is exactly what a reload would show.
  function paintAnswer(turn, text) {
    if (!turn || !text) return;
    var body = stripFinalText(text);
    if (!body) return;
    var parts = (turn.parts || []).filter(function (p) { return p.type === 'text'; });
    if (parts.length > 1) return;            // already painted in pieces: never duplicate a prefix
    var shown = ChatRender.assistantText(turn);
    if (shown === body) return;
    var p = parts.length ? parts[0] : textPart(turn);
    p.content = body;
    p.open = false;
    if (!p.node || !p.node.isConnected) {
      var typing = turn.body.querySelector('.chat-typing');
      if (typing) typing.parentNode.removeChild(typing);
      p.node = ChatRender.text(turn, p);
      turn.body.insertBefore(p.node, actionsAnchor(turn));
    } else {
      p.node.innerHTML = ChatRender.markdown(p.content);
    }
  }
  function stripFinalText(s) { return String(s == null ? '' : s).trim(); }

  function reconcileAnswer(turn) {
    if (!S.sessionId) return Promise.resolve();
    var sid = S.sessionId;
    return ChatApi.session(sid).then(function (doc) {
      if (!turn || S.sessionId !== sid) return;
      if (ChatRender.assistantText(turn)) return;
      var last = null;
      (doc.transcript || []).forEach(function (e) {
        if (e.type === 'assistant' && e.content) last = e;
      });
      if (!last) return;
      paintAnswer(turn, last.content);
      ChatRender.pruneRegen(turn, S.turns);
      if (!turn.body.querySelector('.chat-actions')) turn.body.appendChild(ChatRender.actionsRow(turn));
    }).catch(function () { /* the stream was the only source */ });
  }

  // ── the turn: frames in, transcript out ────────────────────────────────────
  function applyFrame(ev) {
    if (ev.type === 'meta') {
      S.sessionId = ev.session || S.sessionId;
      S.model = ev.model; S.modelId = ev.modelId;
      S.profile = ev.profile; S.egress = ev.egress;
      S.presetId = ev.preset; S.readonly = !!ev.readonly;
      updateHead();
      return;
    }
    if (ev.type === 'session') {
      S.sessionId = ev.id;
      if (ev.title) S.title = ev.title;
      updateHead();
      return;
    }
    if (ev.type === 'start') { ensureAssistant(); return; }
    if (ev.type === 'thinking') {
      var t1 = ensureAssistant();
      t1.thinking += ev.t;
      if (!t1.thinkEl) t1.body.insertBefore(ChatRender.thinking(t1), t1.body.firstChild);
      else t1.thinkEl.textContent = t1.thinking;
      if (nearBottom()) scrollBottom();
      return;
    }
    if (ev.type === 'token') {
      var t2 = ensureAssistant();
      var part = textPart(t2);
      part.content += ev.t;
      if (!part.node) {
        var typing = t2.body.querySelector('.chat-typing');
        if (typing) typing.parentNode.removeChild(typing);
        part.node = ChatRender.text(t2, part);
        t2.body.insertBefore(part.node, actionsAnchor(t2));
      } else {
        part.node.innerHTML = ChatRender.markdown(part.content);
        if (t2.status === 'streaming') part.node.appendChild(el('span', { class: 'chat-cursor' }, '▍'));
        // A node built while its turn was detached (remount, resumed session) renders
        // into nothing until it is put back into the list.
        if (!part.node.isConnected) t2.body.insertBefore(part.node, actionsAnchor(t2));
      }
      if (nearBottom()) scrollBottom();
      return;
    }
    if (ev.type === 'tool_call') {
      var t3 = ensureAssistant();
      var tp = { type: 'tool', id: ev.id, tool: ev.tool, args: ev.args, status: 'running' };
      t3.parts.push(tp);
      t3.body.insertBefore(ChatRender.tool(tp), actionsAnchor(t3));
      if (nearBottom()) scrollBottom();
      return;
    }
    if (ev.type === 'tool_result') {
      var part2 = findPart(ev.id);
      if (!part2) {
        // A result whose call frame we never saw (reconnect): still show the truth.
        var t4 = ensureAssistant();
        part2 = { type: 'tool', id: ev.id, tool: ev.tool, args: {}, status: 'running' };
        t4.parts.push(part2);
        t4.body.insertBefore(ChatRender.tool(part2), actionsAnchor(t4));
      }
      part2.tool = ev.tool || part2.tool;
      part2.ok = !!ev.ok;
      part2.exit = ev.exit;
      part2.durationMs = ev.durationMs;
      part2.output = ev.output;
      part2.blocked = !!ev.blocked;
      part2.reason = ev.reason || null;
      part2.status = part2.blocked ? 'blocked' : (part2.ok ? 'ok' : 'error');
      ChatRender.paintTool(part2);
      if (nearBottom()) scrollBottom();
      return;
    }
    if (ev.type === 'approval') {
      var t5 = ensureAssistant();
      var ap = {
        type: 'approval', id: ev.id, tool: ev.tool, command: ev.command,
        tier: ev.tier, reason: ev.reason, decision: null
      };
      t5.parts.push(ap);
      t5.body.insertBefore(ChatRender.approval(ap), actionsAnchor(t5));
      if (nearBottom()) scrollBottom();
      return;
    }
    if (ev.type === 'approval_result') {
      var ap2 = findPart(ev.id);
      if (ap2) { ap2.decision = ev.decision; ChatRender.paintApproval(ap2); }
      return;
    }
    if (ev.type === 'usage') {
      S.usage = { tokensIn: ev.tokensIn, tokensOut: ev.tokensOut, cost: ev.cost, costLabel: ev.costLabel };
      // Tokens and money are the same quantity here: both come from the conversation's
      // rollup, so the footer never prints this call's tokens beside the engagement's total.
      // The label is the server's (runtime/usage.js), which owns the ledger, the
      // unknown/floor rules and the source name. This file deliberately cannot build a
      // dollar figure from a bare number: a client-side `$' + cost.toFixed(4)` shows an
      // unsourced amount for an unpriced call, which is the lie the rollup exists to stop.
      var label = ev.costLabel || '';
      var tin = ev.totalTokensIn != null ? ev.totalTokensIn : ev.tokensIn;
      var tout = ev.totalTokensOut != null ? ev.totalTokensOut : ev.tokensOut;
      setFoot(tin + ' in · ' + tout + ' out' + (label ? ' · ' + label : ''), ev.costText || '');
      return;
    }
    if (ev.type === 'timings') {
      var tps = ev.timings && (ev.timings.genPerSec || ev.timings.predicted_per_second);
      if (tps) setFoot(Math.round(tps) + ' tok/s');
      return;
    }
    if (ev.type === 'error') {
      var t6 = ensureAssistant();
      t6.error = ev.message;
      t6.body.insertBefore(el('div', { class: 'chat-error' }, '⚠ ' + ev.message), actionsAnchor(t6));
      toast(String(ev.message), 'err');
      return;
    }
    if (ev.type === 'done') {
      if (ev.session) S.sessionId = ev.session;
      var t7 = S.current;
      if (t7) {
        // The closing frame carries the text the server persisted: it is authoritative,
        // so an answer whose token frames never reached the page still gets painted.
        paintAnswer(t7, ev.text);
        (t7.parts || []).forEach(function (x) {
          if (x.type !== 'text') return;
          x.open = false;
          // redraw without the streaming caret: closing the part is not enough, the
          // caret is a span inside the rendered node
          if (x.node) x.node.innerHTML = ChatRender.markdown(x.content || '');
        });
        if (t7.thinkWrap) t7.thinkWrap.open = false;
        t7.status = ev.error ? 'error' : 'done';
        t7.parts.forEach(function (x) { if (x.type === 'tool' && x.status === 'running') { x.status = 'error'; ChatRender.paintTool(x); } });
        // refresh the action row so it can show token counts
        var oldActions = t7.body.querySelector('.chat-actions');
        if (oldActions) oldActions.parentNode.removeChild(oldActions);
        t7.meta = {
          model: ev.model || S.model,
          durationMs: ev.durationMs,
          tokensOut: ev.usage ? ev.usage.tokensOut : (S.usage && S.usage.tokensOut)
        };
        // the action row and a collapsing reasoning block change the height after the
        // last token, so stick to the bottom only for a reader who was already there
        var stick = nearBottom();
        t7.body.appendChild(ChatRender.actionsRow(t7));
        ChatRender.pruneRegen(t7, S.turns);
        if (stick) scrollBottom();
      }
      S.current = null;
      updateHead();
      refreshSessions();
      return;
    }
  }

  // One pump for every kind of turn: a new question, an edited question and a
  // regeneration all speak the same contract (ChatApi.stream).
  async function runTurn(body, opts) {
    uiBusy(true);
    S.abort = new AbortController();
    try {
      await ChatApi.stream(body, { signal: S.abort.signal, onFrame: applyFrame });
      if (S.current) applyFrame({ type: 'done' });
      // Whatever the frames did, the turn must not end on an empty answer: if nothing is
      // painted, read the stored conversation (the same thing a reload renders) and paint
      // it now instead of asking the operator to reload.
      var lastAssistant = null;
      for (var i = S.turns.length - 1; i >= 0; i -= 1) {
        if (S.turns[i].role === 'assistant') { lastAssistant = S.turns[i]; break; }
      }
      if (lastAssistant && !ChatRender.assistantText(lastAssistant) && !lastAssistant.error) {
        reconcileAnswer(lastAssistant);
      }
    } catch (e) {
      // A stopped turn keeps the cards it painted, but no card may look alive.
      if (e.name === 'AbortError') markInterrupted(S.current);
      // A 401 already sent the tab to /login; an error toast would flash over it.
      if (e.name !== 'AbortError' && e.status !== 401) {
        toast(String((e && e.message) || e), 'err');
        // A rewrite the server refused never happened: reload the stored truth rather
        // than leave the page showing a question the store does not have.
        if (e.notAccepted && opts && opts.resync && S.sessionId) {
          openSession(S.sessionId);
        } else {
          var t = ensureAssistant();
          t.error = String((e && e.message) || e);
          t.body.insertBefore(el('div', { class: 'chat-error' }, '⚠ ' + t.error), actionsAnchor(t));
        }
      }
      S.current = null;
    } finally {
      uiBusy(false);
      S.abort = null;
      updateHead();
      refreshSessions();
      var inp = byId('chat-input');
      if (inp) inp.focus();
    }
  }

  async function send() {
    var input = byId('chat-input');
    if (!input || S.streaming) return;
    var text = input.value.trim();
    if (!text) return;
    if (!S.modelId) { toast('the model menu is still loading', 'err'); return; }

    var userTurn = pushUser(text);
    appendTurn(userTurn);
    input.value = ''; autoGrow();
    S.current = null;
    S.usage = null;
    setFoot('');
    return runTurn({
      session: S.sessionId || undefined,
      model: S.modelId,
      preset: S.presetId,
      messages: [{ role: 'user', content: text }]
    });
  }

  // ── sessions ───────────────────────────────────────────────────────────────
  // Transcript entries → render turns. The server keeps the transcript beside the model
  // messages precisely so a reload is a redraw, not a replay.
  function loadTranscript(doc) {
    var turns = [];
    var assistant = null;
    var ordinal = 0;

    function ensure() {
      if (!assistant) {
        assistant = { role: 'assistant', parts: [], thinking: '', status: 'done' };
        turns.push(assistant);
      }
      return assistant;
    }
    (doc.transcript || []).forEach(function (e) {
      if (e.type === 'user') {
        turns.push({ role: 'user', content: e.content || '', ordinal: ordinal++ });
        assistant = null;
        return;
      }
      if (e.type === 'assistant') {
        var a = ensure();
        a.parts.push({ type: 'text', content: e.content || '', open: false });
        a.meta = { model: e.model || null, durationMs: e.durationMs, tokensOut: e.tokensOut };
        assistant = null;              // the next tool/answer belongs to a new block
        return;
      }
      if (e.type === 'tool_call') {
        ensure().parts.push({ type: 'tool', id: e.id, tool: e.tool, args: e.args, status: 'running' });
        return;
      }
      if (e.type === 'tool_result') {
        var t = ensure();
        var part = null;
        for (var i = 0; i < t.parts.length; i++) if (t.parts[i].id === e.id) part = t.parts[i];
        if (!part) { part = { type: 'tool', id: e.id, tool: e.tool, args: {}, status: 'running' }; t.parts.push(part); }
        part.ok = !!e.ok; part.blocked = !!e.blocked; part.reason = e.reason || null;
        part.output = e.output; part.durationMs = e.durationMs;
        part.status = part.blocked ? 'blocked' : (part.ok ? 'ok' : 'error');
        return;
      }
      if (e.type === 'approval') {
        ensure().parts.push({ type: 'approval', id: e.id, tool: e.tool, command: e.command, tier: e.tier, reason: e.reason || '', decision: null });
        return;
      }
      if (e.type === 'approval_result') {
        var ps = ensure().parts;
        for (var k = 0; k < ps.length; k++) if (ps[k].id === e.id) ps[k].decision = e.decision;
      }
      // `interrupted` is the marker the server appends when the operator stops a turn; the
      // cards it left behind are settled by the sweep below, which also covers transcripts
      // written before the marker existed.
    });
    turns.forEach(function (t) {
      (t.parts || []).forEach(function (p) {
        if (p.type !== 'tool' || p.status !== 'running') return;
        p.status = 'error';
        p.interrupted = true;
        if (!p.output) p.output = 'turn interrupted — no result recorded';
      });
    });
    // Sessions written before the transcript existed: fall back to the messages.
    if (!turns.length && doc.messages) {
      var fallbackOrdinal = 0;
      doc.messages.forEach(function (m) {
        if (m.role === 'user') turns.push({ role: 'user', content: m.content, ordinal: fallbackOrdinal++ });
        else if (m.role === 'assistant' && m.content) {
          turns.push({ role: 'assistant', parts: [{ type: 'text', content: m.content, open: false }], thinking: '', status: 'done' });
        }
      });
    }
    return turns;
  }

  function openSession(id) {
    return ChatApi.session(id)
      .then(function (doc) {
        if (!doc || !doc.id) throw new Error('session not found');
        S.sessionId = doc.id;
        S.title = doc.title;
        S.turns = loadTranscript(doc);
        S.current = null;
        applyPresetId(doc.preset || S.presetId);
        if (doc.model && doc.model.id) { S.modelId = doc.model.id; S.model = doc.model.model; S.profile = doc.model.profile; S.egress = doc.model.egress; }
        S.userCount = S.turns.filter(function (t) { return t.role === 'user'; }).length;
        renderAll();
        updateHead();
      })
      .catch(function (e) { toast('cannot open conversation: ' + (e.message || e), 'err'); });
  }

  function resumeLast() {
    if (S.turns.length || S.sessionId) return Promise.resolve();
    return ChatApi.sessions(1)
      .then(function (d) {
        var s = d && d.sessions && d.sessions[0];
        if (!s) return null;
        return openSession(s.id);
      })
      .catch(function () { /* a fresh console has no sessions */ });
  }

  // ── approvals ──────────────────────────────────────────────────────────────
  function decide(part, decision) {
    if (part.decision) return;
    part.state.textContent = 'sending ' + decision + '…';
    ChatApi.approval(part.id, decision).then(function () {
      if (!part.decision) { part.decision = decision === 'approve' ? 'approve' : 'deny'; ChatRender.paintApproval(part); }
    }).catch(function (e) {
      part.state.textContent = '';
      toast('approval failed: ' + (e.message || e), 'err');
    });
  }


  // ── mount ──────────────────────────────────────────────────────────────────
  function seat(kind, label) {
    var pop = el('div', { id: 'chat-' + kind + '-pop', class: 'chat-pop', role: 'listbox', hidden: true });
    var btn = el('button', {
      id: 'chat-' + kind + '-btn', type: 'button', class: 'chat-pill',
      'aria-haspopup': 'listbox', 'aria-expanded': 'false'
    }, [
      el('span', { class: 'chat-pill-mark' }, kind === 'model' ? '◈' : '❯'),
      el('span', { id: 'chat-' + kind + '-label', class: 'chat-pill-label' }, label),
      el('span', { class: 'chat-pill-caret', 'aria-hidden': 'true' }, '▾')
    ]);
    btn.addEventListener('click', function (e) { e.stopPropagation(); toggleMenu(kind); });
    return el('div', { class: 'chat-seat' }, [btn, pop]);
  }

  function mount(pane) {
    pane.innerHTML = '';

    var side = el('aside', { id: 'chat-side', class: 'chat-side' }, [
      el('div', { class: 'chat-brand' }, [
        el('img', { class: 'chat-brand-mark', src: '/img/mark.webp', alt: '', width: '30', height: '30' }),
        el('div', { class: 'chat-brand-text' }, [
          el('b', null, 'CYBOROS'),
          el('span', null, 'operator assistant')
        ])
      ]),
      el('button', { id: 'chat-new', class: 'chat-new', type: 'button' }, '＋  New chat'),
      el('div', { class: 'chat-side-label' }, 'Conversations'),
      el('nav', { id: 'chat-sessions', class: 'chat-sessions', 'aria-label': 'Past conversations' }),
      el('div', { class: 'chat-side-foot' }, [
        el('span', { id: 'chat-role', class: 'chat-meta' }, ''),
        el('span', { class: 'chat-side-brand' }, 'same loop as the CLI')
      ])
    ]);

    var head = el('header', { class: 'chat-head' }, [
      el('button', {
        id: 'chat-side-toggle', class: 'chat-iconbtn', type: 'button',
        'aria-label': 'Toggle the conversation list', 'aria-expanded': 'true'
      }, '☰'),
      el('div', { class: 'chat-head-title' }, [
        el('span', { id: 'chat-title', class: 'chat-title-text' }, 'New conversation'),
        el('span', { id: 'chat-sub', class: 'chat-meta' }, '')
      ]),
      el('div', { class: 'chat-head-right' }, [
        el('span', { id: 'chat-preset-chip', class: 'chat-chip' }, ''),
        el('button', {
          id: 'chat-settings-open', class: 'chat-iconbtn', type: 'button',
          'aria-label': 'Chat settings', 'aria-haspopup': 'dialog'
        }, '⚙')
      ])
    ]);

    var list = el('div', { id: 'chat-list', class: 'chat-list', role: 'log', 'aria-live': 'polite' });
    var scroll = el('div', { class: 'chat-scroll' }, [el('div', { class: 'chat-col' }, [list])]);

    var input = el('textarea', {
      id: 'chat-input', class: 'chat-input', rows: '1', spellcheck: 'false',
      placeholder: 'Message Cyboros — it answers, and acts when the preset allows it',
      'aria-label': 'Message'
    });
    var form = el('form', { id: 'chat-form', class: 'chat-composer' }, [
      input,
      el('div', { class: 'chat-compose-row' }, [
        seat('model', 'model'),
        seat('preset', 'preset'),
        el('span', { id: 'chat-egress', class: 'chat-egress local' }, 'local'),
        el('span', { class: 'chat-grow' }),
        el('button', { id: 'chat-stop', class: 'chat-send chat-stop', type: 'button', 'aria-label': 'Stop', hidden: true }, '■'),
        el('button', { id: 'chat-send', class: 'chat-send', type: 'submit', 'aria-label': 'Send', disabled: true }, '↑')
      ])
    ]);
    var under = el('div', { class: 'chat-under' }, [
      el('span', { id: 'chat-foot', class: 'chat-foot' }, ''),
      el('span', { class: 'chat-hint' }, 'Enter to send · Shift+Enter for a newline')
    ]);
    var main = el('div', { class: 'chat-main' }, [head, scroll, el('div', { class: 'chat-compose-wrap' }, [form, under])]);

    var dialog = el('div', { id: 'chat-settings', class: 'chat-settings', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'chat-set-title', hidden: true });

    pane.appendChild(el('div', { id: 'chat-root', class: 'chat-root' }, [side, main, dialog]));
    pane.dataset.mounted = '1';

    ChatRender.init({
      onEdit: startEdit,
      onRegenerate: regenerate,
      onDecide: decide,
      canRegenerate: function (t) { return !!S.sessionId && S.turns[S.turns.length - 1] === t; }
    });
    ChatSettings.init({
      getState: function () {
        return { models: S.models, presets: S.presets, settings: S.settings, context: S.context, me: S.me };
      },
      // Saved defaults apply to a NEW conversation; the current one keeps what it shows.
      onSaved: function (r) {
        if (r.settings) S.settings = r.settings;
        if (!S.turns.length) { applyDefaultModel(); applyDefaultPreset(); renderAll(); updateHead(); }
      }
    });

    // wiring
    byId('chat-side-toggle').addEventListener('click', function () { setSidebar(!S.sidebar); });
    byId('chat-new').addEventListener('click', newChat);
    byId('chat-settings-open').addEventListener('click', ChatSettings.open);
    dialog.addEventListener('click', function (e) { if (e.target === dialog) ChatSettings.close(); });
    byId('chat-stop').addEventListener('click', stop);
    form.addEventListener('submit', function (e) { e.preventDefault(); send(); });
    input.addEventListener('input', autoGrow);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
      if (e.key === 'Escape') closeMenus();
    });
    document.addEventListener('click', function (e) {
      var inSeat = e.target.closest && e.target.closest('.chat-seat');
      if (!inSeat) closeMenus();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (ChatSettings.isOpen()) { e.preventDefault(); ChatSettings.close(); }
    });

    if (!can('operator')) {
      byId('chat-send').disabled = true;
      byId('chat-send').title = 'requires the operator role';
      input.placeholder = 'Read-only role: the chat needs the operator role to start a turn';
    }

    // The rail starts closed on a narrow window and re-evaluates on every crossing.
    watchWidth();
    renderAll();
    boot();
    setTimeout(autoGrow, 0);
  }

  function boot() {
    if (S.booted) { updateHead(); return; }
    S.booted = true;
    Promise.all([
      ChatApi.models(),
      ChatApi.presets(),
      ChatApi.settings(),
      api('/api/auth/me').catch(function () { return null; })
    ]).then(function (r) {
      var models = r[0], pr = r[1], set = r[2];
      S.models = (models && models.models) || [];
      S.defaultModel = models && models.default;
      S.presets = (pr && pr.presets) || [];
      S.defaultPreset = (pr && pr.default) || (S.presets[0] && S.presets[0].id) || null;
      S.settings = (set && set.settings) || {};
      S.context = (set && set.context) || null;
      S.me = r[3];

      var wanted = S.settings.model || S.defaultModel;
      var entry = modelEntry(wanted) || S.models.find(function (m) { return m.available; });
      S.modelId = entry ? entry.id : null;
      if (entry) { S.profile = entry.profile; S.egress = entry.egress; }
      applyPresetId(S.settings.preset || S.defaultPreset);

      updateHead();
      renderAll();
      refreshSessions().then(resumeLast);
    }).catch(function (e) {
      toast('chat: ' + (e.message || e), 'err');
      var sub = byId('chat-sub'); if (sub) sub.textContent = String(e.message || e);
    });
  }

  function renderChat() {
    var pane = byId('tab-chat');
    if (!pane) return;
    if (pane.dataset.mounted === '1') {
      var i = byId('chat-input'); if (i) i.focus();
      return;
    }
    mount(pane);
  }

  window.renderChat = renderChat;
})();
