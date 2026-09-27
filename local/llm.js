// local/llm.js — client OpenAI-compatibile per llama.cpp (edizione locale StavrosRedTeamer).
// Zero dipendenze (Node >= 22, fetch globale). Espone un loop di tool-calling adatto a un
// modello DEBOLE abliterato: contesto tagliato, output clippato, retry, e un fallback a
// protocollo testuale quando il modello non emette tool_calls nativi affidabili.

'use strict';

function clip(s, n) {
  s = (s == null) ? '' : String(s);
  return s.length <= n ? s : s.slice(0, n) + `\n…[troncato, ${s.length - n} char in piu']`;
}

// Stima grezza dei caratteri di una conversazione (proxy dei token, ~4 char/token).
function convChars(messages) {
  let c = 0;
  for (const m of messages) c += (m.content ? String(m.content).length : 0) + 24;
  return c;
}

// Taglio duro del contesto: tiene system + gli ultimi turni finche' sta nel budget.
function trimContext(messages, budget) {
  if (convChars(messages) <= budget) return messages;
  const sys = messages.filter((m) => m.role === 'system');
  const rest = messages.filter((m) => m.role !== 'system');
  const kept = [];
  let c = convChars(sys);
  for (let i = rest.length - 1; i >= 0; i--) {
    const add = (rest[i].content ? String(rest[i].content).length : 0) + 24;
    if (c + add > budget && kept.length > 0) break;
    kept.unshift(rest[i]);
    c += add;
  }
  return [...sys, ...kept];
}

class LocalLLM {
  constructor(cfg) {
    this.cfg = cfg;
    this.base = cfg.endpoint.base_url.replace(/\/$/, '');
    this.model = cfg.endpoint.model;
    this.key = cfg.endpoint.api_key || 'sk-local';
    this.s = cfg.sampling || {};
    this.rt = cfg.runtime || {};
  }

  async _post(body) {
    const rt = this.rt;
    let lastErr;
    for (let attempt = 0; attempt <= (rt.retries ?? 2); attempt++) {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), rt.request_timeout_ms ?? 300000);
      try {
        const r = await fetch(`${this.base}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.key}` },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        clearTimeout(to);
        if (!r.ok) { lastErr = new Error(`HTTP ${r.status}: ${clip(await r.text(), 300)}`); }
        else return await r.json();
      } catch (e) { clearTimeout(to); lastErr = e; }
      if (attempt < (rt.retries ?? 2)) await new Promise((res) => setTimeout(res, rt.retry_backoff_ms ?? 3000));
    }
    throw new Error(`llama.cpp non raggiungibile (${this.base}): ${lastErr && lastErr.message}. Avvia llama-server o correggi local/config.local.json.`);
  }

  // POST in STREAMING (SSE) — path ADDITIVO usato solo dal REPL per le metriche live.
  // Parsing SSE a mano (zero dip): legge resp.body come stream web, splitta su "\n\n",
  // tiene solo le righe "data:", termina su "[DONE]". Accumula delta.content (onToken),
  // ricompone delta.tool_calls per indice (per il tool-loop) e propaga `timings`
  // (timings_per_token) a onTimings. Ritorna un `message` in forma OpenAI + le timings finali.
  // NB: nessun retry qui (a differenza di _post) per non duplicare l'output già streammato:
  // il chiamante (runAgent) fa un fallback non-stream se lo stream fallisce prima del 1º token.
  async _postStream(body, handlers = {}) {
    const rt = this.rt;
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), rt.request_timeout_ms ?? 300000);
    let r;
    try {
      r = await fetch(`${this.base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.key}`, Accept: 'text/event-stream' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) { clearTimeout(to); throw e; }
    if (!r.ok || !r.body) { clearTimeout(to); throw new Error(`HTTP ${r.status}: ${clip(r.body ? await r.text() : '(no body)', 300)}`); }

    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '', content = '', firstToken = false, finishReason = null, lastTimings = null;
    const toolAcc = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const evt = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = evt.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') { buf = ''; break; }
          let json; try { json = JSON.parse(data); } catch { continue; }
          const ch = json.choices && json.choices[0];
          if (ch) {
            const delta = ch.delta || {};
            if (delta.content) {
              if (!firstToken) { firstToken = true; if (handlers.onFirstToken) handlers.onFirstToken(); }
              content += delta.content;
              if (handlers.onToken) handlers.onToken(delta.content);
            }
            if (delta.tool_calls) accToolDeltas(toolAcc, delta.tool_calls);
            if (ch.finish_reason) finishReason = ch.finish_reason;
          }
          if (json.timings) {
            lastTimings = json.timings;
            if (handlers.onTimings) handlers.onTimings(normTimings(json.timings));
          }
        }
      }
    } finally { clearTimeout(to); }

    const message = { role: 'assistant', content };
    const tcs = toolAcc.filter(Boolean);
    if (tcs.length) {
      tcs.forEach((t, i) => { if (!t.id) t.id = `call_${Date.now()}_${i}`; });
      message.tool_calls = tcs;
    }
    return { message, timings: lastTimings, finishReason };
  }

  _completionBody(messages, tools, grammar) {
    const body = {
      model: this.model,
      messages: trimContext(messages, this.rt.context_char_budget ?? 24000),
      temperature: this.s.temperature ?? 0.4,
      top_p: this.s.top_p ?? 0.9,
      max_tokens: this.s.max_tokens ?? 1024,
      stream: false,
    };
    if (this.s.top_k != null) body.top_k = this.s.top_k; // llama.cpp accetta top_k extra
    if (this.s.presence_penalty != null) body.presence_penalty = this.s.presence_penalty;
    if (this.s.frequency_penalty != null) body.frequency_penalty = this.s.frequency_penalty;
    if (this.s.repeat_penalty != null) body.repeat_penalty = this.s.repeat_penalty;
    // Determinismo: se allow_thinking è false, disattiva il blocco <think> del modello
    // reasoning (Qwen) via chat_template_kwargs. Evita che la chat/tool-loop rallenti
    // ragionando a lungo. Vale sia sul path GBNF sia su quello a tool nativi.
    if (this.rt.allow_thinking === false) body.chat_template_kwargs = { enable_thinking: false };
    // Grammatica GBNF: forza il protocollo testuale (ACTION/FINAL) sempre parsabile.
    // È incompatibile con la grammatica interna dei tool nativi, quindi in questa
    // modalità NON inviamo `tools` e ci affidiamo al branch di parsing testuale.
    if (grammar) { body.grammar = grammar; return body; }
    if (tools && tools.length && this.rt.native_tools) { body.tools = tools; body.tool_choice = 'auto'; }
    return body;
  }

  // Un giro agente completo: system+instructions+task, tool-loop finche' il modello
  // chiude con testo (o max_tool_iters). `dispatch(name, args)` ritorna una stringa.
  // `toolSchema` = array OpenAI tools; `toolNames` = nomi ammessi (per il fallback testuale).
  // `history` (opzionale): messaggi di una conversazione precedente da continuare (REPL).
  // Se assente, comportamento identico a prima (single-shot). Il system non viene duplicato
  // se già presente nella history.
  // Parametri di streaming (ADDITIVI, opzionali): se `stream` è true e la grammatica NON è
  // attiva, usa il path SSE (_postStream) e invoca onToken/onTimings/onFirstToken in tempo
  // reale. Senza questi parametri il comportamento è IDENTICO a prima (run-local.js, --check,
  // fasi autonome con GBNF): single/multi-shot non-stream, nessun callback nuovo invocato.
  async runAgent({ system, task, tools, dispatch, onStep, grammar, history, stream, onToken, onTimings, onFirstToken }) {
    const messages = Array.isArray(history) ? history.slice() : [];
    if (system && !messages.some((m) => m.role === 'system')) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: task });

    const maxIters = this.rt.max_tool_iters ?? 8;
    const clipN = this.rt.tool_output_clip_chars ?? 4000;
    // --- LOOP-GUARD: i modelli abliterati vanno in loop anche a basso contesto. DRY/penalties
    // fermano solo le ripetizioni IDENTICHE e solo dentro un singolo token-stream: non vedono
    // due chiamate tool separate con stessi tool+args, né le varianti "quasi uguali"
    // (typo-hunting). Il freno perciò sta qui, lato harness: riconosciamo tool+args
    // normalizzati già eseguiti, consegniamo l'output PRECEDENTE invece di rieseguire, e
    // alla N-esima ripetizione forziamo una correzione esplicita nel contesto.
    const lgCfg = this.rt.loop_guard ?? {};
    const lgMax = lgCfg.max_repeats ?? 1;            // quante volte si tollera una ripetizione (1 = avviso alla 2ª esecuzione, correzione alla 3ª)
    const lgFuzzy = lgCfg.fuzzy ?? true;             // confronto fuzzy (token-overlap) per i variant-loop
    const lgFuzzyThreshold = lgCfg.fuzzy_threshold ?? 0.85; // dice-bigram >= soglia => stessa azione
    const seenActions = new Map();                   // chiave normalizzata -> { count, lastOutput, lastArgs, viaNative }
    const normKey = (tool, args) => tool + '|' + JSON.stringify(args, Object.keys(args || {}).sort ? Object.keys(args || {}).sort() : []);
    // Similarità a bigrammi di caratteri (Dice): robusta ai typo ("passwd" vs "passwdd" ~0.95),
    // a differenza del token-overlap che crolla a un singolo carattere di differenza.
    const bigrams = (s) => { const t = String(s).toLowerCase().replace(/[^a-z0-9_./]+/g, ' '); const b = new Set(); for (let i = 0; i < t.length - 1; i++) b.add(t.slice(i, i + 2)); return b; };
    const dice = (a, b) => { const A = bigrams(a), B = bigrams(b); if (!A.size || !B.size) return 1; let i = 0; for (const g of A) if (B.has(g)) i++; return (2 * i) / (A.size + B.size); };
    const isRepeat = (tool, args) => {
      // fuzzy like-for-like: confronta la chiave del candidate con quelle salvate,
      // STESSA costruzione (tool|args), altrimenti l'overhead di framing abbassa il dice.
      const probe = normKey(tool, args);
      for (const [k, v] of seenActions) {
        let same = false;
        try { same = k === probe; } catch { same = false; }
        if (!same && lgFuzzy) {
          // fuzzy SOLO a parità di tool: le varianti da bloccare sono args mutati (typo-hunting),
          // non l'uso legittimo di un tool diverso su target simili.
          try { same = k.split('|')[0] === tool && dice(probe, k) >= lgFuzzyThreshold; } catch { same = false; }
        }
        if (same) return v;
      }
      return null;
    };
    const loopBreak = (tool, args, prev) => `LOOP-GUARD: l'azione ${tool}(${JSON.stringify(args)}) ripete la precedente\n` +
      `già eseguita (${prev.count + 1}ª volta). PROIBITO rieseguire la stessa azione o varianti con piccole modifiche\n` +
      `(nomi/path/flag simili). Se l'output precedente è insufficiente, cambia STRATEGIA e usa un tool DIVERSO,\n` +
      `oppure concludi con FINAL: riassumendo ciò che sai. Output precedente (di riferimento, NON rieseguire):\n${clip(prev.lastOutput, 1500)}`;
    // La grammatica è attiva solo se richiesta E abilitata in config. Si spegne da sola
    // se il server la rifiuta (fallback ai tool nativi + parsing testuale).
    let grammarActive = !!(grammar && this.rt.use_grammar);

    for (let iter = 0; iter < maxIters; iter++) {
      // Lo streaming è possibile solo senza grammatica: la GBNF gira sul path testuale
      // non-stream (e in chat non viene mai passata). Ricadiamo comunque su non-stream
      // se lo stream fallisce prima di produrre token.
      const useStream = !!stream && !grammarActive;
      let msg;
      if (useStream) {
        const body = this._completionBody(messages, tools, null);
        body.stream = true; body.timings_per_token = true;
        let sres;
        try {
          sres = await this._postStream(body, { onToken, onTimings, onFirstToken });
        } catch (e) {
          // fallback: una singola chiamata non-stream (nessun token era ancora uscito).
          const resp = await this._post(this._completionBody(messages, tools, null));
          msg = resp && resp.choices && resp.choices[0] && resp.choices[0].message;
          if (resp && resp.timings && onTimings) onTimings(normTimings(resp.timings));
        }
        if (sres) msg = sres.message;
      } else {
        let resp;
        try {
          resp = await this._post(this._completionBody(messages, tools, grammarActive ? grammar : null));
        } catch (e) {
          if (grammarActive && looksLikeGrammarError(e)) {
            if (onStep) onStep({ tool: '(grammar disattivata: il server l\'ha rifiutata)', args: {} });
            grammarActive = false; iter--; continue; // riprova lo stesso giro senza grammatica
          }
          throw e;
        }
        msg = resp && resp.choices && resp.choices[0] && resp.choices[0].message;
        if (resp && resp.timings && onTimings) onTimings(normTimings(resp.timings));
      }
      if (!msg) throw new Error('Risposta LLM vuota/malformata.');

      // 1) tool_calls nativi
      if (msg.tool_calls && msg.tool_calls.length) {
        messages.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });
        for (const tc of msg.tool_calls) {
          let args = {};
          try { args = JSON.parse(tc.function.arguments || '{}'); } catch { args = { _raw: tc.function.arguments }; }
          if (onStep) onStep({ tool: tc.function.name, args });
          const rep = isRepeat(tc.function.name, args);
          let out;
          if (rep && rep.count >= lgMax) {
            // Loop confermato: NON si riesegue. La correzione entra nel contesto come observation.
            out = loopBreak(tc.function.name, args, rep);
            if (onStep) onStep({ tool: '(loop-guard: azione ripetuta, forzo cambio strategia)', args });
            rep.count = lgMax; // pinnata: questa azione non viene piu' eseguita, solo corretta
          } else if (rep) {
            // Prima ripetizione: consegna l'output precedente senza rieseguire il tool.
            out = `LOOP-GUARD (avviso ${rep.count + 1}/${lgMax}): azione identica alla precedente già eseguita.\nOutput precedente (di riferimento, NON rieseguire):\n${clip(rep.lastOutput, 1200)}\nContinua con un'azione DIVERSA o concludi con FINAL:`;
            if (onStep) onStep({ tool: '(loop-guard: avviso ripetizione)', args });
            rep.count++;
          } else {
            try { out = await dispatch(tc.function.name, args); }
            catch (e) { out = `ERRORE tool: ${e.message}`; }
            seenActions.set(normKey(tc.function.name, args), { count: 0, lastOutput: out, args });
          }
          messages.push({ role: 'tool', tool_call_id: tc.id, content: clip(out, clipN) });
        }
        continue;
      }

      // 2) fallback a protocollo testuale: il modello emette una riga ACTION: {json}
      const text = msg.content || '';
      const act = this.rt.text_protocol_fallback ? parseTextAction(text) : null;
      if (act) {
        messages.push({ role: 'assistant', content: text });
        if (onStep) onStep({ tool: act.tool, args: act.args, viaText: true });
        const rep = isRepeat(act.tool, act.args);
        let out;
        if (rep && rep.count >= lgMax) {
          out = loopBreak(act.tool, act.args, rep);
          if (onStep) onStep({ tool: '(loop-guard: azione ripetuta, forzo cambio strategia)', args: act.args });
          rep.count = lgMax; // pinnata: mai piu' rieseguita
        } else if (rep) {
          out = `LOOP-GUARD (avviso ${rep.count + 1}/${lgMax}): azione identica alla precedente già eseguita.\nOutput precedente (di riferimento, NON rieseguire):\n${clip(rep.lastOutput, 1200)}\nContinua con un'azione DIVERSA o concludi con FINAL:`;
          rep.count++;
        } else {
          try { out = await dispatch(act.tool, act.args); }
          catch (e) { out = `ERRORE tool: ${e.message}`; }
          seenActions.set(normKey(act.tool, act.args), { count: 0, lastOutput: out, args: act.args });
        }
        messages.push({ role: 'user', content: `OBSERVATION (${act.tool}):\n${clip(out, clipN)}\nContinua, oppure concludi con FINAL: <riassunto>.` });
        continue;
      }

      // 3) nessun tool: e' la risposta finale
      return { text: stripFinal(text), messages };
    }
    return { text: '[max iterazioni tool raggiunte]', messages };
  }
}

// Protocollo testuale di ripiego: cerca una riga  ACTION: {"tool":"...","args":{...}}
function parseTextAction(text) {
  const m = text.match(/ACTION:\s*(\{[\s\S]*\})\s*$/m) || text.match(/ACTION:\s*(\{[\s\S]*?\})/m);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[1]);
    if (obj && obj.tool) return { tool: obj.tool, args: obj.args || {} };
  } catch { /* ignora json rotto */ }
  return null;
}
function stripFinal(text) {
  const m = text.match(/FINAL:\s*([\s\S]*)$/m);
  return m ? m[1].trim() : text.trim();
}
// Normalizza l'oggetto `timings` di llama.cpp in una forma stabile per la TUI.
// prompt_per_second = PREFILL tok/s ; predicted_per_second = GENERAZIONE tok/s.
function normTimings(t) {
  if (!t) return null;
  return {
    promptPerSec: t.prompt_per_second ?? null,   // prefill tok/s
    genPerSec: t.predicted_per_second ?? null,    // generazione tok/s
    promptN: t.prompt_n ?? null,                  // token di prompt processati
    predictedN: t.predicted_n ?? null,            // token generati finora
    elapsed: ((t.prompt_ms || 0) + (t.predicted_ms || 0)) / 1000,
  };
}

// Ricompone i tool_calls in streaming: arrivano a frammenti (delta.tool_calls[]), ciascuno con
// un `index`, opzionale `id`, e pezzi di function.name / function.arguments da concatenare.
function accToolDeltas(acc, deltas) {
  for (const d of deltas) {
    const i = d.index ?? 0;
    let cur = acc[i];
    if (!cur) cur = acc[i] = { id: d.id || '', type: 'function', function: { name: '', arguments: '' } };
    if (d.id) cur.id = d.id;
    if (d.type) cur.type = d.type;
    if (d.function) {
      if (d.function.name) cur.function.name += d.function.name;
      if (d.function.arguments) cur.function.arguments += d.function.arguments;
    }
  }
}

// Un errore del server dovuto alla grammatica (parse GBNF, campo non supportato…): spegni
// la grammatica e continua coi tool nativi invece di far cadere l'intera run.
function looksLikeGrammarError(e) {
  const m = (e && e.message ? e.message : '').toLowerCase();
  return m.includes('grammar') || m.includes('gbnf') || m.includes('http 400') || m.includes('http 500');
}

module.exports = { LocalLLM, clip, trimContext };
