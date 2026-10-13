#!/usr/bin/env node
// local/run-local.js — runner AUTONOMO dell'edizione locale StavrosRedTeamer.
// Guida il motore deterministico (tools/autopilot.js + pipeline) e usa il modello locale
// abliterato (llama.cpp /v1) SOLO per le fasi di giudizio (recon/map, web-test, host,
// wireless, report). Nessuna dipendenza da Freebuff/cloud, nessun pacchetto npm.
//
// Uso:
//   node local/run-local.js <host>                    # run completa guidata dalle fasi
//   node local/run-local.js <host> --phase web-test   # esegui una sola fase
//   node local/run-local.js <host> --class sqli       # web-test su una classe specifica
//   node local/run-local.js --check                    # smoke test: endpoint LLM + tools
//   node local/run-local.js <host> --dry              # non chiama l'LLM, stampa i task
//   node local/run-local.js <host> --plan             # RECON AUTONOMO -> opzioni -> ATTESA OPERATORE
//       (recon-map con l'LLM, poi la parte non intrusiva del planner deterministico, poi un
//        menu per tier [ricognizione | attivo | offensivo]; l'offensivo richiede conferma
//        esplicita in-sessione. `--no-auto-recon` salta la parte deterministica, `--all`
//        include anche le azioni già coperte nel grafo. Vedi local/plan.js.)
//
// Config: local/config.local.json (endpoint llama.cpp, sampling, routing, budget contesto).

'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { LocalLLM } = require('./llm');
const { schemaFor, makeDispatch, nodeTool } = require('./tools-bridge');
const { getAgent } = require('./agents-local');
const { toolProtocolGrammar } = require('./grammar');

const WS = path.join(__dirname, '..');
const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.local.json'), 'utf8'));

// RAG semantico ibrido: se abilitato in config, esporta l'env che i tool figli (memory-rag)
// leggono per attivare il dense. Senza, il RAG resta lessicale.
(function wireEmbeddings() {
  const e = CFG.embeddings;
  if (!e || !e.enabled || !e.url) return;
  process.env.CYBOROS_EMBED_URL = e.url;
  if (e.model) process.env.CYBOROS_EMBED_MODEL = e.model;
  if (e.api_key) process.env.CYBOROS_EMBED_KEY = e.api_key;
  if (e.alpha != null) process.env.CYBOROS_RAG_ALPHA = String(e.alpha);
})();

function log(...a) { console.log('[local]', ...a); }
function die(msg) { console.error('[local] ERRORE:', msg); process.exit(1); }

// ── --watch: rendering della conversazione per il terminale di monitoraggio ────────────
// Scrive su stdout gia' flushato riga per riga, cosi' `tail -f` mostra subito il giro
// corrente invece di aspettare il buffering a 4 KB. Nessun timestamp: in un log da
// confrontare fra seed, l'orario e' rumore e fa divergere i diff.
function makeWatcher(opts) {
  const clamp = opts.watchClamp || 600;
  const w = (s) => process.stdout.write(s);
  const cut = (s, n) => {
    const t = String(s == null ? '' : s);
    return t.length > n ? t.slice(0, n) + `\n… [+${t.length - n} caratteri tagliati]` : t;
  };
  return (ev) => {
    if (ev.type === 'model') {
      w(`\n── giro ${ev.iter + 1}: modello ──\n`);
      w(cut(ev.text, clamp) + '\n');
    } else if (ev.type === 'tool') {
      w(`  ▸ ${ev.tool}${ev.viaText ? ' (protocollo testuale)' : ''} ${cut(JSON.stringify(ev.args), 400)}\n`);
      w('    ↳ ' + cut(String(ev.out).replace(/\n/g, '\n      '), clamp) + '\n');
    } else if (ev.type === 'final') {
      w(`\n══ FINAL (giro ${ev.iter + 1}) ══\n${cut(ev.text, clamp * 2)}\n`);
    }
  };
}

function parseArgs(argv) {
  const a = { _: [], autoRecon: true };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--check') a.check = true;
    else if (t === '--dry') a.dry = true;
    else if (t === '--plan') a.plan = true;
    else if (t === '--no-auto-recon') a.autoRecon = false;
    else if (t === '--all') a.all = true;
    else if (t === '--phase') a.phase = argv[++i];
    else if (t === '--class') a.klass = argv[++i];
    else if (t === '--yes') a.yes = true;
    else if (t === '--watch') a.watch = true;
    else if (t === '--watch-clamp') a.watchClamp = parseInt(argv[++i], 10) || 600;
    else a._.push(t);
  }
  a.host = a._[0];
  return a;
}

// --- smoke test: endpoint LLM raggiungibile + tools invocabili ---------------------
async function check() {
  const llm = new LocalLLM(CFG);
  log(`endpoint: ${CFG.endpoint.base_url}  model: ${CFG.endpoint.model}`);
  try {
    const r = await llm.runAgent({
      system: 'Rispondi in una parola.',
      task: 'Scrivi esattamente: PRONTO',
      tools: [], dispatch: async () => '',
    });
    log('LLM OK →', JSON.stringify(r.text.slice(0, 60)));
  } catch (e) { die(`LLM non raggiungibile: ${e.message}`); }
  const sc = nodeTool('scope-guard.js', ['check', 'http://127.0.0.1/']);
  log(`scope-guard OK (exit ${sc.code})`);
  const g = nodeTool('gate.js', ['status', 'example.com']);
  log(`gate.js OK (exit ${g.code})`);

  // Verifica GBNF live: chiedi UNA azione vincolata e controlla che sia parsata.
  if (CFG.runtime && CFG.runtime.use_grammar) {
    const names = ['scope_check', 'read_file'];
    const grammar = toolProtocolGrammar(names, { allowThinking: !!CFG.runtime.allow_thinking });
    let fired = null;
    try {
      await llm.runAgent({
        system: 'Chiama il tool scope_check sul target http://127.0.0.1/.',
        task: 'Emetti l\'azione ora.',
        tools: schemaFor(names),
        grammar,
        dispatch: async (name, args) => { fired = { name, args }; return 'OK'; },
        onStep: (s) => log(`  · GBNF → ${s.tool}${s.viaText ? ' (text)' : ''}`),
      });
      if (fired) log(`grammatica GBNF OK → tool "${fired.name}" parsato correttamente`);
      else log('grammatica GBNF: nessuna azione emessa (il modello ha risposto FINAL) — accettata comunque');
    } catch (e) { log(`grammatica GBNF: avviso — ${e.message}`); }
  }
  log('check completato.');
}

// --- esegue un singolo agente di fase --------------------------------------------
async function runPhaseAgent(llm, agentId, ctx, opts = {}) {
  const agent = getAgent(agentId);
  if (!agent) die(`agente di fase sconosciuto: ${agentId}`);
  const tools = schemaFor(agent.tools);
  const dispatch = makeDispatch({ allowRunTool: agent.tools.includes('run_tool') });
  const task = agent.task(ctx);

  log(`── fase ${agentId} (host=${ctx.host}${ctx.klass ? ', classe=' + ctx.klass : ''})`);
  if (opts.dry) { console.log('--- SYSTEM ---\n' + agent.system + '\n--- TASK ---\n' + task + '\n'); return { text: '[dry]' }; }

  const grammar = CFG.runtime && CFG.runtime.use_grammar
    ? toolProtocolGrammar(agent.tools, { allowThinking: !!(CFG.runtime && CFG.runtime.allow_thinking) })
    : null;

  const res = await llm.runAgent({
    system: agent.system, task, tools, dispatch, grammar,
    onStep: (s) => log(`  · ${s.tool}${s.viaText ? ' (text)' : ''} ${JSON.stringify(s.args).slice(0, 120)}`),
    // --watch stampa la conversazione completa, giro per giro, man mano che avviene.
    // Pensato per `... | tee /tmp/bench-live.log` + `tail -f` in un secondo terminale:
    // serve a vedere PERCHE' un finding non e' stato trovato, che e' la domanda che il
    // punteggio finale non risponde. Osserva solo: non cambia grammatica, streaming,
    // dispatch o loop, quindi un run --watch resta confrontabile con uno senza.
    onTrace: opts.watch ? makeWatcher(opts) : undefined,
  });
  log(`── fase ${agentId} FINAL:\n${res.text}\n`);
  return res;
}

// --- run completa: sequenza di fasi con stage-gate --------------------------------
async function runFull(host, opts) {
  const llm = new LocalLLM(CFG);

  // 0) scope check duro prima di tutto
  const sc = nodeTool('scope-guard.js', ['check', host]);
  if (sc.code !== 0) die(`host fuori scope o scope.json vuoto: ${host}\n${sc.out}\nCompila scope.json.`);

  const seq = opts.phase ? [opts.phase] : ['recon-map', 'web-test', 'report'];
  for (const phase of seq) {
    const ctx = { host, klass: opts.klass };
    await runPhaseAgent(llm, phase, ctx, opts);

    // stage-gate deterministico tra le fasi (best-effort: non blocca se il gate non è configurato)
    if (!opts.phase && !opts.dry) {
      const gatePhase = phase === 'recon-map' ? 'map' : phase === 'web-test' ? 'test' : phase;
      const g = nodeTool('gate.js', ['pass', gatePhase]);
      log(`gate ${gatePhase}: exit ${g.code}${g.out ? ' — ' + g.out.split('\n')[0] : ''}`);
      if (phase === 'recon-map') nodeTool('coverage.js', [host, '--write']);
      if (phase === 'web-test') nodeTool('chain.js', ['--host', host]);
    }
  }
  log('run completata. Report/finding sotto reports/.');
}

// --- MODALITA' PIANO: recon autonomo -> opzioni -> attesa dell'operatore ------------------
// 1) recon con l'agente di fase (pipeline recon/enumerate + mappa in reports/);
// 2) la parte NON intrusiva del planner deterministico (auto-recon, saltabile con
//    --no-auto-recon): solo azioni ammesse dallo scope-guard, non intrusive, non coperte;
// 3) menu per tier (ricognizione | attivo | offensivo) e STOP: si esegue solo cio' che
//    l'operatore sceglie. L'offensivo chiede una conferma esplicita in-sessione.
// Le policy e il rendering stanno in local/plan.js (puro e testato); qui c'e' solo il REGIA.
async function runPlanMode(host, opts) {
  const plan = require('./plan');
  const readline = require('node:readline');
  const choices = [];

  // 0) scope check duro: niente parte senza autorizzazione scritta.
  const sc = nodeTool('scope-guard.js', ['check', host]);
  if (sc.code !== 0) die(`host fuori scope o scope.json vuoto: ${host}\n${sc.out}\nCompila scope.json.`);

  log(`modalita' PIANO — target ${host}`);
  const llm = new LocalLLM(CFG);

  // 1) recon autonomo (agente di fase).
  await runPhaseAgent(llm, 'recon-map', { host }, opts);

  // 2) recon deterministico non intrusivo dal grafo appena popolato.
  let p = plan.buildPlan(host, { all: opts.all });
  let autoRecon = [];
  if (!opts.dry && opts.autoRecon) {
    log('auto-recon (solo azioni ammesse, non intrusive, non coperte):');
    autoRecon = plan.autoRecon(p, { onRun: (a) => log(`  · ${a.cmd}`) });
    if (!autoRecon.length) log('  (niente da fare: il grafo e\' gia\' coperto)');
    p = plan.buildPlan(host, { all: opts.all }); // il grafo e' cambiato: ripianifica
  }

  // --dry resta senza effetti collaterali: nessun file scritto, solo stampa del piano.
  if (!opts.dry) {
    const report = plan.writeReport(host, p, { autoRecon });
    log(`piano salvato: ${path.relative(WS, report.md)}`);
  }

  // 3) menu + STOP in attesa dell'operatore. Senza TTY (run da script/cron) si ferma qui
  //    dopo aver salvato il piano: nessuna scelta implicita, nessuna azione non autorizzata.
  let m = plan.menu(p);
  console.log(plan.renderMenu(m, { host }));
  if (!process.stdin.isTTY || opts.dry) {
    log('nessuna attesa della scelta (stdin non interattivo o --dry): mi fermo qui.');
    if (!opts.dry) plan.writeReport(host, p, { autoRecon, choices, stopped: true });
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, res));
  const refresh = () => { p = plan.buildPlan(host, { all: opts.all }); m = plan.menu(p); };

  try {
    for (;;) {
      const raw = await ask('Scelta > ');
      const it = plan.pick(m, raw);

      if (it.type === 'quit') {
        log('uscita richiesta dall\'operatore.');
        plan.writeReport(host, p, { autoRecon, choices, stopped: true });
        return;
      }
      if (it.type === 'invalid') { log(it.msg); continue; }
      if (it.type === 'reload') { refresh(); console.log(plan.renderMenu(m, { host })); continue; }
      if (it.type === 'phase') {
        choices.push({ at: Date.now(), type: 'phase', phase: it.phase });
        await runPhaseAgent(llm, it.phase, { host, klass: opts.klass }, opts);
        refresh();
        console.log(plan.renderMenu(m, { host }));
        continue;
      }

      // it.type === 'exec'
      const a = it.action;
      const d = plan.decide(a);
      if (!d.ok) { log(`rifiutata: ${d.reason}`); continue; }
      if (d.warn) log(`attenzione: ${d.warn}`);
      if (d.needsConfirm) {
        const y = (await ask(`  ⚠ azione di tier "${a.tier}" su ${a.host}\n    ${a.cmd}\n  confermi l'esecuzione? (y/N) > `)).trim().toLowerCase();
        if (y !== 'y' && y !== 'yes' && y !== 'si' && y !== 'sì') { log('annullata dall\'operatore.'); continue; }
      }
      log(`eseguo: ${a.cmd}`);
      const r = plan.execAction(a);
      console.log(`  exit ${r.code}\n${plan.clip(r.out, 6000)}`);
      choices.push({ at: Date.now(), type: 'exec', n: a.n, tier: a.tier, cmd: a.cmd, exit: r.code });
      refresh();
      console.log(plan.renderMenu(m, { host }));
    }
  } finally {
    rl.close();
    plan.writeReport(host, p, { autoRecon, choices, stopped: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.check) return check();
  if (!args.host) {
    console.log('Uso: node local/run-local.js <host> [--phase recon-map|web-test|host|wireless|report] [--class sqli] [--dry]\n     node local/run-local.js <host> --plan [--no-auto-recon] [--all]   # recon -> opzioni -> STOP\n     node local/run-local.js --check');
    process.exit(2);
  }
  if (args.plan) return runPlanMode(args.host, args);
  await runFull(args.host, args);
}

main().catch((e) => die(e.stack || e.message));
