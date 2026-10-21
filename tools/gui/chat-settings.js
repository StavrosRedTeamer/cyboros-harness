/* Cyboros Console — the chat settings dialog.
   Seven sections over the server-owned turn settings: model default, preset default,
   temperature/max tokens/streaming, approval policy, the read-only data paths, the role
   readout, and the console theme.

   Why it is its own file: it is a complete surface with its own form, navigation and
   save path, and none of it belongs in the transcript view. It owns no state — every
   value is read from the server on open and written back through ChatApi; `onSaved`
   lets the view update the copy it caches and apply defaults to a not-yet-started chat.

   Requires app.js globals at call time: el, byId, toast. */
(function () {
  'use strict';

  var HOOKS = {
    getState: function () { return {}; },
    onSaved: function () {}
  };

  function init(hooks) {
    if (hooks) Object.assign(HOOKS, hooks);
  }

  function field(label, control, hint) {
    return el('label', { class: 'chat-set-field' }, [
      el('span', { class: 'chat-set-label' }, label),
      control,
      hint ? el('span', { class: 'chat-set-hint' }, hint) : null
    ]);
  }

  function readonlyRow(label, value) {
    return el('div', { class: 'chat-set-ro-row' }, [
      el('span', { class: 'chat-set-label' }, label),
      el('code', { class: 'chat-set-ro-val' }, value),
      el('span', { class: 'chat-set-ro' }, 'read-only')
    ]);
  }

  function panel() {
    var nav = el('nav', { class: 'chat-set-nav', 'aria-label': 'Settings sections' });
    var bodyBox = el('div', { class: 'chat-set-sections' });
    [
      ['model', 'Model'],
      ['preset', 'Preset'],
      ['generation', 'Generation'],
      ['approvals', 'Approvals'],
      ['storage', 'Data & sessions'],
      ['access', 'Role & access'],
      ['appearance', 'Appearance']
    ].forEach(function (s, i) {
      nav.appendChild(el('button', {
        type: 'button', class: 'chat-set-navitem' + (i === 0 ? ' is-active' : ''),
        'data-sec': s[0], onclick: function () { showSection(s[0]); }
      }, s[1]));
      bodyBox.appendChild(el('section', { class: 'chat-set-section', 'data-sec': s[0], hidden: i !== 0 }, section(s[0])));
    });

    var saveBtn = el('button', { id: 'chat-set-save', class: 'btn btn-primary', type: 'button' }, 'Save');
    saveBtn.addEventListener('click', save);
    var closeBtn = el('button', { id: 'chat-set-close', class: 'chat-iconbtn', type: 'button', 'aria-label': 'Close settings' }, '✕');
    closeBtn.addEventListener('click', close);

    return el('div', { class: 'chat-set-panel', role: 'document' }, [
      el('header', { class: 'chat-set-head' }, [el('h2', { id: 'chat-set-title' }, 'Chat settings'), closeBtn]),
      el('div', { class: 'chat-set-body' }, [nav, bodyBox]),
      el('footer', { class: 'chat-set-foot' }, [
        el('span', { id: 'chat-set-msg', class: 'chat-set-msg' }, ''),
        saveBtn
      ])
    ]);
  }

  function showSection(sec) {
    var dialog = byId('chat-settings');
    if (!dialog) return;
    dialog.querySelectorAll('.chat-set-navitem').forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.sec === sec);
    });
    dialog.querySelectorAll('.chat-set-section').forEach(function (s) {
      s.hidden = s.dataset.sec !== sec;
    });
  }

  function section(sec) {
    var state = HOOKS.getState();
    var st = state.settings || {};
    if (sec === 'model') {
      var sel = el('select', { id: 'chat-set-model', class: 'chat-set-input' });
      sel.appendChild(el('option', { value: '' }, 'Availability default'));
      (state.models || []).forEach(function (m) {
        var note = m.available ? '' : ' (' + (m.reason || 'n/a') + ')';
        sel.appendChild(el('option', {
          value: m.id, disabled: !m.available
        }, m.model + ' · ' + m.profile + note));
      });
      sel.value = st.model || '';
      return [
        el('p', { class: 'chat-set-intro' }, 'The model a NEW conversation starts with. Changing it in the composer only affects the conversation you are in.'),
        field('Default model', sel, 'Unavailable entries are disabled: cloud egress off or the key env is not set.')
      ];
    }
    if (sec === 'preset') {
      var box = el('div', { class: 'chat-set-presets' });
      (state.presets || []).forEach(function (p) {
        var input = el('input', { type: 'radio', name: 'chat-set-preset', value: p.id });
        input.checked = (st.preset || '') === p.id;
        box.appendChild(el('label', { class: 'chat-set-preset' + (input.checked ? ' is-active' : '') }, [
          input,
          el('span', { class: 'chat-set-preset-name' }, [p.label, p.readonly ? el('span', { class: 'chat-chip chat-chip-ro' }, 'read-only') : null]),
          el('span', { class: 'chat-set-hint' }, p.description || '')
        ]));
      });
      return [
        el('p', { class: 'chat-set-intro' }, 'What the model may do. Enforced by the server in two layers: the tool list it is offered, and the dispatch that refuses anything else.'),
        box,
        el('p', { class: 'chat-set-hint' }, 'Analysis can read findings, reports and sessions and cannot run anything. Conversation has no tools at all.')
      ];
    }
    if (sec === 'generation') {
      var temp = el('input', { id: 'chat-set-temp', class: 'chat-set-input', type: 'range', min: '0', max: '2', step: '0.05', value: String(st.temperature != null ? st.temperature : 0.2) });
      var tempOut = el('span', { class: 'chat-set-value' }, String(st.temperature != null ? st.temperature : 0.2));
      temp.addEventListener('input', function () { tempOut.textContent = temp.value; });
      var maxTok = el('input', { id: 'chat-set-maxtok', class: 'chat-set-input', type: 'number', min: '64', max: '32768', step: '1', value: String(st.max_tokens != null ? st.max_tokens : 2048) });
      var streamInput = el('input', { id: 'chat-set-stream', type: 'checkbox' });
      streamInput.checked = st.streaming !== false;
      return [
        el('p', { class: 'chat-set-intro' }, 'Applied to every turn by the server. These override the provider profile for chat turns only.'),
        field('Temperature', el('div', { class: 'chat-set-inline' }, [temp, tempOut]), 'Lower is more deterministic — 0.2 for evidence, higher for brainstorming.'),
        field('Max tokens', maxTok, 'Upper bound for one completion (64–32768).'),
        el('label', { class: 'chat-set-check' }, [streamInput, el('span', null, 'Stream tokens as they arrive'), el('span', { class: 'chat-set-hint' }, 'Off = one completion, then the whole answer. Same frames, one token frame.')])
      ];
    }
    if (sec === 'approvals') {
      var pol = el('select', { id: 'chat-set-policy', class: 'chat-set-input' });
      [['ask', 'Ask me for every intrusive tool (recommended)'], ['deny', 'Never allow intrusive tools']].forEach(function (o) {
        pol.appendChild(el('option', { value: o[0] }, o[1]));
      });
      pol.value = st.approval_policy || 'ask';
      return [
        el('p', { class: 'chat-set-intro' }, 'Intrusive tools are the ones tools/tool-registry.json marks risk_tier=intrusive (sqlmap, netexec, hydra, …). Non-intrusive recon is not gated here; scope-guard and run.js still apply to every call.'),
        field('Approval policy', pol, 'Deny refuses before the dialog is shown, so a distracted operator cannot be talked into it.'),
        el('div', { class: 'chat-set-note' }, [
          el('b', null, 'Unanswered approves nothing.'),
          el('span', null, ' An approval that times out is a denial, and a decision is single-use.')
        ])
      ];
    }
    if (sec === 'storage') {
      var ctx = state.context || {};
      return [
        el('p', { class: 'chat-set-intro' }, 'Where this console keeps conversations and engagement data. These come from the console config file — not from this form.'),
        readonlyRow('Data root', ctx.dataRoot || '—'),
        readonlyRow('Session storage', ctx.sessionsDir || '—'),
        readonlyRow('Settings file', ctx.settingsFile || '—'),
        readonlyRow('Conversations', String(ctx.sessions)),
        el('p', { class: 'chat-set-hint' }, 'To move them, edit path.reports / data_root in the console config and restart the server.')
      ];
    }
    if (sec === 'access') {
      var me = state.me || {};
      var user = me.user || {};
      return [
        el('p', { class: 'chat-set-intro' }, 'Your session, as the server sees it. Roles are enforced per request by tools/identity.js, not by this page.'),
        readonlyRow('Signed in as', user.username || '—'),
        readonlyRow('Role', user.role || '—'),
        readonlyRow('Role order', (me.roles || ['viewer', 'operator', 'admin']).join(' < ')),
        el('div', { class: 'chat-set-note' }, [
          el('b', null, 'Chat needs operator.'),
          el('span', null, ' A viewer can read the console but cannot start a turn or answer an approval; the server refuses the POST regardless of what the UI shows.')
        ])
      ];
    }
    return [
      el('p', { class: 'chat-set-intro' }, 'The console theme is shared with the topbar switch, so there is one theme state and one place that owns it.'),
      el('button', {
        id: 'chat-set-theme', class: 'btn', type: 'button',
        onclick: function () { var b = byId('btn-theme'); if (b) b.click(); }
      }, 'Switch theme (this browser)'),
      el('p', { class: 'chat-set-hint' }, 'Stored in this browser (localStorage), not on the server — the ouroboros mark and layout are the same in both themes.')
    ];
  }

  // Rebuilt on every open, so the fields always show what the server has now.
  function open() {
    var dialog = byId('chat-settings');
    if (!dialog) return;
    dialog.innerHTML = '';
    dialog.appendChild(panel());
    dialog.hidden = false;
    var first = dialog.querySelector('select, input');
    if (first) first.focus();
  }

  function close() {
    var d = byId('chat-settings');
    if (d) d.hidden = true;
  }

  function isOpen() {
    var d = byId('chat-settings');
    return !!d && !d.hidden;
  }

  function readForm() {
    var dialog = byId('chat-settings');
    if (!dialog) return null;
    var picked = dialog.querySelector('input[name="chat-set-preset"]:checked');
    return {
      model: byId('chat-set-model') ? (byId('chat-set-model').value || null) : null,
      preset: picked ? picked.value : null,
      temperature: byId('chat-set-temp') ? Number(byId('chat-set-temp').value) : undefined,
      max_tokens: byId('chat-set-maxtok') ? Number(byId('chat-set-maxtok').value) : undefined,
      streaming: byId('chat-set-stream') ? !!byId('chat-set-stream').checked : undefined,
      approval_policy: byId('chat-set-policy') ? byId('chat-set-policy').value : undefined
    };
  }

  function save() {
    var body = readForm();
    if (!body) return;
    var msg = byId('chat-set-msg');
    if (msg) msg.textContent = 'saving…';
    ChatApi.saveSettings(body).then(function (r) {
      if (msg) msg.textContent = 'saved · applies to the next turn';
      toast('chat settings saved', '');
      HOOKS.onSaved({ settings: r.settings });
    }).catch(function (e) {
      if (msg) msg.textContent = String(e.message || e);
      toast('settings: ' + (e.message || e), 'err');
    });
  }

  window.ChatSettings = { init: init, open: open, close: close, isOpen: isOpen };
})();
