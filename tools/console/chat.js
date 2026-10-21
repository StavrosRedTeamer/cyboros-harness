// Console — chat: a plain OpenAI-style conversational surface over the SAME
// providers the agent runtime uses (runtime/providers.json) through local/llm.js —
// no tools, no guards: this is conversation, not actions. Cloud profiles are
// offered only when the config opts in (allow_cloud); local profiles (llama on
// loopback) are the default, in line with the zero-cloud-egress opsec of the
// harness.
'use strict';
const { sendJson } = require('./http');

function createChat() {
  let _chatMod = null;
  function chatMod() {
    if (_chatMod) return _chatMod;
    _chatMod = { live: require('../../runtime/live'), llm: require('../../local/llm') };
    return _chatMod;
  }
  function inferEgress(baseUrl) {
    return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(String(baseUrl)) ? 'local' : 'cloud';
  }
  function chatProfiles() {
    let m, loaded;
    try { m = chatMod(); loaded = m.live.loadConfig(); }
    catch (e) { return { error: String((e && e.message) || e), profiles: [] }; }
    const cfg = loaded.cfg;
    const out = [];
    for (const [name, p] of Object.entries(cfg.profiles)) {
      const egress = p.egress || inferEgress(p.base_url);
      let host = p.base_url; try { host = new URL(p.base_url).host; } catch { /* keep raw */ }
      const keyPresent = !p.api_key_env || !!process.env[p.api_key_env];
      const available = egress === 'local' ? true : (!!cfg.allow_cloud && keyPresent);
      out.push({
        name, model: p.model, egress, host, cloud: egress === 'cloud',
        available, keyEnv: p.api_key_env || null, keyPresent,
        reason: available ? null
          : (egress === 'cloud' && !cfg.allow_cloud ? 'cloud egress disabled (allow_cloud=false)'
            : (!keyPresent ? ('set $' + p.api_key_env) : 'unavailable')),
      });
    }
    // Default prefers an AVAILABLE LOCAL profile — the harness's zero-cloud-egress
    // opsec: the chat never silently defaults to a cloud provider, even when the
    // config's default_profile is a cloud one.
    const avail = out.filter((o) => o.available);
    const localAvail = avail.find((o) => o.egress === 'local');
    let def;
    if (localAvail) def = localAvail.name;
    else if (out.find((o) => o.name === cfg.default_profile && o.available)) def = cfg.default_profile;
    else def = (avail[0] && avail[0].name) || cfg.default_profile || (out[0] && out[0].name);
    return { profiles: out, default: def, allowCloud: !!cfg.allow_cloud };
  }
  async function chatStream(req, res, body) {
    const sse = (obj) => { try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch { /* client gone */ } };
    let m;
    try { m = chatMod(); } catch (e) { return sendJson(res, 500, { error: String((e && e.message) || e) }); }
    let messages = Array.isArray(body && body.messages) ? body.messages : null;
    if (!messages || !messages.length) return sendJson(res, 400, { error: 'messages[] required' });
    messages = messages.slice(-40).map((x) => ({
      role: ['system', 'user', 'assistant'].includes(x && x.role) ? x.role : 'user',
      content: String((x && x.content) || '').slice(0, 24000),
    })).filter((x) => x.content);
    if (!messages.length) return sendJson(res, 400, { error: 'no usable message content' });

    // Resolve against the same availability view the selector uses: an unpicked
    // profile falls back to the AVAILABLE LOCAL default (opsec), and an unavailable
    // profile (cloud with egress off / no key) is refused rather than attempted.
    const info = chatProfiles();
    if (info.error) return sendJson(res, 500, { error: info.error });
    const wanted = (body && body.profile) || info.default;
    const pinfo = info.profiles.find((x) => x.name === wanted);
    if (!pinfo) return sendJson(res, 400, { error: `unknown profile "${wanted}"` });
    if (!pinfo.available) return sendJson(res, 400, { error: `profile "${wanted}" unavailable: ${pinfo.reason || 'n/d'}` });

    let loaded, prof;
    try { loaded = m.live.loadConfig(); prof = m.live.resolveProfile(loaded.cfg, wanted); }
    catch (e) { return sendJson(res, 400, { error: String((e && e.message) || e) }); }
    const { profile, p, egress } = prof;
    if (egress === 'cloud' && !loaded.cfg.allow_cloud) {
      return sendJson(res, 403, { error: `profile "${profile}" uses cloud egress but allow_cloud=false` });
    }
    let key = '';
    try { key = (m.live.resolveKey(profile, p.api_key_env) || {}).key || ''; } catch { key = ''; }
    if (!key) key = egress === 'local' ? 'sk-local' : '';
    if (egress === 'cloud' && !key) {
      return sendJson(res, 400, { error: `no API key for cloud profile "${profile}"${p.api_key_env ? ' — set $' + p.api_key_env : ''}` });
    }

    const { LocalLLM, trimContext } = m.llm;
    const llmc = new LocalLLM({
      endpoint: { base_url: p.base_url, model: p.model, api_key: key },
      sampling: { temperature: p.temperature ?? 0.4, top_p: p.top_p ?? 0.9, max_tokens: p.max_tokens ?? 1024 },
      runtime: { request_timeout_ms: p.request_timeout_ms ?? 300000, context_char_budget: p.context_char_budget ?? 24000 },
    });
    const reqBody = {
      model: p.model,
      messages: trimContext(messages, p.context_char_budget ?? 24000),
      temperature: p.temperature ?? 0.4,
      top_p: p.top_p ?? 0.9,
      max_tokens: p.max_tokens ?? 1024,
      stream: true,
    };

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    sse({ type: 'meta', profile, model: p.model, egress });
    let aborted = false;
    req.on('close', () => { aborted = true; });
    try {
      const result = await llmc._postStream(reqBody, {
        onThinkingDelta: (t) => { if (!aborted) sse({ type: 'thinking', t }); },
        onFirstToken: () => { if (!aborted) sse({ type: 'start' }); },
        onToken: (t) => { if (!aborted) sse({ type: 'token', t }); },
        onTimings: (x) => { if (!aborted) sse({ type: 'timings', timings: x }); },
      });
      if (!aborted) sse({ type: 'done', usage: (result && result.usage) || null, finishReason: (result && result.finishReason) || null });
    } catch (e) {
      if (!aborted) sse({ type: 'error', message: String((e && e.message) || e) });
    }
    try { res.end(); } catch { /* already closed */ }
  }

  return { profiles: chatProfiles, stream: chatStream };
}

module.exports = { createChat };
