// Console — chat: the operator's conversational surface over the SAME loop the CLI runs.
//
// Why it is shaped this way: the console must not grow a second agent engine. A turn
// here is local/llm.js#runAgent (native tool_calls + textual fallback + loop-guard),
// driving local/tools-bridge.js#makeDispatch (the guarded switch: scope-guard, rate
// limit, tool registry, record-finding validation) behind a preset allowlist, with the
// engagement prompt from runtime/live.js#systemFor. What this file adds is transport:
// SSE, an approval channel a browser can answer, model/preset discovery, and resumable
// conversations. Nothing in it decides whether a target may be touched.
//
// ── SSE contract ───────────────────────────────────────────────────────────────
// One JSON object per `data:` frame, frames separated by a blank line, `retry: 2000`
// first. Additive only: a client MUST ignore a `type` it does not know, and MUST NOT
// infer a refusal from prose — a blocked call always produces a tool_result frame with
// `blocked: true` and a `reason`.
//
//   meta            {session, model, modelId, profile, egress, preset, readonly, tools[]}
//                     first frame of every turn; `tools` is the preset's allowlist
//   session         {id, title}
//   start           {}                                   first assistant token arriving
//   thinking        {t}                                  reasoning delta (may be absent)
//   token           {t}                                  assistant text delta
//   tool_call       {id, tool, args}                     a tool is about to run
//   tool_result     {id, tool, ok, exit, durationMs, output, blocked?, reason?}
//                     reason: preset | approval | invalid-args
//   approval        {id, tool, args, command, tier, reason, expiresAt}
//                     answer with POST /api/chat/approval {id, decision}; failure to
//                     answer before expiresAt is a deny ("timeout"), never a grant
//   approval_result {id, decision}                       decision: approve|deny|stop|timeout
//   usage           {tokensIn, tokensOut, totalTokensIn, totalTokensOut, cost, source,
//                    costLabel, costText, costKnown, costPartial}
//                     `tokensIn`/`tokensOut`/`cost`/`source` are THIS call (cost null when
//                     neither the provider nor the profile had a price); `totalTokens*` and
//                     `costLabel`/`costText` are the CONVERSATION's, rendered by
//                     runtime/usage.js. A footer can therefore pair tokens with the cost
//                     label and both are the same quantity.
//   timings         {timings}                            provider timings, when reported
//   error           {message}                            turn failed; followed by done
//   done            {session, text, stopped, error?, usage}
//                     usage: {tokensIn, tokensOut, cost, costLabel, costText, costKnown,
//                             costPartial, requests, totalTokensIn, totalTokensOut}
//                     tokensIn/Out are THIS turn; cost and the cost* fields are the
//                     conversation's rollup (the same one the CLI calls `/cost`)
//
// Cost is not formatted here and not in the browser: `runtime/usage.js` owns the
// ledger, the unknown/floor rules and the label, exactly as it does for the CLI. The
// console's conversation store keeps its usage in the same shape, so a bill shown in a
// browser is the bill the terminal would report for that usage.
//
// Role: POST stays operator-only (tools/identity.js), viewer keeps the read endpoints.
// Egress: a cloud profile is used only when the config sets allow_cloud AND the key is
// present; local loopback profiles remain the default, as before.
'use strict';
const path = require('node:path');
const { sendJson } = require('./http');
const live = require('../../runtime/live');
const { LocalLLM } = require('../../local/llm');
const presets = require('./chat-presets');
const { createChatSessions } = require('./chat-sessions');
const { createChatSettings } = require('./chat-settings');
const { createAsyncRunner, createApprovalBroker, createChatDispatch } = require('./chat-tools');
// The one ledger and the one formatter (runtime/usage.js): a conversation's cost is
// accumulated by the same owner as a session's, so the two surfaces cannot disagree. The
// continuity module is deliberately NOT required here — this surface keeps its own store
// and has no business loading a resumable session file to format money.
const usage = require('../../runtime/usage');

const WORKSPACE = path.join(__dirname, '..', '..');
const MAX_INPUT_CHARS = 24000;

// The stored transcript is what a reload redraws AND the index an edit addresses:
// "rewrite from user turn #n" has to mean the same thing to the client, the store and
// the model history. Cutting at the ordinal (not at a raw array index) is what keeps
// tool frames from shifting that arithmetic.
function cutTranscript(list, ordinal) {
  const before = [];
  let seen = -1;
  let user = null;
  for (const entry of Array.isArray(list) ? list : []) {
    if (entry && entry.type === 'user') {
      seen += 1;
      if (seen === ordinal) { user = entry; break; }
    }
    before.push(entry);
  }
  return { before, user };
}

function createChat(opts = {}) {
  // Tool processes always run against the REPOSITORY (tools/… are code), while the
  // conversations live under the DATA ROOT the console was configured with.
  const sessions = createChatSessions({ dir: opts.sessionsDir || path.join(opts.root || WORKSPACE, 'app', 'chat') });
  const approvals = createApprovalBroker({ ttlMs: opts.approvalTtlMs });
  // Server-owned turn settings: the menu writes here, and every turn reads here.
  const settings = createChatSettings({
    file: opts.settingsFile || path.join(opts.root || WORKSPACE, 'app', 'chat', 'settings.json'),
  });
  // The engagement the dashboard shows is the one the read-only tools must see, even
  // when the data root is not the checkout. Child tools take these from the env.
  const reportsDir = opts.reportsDir || path.join(WORKSPACE, 'reports');
  const toolEnv = {
    FINDINGS_JSONL: path.join(reportsDir, 'findings.jsonl'),
    CYBOROS_AGENT_DIR: path.join(reportsDir, 'agent', 'sessions'),
  };
  const runner = createAsyncRunner({ cwd: WORKSPACE, env: toolEnv });

  function inferEgress(baseUrl) {
    return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(String(baseUrl)) ? 'local' : 'cloud';
  }

  // One load of the provider file, two views over it: `profiles` (what the old chat
  // endpoint exposed) and `models` (what the picker needs). Both come from the same
  // availability rules, so the menu can never offer what the turn would refuse.
  function loadInfo(configPath) {
    let loaded, cfg;
    try {
      loaded = live.loadConfig(configPath);
      cfg = loaded.cfg;
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
    const profiles = [];
    for (const [name, p] of Object.entries(cfg.profiles)) {
      const egress = p.egress || inferEgress(p.base_url);
      let host = p.base_url;
      try { host = new URL(p.base_url).host; } catch { /* keep raw */ }
      // The key is resolved the way the TURN will resolve it — environment first, then
      // the operator's per-profile key file. Checking only process.env disabled a cloud
      // profile whose key lives in ~/.config/cyboros/<profile>.env, even though a turn
      // on it would have run: the menu refused what the runtime accepts.
      let keyPresent = !p.api_key_env;
      let keyError = null;
      if (p.api_key_env) {
        try { keyPresent = !!live.resolveKey(name, p.api_key_env).key; }
        catch (e) { keyError = String((e && e.message) || e); keyPresent = false; }
      }
      const available = egress === 'local' ? true : (!!cfg.allow_cloud && keyPresent);
      profiles.push({
        name, model: p.model, egress, host, cloud: egress === 'cloud',
        available, keyEnv: p.api_key_env || null, keyPresent,
        reason: available ? null
          : (egress === 'cloud' && !cfg.allow_cloud ? 'cloud egress disabled (allow_cloud=false)'
            : keyError ? keyError
            : (!keyPresent ? ('no key: set $' + p.api_key_env + ' or add it to ' + live.keyFileFor(name)) : 'unavailable')),
      });
    }
    // Default prefers an AVAILABLE LOCAL profile — the harness's zero-cloud-egress
    // opsec: the chat never silently defaults to a cloud provider, even when the
    // config's default_profile is a cloud one.
    const avail = profiles.filter((o) => o.available);
    const localAvail = avail.find((o) => o.egress === 'local');
    let def;
    if (localAvail) def = localAvail.name;
    else if (profiles.find((o) => o.name === cfg.default_profile && o.available)) def = cfg.default_profile;
    else def = (avail[0] && avail[0].name) || cfg.default_profile || (profiles[0] && profiles[0].name);
    return { loaded, cfg, profiles, default: def, allowCloud: !!cfg.allow_cloud };
  }

  function chatProfiles() {
    const info = loadInfo(opts.configPath);
    if (info.error) return { error: info.error, profiles: [] };
    return { profiles: info.profiles, default: info.default, allowCloud: info.allowCloud };
  }

  // A profile may declare `models: [...]` to expose several models on one endpoint;
  // otherwise it exposes its single configured model. The id is what the client sends
  // back — the profile name for the first model, `profile:model` for the rest.
  function chatModels() {
    const info = loadInfo(opts.configPath);
    if (info.error) return { error: info.error, models: [] };
    const models = [];
    for (const p of info.profiles) {
      const raw = info.cfg.profiles[p.name] || {};
      const list = Array.isArray(raw.models) && raw.models.length ? raw.models : [p.model];
      list.forEach((m, i) => {
        models.push({
          id: i === 0 ? p.name : `${p.name}:${String(m)}`,
          label: String(m),
          profile: p.name,
          model: String(m),
          egress: p.egress,
          host: p.host,
          cloud: p.cloud,
          available: p.available,
          reason: p.reason,
        });
      });
    }
    return { models, default: info.default, allowCloud: info.allowCloud };
  }

  function presetList() {
    return { presets: presets.list(), default: presets.DEFAULT_ID };
  }

  // What the settings dialog renders. `context` is read-only on purpose: the data
  // root and the session store come from the console's config file, not from a form.
  function settingsPayload() {
    return {
      settings: settings.get(),
      defaults: settings.defaults,
      policies: settings.policies,
      context: {
        dataRoot: opts.root || WORKSPACE,
        sessionsDir: sessions.dir,
        settingsFile: settings.file,
        workspace: WORKSPACE,
        sessions: sessions.list(1000).length,
        editable: false,
      },
    };
  }

  // Model/preset defaults are validated against the same lists the menus render, so a
  // settings write can never point a turn at something the provider file does not offer.
  function saveSettings(patch) {
    const p = Object.assign({}, patch || {});
    if (p.model) {
      const menu = chatModels();
      if (menu.error) return { ok: false, error: menu.error, problems: [menu.error] };
      if (!menu.models.some((m) => m.id === p.model)) {
        const error = `unknown model "${p.model}"`;
        return { ok: false, error, problems: [error] };
      }
    }
    if (p.preset && !presets.get(p.preset)) {
      const error = `unknown preset "${p.preset}"`;
      return { ok: false, error, problems: [error] };
    }
    return settings.save(p);
  }

  // The model and the preset belong to the conversation, not to the tab that selected
  // them. Persisting on selection is what makes "pick, reload, still picked" true even
  // when no turn has run since the switch; the availability rules are the same ones the
  // turn applies, so a stored choice is always one a turn would accept.
  function updateSession(id, body) {
    const doc = sessions.get(String(id || ''));
    if (!doc) return { ok: false, status: 404, error: 'unknown session' };
    const patch = {};
    if (body && body.model !== undefined) {
      const menu = chatModels();
      if (menu.error) return { ok: false, status: 500, error: menu.error };
      const wanted = String(body.model || '');
      const chosen = menu.models.find((m) => m.id === wanted);
      if (!chosen) {
        return { ok: false, status: 400, error: `unknown model "${wanted}" · available: ${menu.models.map((m) => m.id).join(', ')}` };
      }
      if (!chosen.available) {
        return { ok: false, status: 400, error: `model "${chosen.id}" unavailable: ${chosen.reason || 'n/d'}` };
      }
      patch.model = chosen;
    }
    if (body && body.preset !== undefined) {
      const preset = presets.get(body.preset);
      if (!preset) {
        return { ok: false, status: 400, error: `unknown preset "${body.preset}" · available: ${presets.PRESETS.map((p) => p.id).join(', ')}` };
      }
      patch.preset = preset.id;
    }
    if (!Object.keys(patch).length) return { ok: false, status: 400, error: 'model or preset required' };
    sessions.save(doc.id, patch);
    return { ok: true, session: { id: doc.id, model: patch.model || doc.model || null, preset: patch.preset || doc.preset || null } };
  }

  function sanitize(messages) {
    return (Array.isArray(messages) ? messages : [])
      .slice(-40)
      .map((x) => ({
        role: ['system', 'user', 'assistant'].includes(x && x.role) ? x.role : 'user',
        content: String((x && x.content) || '').slice(0, MAX_INPUT_CHARS),
      }))
      .filter((x) => x.role !== 'system' && x.content);
  }

  async function chatStream(req, res, body) {
    // Two rewrites of a stored conversation, both addressed by the ordinal of a USER
    // turn: `regenerate` re-runs the last question, `edit` replaces one question and
    // drops everything after it. The client never sends a message array for these —
    // the store is what the rewrite is applied to.
    const edit = body && body.edit && typeof body.edit === 'object' ? body.edit : null;
    const regenerate = !!(body && body.regenerate === true);
    const messages = sanitize(body && body.messages);
    if (!messages.length && !edit && !regenerate) {
      return sendJson(res, 400, { error: 'messages[] required' });
    }

    const current = settings.get();
    const presetId = String((body && body.preset) || current.preset || presets.DEFAULT_ID);
    const preset = presets.get(presetId);
    if (!preset) {
      return sendJson(res, 400, {
        error: `unknown preset "${presetId}" · available: ${presets.PRESETS.map((p) => p.id).join(', ')}`,
      });
    }

    // Resolve the requested model against the SAME availability view the picker uses:
    // an unavailable entry is refused here rather than attempted against the provider.
    const wanted = String((body && (body.model || body.profile)) || '');
    const menu = chatModels();
    if (menu.error) return sendJson(res, 500, { error: menu.error });
    const chosen = menu.models.find((m) => m.id === (wanted || current.model || menu.default));
    if (!chosen) {
      return sendJson(res, 400, {
        error: `unknown model "${wanted || '(none)'}" · available: ${menu.models.map((m) => m.id).join(', ')}`,
      });
    }
    if (!chosen.available) {
      return sendJson(res, 400, { error: `model "${chosen.id}" unavailable: ${chosen.reason || 'n/d'}` });
    }

    let loaded, prof;
    try {
      loaded = live.loadConfig(opts.configPath);
      prof = live.resolveProfile(loaded.cfg, chosen.profile);
    } catch (e) {
      return sendJson(res, 400, { error: String((e && e.message) || e) });
    }
    const egress = prof.egress || chosen.egress;
    if (egress === 'cloud' && !loaded.cfg.allow_cloud) {
      return sendJson(res, 403, { error: `profile "${prof.profile}" uses cloud egress but allow_cloud=false` });
    }
    let key = '';
    try { key = (live.resolveKey(prof.profile, prof.p.api_key_env) || {}).key || ''; }
    catch (e) { return sendJson(res, 400, { error: String((e && e.message) || e) }); }
    if (!key) key = egress === 'local' ? 'sk-local' : '';
    if (egress === 'cloud' && !key) {
      return sendJson(res, 400, {
        error: `no API key for cloud profile "${prof.profile}"${prof.p.api_key_env ? ' — set $' + prof.p.api_key_env : ''}`,
      });
    }

    // Resume: a known session owns the conversation so far. The client's last message
    // is the new task; earlier client messages are ignored when the store already has
    // them (a reload sends the task, not the whole transcript).
    const wantedSession = String((body && body.session) || '');
    let stored = null;
    if (wantedSession) {
      stored = sessions.get(wantedSession);
      if (!stored) return sendJson(res, 400, { error: `unknown session "${wantedSession}"` });
    }
    const target = String((body && body.target) || (stored && stored.target) || '') || null;

    let history, task, transcript;
    const now = new Date().toISOString();
    if (edit || regenerate) {
      if (!stored) return sendJson(res, 400, { error: 'edit/regenerate needs an existing session' });
      const base = stored.messages.slice();
      let ordinal = -1;
      if (edit) {
        const want = Number(edit.user);
        if (!Number.isInteger(want) || want < 0) {
          return sendJson(res, 400, { error: 'edit.user must be a user-turn ordinal' });
        }
        let seen = -1;
        let at = -1;
        for (let i = 0; i < base.length; i += 1) {
          if (base[i].role === 'user') {
            seen += 1;
            if (seen === want) { at = i; break; }
          }
        }
        if (at < 0) return sendJson(res, 400, { error: `unknown user turn #${want}` });
        const content = String((edit.content != null && edit.content) || '').trim().slice(0, MAX_INPUT_CHARS);
        if (!content) return sendJson(res, 400, { error: 'edit.content required' });
        base.splice(at, base.length - at, { role: 'user', content });
        task = content;
        ordinal = want;
      } else {
        let at = -1;
        for (let i = base.length - 1; i >= 0; i -= 1) if (base[i].role === 'user') { at = i; break; }
        if (at < 0) return sendJson(res, 400, { error: 'nothing to regenerate' });
        base.splice(at + 1, base.length - at - 1);
        task = String(base[at].content || '');
        ordinal = base.slice(0, at + 1).filter((m) => m.role === 'user').length - 1;
      }
      const cut = cutTranscript(stored.transcript, ordinal);
      if (!cut.user) {
        return sendJson(res, 400, { error: 'session transcript is out of sync — start a new conversation' });
      }
      history = base.slice(0, -1);
      // The trimmed conversation is what the turn runs on AND what the store keeps, so
      // persist it before the model is called: a provider failure must not leave the
      // old answer standing next to a transcript that no longer contains it.
      transcript = cut.before.slice();
      transcript.push(edit ? { type: 'user', content: task, ts: now } : cut.user);
      sessions.save(stored.id, {
        messages: base, transcript, title: task, model: chosen, preset: preset.id, target,
      });
    } else {
      if (!messages.length) return sendJson(res, 400, { error: 'messages[] required' });
      history = stored && stored.messages.length ? stored.messages : messages.slice(0, -1);
      task = messages[messages.length - 1].content;
      // Accumulate, never replace: a resumed turn used to overwrite the redraw
      // transcript with its own frames, so a reload showed only the last exchange.
      transcript = stored && Array.isArray(stored.transcript) ? stored.transcript.slice() : [];
      transcript.push({ type: 'user', content: task, ts: now });
    }
    const doc = stored || sessions.create({ model: chosen, preset: preset.id, target, title: task });

    const system = [
      live.systemFor({ target, phase: 'web-test', klass: null, egress, mode: preset.mode }),
      presets.systemAddendum(preset),
    ].filter(Boolean).join('\n\n');

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    let aborted = false;
    let finished = false;
    // What the operator has SEEN is the transcript, so it is written as it happens — not
    // only when the turn completes. A stopped or crashed turn used to leave the stored
    // conversation empty while the page showed twelve tool cards; reopening it from the
    // rail then showed an empty thread. Structural frames are the few, meaningful points
    // (a tool call, its result, a gate), so saving on them costs a handful of atomic
    // writes per turn and makes an abort recoverable.
    const persist = () => {
      try {
        sessions.save(doc.id, { transcript, title: task, model: chosen, preset: preset.id, target });
      } catch { /* a failed snapshot must not break the live turn */ }
    };
    let stopped = false;
    // Both sides are watched: an aborted request may surface as `req` closing or as the
    // response socket going away, depending on when the client leaves.
    const stopSnapshot = () => {
      if (finished || stopped) return;
      stopped = true;
      aborted = true;
      // Stopped mid-turn: keep exactly what was emitted, and say the turn was cut so
      // unfinished tool cards are not redrawn as if they were still running.
      transcript.push({ type: 'interrupted', ts: new Date().toISOString() });
      persist();
    };
    req.on('close', stopSnapshot);
    res.on('close', stopSnapshot);

    const send = (ev) => {
      if (aborted) return;
      try { res.write('data: ' + JSON.stringify(ev) + '\n\n'); } catch { /* client gone */ }
    };
    const emit = (ev) => {
      // After the stop the turn may keep running inside the model loop, but those frames
      // were never shown to anyone: recording them would reopen a conversation with
      // cards the operator never saw.
      if (stopped) return;
      let structural = false;
      if (ev.type === 'tool_call' || ev.type === 'tool_result') {
        transcript.push(ev.type === 'tool_call'
          ? { type: 'tool_call', id: ev.id, tool: ev.tool, args: ev.args }
          : { type: 'tool_result', id: ev.id, tool: ev.tool, ok: !!ev.ok, blocked: !!ev.blocked, reason: ev.reason || null, output: ev.output });
        structural = true;
      } else if (ev.type === 'approval') {
        transcript.push({ type: 'approval', id: ev.id, tool: ev.tool, command: ev.command, tier: ev.tier, reason: ev.reason || null });
        structural = true;
      } else if (ev.type === 'approval_result') {
        transcript.push({ type: 'approval_result', id: ev.id, decision: ev.decision });
        structural = true;
      }
      send(ev);
      if (structural) persist();
    };
    // The question itself is saved before the model is called, so even a turn that dies
    // at the first frame is a conversation the operator can open.
    persist();

    emit({
      type: 'meta', session: doc.id, model: chosen.model, modelId: chosen.id,
      profile: prof.profile, egress, preset: preset.id,
      readonly: preset.mode !== 'operate', tools: preset.tools.slice(),
      streaming: current.streaming, approvalPolicy: current.approval_policy,
    });
    emit({ type: 'session', id: doc.id, title: doc.title });

    // What this conversation has spent so far, restored from its own store: a turn adds to
    // the bill instead of reporting only its own calls. `stored.usage` written before the
    // rollup existed is a flat number, which normalizeUsage keeps as `unattributed` —
    // preserved, not attributed to a source it never had.
    let rollup = usage.normalizeUsage(stored && stored.usage);
    // The per-message badge counts this turn; the rollup counts the conversation. Two
    // numbers, one accumulator each, and neither is derived from the other.
    let turnIn = 0;
    let turnOut = 0;
    const costFrame = () => {
      const v = usage.costView(rollup);
      return {
        costLabel: usage.costBadge(v),
        costText: usage.costText(v),
        costKnown: v.known,
        costPartial: v.partial,
      };
    };
    const usageFrame = () => {
      const v = usage.costView(rollup);
      return Object.assign({
        tokensIn: turnIn,
        tokensOut: turnOut,
        totalTokensIn: rollup.tokens_in,
        totalTokensOut: rollup.tokens_out,
        requests: rollup.requests,
        // `cost` is the amount when one exists (a floor, if partial — the flags say
        // which); null when nothing was priced, never 0 as a stand-in for unknown.
        cost: v.known ? v.amount : null,
      }, costFrame());
    };
    const turnStarted = Date.now();
    let text = '';
    const llm = new LocalLLM({
      // The profile's declared type and capabilities travel with the model choice: the
      // request builder sends only what this endpoint declares it accepts.
      type: prof.p.type || 'openai-compatible',
      capabilities: prof.p.capabilities,
      endpoint: { base_url: prof.p.base_url, model: chosen.model, api_key: key },
      sampling: {
        temperature: current.temperature,
        top_p: prof.p.top_p ?? 0.9,
        max_tokens: current.max_tokens,
      },
      runtime: {
        max_tool_iters: preset.max_iters ?? prof.p.max_tool_iters ?? 12,
        max_tool_calls: prof.p.max_tool_calls,
        // No `native_tools` here: the tool-calling style is the profile's declaration,
        // not a per-surface assumption. A text-only profile still gets the ACTION: parser.
        text_protocol_fallback: true,
        use_grammar: false,
        context_char_budget: prof.p.context_char_budget ?? 40000,
        // Same budget resolution as the CLI loop: the model window wins over the legacy
        // char field, so a turn is not sized off a 15k-token assumption.
        context_window_tokens: prof.p.context_window_tokens,
        reserved_output_tokens: prof.p.reserved_output_tokens,
        context_safety_tokens: prof.p.context_safety_tokens,
        tool_output_clip_chars: prof.p.tool_output_clip_chars ?? 4000,
        request_timeout_ms: prof.p.request_timeout_ms ?? 180000,
        retries: prof.p.retries ?? 1,
        retry_backoff_ms: prof.p.retry_backoff_ms ?? 1500,
        loop_guard: prof.p.loop_guard || { max_repeats: 1, fuzzy: true, fuzzy_threshold: 0.85, exempt_tools: ['run_tool'] },
      },
    });

    const dispatch = createChatDispatch({
      preset,
      emit,
      approve: (spec, e) => approvals.request(spec, e),
      runner,
      env: toolEnv,
      readRoots: [reportsDir],
      reportRoots: [reportsDir],
      approvalPolicy: current.approval_policy,
      noCache: true,
    });

    try {
      const result = await llm.runAgent({
        system,
        task,
        tools: presets.schemaFor(preset),
        dispatch,
        history,
        // Streaming off is a real mode: one completion, then the whole answer as a
        // single token frame so the contract the UI renders stays the same.
        stream: current.streaming,
        onFirstToken: () => emit({ type: 'start' }),
        onToken: (t) => { text += t; emit({ type: 'token', t }); },
        onThinkingDelta: (t) => emit({ type: 'thinking', t }),
        onTimings: (x) => emit({ type: 'timings', timings: x }),
        onUsage: (u) => {
          const tin = Number(u.prompt_tokens ?? u.tokens_in ?? 0) || 0;
          const tout = Number(u.completion_tokens ?? u.tokens_out ?? 0) || 0;
          // A number the provider did not report and the profile did not price is not a
          // cost of 0: it is an unpriced call, and the rollup counts it as one.
          const hasCost = u.cost != null && Number.isFinite(Number(u.cost));
          const cost = hasCost ? Number(u.cost) : null;
          const source = hasCost ? (u.cost_source || null) : null;
          turnIn += tin;
          turnOut += tout;
          rollup = usage.addUsage(rollup, { tokens_in: tin, tokens_out: tout, cost, source });
          // Totals travel with the call: the footer prints tokens next to the cost label,
          // and a per-call count beside a conversation total reads as a rate.
          emit(Object.assign({
            type: 'usage',
            tokensIn: tin,
            tokensOut: tout,
            totalTokensIn: rollup.tokens_in,
            totalTokensOut: rollup.tokens_out,
            cost,
            source,
          }, costFrame()));
        },
      });
      if (!current.streaming && result.text) {
        text = result.text;
        emit({ type: 'token', t: result.text });
      }
      // The operator stopped this turn: the snapshot taken at that moment is the truth,
      // so a late answer must not be merged into a conversation that was closed.
      if (stopped) { finished = true; return; }
      const durationMs = Date.now() - turnStarted;
      transcript.push({
        type: 'assistant', content: result.text, ts: new Date().toISOString(),
        model: chosen.model, modelId: chosen.id, durationMs, tokensOut: turnOut,
      });
      sessions.save(doc.id, {
        messages: result.messages, transcript, usage: rollup, title: task,
        model: chosen, preset: preset.id, target,
      });
      // The turn is decided and stored: a socket closing from here on is a client leaving
      // a finished answer, not an abort, and must not stamp it as interrupted.
      finished = true;
      emit({
        type: 'done', session: doc.id, text: result.text, stopped: aborted,
        model: chosen.model, modelId: chosen.id, durationMs,
        usage: usageFrame(),
      });
    } catch (e) {
      if (stopped) { finished = true; return; }
      const message = String((e && e.message) || e).replace('llama.cpp non raggiungibile', 'provider unreachable');
      transcript.push({ type: 'error', message, ts: new Date().toISOString() });
      sessions.save(doc.id, { transcript, usage: rollup, title: task, model: chosen, preset: preset.id, target });
      finished = true;
      emit({ type: 'error', message });
      emit({
        type: 'done', session: doc.id, text, stopped: true, error: true,
        usage: usageFrame(),
      });
    }
    finished = true;
    try { res.end(); } catch { /* already closed */ }
  }

  function approve(body) {
    return approvals.answer(body || {});
  }

  return {
    profiles: chatProfiles,
    models: chatModels,
    presets: presetList,
    settings: settingsPayload,
    saveSettings,
    updateSession,
    sessions: { list: (limit) => sessions.list(limit), get: (id) => sessions.get(id) },
    stream: chatStream,
    approve,
  };
}

module.exports = { createChat };
