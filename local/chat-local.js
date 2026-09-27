#!/usr/bin/env node
// local/chat-local.js — REPL INTERATTIVO dell'edizione locale StavrosRedTeamer.
// "Stavros al tuo comando" dal terminale: chatti, il modello ragiona e chiama i TOOL REALI
// (gli stessi guardati di run-local.js: scope-guard/rate hard-enforced nei wrapper), tu vedi
// output e findings e continui la conversazione. Nessuna dipendenza npm.
//
// Uso:
//   bash ~/models/qwen36-35b-abl/serve-chat.sh   # (prima) avvia il modello locale su :8080
//   node local/chat-local.js                     # apri il REPL
//   node local/chat-local.js <host> [--phase web-test] [--class sqli] [--auto]
//
// Comandi nel REPL (prefisso /):
//   /help                      questa guida
//   /target <host>             imposta il target e fa subito uno scope_check
//   /phase <fase>              cambia fase/agente (resetta la conversazione)
//   /class <classe>            imposta la classe web (sqli/xss/authz/...)
//   /tools                     tool ammessi nella fase corrente
//   /scope [host]              scope_check dell'host (o del target corrente)
//   /auto [on|off]            auto-conferma dei tool ATTIVI (pipeline/run_tool). Default: off
//   /reset                     azzera la conversazione (mantiene fase/target)
//   /state                     mostra fase, target, classe, auto, lunghezza conversazione
//   /quit | /exit              esci
//   (qualsiasi altra riga)     messaggio al modello nella fase corrente
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const readline = require('node:readline');
const { LocalLLM } = require('./llm');
const { schemaFor, makeDispatch, nodeTool } = require('./tools-bridge');
const { getAgent, AGENTS } = require('./agents-local');
const { toolProtocolGrammar } = require('./grammar');

const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.local.json'), 'utf8'));
const PHASES = CFG.phases || Object.keys(AGENTS);
const ROUTE = CFG.route || {};
// Tool che TOCCANO il target/rete: richiedono conferma esplicita se /auto e' off.
const ACTIVE_TOOLS = new Set(['pipeline', 'run_tool']);

// colori ANSI minimi (no dipendenze)
const c = (n, s) => `\x1b[${n}m${s}\x1b[0m`;
const dim = (s) => c(2, s), bold = (s) => c(1, s), grn = (s) => c(32, s), red = (s) => c(31, s),
  ylw = (s) => c(33, s), cyn = (s) => c(36, s), mag = (s) => c(35, s);

// ── estetica "agent terminal" (solo ANSI, zero dipendenze) ─────────────────────────
const CLR = '\r\x1b[K';                                   // torna a inizio riga + cancella
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']; // braille (dark-terminal safe)
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const cols = () => process.stdout.columns || 80;
const fmt0 = (n) => (n == null ? '—' : String(Math.round(n)));
const fmt1 = (n) => (n == null ? '—' : String(Math.round(n * 10) / 10));

// Banner d'avvio: nome + modello + endpoint, palette coerente. Sobrio, box-drawing standard.
function banner() {
  const line = '─'.repeat(49);
  return [
    '',
    cyn('  ╭' + line + '╮'),
    cyn('  │') + bold('   S T A V R O S   R E D T E A M E R') + dim('  · local edition') + cyn('    │'),
    cyn('  ╰' + line + '╯'),
    dim('   model  ') + CFG.endpoint.model,
    dim('   api    ') + CFG.endpoint.base_url,
    dim('   live   ') + dim('prefill/gen tok/s in tempo reale · stile Hermes'),
  ].join('\n');
}

// Spinner semplice per attese senza metriche (preflight/load). Ritorna stop(finalLine?).
function startSpinner(label) {
  let i = 0;
  const t0 = Date.now();
  const id = setInterval(() => {
    const el = ((Date.now() - t0) / 1000).toFixed(1);
    process.stdout.write(`${CLR}  ${cyn(SPIN[i++ % SPIN.length])} ${label} ${dim(el + 's')}`);
  }, 90);
  if (id.unref) id.unref();
  return (finalLine) => { clearInterval(id); process.stdout.write(CLR); if (finalLine) console.log(finalLine); };
}

// Meter live di un turno: spinner "prefill…" → riga tok/s che sale (prefill+gen+token+durata)
// con una preview in coda del testo che il modello sta scrivendo. Un solo setInterval a 90ms
// ridisegna dallo stato corrente: i callback aggiornano solo i numeri, niente polling per token.
function makeLiveMeter() {
  const st = { phase: 'prefill', start: Date.now(), spin: 0,
    prefill: null, gen: null, genTok: 0, tail: '', lastElapsed: null };

  function draw() {
    const el = st.lastElapsed != null ? st.lastElapsed : (Date.now() - st.start) / 1000;
    if (st.phase === 'prefill') {
      process.stdout.write(`${CLR}  ${cyn(SPIN[st.spin++ % SPIN.length])} ${dim('prefill…')}  ${dim(fmt1(el) + 's')}`);
      return;
    }
    const parts = [
      st.prefill != null ? `prefill ${fmt0(st.prefill)} tok/s` : null,
      `gen ${grn(fmt1(st.gen))} tok/s`,
      `${st.genTok} tok`,
      `${fmt1(el)}s`,
    ].filter(Boolean);
    let head = `  ${cyn('⏱')}  ` + parts.join(dim(' · '));
    // preview del testo in scrittura, troncata per stare nella larghezza del terminale
    if (st.tail) {
      const budget = cols() - 1 - stripAnsi(head).length - 4;
      if (budget > 6) head += dim('  ▏ ') + dim(st.tail.slice(-budget));
    }
    process.stdout.write(CLR + head);
  }

  const id = setInterval(draw, 90);
  if (id.unref) id.unref();

  return {
    onFirstToken() { if (st.phase === 'prefill') st.phase = 'gen'; },
    onTimings(t) {
      if (!t) return;
      if (t.promptPerSec != null) st.prefill = t.promptPerSec;
      if (t.genPerSec != null) st.gen = t.genPerSec;
      if (t.predictedN != null) st.genTok = t.predictedN;
      if (t.elapsed) st.lastElapsed = t.elapsed;
      if (st.phase === 'prefill' && (t.genPerSec != null || t.predictedN)) st.phase = 'gen';
    },
    onToken(txt) {
      st.tail = (st.tail + txt).replace(/\s+/g, ' ').slice(-120);
    },
    // chiamato quando parte un tool: pulisci la riga viva così la riga tool non si sovrappone,
    // e rimettiti in prefill (il modello rivaluterà il prompt dopo l'observation).
    beforeStep() { process.stdout.write(CLR); st.phase = 'prefill'; st.tail = ''; },
    stop() {
      clearInterval(id);
      process.stdout.write(CLR);
      return { prefill: st.prefill, gen: st.gen, genTok: st.genTok,
        elapsed: st.lastElapsed != null ? st.lastElapsed : (Date.now() - st.start) / 1000 };
    },
  };
}

// RAG semantico ibrido: come in run-local, esporta l'env se abilitato.
(function wireEmbeddings() {
  const e = CFG.embeddings;
  if (!e || !e.enabled || !e.url) return;
  process.env.STAVROS_EMBED_URL = e.url;
  if (e.model) process.env.STAVROS_EMBED_MODEL = e.model;
  if (e.api_key) process.env.STAVROS_EMBED_KEY = e.api_key;
  if (e.alpha != null) process.env.STAVROS_RAG_ALPHA = String(e.alpha);
})();

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--phase') a.phase = argv[++i];
    else if (t === '--class') a.klass = argv[++i];
    else if (t === '--auto') a.auto = true;
    else a._.push(t);
  }
  a.host = a._[0];
  return a;
}

const state = {
  phase: 'recon-map',
  host: null,
  klass: null,
  auto: false,
  history: null, // messages della conversazione corrente (per la fase corrente)
};

const llm = new LocalLLM(CFG);
let rl;
let nextLine = null; // coda di righe, impostata in main() dopo la creazione di readline

// ask: stampa il prompt (se dato) e attende UNA riga. Ritorna null a EOF (stdin chiuso).
// Usa una coda di eventi 'line' invece di rl.question: robusto con input in pipe e con
// prompt annidati (conferme) durante un await, senza perdere righe né chiudersi troppo presto.
function ask(promptStr) {
  if (promptStr) process.stdout.write(promptStr);
  return nextLine();
}
async function askYesNo(q) {
  const a = await ask(q);
  if (a == null) return false;
  const s = a.trim().toLowerCase();
  return s === 'y' || s === 's' || s === 'si' || s === 'yes';
}

function currentAgent() {
  const ag = getAgent(state.phase);
  if (!ag) throw new Error(`fase sconosciuta: ${state.phase}`);
  return ag;
}

// Preambolo di contesto iniettato come primo turno utente della conversazione di fase.
function phasePreamble(agent) {
  const lines = [
    `CONTESTO OPERATIVO (fase ${agent.id}):`,
    state.host ? `- Target host: ${state.host} (verifica sempre con scope_check prima di toccarlo).`
      : '- Nessun target impostato: usa /target <host> per fissarlo. Senza target, rispondi solo a livello metodologico.',
    state.klass ? `- Classe di interesse: ${state.klass}.` : null,
    `- Tool disponibili in questa fase: ${agent.tools.join(', ')}.`,
    '- Rispetta lo scope. Prova a impatto minimo. Registra solo finding verificati.',
    'Ora attendi le richieste dell\'operatore e agisci al suo comando, un passo alla volta.',
  ].filter(Boolean);
  return lines.join('\n');
}

// Riporta gli args di run_tool alla forma canonica {bin, args:[]}. Il modello debole li emette
// in varianti: array posizionale ["bin","arg1",…], `command`/`cmd` invece di `bin`, o `args`
// come stringa unica. Senza normalizzazione il riepilogo mostrava "?" e la dispatch falliva con
// "bin mancante" (args.bin è undefined su un array). Guardrail invariati: run.js applica comunque
// scope/rate sull'esecuzione reale.
function normalizeRunTool(args) {
  if (Array.isArray(args)) {
    const [bin, ...rest] = args.map(String);
    return { bin: bin || '', args: rest };
  }
  if (args && typeof args === 'object') {
    const bin = args.bin || args.command || args.cmd || '';
    let a = args.args ?? args.argv ?? [];
    if (typeof a === 'string') a = a.split(/\s+/).filter(Boolean);
    if (!Array.isArray(a)) a = [];
    return { bin: String(bin), args: a.map(String) };
  }
  if (typeof args === 'string') {
    const parts = args.split(/\s+/).filter(Boolean);
    return { bin: parts[0] || '', args: parts.slice(1) };
  }
  return { bin: '', args: [] };
}

// Dispatch guardato + gate di conferma interattivo per i tool attivi.
function makeGuardedDispatch(agent) {
  const base = makeDispatch({ allowRunTool: agent.tools.includes('run_tool') });
  return async function (name, args = {}) {
    const callArgs = name === 'run_tool' ? normalizeRunTool(args) : args;
    if (ACTIVE_TOOLS.has(name) && !state.auto) {
      const summary = name === 'run_tool'
        ? `${callArgs.bin || '?'} ${callArgs.args.join(' ')}`.trim()
        : `${args.phase || '?'} ${args.host || state.host || '?'}`;
      const ok = await askYesNo(ylw(`  ⚠  eseguo tool ATTIVO ${bold(name)}(${summary}) sul target? [y/N] `));
      if (!ok) return `AZIONE ANNULLATA dall'operatore: ${name}(${summary}). Proponi un'alternativa o chiedi indicazioni.`;
    }
    return base(name, callArgs);
  };
}

// In CHAT non usiamo la GBNF tool-protocol: forza ACTION/FINAL e su questo modello debole
// collassa la risposta conversazionale a un FINAL vuoto. Ci affidiamo ai tool NATIVI
// (native_tools) + fallback testuale ACTION:. La GBNF resta in run-local.js per le fasi
// autonome, dove serve il tool-calling rigido.
function grammarFor(_agent) { return null; }

// Esegue un turno conversazionale: il messaggio utente diventa il task, con la history corrente.
async function turn(userMsg) {
  const agent = currentAgent();
  const dispatch = makeGuardedDispatch(agent);
  const tools = schemaFor(agent.tools);
  const grammar = grammarFor(agent);

  // primo turno della fase: inisettiamo il preambolo come parte del task
  const firstOfPhase = !state.history;
  const task = firstOfPhase ? `${phasePreamble(agent)}\n\nOPERATORE: ${userMsg}` : userMsg;

  const meter = makeLiveMeter();
  let res;
  try {
    res = await llm.runAgent({
      system: firstOfPhase ? agent.system : undefined,
      task,
      tools,
      dispatch,
      grammar,
      history: state.history || undefined,
      stream: true,
      onToken: (txt) => meter.onToken(txt),
      onTimings: (t) => meter.onTimings(t),
      onFirstToken: () => meter.onFirstToken(),
      onStep: (s) => {
        meter.beforeStep();
        const via = s.viaText ? dim(' (text)') : '';
        const a = JSON.stringify(s.args || {}).slice(0, 160);
        process.stdout.write(dim(`  · tool ${cyn(s.tool)}${via} ${a}\n`));
      },
    });
  } catch (e) {
    meter.stop();
    console.log(red(`  errore LLM: ${e.message}`));
    return;
  }
  const m = meter.stop();
  // riga di riepilogo stabile: prefill, gen media, n token, durata
  const summary = [
    m.prefill != null ? `prefill ${fmt0(m.prefill)} tok/s` : null,
    `gen ${fmt1(m.gen)} tok/s`,
    `${m.genTok} tok`,
    `${fmt1(m.elapsed)}s`,
  ].filter(Boolean).join(dim(' · '));
  console.log(dim(`  ${grn('✔')}  `) + dim(summary));
  state.history = res.messages; // porta avanti la conversazione (system+tool turns inclusi)
  console.log('\n' + bold(grn('Stavros')) + ': ' + res.text + '\n');
}

// ---- comandi slash ----------------------------------------------------------------
async function handleCommand(line) {
  const [cmd, ...rest] = line.slice(1).trim().split(/\s+/);
  const arg = rest.join(' ');
  switch (cmd) {
    case 'help': printHelp(); break;
    case 'quit': case 'exit': return 'quit';
    case 'state':
      console.log(dim(`  fase=${state.phase} target=${state.host || '—'} classe=${state.klass || '—'} auto=${state.auto ? 'ON' : 'off'} turni=${state.history ? state.history.length : 0}`));
      break;
    case 'phase': {
      if (!PHASES.includes(arg)) { console.log(red(`  fasi valide: ${PHASES.join(', ')}`)); break; }
      state.phase = arg; state.history = null;
      console.log(dim(`  fase → ${arg} (conversazione azzerata). Tool: ${getAgent(arg).tools.join(', ')}`));
      break;
    }
    case 'class': state.klass = arg || null; state.history = null; console.log(dim(`  classe → ${state.klass || '—'} (conversazione azzerata)`)); break;
    case 'target': {
      if (!arg) { console.log(red('  uso: /target <host>')); break; }
      state.host = arg; state.history = null;
      const r = nodeTool('scope-guard.js', ['check', arg]);
      console.log(r.code === 0 ? grn(`  IN SCOPE: ${arg}`) : red(`  OUT OF SCOPE / bloccato: ${arg}\n${r.out}`));
      console.log(dim('  (conversazione azzerata sul nuovo target)'));
      break;
    }
    case 'scope': {
      const h = arg || state.host;
      if (!h) { console.log(red('  nessun target: /scope <host> o /target <host>')); break; }
      const r = nodeTool('scope-guard.js', ['check', h]);
      console.log(r.code === 0 ? grn(`  IN SCOPE: ${h}`) : red(`  OUT OF SCOPE: ${h}\n${r.out}`));
      break;
    }
    case 'tools': console.log(dim(`  ${currentAgent().tools.join(', ')}`)); break;
    case 'auto': {
      if (arg === 'on') state.auto = true; else if (arg === 'off') state.auto = false; else state.auto = !state.auto;
      console.log(dim(`  auto-conferma tool attivi: ${state.auto ? ylw('ON (esegue senza chiedere)') : 'off (chiede conferma)'}`));
      break;
    }
    case 'reset': state.history = null; console.log(dim('  conversazione azzerata (fase/target invariati)')); break;
    default: console.log(red(`  comando sconosciuto: /${cmd} — /help per la lista`));
  }
  return null;
}

function printHelp() {
  console.log([
    bold('  Comandi:'),
    '  /target <host>     imposta target + scope_check      /phase <fase>   cambia fase',
    '  /class <classe>    classe web (sqli/xss/...)          /tools          tool della fase',
    '  /scope [host]      verifica scope                     /auto [on|off]  auto-conferma tool attivi',
    '  /reset             azzera conversazione               /state          stato corrente',
    '  /help              questa guida                       /quit           esci',
    dim(`  fasi: ${PHASES.join(', ')}`),
    dim('  Qualsiasi altra riga = messaggio al modello. I tool ATTIVI (pipeline/run_tool) chiedono conferma se /auto è off.'),
  ].join('\n'));
}

async function preflight(onError) {
  // il server deve rispondere, altrimenti spieghiamo come avviarlo. NB: non-stream (nessun
  // callback di streaming), così il preflight resta identico al comportamento precedente.
  try {
    const r = await llm.runAgent({ system: 'Rispondi in una parola.', task: 'Scrivi: PRONTO', tools: [], dispatch: async () => '' });
    return /PRONTO/i.test(r.text);
  } catch (e) {
    if (onError) onError(); // ferma lo spinner PRIMA di stampare, per non sovrapporsi
    console.log(red(`\n  ✗ Modello non raggiungibile su ${CFG.endpoint.base_url}`));
    console.log(dim('    Avvia prima:  bash ~/models/qwen36-35b-abl/serve.sh'));
    console.log(dim(`    Dettaglio: ${e.message}\n`));
    return false;
  }
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.phase && PHASES.includes(a.phase)) state.phase = a.phase;
  if (a.klass) state.klass = a.klass;
  if (a.auto) state.auto = true;

  console.log(banner());
  const stopSpin = startSpinner(dim('connessione al modello locale…'));
  let spun = false;
  const ok = await preflight(() => { spun = true; stopSpin(); });
  if (!spun) stopSpin();
  if (!ok) process.exit(1);
  console.log(grn('  ✓ modello pronto.') + dim('  /help per i comandi, /quit per uscire.\n'));

  if (a.host) {
    const r = nodeTool('scope-guard.js', ['check', a.host]);
    state.host = a.host;
    console.log(r.code === 0 ? grn(`  target ${a.host} IN SCOPE`) : red(`  target ${a.host} OUT OF SCOPE:\n${r.out}`));
  }

  rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // coda di righe: gli eventi 'line' si accumulano finché ask() non li consuma; 'close'
  // (EOF/stdin chiuso) sblocca un'eventuale attesa con null solo dopo aver drenato la coda.
  const buf = []; let waiting = null; let closed = false;
  rl.on('line', (l) => { if (waiting) { const w = waiting; waiting = null; w(l); } else buf.push(l); });
  rl.on('close', () => { closed = true; if (waiting) { const w = waiting; waiting = null; w(null); } });
  nextLine = () => buf.length ? Promise.resolve(buf.shift())
    : (closed ? Promise.resolve(null) : new Promise((res) => { waiting = res; }));

  const prompt = () => cyn(`\n[${state.phase}${state.host ? ' ' + state.host : ''}]> `);

  // loop principale
  for (;;) {
    const raw = await ask(prompt());
    if (raw == null) break; // EOF / stdin chiuso
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('/')) {
      const r = await handleCommand(line);
      if (r === 'quit') break;
      continue;
    }
    await turn(line);
  }
  if (!closed) rl.close();
  console.log(dim('\n  chiuso. (il modello resta attivo; per fermarlo: pkill -x llama-server)\n'));
}

process.on('SIGINT', () => { console.log(dim('\n  (usa /quit per uscire)')); if (rl) rl.prompt(); });
main().catch((e) => { console.error(red('errore fatale: ' + (e.stack || e.message))); process.exit(1); });
