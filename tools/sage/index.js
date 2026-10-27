#!/usr/bin/env node
'use strict';
// tools/sage/index.js — Cyboros Sage: deep research locale su Sage-A1.5.
//
//   node tools/sage/index.js run --brief "..." [--lane offensive|capability]
//   node tools/sage/index.js resume [runId]
//   node tools/sage/index.js chat [runId]
//   node tools/sage/index.js status
//   node tools/sage/index.js check
//   node tools/sage/index.js promote <SAGE-...> [--apply] [--force]
//
// Flag: --max-sources N (12)  --budget-min N (90)  --model sage|qwen  --endpoint URL
//       --questions N (6)  --open  --no-redact
//
// Il run è un job lungo con checkpoint: Ctrl-C salva e si riprende con `resume`.
// Il report non è prosa del modello — ogni affermazione che resta ha una citazione
// verificata byte-per-byte contro l'artefatto congelato della fonte.

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const state = require('./state');
const { makeLlm, askJson, usageTokens } = require('./ask');
const { loadHints, scrubText, HOST_MARK } = require('./redact');
const { makePlan, queriesFor } = require('./plan');
const sources = require('./sources');
const { extractClaims } = require('./extract');
const synth = require('./synth');
const { validateQuote } = require('../evidence-quote');

// ── output ─────────────────────────────────────────────────────────────────────
const say = (...a) => console.log('\x1b[1;32m[sage]\x1b[0m', ...a);
const warn = (...a) => console.log('\x1b[1;33m[sage]\x1b[0m', ...a);
const bad = (...a) => console.error('\x1b[1;31m[sage]\x1b[0m', ...a);
function die(msg, code = 1) { bad(msg); process.exit(code); }

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const key = t.slice(2);
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith('--') && next.length > 2)) a[key] = true;
      else { a[key] = next; i++; }
    } else a._.push(t);
  }
  return a;
}

function clampInt(raw, min, max, def) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function normUrl(u) {
  return String(u == null ? '' : u).replace(/[#?].*$/, '').replace(/\/+$/, '');
}

function loadConfig(flags) {
  const model = flags.model === 'qwen' ? 'qwen' : 'sage';
  const rel = model === 'qwen' ? ['local', 'config.local.json'] : ['local', 'sage', 'config.json'];
  const file = path.join(state.ROOT, ...rel);
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { die(`config non leggibile: ${path.relative(state.ROOT, file)} — ${e.message}`); }
  if (flags.endpoint) cfg.endpoint.base_url = String(flags.endpoint);
  // Il profilo del pentest (local/config.local.json) tarа max_tokens per un turno
  // d'agente (1024). La sintesi Sage produce un documento — sintesi, note, proposte — e con
  // 1024 esce TRONCATA: il JSON diventa invalido e il run perde le proposte. Il limite si
  // alza solo per questo processo: il file e il comportamento del pentest restano intatti.
  const want = Number(cfg.sampling && cfg.sampling.max_tokens);
  if (!Number.isFinite(want) || want < 2000) {
    cfg.sampling = Object.assign({}, cfg.sampling, { max_tokens: 2000 });
  }
  return { cfg, model, file };
}

async function endpointIds(cfg) {
  const base = cfg.endpoint.base_url.replace(/\/$/, '');
  const r = await fetch(`${base}/models`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} su ${base}/models`);
  const j = await r.json();
  return (j.data || []).map((m) => m.id);
}

function meter(st) {
  return (u) => {
    const t = usageTokens(u);
    st.tokens.in += t.in;
    st.tokens.out += t.out;
  };
}

function latestRun() {
  const runs = state.list();
  if (!runs.length) die('nessun run in artifacts/sage — lancia prima `run`');
  return runs[0].runId;
}

// ── run / resume ───────────────────────────────────────────────────────────────
function installSigint(st) {
  let done = false;
  process.on('SIGINT', () => {
    if (done) return;
    done = true;
    try { st.phase = 'paused'; state.save(st); } catch { /* niente da salvare */ }
    console.log('');
    say(`interrotto. Stato salvato. Riprendi con: node tools/sage/index.js resume ${st.runId}`);
    process.exit(130);
  });
}

/**
 * Ciclo di ricerca condiviso da run e resume. Ogni fonte completata finisce in
 * `completedUrls` e su disco: al resume non si rifetcha nulla.
 */
async function researchLoop({ llm, st, flags, redact, egress, claims, dropped }) {
  const maxSources = st.maxSources;
  const maxChunks = clampInt(flags['chunks-per-source'], 1, 4, 2);

  for (const question of st.questions) {
    if (st.sources.length >= maxSources) break;
    if (state.budgetLeft(st) <= 0) { warn('budget tempo esaurito: mi fermo e sintetizzo quello che ho'); break; }

    const queries = queriesFor(question, st.lane).map((q) => redact(q));
    for (const q of queries) {
      if (q.redacted) warn(`query ripulita: ${q.hits.map((h) => `${h.count}×${h.kind}`).join(', ')}`);
    }
    let candidates = [];
    let searchError = null;
    try {
      candidates = await sources.gather({
        runId: st.runId, question, queries: queries.map((q) => q.text), lane: st.lane, limit: maxSources,
      });
    } catch (e) { searchError = e.message; }
    egress({
      kind: 'search', question: redact(question).text, queries: queries.map((q) => q.text),
      candidates: candidates.length, ...(searchError ? { error: searchError } : {}),
    });
    if (searchError) {
      st.errors.push(`ricerca "${question}": ${searchError}`);
      state.save(st);
      continue;
    }
    if (!candidates.length) warn(`nessuna fonte per: ${question}`);

    for (const cand of candidates) {
      if (st.sources.length >= maxSources) break;
      if (state.budgetLeft(st) <= 0) break;
      const key = normUrl(cand.url);
      if (st.completedUrls.includes(key)) continue;

      let frozen = null;
      try {
        if (cand.rel) frozen = { rel: cand.rel, url: cand.url };
        else if (cand.text) {
          frozen = { ...sources.freeze(st.runId, cand.url, cand.text, { url: cand.url, origin: cand.provider, title: cand.title }), url: cand.url };
        } else {
          frozen = await sources.fetchSource(st.runId, cand.url, { title: cand.title, provider: cand.provider });
        }
      } catch (e) {
        st.warnings.push(`fetch ${cand.url}: ${e.message}`);
        st.completedUrls.push(key);   // un URL che fallisce non va ritentato a ogni resume
        state.save(st);
        continue;
      }
      if (!frozen) { st.completedUrls.push(key); state.save(st); continue; }

      egress({ kind: 'fetch', url: frozen.url || cand.url, provider: cand.provider, artifact: frozen.rel });

      let text = cand.text;
      if (!text) {
        try { text = fs.readFileSync(path.join(state.ROOT, frozen.rel), 'utf8'); }
        catch { text = ''; }
      }

      let res;
      try {
        res = await extractClaims({
          llm, sourceRel: frozen.rel, text, question, maxChunks, onUsage: meter(st),
        });
      } catch (e) {
        st.warnings.push(`estrazione ${cand.url}: ${e.message}`);
        st.completedUrls.push(key);
        state.save(st);
        continue;
      }

      for (const c of res.kept) {
        c.id = `C-${String(claims.length + 1).padStart(4, '0')}`;
        claims.push(c);
        state.appendJsonl(state.dirs(st.runId).claims, c);
      }
      for (const d of res.dropped) state.appendJsonl(state.dirs(st.runId).dropped, { ...d, source: frozen.rel });
      dropped.push(...res.dropped);

      st.sources.push({
        url: frozen.url || cand.url, title: cand.title || cand.url, provider: cand.provider || 'web',
        rel: frozen.rel, claims: res.kept.length, at: new Date().toISOString(),
      });
      st.completedUrls.push(key);
      st.claims.kept = claims.length;
      st.claims.dropped = dropped.length;
      state.save(st);

      say(`fonte ${st.sources.length}/${maxSources} · ${String(cand.title || cand.url).slice(0, 55)} · +${res.kept.length} claim (${res.emitted} proposti) · ${state.elapsedMin(st).toFixed(0)} min`);
    }
  }
}

async function finishRun({ llm, st, redact, claims, dropped, flags }) {
  st.phase = 'synthesize';
  state.save(st);

  const unique = synth.dedupeClaims(claims);
  const syn = await synth.synthesize({
    llm, brief: st.brief, lane: st.lane, claims: unique, questions: st.questions, runId: st.runId, onUsage: meter(st),
  });

  if (syn.origin === 'fallback') {
    warn(`sintesi in fallback: la risposta del modello non era JSON valido. Inizio risposta: ${String(syn.raw || '').replace(/\s+/g, ' ').slice(0, 240)}`);
  }

  const minutes = state.elapsedMin(st);
  const metrics = {
    sources: st.sources.length,
    kept: unique.length,
    dropped: dropped.length,
    minutes,
    tokPerSec: minutes > 0 ? st.tokens.out / (minutes * 60) : 0,
  };

  const out = synth.writeOutputs({
    st, sources: st.sources, claims: unique, notes: syn.notes, proposals: syn.proposals,
    summary: syn.summary, dropped, metrics, proposalsSkipped: syn.proposalsSkipped,
  });

  st.phase = 'done';
  st.finishedAt = new Date().toISOString();
  st.outputs = out;
  st.metrics = metrics;
  state.save(st);

  say(`fatto: ${metrics.kept} claim verificati, ${metrics.dropped} citazioni scartate, ${metrics.sources} fonti, ${minutes.toFixed(0)} min`);
  say(`report: ${out.report}`);
  say(`proposte: ${out.proposals}`);
  say(`chat: node tools/sage/index.js chat ${st.runId}`);

  if (flags.open) openPath(path.join(state.ROOT, out.report));
  return out;
}

function openPath(p) {
  const { spawn } = require('node:child_process');
  const opener = ['xdg-open', 'gio', 'open'].find((b) => {
    try { require('node:child_process').execFileSync('which', [b], { stdio: 'ignore' }); return true; } catch { return false; }
  });
  if (!opener) { warn(`nessun opener grafico: apri ${p}`); return; }
  spawn(opener, opener === 'gio' ? ['open', p] : [p], { detached: true, stdio: 'ignore' }).unref();
}

async function cmdRun(flags) {
  const lane = flags.lane === 'capability' ? 'capability' : 'offensive';
  const brief = String(flags.brief || flags._.slice(1).join(' ')).trim();
  if (!brief) die('brief mancante: --brief "cosa vuoi indagare"');
  const { cfg, model } = loadConfig(flags);

  const id = state.runId(lane);
  state.ensure(id);
  const st = {
    runId: id, lane, brief, model, endpoint: cfg.endpoint.base_url,
    maxSources: clampInt(flags['max-sources'], 1, 200, 12),
    budgetMin: clampInt(flags['budget-min'], 1, 24 * 60, 90),
    startedAt: new Date().toISOString(),
    phase: 'plan', questions: [], sources: [], completedUrls: [],
    claims: { kept: 0, dropped: 0 }, tokens: { in: 0, out: 0 },
    errors: [], warnings: [],
  };
  state.save(st);
  installSigint(st);

  try {
    const ids = await endpointIds(cfg);
    say(`modello: ${ids.join(', ') || '?'} su ${cfg.endpoint.base_url}`);
  } catch (e) {
    st.phase = 'failed';
    st.errors.push(`endpoint: ${e.message}`);
    state.save(st);
    die(`endpoint non raggiungibile (${cfg.endpoint.base_url}): ${e.message}\n`
      + '  avvia il modello: bash local/sage/serve.sh   (oppure --model qwen con il server già attivo)');
  }

  const llm = makeLlm(cfg);
  const hints = loadHints(state.ROOT);
  const redact = (t) => (flags['no-redact']
    ? { text: String(t), hits: [], redacted: false }
    : scrubText(t, hints));
  const egress = (entry) => state.appendJsonl(state.dirs(id).egress, { ts: new Date().toISOString(), ...entry });

  say(`run ${id} · lane ${lane} · ${st.maxSources} fonti · ${st.budgetMin} min`);

  const plan = await makePlan({
    llm, brief, lane, maxQuestions: clampInt(flags.questions, 2, 12, 6), onUsage: meter(st),
  });
  st.questions = plan.questions;
  st.phase = 'research';
  state.save(st);
  say(`piano (${plan.origin}): ${plan.questions.length} domande`);

  const claims = [];
  const dropped = [];
  await researchLoop({ llm, st, flags, redact, egress, claims, dropped });
  return finishRun({ llm, st, redact, claims, dropped, flags });
}

async function cmdResume(flags) {
  const id = flags._[1] || latestRun();
  const st = state.load(id);
  if (!st) die(`run non trovato: ${id}`);
  if (st.phase === 'done') { say(`run ${id} già completo: ${st.outputs ? st.outputs.report : '(report non registrato)'}`); return; }

  const { cfg } = loadConfig({ ...flags, model: flags.model || st.model });
  try { await endpointIds(cfg); } catch (e) { die(`endpoint non raggiungibile (${cfg.endpoint.base_url}): ${e.message}`); }
  const llm = makeLlm(cfg);
  const hints = loadHints(state.ROOT);
  const redact = (t) => (flags['no-redact']
    ? { text: String(t), hits: [], redacted: false }
    : scrubText(t, hints));
  const egress = (entry) => state.appendJsonl(state.dirs(id).egress, { ts: new Date().toISOString(), ...entry });

  const claims = state.readJsonl(state.dirs(id).claims);
  const dropped = state.readJsonl(state.dirs(id).dropped);
  st.phase = 'research';
  state.save(st);
  installSigint(st);

  say(`resume ${id}: ${st.sources.length} fonti già lette, ${claims.length} claim, ${st.completedUrls.length} URL completati`);
  await researchLoop({ llm, st, flags, redact, egress, claims, dropped });
  return finishRun({ llm, st, redact, claims, dropped, flags });
}

// ── chat ───────────────────────────────────────────────────────────────────────
function chatMaterial(st, claims) {
  const lines = [];
  lines.push(`RUN: ${st.runId} · lane ${st.lane}`);
  lines.push(`BRIEF: ${st.brief}`);
  lines.push('');
  lines.push('CLAIM VERIFICATI (id · claim · fonte):');
  for (const c of claims.slice(0, 120)) {
    lines.push(`[${c.id}] ${c.claim} (${path.basename(c.source)}, ${c.confidence})`);
  }
  let material = lines.join('\n');
  if (st.outputs && st.outputs.report) {
    try {
      const report = fs.readFileSync(path.join(state.ROOT, st.outputs.report), 'utf8');
      material += `\n\nREPORT:\n${report.slice(0, 18000)}`;
    } catch { /* report sparito: i claim bastano */ }
  }
  return material.slice(0, 40000);
}

async function cmdChat(flags) {
  const id = flags._[1] || latestRun();
  const st = state.load(id);
  if (!st) die(`run non trovato: ${id}`);
  const claims = state.readJsonl(state.dirs(id).claims);
  const { cfg } = loadConfig({ ...flags, model: flags.model || st.model });
  const llm = makeLlm(cfg);

  const system = [
    'Sei il ricercatore che ha prodotto questo studio. Rispondi in italiano, asciutto.',
    'Usa SOLO il materiale qui sotto. Ogni affermazione fattuale cita l\'id del claim, per esempio [C-0007].',
    'Se il materiale non risponde, dillo e indica quale fonte manca: non improvvisare.',
    '',
    chatMaterial(st, claims),
  ].join('\n');

  const interactive = process.stdin.isTTY;
  if (interactive) {
    say(`chat sul run ${id} (${claims.length} claim). /q per uscire, /claims per la lista.`);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'sage> ' });
  let history = [{ role: 'system', content: system }];
  if (interactive) rl.prompt();

  for await (const raw of rl) {
    const line = String(raw).trim();
    if (!line) { if (interactive) rl.prompt(); continue; }
    if (['/q', '/quit', '/exit'].includes(line)) break;
    if (line === '/claims') {
      for (const c of claims) console.log(`${c.id}  ${c.claim}`);
      if (interactive) rl.prompt();
      continue;
    }
    try {
      const res = await llm.runAgent({
        task: line, tools: [], dispatch: async () => '', history,
        onUsage: meter(st),
      });
      history = res.messages;
      console.log(`\n${res.text}\n`);
    } catch (e) {
      bad(`errore: ${e.message}`);
    }
    if (interactive) rl.prompt();
  }
}

// ── status / check ─────────────────────────────────────────────────────────────
function cmdStatus() {
  const runs = state.list();
  if (!runs.length) { say('nessun run. `node tools/sage/index.js run --brief "..."`'); return; }
  console.log('run                          lane         stato      fonti  claim  min   brief');
  for (const r of runs.slice(0, 20)) {
    console.log([
      r.runId.padEnd(28),
      String(r.lane).padEnd(12),
      String(r.phase).padEnd(10),
      String(r.sources ? r.sources.length : 0).padStart(5),
      String(r.claims ? r.claims.kept : 0).padStart(6),
      String(state.elapsedMin(r).toFixed(0)).padStart(5),
      String(r.brief || '').slice(0, 50),
    ].join(' '));
  }
}

async function cmdCheck(flags) {
  const { cfg, model, file } = loadConfig(flags);
  let fails = 0;
  const ok = (name, detail = '') => console.log(`  PASS ${name}${detail ? ` — ${detail}` : ''}`);
  const no = (name, detail = '') => { fails++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); };

  say(`check · profilo ${model} · ${path.relative(state.ROOT, file)}`);

  // 1) endpoint + modello servito
  try {
    const ids = await endpointIds(cfg);
    ok('endpoint', `${cfg.endpoint.base_url} → ${ids.join(', ') || '(nessun id)'}`);
  } catch (e) {
    no('endpoint', `${cfg.endpoint.base_url}: ${e.message}`);
    bad('  avvia il modello: bash local/sage/serve.sh (o --model qwen)');
    process.exit(1);
  }

  const llm = makeLlm(cfg);
  const budget = { in: 0, out: 0 };
  const count = (u) => { const t = usageTokens(u); budget.in += t.in; budget.out += t.out; };

  // 2) round-trip JSON
  try {
    const { json, raw } = await askJson(llm, {
      system: 'Rispondi in JSON.', task: 'Restituisci {"ok":true}.', onUsage: count,
    }, );
    if (json && json.ok === true) ok('round-trip JSON', `${budget.out} token out`);
    else no('round-trip JSON', `risposta non conforme: ${String(raw).slice(0, 120)}`);
  } catch (e) {
    no('round-trip JSON', e.message);
  }

  // 3) quote-gate: una citazione inventata DEVE essere rifiutata, una reale accettata
  const probe = state.ensure('preflight');
  const probeFile = path.join(probe.sources, 'quote-probe.txt');
  const realText = 'Il gate accetta solo citazioni che esistono davvero nel file congelato.';
  fs.writeFileSync(probeFile, realText, 'utf8');
  const rel = path.relative(state.ROOT, probeFile);
  const good = validateQuote({ status: 'confirmed', evidence_quote: { file: rel, text: 'citazioni che esistono davvero' } });
  const fake = validateQuote({ status: 'confirmed', evidence_quote: { file: rel, text: 'questa frase non esiste nel file' } });
  if (good === null && fake !== null) ok('quote-gate', 'citazione reale accettata, inventata rifiutata');
  else no('quote-gate', `reale=${good === null ? 'ok' : good} · inventata=${fake ? 'rifiutata' : 'ACCETTATA (grave)'}`);

  // 4) redazione: un host in scope non deve sopravvivere a una query
  const hints = loadHints(state.ROOT);
  const knownHost = (hints.hosts || [])[0];
  if (knownHost) {
    const r = scrubText(`novità su ${knownHost} e su sub.${knownHost}`, hints);
    if (!r.text.includes(knownHost) && r.text.includes(HOST_MARK)) ok('redazione', `host in scope → ${HOST_MARK}`);
    else no('redazione', `host in scope sopravvissuto: ${r.text.slice(0, 80)}`);
  } else {
    const r = scrubText('novità su example.org', { hosts: ['example.org'], ips: [] });
    if (r.redacted) ok('redazione', 'scope vuoto: verificata su host sintetico');
    else no('redazione', 'la redazione non ha toccato un host noto');
  }

  say(fails ? `${fails} check falliti` : 'tutto pronto');
  process.exit(fails ? 1 : 0);
}

// ── promote ────────────────────────────────────────────────────────────────────
function findProposal(pid) {
  let files = [];
  try { files = fs.readdirSync(state.REPORTS).filter((f) => f.endsWith('.proposals.json')); } catch { return null; }
  const hits = [];
  for (const f of files.sort().reverse()) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(state.REPORTS, f), 'utf8')); } catch { continue; }
    const p = (j.proposals || []).find((x) => x.id === pid);
    if (p) hits.push({ proposal: p, run: j.run, file: path.join(state.REPORTS, f) });
  }
  if (hits.length > 1) {
    // Due run hanno generato lo stesso id: non si sceglie "il più recente", si chiede
    // all'operatore quale intende (e si segnala il difetto, non lo si nasconde).
    die(`id ambiguo: ${pid} compare in ${hits.length} file — specifica quello giusto o rigenera la proposta\n  `
      + hits.map((h) => `- ${path.relative(state.ROOT, h.file)} (run ${h.run})`).join('\n  '));
  }
  return hits[0] || null;
}

function cmdPromote(flags) {
  const pid = flags._[1];
  if (!pid) die('uso: promote <SAGE-...> [--apply] [--force]');
  const found = findProposal(pid);
  if (!found) die(`proposta ${pid} non trovata in reports/sage/*.proposals.json`);
  const { proposal, run, file } = found;
  if (proposal.status !== 'approved') {
    die(`la proposta ${pid} è "${proposal.status}": aprila, verificala e metti "status":"approved" in\n  ${path.relative(state.ROOT, file)}\n  poi rilancia. Nessuna conoscenza non revisionata entra nei playbook.`);
  }
  const st = state.load(run) || { runId: run, brief: proposal.name };
  const claims = state.readJsonl(state.dirs(run).claims);
  const draft = synth.renderPlaybookDraft(proposal, claims, st);

  const slug = state.slugify(proposal.name).slice(0, 64) || 'proposal';
  const draftFile = path.join(state.REPORTS, 'drafts', `${slug}.md`);
  fs.mkdirSync(path.dirname(draftFile), { recursive: true });
  fs.writeFileSync(draftFile, draft, 'utf8');
  say(`bozza: ${path.relative(state.ROOT, draftFile)}`);

  if (!flags.apply) { say('per promuovere nei playbook: --apply (dopo aver letto la bozza)'); return; }

  const target = path.join(state.ROOT, 'skills', 'pentest-playbook', 'references', `${slug}.md`);
  if (fs.existsSync(target) && !flags.force) {
    die(`esiste già ${path.relative(state.ROOT, target)} — usa --force per sovrascrivere (dopo averlo letto)`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, draft, 'utf8');
  say(`promosso: ${path.relative(state.ROOT, target)}`);
}

// ── main ───────────────────────────────────────────────────────────────────────
function usage() {
  console.log(`Cyboros Sage — deep research locale

  run      --brief "..." [--lane offensive|capability] [--max-sources 12] [--budget-min 90]
  resume   [runId]
  chat     [runId]
  status
  check    [--model sage|qwen] [--endpoint URL]
  promote  <SAGE-...> [--apply] [--force]

Comuni: --model sage|qwen  --endpoint URL  --questions N  --chunks-per-source N  --open  --no-redact`);
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const cmd = flags._[0] || 'status';
  switch (cmd) {
    case 'run': await cmdRun(flags); break;
    case 'resume': await cmdResume(flags); break;
    case 'chat': await cmdChat(flags); break;
    case 'status': cmdStatus(); break;
    case 'check': await cmdCheck(flags); break;
    case 'promote': cmdPromote(flags); break;
    case 'help': case '--help': case '-h': usage(); break;
    default: usage(); process.exit(1);
  }
}

if (require.main === module) {
  main().catch((e) => { bad(e && e.stack ? e.stack : String(e)); process.exit(1); });
}

module.exports = {
  parseArgs, clampInt, normUrl, loadConfig, findProposal, chatMaterial, main,
};
