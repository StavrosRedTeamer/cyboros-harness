// local/plan.js — "RECON PRIMA, POI LE OPZIONI, POI MI FERMO".
//
// Scopo: dopo il recon autonomo, presentare all'operatore i modi di PROSEGUIRE l'engagement
// (ricognizione aggiuntiva, verifica attiva, offensivo) e fermarsi in attesa della sua risposta.
//
// Da dove vengono le opzioni: dal planner DETERMINISTICO tools/next-actions.js, che legge il
// grafo del target (reports/state.db) e propone le prossime azioni già taggate con il verdetto
// dello scope-guard e con il tier (read|active|intrusive). Il modello locale NON inventa le
// opzioni: le opzioni sono codice, la loro esecuzione passa dagli entrypoint GIA' guardati
// (tools/run.js, tools/workflow.js) quindi scope-guard/rate-limit/gate restano hard-enforced.
//
// Garanzie di questo modulo (fail-closed):
//   - le azioni BLOCCATE dallo scope-guard non sono nemmeno selezionabili (decide() rifiuta);
//   - un comando che contiene un segreto (<secret>) non viene mai eseguito: va a mano;
//   - il tier intrusive richiede una conferma ESPLICITA in-sessione (needsConfirm) — non c'è
//     percorso che lo esegua senza che l'operatore lo abbia scelto e confermato;
//   - il piano è filtrato sull'host richiesto (e i suoi sottodomini): niente azioni di altri
//     engagement finiti per sbaglio nel grafo;
//   - nessuna dipendenza npm, nessuno stato globale: le funzioni di decisione sono pure e
//     testabili (tools/test-local-plan.js).

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const WS = path.join(__dirname, '..');

// Ordine di presentazione: prima ciò che è innocuo, l'offensivo sempre in fondo e sempre marcato.
const TIER_ORDER = ['read', 'active', 'intrusive'];
const TIER_LABEL = {
  read: 'RICOGNIZIONE — sola lettura',
  active: 'VERIFICA ATTIVA — non intrusiva',
  intrusive: 'OFFENSIVO — intrusivo (conferma esplicita)',
};
// Tasti di fase: proseguono l'engagement con un agente LLM di fase, non con una singola azione.
const PHASE_KEYS = { w: 'web-test', h: 'host', R: 'report' };

// ------------------------------------------------------------------ host filter
// hostOf(target) — normalizza URL o host nella sola forma hostname. Serve perché l'operatore
// può passare `https://portal.example.com/` mentre il grafo tiene `portal.example.com`: senza
// questa normalizzazione il filtro scarterebbe TUTTE le azioni e il menu uscirebbe vuoto.
function hostOf(target) {
  const s = String(target == null ? '' : target).trim();
  if (!s) return '';
  try {
    const u = new URL(s.includes('://') ? s : 'http://' + s, 'http://placeholder.invalid');
    return (u.hostname || '').toLowerCase().replace(/\.+$/, '');
  } catch {
    return s.toLowerCase().replace(/\.+$/, '');
  }
}

// Il grafo può contenere host di altri engagement: teniamo solo l'host richiesto e i suoi
// sottodomini (o il padre, se l'operatore punta a un sottodominio).
function related(candidate, host) {
  const a = hostOf(candidate);
  const b = hostOf(host);
  if (!a || !b) return false;
  return a === b || a.endsWith('.' + b) || b.endsWith('.' + a);
}

// ------------------------------------------------------------------ plan build
// buildPlan(host, {all, db}) -> { host, generated_at, actions[], summary }
// `db` esiste solo per i test (path di un sqlite temporaneo); in produzione si usa il default.
function buildPlan(host, opts = {}) {
  const na = require('../tools/next-actions');
  const tm = require('../tools/target-model');
  const db = tm.open(opts.db);
  try {
    const raw = na.planFromDb(db, { all: !!opts.all });
    const actions = (raw.actions || []).filter((a) => related(a.host, host));
    return { host, generated_at: raw.generated_at || null, actions, summary: na.summarize(actions) };
  } finally {
    if (db && typeof db.close === 'function') db.close();
  }
}

// ------------------------------------------------------------------ policy (pura)
// decide(a) -> { ok, needsConfirm, warn?, reason? }. Non esegue nulla: decide soltanto.
function decide(a) {
  if (!a || !a.cmd) return { ok: false, needsConfirm: false, reason: 'azione senza comando' };
  if (a.blocked) return { ok: false, needsConfirm: false, reason: 'fuori scope: ' + (a.scope_reason || 'scope-guard') };
  if (/<secret>/.test(String(a.cmd))) {
    return { ok: false, needsConfirm: false, reason: 'il comando contiene un segreto (<secret>): eseguilo a mano' };
  }
  return {
    ok: true,
    needsConfirm: a.tier === 'intrusive' || !!a.requires_optin,
    warn: a.covered ? 'già coperto nel grafo (ri-esecuzione richiesta dall\'operatore)' : null,
  };
}

// ------------------------------------------------------------------ menu (pura)
// menu(plan) -> { items[], blocked[] }: assegna i numeri NELL'ORDINE DI VISUALIZZAZIONE
// (tier, poi priorità) così ciò che si legge è ciò che si sceglie. Le bloccate sono elencate
// a parte, senza numero: non sono selezionabili.
function menu(plan) {
  const all = (plan && plan.actions) || [];
  const blocked = all.filter((a) => a.blocked);
  const items = all
    .filter((a) => !a.blocked)
    .sort((a, b) => {
      const t = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier);
      if (t !== 0) return t;
      return (a.priority || 99) - (b.priority || 99);
    })
    .map((a, i) => ({ ...a, n: i + 1 }));
  return { items, blocked };
}

function clip(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+$/, '');
  return t.length > n ? t.slice(0, n) + '\n[…' + (t.length - n) + ' char omessi]' : t;
}

// renderMenu(m, {host, actions}) -> stringa da stampare all'operatore.
function renderMenu(m, opts = {}) {
  const host = opts.host || '(host)';
  const L = [];
  const rule = '─'.repeat(72);
  L.push('');
  L.push(rule);
  L.push(` PROSSIME AZIONI — ${host}`);
  L.push(rule);
  if (!m.items.length) {
    L.push(' (nessuna azione proposta dal planner sul grafo attuale)');
  }
  let lastTier = null;
  for (const a of m.items) {
    if (a.tier !== lastTier) {
      lastTier = a.tier;
      L.push('');
      L.push(` ${TIER_LABEL[a.tier] || a.tier.toUpperCase()}`);
    }
    const mark = '[' + String(a.n).padStart(2, ' ') + ']';
    const tags = [a.surface, a.port ? ':' + a.port : null].filter(Boolean).join('');
    const warn = a.tier === 'intrusive' || a.requires_optin ? '  ⚠ richiede conferma' : (a.covered ? '  (già coperto)' : '');
    L.push(`  ${mark} ${tags ? tags + ' — ' : ''}${a.reason || ''}${warn}`);
    L.push(`        $ ${a.cmd}`);
  }
  if (m.blocked.length) {
    L.push('');
    L.push(` FUORI SCOPE — non selezionabili (${m.blocked.length}):`);
    // dedup compatto: un host può generare molte azioni bloccate, stampiamo le prime 5.
    for (const a of m.blocked.slice(0, 5)) L.push(`   ✗ ${a.host}: ${a.reason || ''}`);
    if (m.blocked.length > 5) L.push(`   … e altre ${m.blocked.length - 5}`);
  }
  L.push('');
  L.push(' Comandi: [numero] esegui · r ricarica il piano · w fase web-test · h fase host · R report · q esci');
  L.push(rule);
  return L.join('\n');
}

// pick(m, raw) -> intento. Puro: nessun I/O, così il REPL è testabile.
function pick(m, raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { type: 'invalid', msg: 'scelta vuota' };
  if (s === 'q' || s === 'quit' || s === 'exit') return { type: 'quit' };
  if (s === 'r') return { type: 'reload' };
  if (PHASE_KEYS[s]) return { type: 'phase', phase: PHASE_KEYS[s] };
  if (/^\d+$/.test(s)) {
    const a = m.items.find((x) => x.n === Number(s));
    if (!a) return { type: 'invalid', msg: `nessuna opzione ${s} (validi: 1-${m.items.length})` };
    return { type: 'exec', action: a };
  }
  return { type: 'invalid', msg: `comando sconosciuto "${s}"` };
}

// ------------------------------------------------------------------ esecuzione
// Esegue UNA azione del planner passando dagli stessi entrypoint guardati (tools/run.js,
// tools/workflow.js). Nessuna shell: split dell'argv + spawn diretto di node.
function execAction(a, opts = {}) {
  const argv = String(a.cmd || '').trim().split(/\s+/);
  if (argv[0] !== 'node') return { ok: false, code: 1, out: `comando non eseguibile (atteso "node …"): ${a.cmd}` };
  const args = argv.slice(1).map((x) => (x.startsWith('tools/') ? path.join(WS, x) : x));
  const r = spawnSync(process.execPath, args, {
    cwd: WS, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    timeout: opts.timeout ?? 1800000,
  });
  const out = [r.stdout, r.stderr].filter(Boolean).join('\n').trim();
  return { ok: r.status === 0, code: r.status == null ? 1 : r.status, out: out || (r.error ? String(r.error.message) : '') };
}

// autoRecon(plan, {onRun, dry}) — la parte "tutto il recon da solo": esegue SOLO le azioni
// ammesse, non intrusive, non ancora coperte e non bloccate. Tutto il resto resta al menu.
function autoRecon(plan, opts = {}) {
  const m = menu(plan);
  const results = [];
  for (const a of m.items) {
    const d = decide(a);
    if (!d.ok || d.needsConfirm || a.covered) continue;
    if (opts.onRun) opts.onRun(a);
    if (opts.dry) { results.push({ cmd: a.cmd, skipped: 'dry-run' }); continue; }
    const r = execAction(a, { timeout: opts.timeout });
    results.push({ cmd: a.cmd, status: r.code, ok: r.ok });
  }
  return results;
}

// ------------------------------------------------------------------ report del piano
function writeReport(host, plan, extra = {}) {
  const m = menu(plan);
  const base = path.join(WS, 'reports', `${hostOf(host).replace(/[^\w.-]/g, '_') || 'target'}-next-actions`);
  const json = {
    host, generated_at: plan.generated_at, generated_by: 'local/plan.js',
    summary: plan.summary,
    actions: m.items.map((a) => ({ n: a.n, tier: a.tier, surface: a.surface, reason: a.reason, cmd: a.cmd, requires_optin: !!a.requires_optin, covered: !!a.covered })),
    blocked: m.blocked.map((a) => ({ host: a.host, reason: a.reason, cmd: a.cmd })),
    auto_recon: extra.autoRecon || [],
    choices: extra.choices || [],
    stopped: !!extra.stopped,
  };
  fs.mkdirSync(path.dirname(base), { recursive: true });
  fs.writeFileSync(base + '.json', JSON.stringify(json, null, 2));

  const L = [`# Prossime azioni — ${host}`, '', `Generato: ${new Date().toISOString()} · planner: \`tools/next-actions.js\``, ''];
  L.push(`Azioni proposte: **${plan.summary ? plan.summary.total : 0}** (eseguibili senza opt-in: ${plan.summary ? plan.summary.executable : 0})`, '');
  let lastTier = null;
  for (const a of m.items) {
    if (a.tier !== lastTier) { lastTier = a.tier; L.push('', `## ${TIER_LABEL[a.tier] || a.tier}`); }
    L.push(`- **[${a.n}] ${a.surface}${a.port ? ':' + a.port : ''}** — ${a.reason}${a.requires_optin ? ' _(opt-in)_' : ''}`);
    L.push('  ```', `  ${a.cmd}`, '  ```');
  }
  if (m.blocked.length) {
    L.push('', `## Fuori scope (non eseguibili) — ${m.blocked.length}`, '');
    for (const a of m.blocked.slice(0, 20)) L.push(`- ✗ ${a.host} — ${a.reason}`);
  }
  fs.writeFileSync(base + '.md', L.join('\n') + '\n');
  return { json: base + '.json', md: base + '.md' };
}

module.exports = {
  buildPlan, menu, renderMenu, pick, decide, execAction, autoRecon, writeReport,
  related, hostOf, clip, TIER_ORDER, TIER_LABEL, PHASE_KEYS,
};
