// local/llm.js — client OpenAI-compatibile per llama.cpp (edizione locale di Cyboros Harness).
// Zero dipendenze (Node >= 22, fetch globale). Espone un loop di tool-calling adatto a un
// modello DEBOLE abliterato: contesto tagliato, output clippato, retry, e un fallback a
// protocollo testuale quando il modello non emette tool_calls nativi affidabili.

'use strict';

// Context management lives in ./context: token accounting (including tool_calls
// argument payloads), atomic tool exchanges, and a state digest for what compaction
// drops. `trimContext` is re-exported below so the old call sites and docs keep
// working — it now routes through the structural compiler instead of slicing by chars.
const { ContextManager, estimateTokens, trimContext } = require('./context');
// What the endpoint actually accepts is declared per profile and consumed by one builder
// (local/adapters.js). The loop below no longer knows any provider-specific field name.
const { resolveAdapter } = require('./adapters');

function clip(s, n) {
  s = (s == null) ? '' : String(s);
  return s.length <= n ? s : s.slice(0, n) + `\n…[troncato, ${s.length - n} char in piu']`;
}

class LocalLLM {
  constructor(cfg) {
    this.cfg = cfg;
    this.base = cfg.endpoint.base_url.replace(/\/$/, '');
    this.model = cfg.endpoint.model;
    this.key = cfg.endpoint.api_key || 'sk-local';
    this.s = cfg.sampling || {};
    this.rt = cfg.runtime || {};
    this.adapter = resolveAdapter({ ...cfg, runtime: this.rt });
    // A declared window is the context manager's business, not the adapter's: hand the
    // resolved capability through so the budget is sized off the model, not a guess.
    for (const k of ['context_window_tokens', 'reserved_output_tokens', 'context_safety_tokens']) {
      if (this.adapter.caps[k] != null && this.rt[k] == null) this.rt[k] = this.adapter.caps[k];
    }
    // A profile that declares text tool-calling has no schema to send, so the parser is
    // the only way its ``ACTION:`` lines become actions. The capability turns it on; a
    // profile that declares native tools keeps the flag as the model's own safety net.
    if (this.adapter.toolMode === 'text' && this.rt.text_protocol_fallback == null) {
      this.rt.text_protocol_fallback = true;
    }
    // One manager per model instance: it owns the token budget, the calibration
    // learned from the provider's own `prompt_tokens`, and the statistics the TUI
    // and the console report instead of inventing them.
    this.ctxm = new ContextManager(this.rt, this.s);
    this.ctxStats = null;
    this._lastSent = null;
    this._lastSentTools = null;
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

    // Alcuni gateway ignorano `stream:true` e rispondono JSON: trattalo come un colpo
    // non-stream invece di restituire un messaggio vuoto.
    const ctype = String(r.headers.get('content-type') || '');
    if (!ctype.includes('event-stream')) {
      const json = await r.json();
      clearTimeout(to);
      const m = (json.choices && json.choices[0] && json.choices[0].message) || { role: 'assistant', content: '' };
      if (m.content && handlers.onToken) handlers.onToken(m.content);
      return { message: m, timings: json.timings || null, finishReason: json.choices && json.choices[0] && json.choices[0].finish_reason, usage: json.usage || null };
    }

    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '', content = '', reasoning = '', firstToken = false, finishReason = null, lastTimings = null, streamUsage = null;
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
            const rsn = this.adapter.readReasoning(delta);
            if (rsn) {
              reasoning += rsn;
              if (handlers.onThinkingDelta) handlers.onThinkingDelta(rsn);
            }
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
          if (json.usage) streamUsage = json.usage;
        }
      }
    } finally { clearTimeout(to); }

    const message = this.adapter.attachReasoning({ role: 'assistant', content }, reasoning);
    const tcs = toolAcc.filter(Boolean);
    if (tcs.length) {
      tcs.forEach((t, i) => { if (!t.id) t.id = `call_${Date.now()}_${i}`; });
      message.tool_calls = tcs;
    }
    return { message, timings: lastTimings, finishReason, usage: streamUsage };
  }

  _completionBody(messages, tools, grammar, opts = {}) {
    // The tool schema is sent on every request, so it is part of the bill: count it
    // against the same budget instead of pretending the conversation is all that ships.
    // `offersSchema` is the adapter's own rule, so the accounting and the wire agree by
    // construction — a profile in text mode, and the grammar path that withholds the
    // schema, are billed for what they actually send.
    const schemaExpense = this.adapter.offersSchema({ tools, grammar })
      ? estimateTokens(JSON.stringify(tools))
      : 0;
    const prepared = this.ctxm.prepare(messages, { extraTokens: schemaExpense });
    this.ctxStats = prepared.stats;
    this._lastSent = prepared.messages;
    this._lastSentTools = Array.isArray(tools) && tools.length ? tools : null;
    // Every optional field below is paid for by a declared capability; nothing here is
    // provider-specific by assumption. `tools` and `grammar` are both handed over and the
    // ADAPTER arbitrates: a declared grammar wins over the schema, and asking for a grammar
    // the profile never declared throws instead of silently offering neither (the run would
    // then have no way to call a tool at all).
    const built = this.adapter.buildRequest({
      model: this.model,
      messages: prepared.messages,
      tools,
      grammar,
      sampling: this.s,
      runtime: this.rt,
      stream: opts.stream === true,
    });
    return built.body;
  }

  // Un giro agente completo: system+instructions+task, tool-loop finche' il modello
  // chiude con testo (o budget dei tool / max_tool_iters: a quel punto la richiesta di
  // chiusura senza schema tool lo costringe a rispondere).
  // `toolSchema` = array OpenAI tools; `toolNames` = nomi ammessi (per il fallback testuale).
  // `history` (opzionale): messaggi di una conversazione precedente da continuare (REPL).
  // Se assente, comportamento identico a prima (single-shot). Il system non viene duplicato
  // se già presente nella history.
  // Parametri di streaming (ADDITIVI, opzionali): se `stream` è true e la grammatica NON è
  // attiva, usa il path SSE (_postStream) e invoca onToken/onTimings/onFirstToken in tempo
  // reale. Senza questi parametri il comportamento è IDENTICO a prima (run-local.js, --check,
  // fasi autonome con GBNF): single/multi-shot non-stream, nessun callback nuovo invocato.
  async runAgent({ system, task, tools, dispatch, onStep, grammar, history, stream, onToken, onTimings, onFirstToken, onTrace, onUsage, onThinkingDelta, onThinkingDone }) {
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
    // Tool la cui stessa struttura può legittimamente cambiare bersaglio o identità (run_tool:
    // curl su URL diversi, header diversi). Il fuzzy li confonderebbe con un variant-loop e
    // bloccherebbe l'enumerazione: per loro vale solo la ripetizione ESATTA.
    const lgExempt = new Set(lgCfg.exempt_tools ?? []);
    const seenActions = new Map();                   // chiave normalizzata -> { count, lastOutput, lastArgs, viaNative }
    const normKey = (tool, args) => tool + '|' + JSON.stringify(args, Object.keys(args || {}).sort ? Object.keys(args || {}).sort() : []);
    // Similarità a bigrammi di caratteri (Dice): robusta ai typo ("passwd" vs "passwdd" ~0.95),
    // a differenza del token-overlap che crolla a un singolo carattere di differenza.
    const bigrams = (s) => { const t = String(s).toLowerCase().replace(/[^a-z0-9_./]+/g, ' '); const b = new Set(); for (let i = 0; i < t.length - 1; i++) b.add(t.slice(i, i + 2)); return b; };
    const dice = (a, b) => { const A = bigrams(a), B = bigrams(b); if (!A.size || !B.size) return 1; let i = 0; for (const g of A) if (B.has(g)) i++; return (2 * i) / (A.size + B.size); };
    // Aggiungere un campo non è un refuso: un record_finding che guadagna `oracle` dopo la
    // scoperta dell'oracolo, o un payload che passa da `suspected` a `confirmed`, è evidenza
    // nuova e deve essere eseguito. Il fuzzy vale solo a parità di forma (stesse chiavi).
    const argShape = (a) => {
      if (Array.isArray(a)) return 'array';
      if (a && typeof a === 'object') return 'object:' + Object.keys(a).sort().join(',');
      return typeof a;
    };
    // Un retry dopo un errore non è un loop: la chiamata precedente è fallita (validazione,
    // exit ≠ 0) e l'agente ha corretto gli argomenti. Il fuzzy non deve bloccarla.
    const failedOutput = (out) => /\bexit [1-9]\d*\b/.test(String(out == null ? '' : out))
      || /^\s*(ERRORE|error:)/im.test(String(out == null ? '' : out));
    const isRepeat = (tool, args) => {
      // fuzzy like-for-like: confronta la chiave del candidate con quelle salvate,
      // STESSA costruzione (tool|args), altrimenti l'overhead di framing abbassa il dice.
      const probe = normKey(tool, args);
      const probeShape = argShape(args);
      for (const [k, v] of seenActions) {
        let same = false;
        try { same = k === probe; } catch { same = false; }
        if (!same && lgFuzzy && !lgExempt.has(tool)) {
          // fuzzy SOLO a parità di tool e di forma: le varianti da bloccare sono args mutati
          // (typo-hunting), non l'uso legittimo di un tool diverso su target simili.
          try {
            same = k.split('|')[0] === tool && probeShape === argShape(v.args)
              && dice(probe, k) >= lgFuzzyThreshold && !failedOutput(v.lastOutput);
          } catch { same = false; }
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
    // Reasoning del modello, accumulato per il caller. Non viene mai *mostrato* al modello
    // come prosa; torna indietro solo dove il provider lo esige per proseguire un turno con
    // tool (capability `reasoning_echo_with_tools`), e in quel caso nel campo dichiarato.
    let reasoningAll = '';

    // --- TOOL BUDGET: un limite che FORZA la conclusione. La loop-guard qui sopra vede le
    // ripetizioni che sa riconoscere; `exempt_tools: ['run_tool']` esenta le chiamate da
    // riga di comando proprio perché due probe con URL diversi sono evidenza nuova. Con un
    // modello reale questo basta a consumare l'intero turno in esplorazione: dieci curl
    // "diversi" non fanno scattare nulla, e il turno finiva solo perché l'operatore
    // premeva Stop. Quindi il turno ha anche un budget di CHIAMATE — l'esenzione dal
    // controllo delle varianti non è esenzione dal budget — e quando finisce (o si
    // raggiunge il tetto di iterazioni) la richiesta successiva parte SENZA schema dei
    // tool e con una direttiva esplicita a rispondere con ciò che ha già.
    const maxCalls = Math.max(1, Number(this.rt.max_tool_calls) || Math.max(4, Math.min(12, maxIters)));
    const closingNote = (n) => `TOOL BUDGET EXHAUSTED (${n}/${maxCalls} tool calls in this turn). `
      + 'Tools are no longer available. Answer now, in the operator\'s language, using the results already in this conversation. '
      + 'If the evidence is incomplete, say in one sentence what is missing.';
    let callsMade = 0;
    let closingIdx = -1;   // where the directive sits, so it never enters the stored history
    // Il messaggio di chiusura serve al contesto di QUESTA richiesta, non alla
    // conversazione: se restasse in `messages` verrebbe salvato e ripresentato come se
    // l'operatore l'avesse scritto nel turno successivo.
    const finish = (finalText) => {
      if (closingIdx >= 0) messages.splice(closingIdx, 1);
      return { text: finalText, messages, reasoning: reasoningAll };
    };
    // The provider's own count is the only ground truth for token accounting. Feeding it
    // back is what turns the estimator into a measurement: without it the budget is a
    // guess that drifts, and a drifting budget either overflows or wastes the window.
    const reportUsage = (u) => {
      if (!u) return;
      if (u.prompt_tokens != null) this.ctxm.calibrate(u.prompt_tokens, this._lastSent, this._lastSentTools);
      if (!onUsage) return;
      // A provider that reports cost is authoritative. One that does not gets the
      // profile's declared price table, or null — never an invented number. The source
      // travels with the amount: `cost_source` is what lets a rollup say whether it is
      // reporting a bill or an estimate, and refuse to total the two silently.
      if (u.cost != null) { onUsage({ ...u, cost_source: 'provider' }); return; }
      const cost = this.adapter.costOf(u);
      onUsage(cost == null ? { ...u, cost_source: null } : { ...u, cost, cost_source: 'declared' });
    };

    for (let iter = 0; iter <= maxIters; iter++) {
      // L'ultima iterazione (e ogni iterazione a budget speso) è la richiesta di chiusura.
      const mustConclude = iter === maxIters || callsMade >= maxCalls;
      if (mustConclude && closingIdx < 0) {
        closingIdx = messages.length;
        messages.push({ role: 'user', content: closingNote(callsMade) });
      }
      const offeredTools = mustConclude ? null : tools;
      // Lo streaming è possibile solo senza grammatica: la GBNF gira sul path testuale
      // non-stream (e in chat non viene mai passata). Ricadiamo comunque su non-stream
      // se lo stream fallisce prima di produrre token.
      const useStream = !!stream && !grammarActive;
      let msg;
      if (useStream) {
        // Streaming options (usage chunk, llama.cpp timings) are emitted by the builder
        // only where the profile declares the endpoint accepts them.
        const body = this._completionBody(messages, offeredTools, null, { stream: true });
        let sres;
        try {
          sres = await this._postStream(body, { onToken, onTimings, onFirstToken, onThinkingDelta, onThinkingDone });
        } catch (e) {
          // fallback: una singola chiamata non-stream (nessun token era ancora uscito).
          const resp = await this._post(this._completionBody(messages, offeredTools, null));
          msg = resp && resp.choices && resp.choices[0] && resp.choices[0].message;
          if (resp && resp.timings && onTimings) onTimings(normTimings(resp.timings));
          if (resp && resp.usage) reportUsage(resp.usage);
        }
        if (sres) {
          msg = sres.message;
          if (sres.usage) reportUsage(sres.usage);
        }
      } else {
        let resp;
        try {
          // La grammatica impone il protocollo ACTION/FINAL: incompatibile con la richiesta
          // di chiusura, dove il modello deve solo scrivere la risposta.
          resp = await this._post(this._completionBody(messages, offeredTools, !mustConclude && grammarActive ? grammar : null));
        } catch (e) {
          // A contract error from the adapter must NEVER take the grammar-fallback path:
          // its message names "grammar", so `looksLikeGrammarError` would classify it as
          // the server rejecting GBNF, disable the grammar and retry — turning a loud
          // failure back into the silent downgrade this guard exists to prevent.
          if (e && e.code === 'grammar_unsupported') throw e;
          if (grammarActive && looksLikeGrammarError(e)) {
            if (onStep) onStep({ tool: '(grammar disattivata: il server l\'ha rifiutata)', args: {} });
            grammarActive = false; iter--; continue; // riprova lo stesso giro senza grammatica
          }
          throw e;
        }
        msg = resp && resp.choices && resp.choices[0] && resp.choices[0].message;
        if (resp && resp.timings && onTimings) onTimings(normTimings(resp.timings));
        if (resp && resp.usage) reportUsage(resp.usage);
      }
      if (!msg) throw new Error('Risposta LLM vuota/malformata.');
      const rsn = this.adapter.readReasoning(msg);
      if (rsn) {
        reasoningAll += (reasoningAll ? '\n' : '') + rsn;
        // `onThinkingDone` riceve il testo completo del giro, anche quando i delta sono
        // gia' passati da onThinkingDelta: la TUI lo usa per chiudere il blocco, non per
        // ristampare.
        if (onThinkingDone) onThinkingDone(rsn);
      }

      // onTrace: osservazione PURA, nessun effetto sul loop. Emette cosa ha detto il
      // modello a ogni giro, cosi' un run in un'altra finestra (tail -f) mostra la
      // conversazione per intero. Non tocca grammatica, streaming o dispatch: se
      // cambiasse qualcosa, un benchmark misurerebbe una configurazione diversa da
      // quella che si spedisce.
      if (onTrace) onTrace({ type: 'model', iter, text: msg.content || '' });

      // 1) tool_calls nativi
      if (msg.tool_calls && msg.tool_calls.length) {
        if (mustConclude) {
          // Nessuno schema è stato offerto: una chiamata qui è il modello che ignora la
          // direttiva. NON si esegue (il budget è un limite, non un suggerimento) e la
          // correzione torna nel contesto; se anche l'ultimo giro non produce testo, il
          // turno finisce dicendolo invece di far finta di aver risposto.
          messages.push(this.adapter.echoReasoning({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls }, rsn));
          for (const tc of msg.tool_calls) {
            messages.push({ role: 'tool', tool_call_id: tc.id, content: 'NOT EXECUTED: the tool budget is exhausted for this turn. Answer with text only.' });
          }
          if (iter === maxIters) break;
          continue;
        }
        // Echoing the reasoning is what lets a tool-using turn be continued by providers
        // that require it (declared per profile); for the rest this is a no-op.
        messages.push(this.adapter.echoReasoning({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls }, rsn));
        callsMade += msg.tool_calls.length;   // ogni chiamata conta, anche se poi viene bloccata
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
          if (onTrace) onTrace({ type: 'tool', iter, tool: tc.function.name, args, out });
        }
        continue;
      }

      // 2) fallback a protocollo testuale: il modello emette una riga ACTION: {json}
      // Nella richiesta di chiusura un ACTION non viene eseguito: il testo è la risposta.
      const text = msg.content || '';
      const act = (!mustConclude && this.rt.text_protocol_fallback) ? parseTextAction(text) : null;
      if (act) {
        messages.push({ role: 'assistant', content: text });
        callsMade += 1;
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
        if (onTrace) onTrace({ type: 'tool', iter, tool: act.tool, args: act.args, out, viaText: true });
        continue;
      }

      // 3) nessun tool: e' la risposta finale. Va anche in `messages`: chi riusa
      // l'array come history (REPL, chat della console) altrimenti riparte senza
      // l'ultima risposta del modello — la conversazione sembra sospesa a meta'.
      const finalText = stripFinal(text);
      if (onTrace) onTrace({ type: 'final', iter, text: finalText });
      if (finalText) messages.push(this.adapter.echoReasoning({ role: 'assistant', content: finalText }, rsn));
      return finish(finalText);
    }
    return finish(callsMade
      ? `[budget esaurito dopo ${callsMade} tool: il modello non ha prodotto una risposta]`
      : '[il modello non ha prodotto una risposta]');
  }

  // The same compaction the next request will run, exposed so a surface can apply it
  // and report the real numbers instead of a hardcoded string.
  prepareContext(messages, opts = {}) {
    return this.ctxm.prepare(messages, opts);
  }

  contextStats() {
    return this.ctxm.stats();
  }

  // What the profile declared, for the session card and the trace. No secrets.
  modelInfo() {
    return this.adapter.describe();
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
