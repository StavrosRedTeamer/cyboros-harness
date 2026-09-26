#!/usr/bin/env node
// WP3 — Campagna (schema v1): manifest, template, storico append-only, drift di scope.json.
//
// Perché: l'app desktop governa un ENGAGEMENT, non un host. La campagna è il contesto che
// lega scope / RoE / obiettivi / superfici / team / budget e dà un nome alle operazioni.
//
// Regole non negoziabili rispettate qui:
//   - Nessun bypass: questo modulo NON scrive scope.json. Lo LEGGE solo per l'hash di
//     ancoraggio, così un cambio di scope fuori dall'app diventa un badge *stale* e non
//     una modifica silenziosa. I guard non cambiano: la campagna è metadati, non autorità.
//   - Fail-closed ma non bloccante: una campagna senza RoE produce un WARNING (badge rosso
//     nell'app) ma resta salvabile; solo la forma strutturale (id/name) è un errore.
//   - Scrittura atomica (tmp+rename). Storico append-only, mai riscritture.
//
// File (override env per i test, sempre tmpdir, mai i file reali):
//   CC_CAMPAIGN_FILE   (default <ws>/campaign.json)               campagna attiva   [gitignored]
//   CC_CAMPAIGNS_DIR   (default <ws>/campaigns)                   archivio          [gitignored]
//   CC_HISTORY_FILE    (default <ws>/reports/campaign-history.jsonl) storico append   [gitignored]
//   CC_TEMPLATES_DIR   (default <ws>/templates/campaign)
//
// CLI:
//   node tools/cc-campaign.js list [--json]
//   node tools/cc-campaign.js show [--json]
//   node tools/cc-campaign.js templates [--json]
//   node tools/cc-campaign.js from-template <name> --client <c> --name <n> [--id <id>]
//   node tools/cc-campaign.js activate <file|-> [--by <actor>]     (# - = stdin)
//   node tools/cc-campaign.js update --set k=v [--set ...] [--by <actor>]
//   node tools/cc-campaign.js archive [--by <actor>]
//   node tools/cc-campaign.js history [--tail N]
//   node tools/cc-campaign.js drift [--json]
//   node tools/cc-campaign.js rollup [--json]
'use strict';
const fs = require('fs');
const path = require('path');
const u = require('./cc-util');

const SCHEMA_VERSION = 1;
const SURFACES = ['web', 'internal', 'wireless', 'mobile', 'cloud', 'ai'];
const PHASES = ['recon', 'map', 'test', 'authed', 'chains', 'report'];

const root = () => process.env.CC_ROOT || u.ROOT;
const campaignFile = () => process.env.CC_CAMPAIGN_FILE || path.join(root(), 'campaign.json');
const campaignsDir = () => process.env.CC_CAMPAIGNS_DIR || path.join(root(), 'campaigns');
const historyFile = () => process.env.CC_HISTORY_FILE || path.join(root(), 'reports', 'campaign-history.jsonl');
const templatesDir = () => process.env.CC_TEMPLATES_DIR || path.join(root(), 'templates', 'campaign');
const scopeFile = () => process.env.SCOPE_JSON || path.join(root(), 'scope.json');

function listTemplates() {
  try {
    return fs.readdirSync(templatesDir()).filter((f) => f.endsWith('.json')).sort()
      .map((f) => ({ name: f.replace(/\.json$/, ''), path: path.join(templatesDir(), f) }));
  } catch { return []; }
}

function template(name) {
  const f = path.join(templatesDir(), name.replace(/[^a-z0-9._-]/gi, '') + '.json');
  return u.readJson(f, null);
}

// A campaign derived from a template; the template contributes surfaces/gates/
// workflow/classes/team but the operator owns the identity (client, name, id, window).
function fromTemplate(name, overrides) {
  const t = template(name);
  if (!t) return { ok: false, error: 'unknown template: ' + name, available: listTemplates().map((x) => x.name) };
  const o = overrides || {};
  const now = u.nowIso();
  const campaign = Object.assign({}, t, {
    version: SCHEMA_VERSION,
    id: u.slug(o.id || (o.client ? o.client + '-' + name : name + '-' + now.slice(0, 10))),
    name: o.name || (o.client ? o.client + ' — ' + (t.label || name) : (t.label || name)),
    client: o.client || '',
    status: 'draft',
    created_at: now,
    updated_at: now,
    from_template: name,
    scope_hash: scopeHash(),
    scope_hash_at: now,
  });
  // Never leak template-only helper fields into the manifest.
  delete campaign.label;
  return { ok: true, campaign, validation: validate(campaign) };
}

// ── validation ──────────────────────────────────────────────────────────────
// Non-blocking: `errors` break structural integrity (cannot save), `warnings` are
// advisory (rendered as a red badge in the app; guards are untouched either way).
function validate(c) {
  const errors = [];
  const warnings = [];
  if (!c || typeof c !== 'object') return { ok: false, errors: ['campaign is not an object'], warnings };
  if (Number(c.version) !== SCHEMA_VERSION) errors.push('version must be ' + SCHEMA_VERSION);
  if (!c.id || !/^[a-z0-9][a-z0-9._-]*$/.test(String(c.id))) errors.push('id missing or not a slug');
  if (!c.name || !String(c.name).trim()) errors.push('name is required');
  if (!c.roe || !c.roe.authorized_by) warnings.push('no RoE (authorized_by) — authorization is not recorded');
  if (!c.window || (!c.window.start && !c.window.end)) warnings.push('no engagement window');
  if (!Array.isArray(c.objectives) || !c.objectives.length) warnings.push('no objectives listed');
  if (!Array.isArray(c.surfaces) || !c.surfaces.length) warnings.push('no surfaces selected');
  else for (const s of c.surfaces) if (!SURFACES.includes(s)) warnings.push('unknown surface: ' + s);
  if (Array.isArray(c.gates)) for (const g of c.gates) if (!PHASES.includes(g)) warnings.push('unknown gate: ' + g);
  if (!c.scope_hash) warnings.push('no scope.json anchor hash — drift cannot be detected');
  return { ok: errors.length === 0, errors, warnings };
}

// ── scope drift ─────────────────────────────────────────────────────────────
function scopeHash() {
  try { return u.sha256(fs.readFileSync(scopeFile(), 'utf8')); } catch { return null; }
}

function drift(c) {
  const active = c || loadActive();
  const current = scopeHash();
  const anchored = active && active.scope_hash ? active.scope_hash : null;
  return {
    anchored, current,
    stale: !!(anchored && current && anchored !== current),
    scope_file: scopeFile(),
  };
}

// ── active campaign + archive ───────────────────────────────────────────────
function loadRaw(file) { return u.readJson(file, null); }

function loadActive() {
  const c = loadRaw(campaignFile());
  return c && typeof c === 'object' ? c : null;
}

function listCampaigns() {
  const out = [];
  const active = loadActive();
  if (active) out.push(Object.assign({ _active: true }, active));
  try {
    for (const f of fs.readdirSync(campaignsDir()).filter((x) => x.endsWith('.json'))) {
      const c = loadRaw(path.join(campaignsDir(), f));
      if (c && typeof c === 'object') out.push(Object.assign({ _active: !!(active && active.id === c.id) }, c));
    }
  } catch { /* no archive yet */ }
  return out;
}

function getCampaign(id) {
  const active = loadActive();
  if (active && active.id === id) return active;
  return loadRaw(path.join(campaignsDir(), u.slug(id) + '.json'));
}

function appendHistory(entry) {
  u.appendJsonl(historyFile(), Object.assign({ ts: u.nowIso() }, entry));
}

// Atomic manifest write — refuses structural invalidity (fail-closed).
function save(campaign) {
  const v = validate(campaign);
  if (!v.ok) return { ok: false, validation: v };
  campaign.updated_at = u.nowIso();
  u.atomicWriteJson(path.join(campaignsDir(), u.slug(campaign.id) + '.json'), campaign);
  return { ok: true, campaign, validation: v };
}

// Switching the active campaign NEVER rewrites scope.json — it only records the anchor.
function activate(campaign, opts) {
  const o = opts || {};
  const v = validate(campaign);
  if (!v.ok) return { ok: false, validation: v };
  campaign.status = 'active';
  campaign.scope_hash = scopeHash();
  campaign.scope_hash_at = u.nowIso();
  const saved = save(campaign);
  if (!saved.ok) return saved;
  u.atomicWriteJson(campaignFile(), saved.campaign);
  appendHistory({ event: 'activate', id: saved.campaign.id, by: o.actor || 'operator', scope_hash: saved.campaign.scope_hash });
  return { ok: true, campaign: saved.campaign, validation: v };
}

// Re-anchor the active campaign to the current scope (explicit operator action).
function resign(actor) {
  const active = loadActive();
  if (!active) return { ok: false, error: 'no active campaign' };
  const before = active.scope_hash;
  active.scope_hash = scopeHash();
  active.scope_hash_at = u.nowIso();
  u.atomicWriteJson(campaignFile(), active);
  u.atomicWriteJson(path.join(campaignsDir(), u.slug(active.id) + '.json'), active);
  appendHistory({ event: 'resign-scope', id: active.id, by: actor || 'operator', before, after: active.scope_hash });
  return { ok: true, campaign: active };
}

function setPath(obj, dotted, value) {
  const parts = String(dotted).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function update(id, patch, opts) {
  const o = opts || {};
  const target = id ? getCampaign(id) : loadActive();
  if (!target) return { ok: false, error: 'no campaign to update' };
  const next = JSON.parse(JSON.stringify(target));
  for (const [k, v] of Object.entries(patch || {})) setPath(next, k, v);
  const saved = save(next);
  if (!saved.ok) return saved;
  if ((loadActive() || {}).id === saved.campaign.id) u.atomicWriteJson(campaignFile(), saved.campaign);
  appendHistory({ event: 'update', id: saved.campaign.id, by: o.actor || 'operator', patch });
  return { ok: true, campaign: saved.campaign, validation: saved.validation };
}

function archive(id, opts) {
  const o = opts || {};
  const target = id ? getCampaign(id) : loadActive();
  if (!target) return { ok: false, error: 'no campaign to archive' };
  target.status = 'archived';
  const saved = save(target);
  if (!saved.ok) return saved;
  if ((loadActive() || {}).id === target.id) {
    try { fs.unlinkSync(campaignFile()); } catch { /* already gone */ }
  }
  appendHistory({ event: 'archive', id: target.id, by: o.actor || 'operator' });
  return { ok: true, campaign: saved.campaign };
}

function history(limit) {
  const rows = u.readJsonl(historyFile());
  return limit ? rows.slice(-limit) : rows;
}

// ── rollup: hours per phase/operator from the ledger sources ────────────────
// Reads the gate-log transitions (phase passes) and the run-audit job starts; the
// resulting minutes are reported per phase and per operator. Read-only.
function rollup() {
  const reports = path.join(root(), 'reports');
  const gateLog = path.join(reports, 'gate-log.md');
  const audit = process.env.RUN_AUDIT_FILE || path.join(reports, 'tmp', 'run-audit.jsonl');
  const byPhase = {}; const byOperator = {};
  let first = null; let last = null;
  for (const row of u.readJsonl(audit)) {
    const ts = row.ts || row.timestamp || row.started_at;
    if (!ts) continue;
    if (!first || ts < first) first = ts;
    if (!last || ts > last) last = ts;
    const op = row.agent || row.owner || row.by || 'agent';
    byOperator[op] = (byOperator[op] || 0) + (Number(row.duration_ms) || 0);
  }
  try {
    for (const line of fs.readFileSync(gateLog, 'utf8').split('\n')) {
      if (!line.includes('|')) continue;
      const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
      const phase = cells[1] && cells[1].includes('/') ? cells[1].split('/')[1] : null;
      if (phase && cells[2] === 'pass') byPhase[phase] = (byPhase[phase] || 0) + 1;
    }
  } catch { /* no gate log */ }
  const minutes = first && last ? Math.round((Date.parse(last) - Date.parse(first)) / 60000) : 0;
  return {
    window: { first, last, minutes },
    by_phase: byPhase,
    by_operator_ms: byOperator,
    gate_passes: Object.values(byPhase).reduce((a, b) => a + b, 0),
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--client') o.client = argv[++i];
    else if (a === '--name') o.name = argv[++i];
    else if (a === '--id') o.id = argv[++i];
    else if (a === '--by') o.by = argv[++i];
    else if (a === '--tail') o.tail = parseInt(argv[++i], 10);
    else if (a === '--set') { o.sets = o.sets || []; o.sets.push(argv[++i]); }
    else o._.push(a);
  }
  return o;
}

function patchFromSets(sets) {
  const patch = {};
  for (const s of sets || []) {
    const eq = s.indexOf('=');
    if (eq < 0) continue;
    let v = s.slice(eq + 1);
    try { v = JSON.parse(v); } catch { /* keep string */ }
    patch[s.slice(0, eq)] = v;
  }
  return patch;
}

function main(argv) {
  const cli = parseArgs(argv);
  const cmd = cli._[0] || 'show';
  const j = (o) => console.log(JSON.stringify(o, null, 2));

  if (cmd === 'list') {
    const rows = listCampaigns().map((c) => ({ id: c.id, name: c.name, client: c.client, status: c.status, active: !!c._active }));
    if (cli.json) return j(rows), 0;
    for (const r of rows) console.log((r.active ? '● ' : '  ') + r.id + '  ' + (r.name || '') + '  [' + (r.status || '?') + ']');
    if (!rows.length) console.log('(no campaigns)');
    return 0;
  }
  if (cmd === 'show') {
    const c = loadActive();
    if (!c) { if (cli.json) j({ active: null }); else console.log('(no active campaign)'); return 1; }
    const out = { campaign: c, validation: validate(c), drift: drift(c) };
    j(out);
    return 0;
  }
  if (cmd === 'templates') {
    const names = listTemplates().map((x) => x.name);
    if (cli.json) return j(names), 0;
    for (const n of names) console.log(n);
    return 0;
  }
  if (cmd === 'from-template') {
    const r = fromTemplate(cli._[1], { client: cli.client, name: cli.name, id: cli.id });
    if (!r.ok) { console.error(JSON.stringify(r)); return 1; }
    j(r);
    return 0;
  }
  if (cmd === 'activate') {
    let text;
    const src = cli._[1];
    try { text = src === '-' || !src ? fs.readFileSync(0, 'utf8') : fs.readFileSync(src, 'utf8'); }
    catch (e) { console.error('cannot read campaign: ' + e.message); return 1; }
    let campaign;
    try { campaign = JSON.parse(text); } catch (e) { console.error('invalid JSON: ' + e.message); return 1; }
    const r = activate(campaign, { actor: cli.by });
    if (!r.ok) { console.error(JSON.stringify(r)); return 1; }
    j({ ok: true, id: r.campaign.id, validation: r.validation });
    return 0;
  }
  if (cmd === 'update') {
    const r = update(null, patchFromSets(cli.sets), { actor: cli.by });
    if (!r.ok) { console.error(JSON.stringify(r)); return 1; }
    j({ ok: true, id: r.campaign.id, validation: r.validation });
    return 0;
  }
  if (cmd === 'archive') {
    const r = archive(null, { actor: cli.by });
    if (!r.ok) { console.error(JSON.stringify(r)); return 1; }
    j({ ok: true, id: r.campaign.id });
    return 0;
  }
  if (cmd === 'resign') {
    const r = resign(cli.by);
    if (!r.ok) { console.error(JSON.stringify(r)); return 1; }
    j({ ok: true, id: r.campaign.id });
    return 0;
  }
  if (cmd === 'history') {
    j(history(cli.tail));
    return 0;
  }
  if (cmd === 'drift') { j(drift()); return 0; }
  if (cmd === 'rollup') { j(rollup()); return 0; }

  console.error('usage: node tools/cc-campaign.js list|show|templates|from-template <name>|activate <file|->|update --set k=v|archive|resign|history|drift|rollup [--json]');
  return 2;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = {
  SCHEMA_VERSION, SURFACES, PHASES,
  campaignFile, campaignsDir, historyFile, templatesDir, scopeFile,
  listTemplates, template, fromTemplate, validate,
  scopeHash, drift, loadActive, listCampaigns, getCampaign,
  save, activate, update, archive, resign, history, rollup,
};
