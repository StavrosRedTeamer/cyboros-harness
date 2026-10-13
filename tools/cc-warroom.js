#!/usr/bin/env node
// WP10 — War Room: la board LIVE dell'operazione, read-only e deterministica.
//
// Mission control dice COSA FARE (piano), il Ledger dice COSA È SUCCESSO (storia): il War
// Room dice COSA STA SUCCEDENDO ADESSO. Non è una nuova fonte di verità — compone i moduli
// esistenti (cc-mission, cc-ledger, cc-graph, sessions, job runner, budget) in UN snapshot
// con timestamp, così i numeri coincidono per costruzione con le altre viste e con la CLI.
//
// DUE FILTRI, ENTRAMBI DICHIARATI NEL PAYLOAD:
//   · SCOPE — solo gli host autorizzati da scope.json (e i loro derivati: un sottodominio di
//     un host in scope è in scope, esattamente come decide scope-guard a runtime). findings.jsonl
//     e lo state.db sono condivisi fra engagement: senza questo filtro la board conta i finding
//     di altri ingaggi. Le righe che NON hanno un host (gate, transizioni, artefatti) restano
//     e sono marcate come non attribuibili, invece di sparire in silenzio; i totali esclusi
//     sono riportati in `engagement.excluded`.
//   · CAMPAGNA — finestra RoE se dichiarata, altrimenti ultima attivazione dallo storico
//     append-only (nessun record porta un campaign_id). Se non è attribuibile lo dice.
//
// FOCUS HOST (opzionale, dichiarato in `campaign.host`): restringe la board a UN host e ai suoi
// derivati — identità fuse dal graph (address/hostname/targets), sottodomini, servizi, porte,
// endpoint e i finding che lo nominano, più approvazioni/sessioni/run che lo toccano. Se non
// c'è focus, la board resta sullo scope intero; l'ultimo target del pipeline viene offerto come
// suggerimento, mai applicato da solo.
//
// Niente LLM, nessuna scrittura: gli unici write del War Room sono di routing (dispatch, panic e
// la scelta del focus, che passa da `/api/cc/campaign/update`) e vivono sui wrapper esistenti.
//
// Delta: lo snapshot è senza stato; il client confronta il tick precedente con quello nuovo
// ed evidenzia ciò che è cambiato (nessun cursore da mantenere lato server).
//
// CLI:
//   node tools/cc-warroom.js show [--tail N]
'use strict';
const fs = require('fs');
const path = require('path');
const u = require('./cc-util');

const root = () => process.env.CC_ROOT || u.ROOT;
const findingsFile = () => process.env.FINDINGS_JSONL || path.join(root(), 'reports', 'findings.jsonl');
const auditFile = () => process.env.RUN_AUDIT_FILE || path.join(root(), 'reports', 'tmp', 'run-audit.jsonl');
const SEV_WEIGHT = { critical: 10, high: 5, medium: 2, low: 1, info: 0 };

function safeInt(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }
function pct(used, cap) { return cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : null; }
function ageMinutes(iso) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? (Date.now() - t) / 60000 : null;
}
function urlHostOf(s) {
  try { return new URL(String(s)).hostname.toLowerCase(); } catch { return null; }
}
function endpointHost(f) { return urlHostOf(f && (f.endpoint || f.url)); }

// Un operatore incolla un URL, un host con porta o un host nudo: normalizza a un hostname,
// senza mai inventare nulla (stringa vuota → nessun focus).
function normalizeHost(input) {
  if (input == null) return null;
  let s = String(input).trim();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  s = s.split('/')[0].split('?')[0].split('#')[0].replace(/:[0-9]+$/, '').toLowerCase();
  return s || null;
}

// ── scope ───────────────────────────────────────────────────────────────────
// Fail-closed anche qui: se il guard non carica, lo stato è BLOCCATO, non "consentito".
function scopePayload() {
  try {
    const sg = require('./scope-guard');
    const s = sg.loadScope();
    const hosts = (s.allowed_hosts || []).length;
    const ips = (s.allowed_ips || []).length;
    const prefixes = (s.allowed_url_prefixes || []).length;
    return {
      fail_closed: !(hosts + ips + prefixes),
      hosts, ips, prefixes,
      rps: typeof s.max_requests_per_second === 'number' ? s.max_requests_per_second : null,
    };
  } catch (e) {
    return { fail_closed: true, hosts: 0, ips: 0, prefixes: 0, rps: null, error: String((e && e.message) || e) };
  }
}

// Il filtro di scope dell'engagement. `applied` è false quando scope.json è vuoto: lì non si
// filtra nulla (la board è vuota per definizione) e il warning fail-closed resta a schermo.
function scopeFilter() {
  try {
    const sg = require('./scope-guard');
    const s = sg.loadScope();
    const hosts = (s.allowed_hosts || []).map(String);
    const ips = (s.allowed_ips || []).map(String);
    const prefixes = (s.allowed_url_prefixes || []).map(String);
    const empty = !(hosts.length + ips.length + prefixes.length);
    const check = (t) => {
      if (!t || empty) return false;
      try { return !!sg.inScope(String(t), s).ok; } catch { return false; }
    };
    return {
      applied: !empty,
      empty,
      check,
      // Un host del graph è dell'engagement se UNA delle sue identità (address, hostname,
      // target) è in scope: è la stessa fusione IP↔hostname che fa cc-graph.
      keepsHost: (h) => {
        if (!h || empty) return true;
        if (h.address && check(h.address)) return true;
        if (h.hostname && check(h.hostname)) return true;
        for (const t of (h.targets || [])) if (check(t)) return true;
        return false;
      },
      // Derivati: vale il host del finding e vale l'hostname dell'endpoint (sottodomini inclusi,
      // perché inScope usa hostAllowed che accetta i sottodomini di un host autorizzato).
      keepsFinding: (f) => {
        if (!f || empty) return true;
        if (f.host && check(f.host)) return true;
        const eh = endpointHost(f);
        return !!(eh && check(eh));
      },
      // Valori senza host (nullo) restano: non sono attribuibili, ma non si buttano via.
      keepsValue: (v) => {
        if (!v || empty) return true;
        return check(v);
      },
      hosts, ips, prefixes,
      authorized: [].concat(
        hosts.map((v) => ({ value: v, kind: 'host' })),
        ips.map((v) => ({ value: v, kind: 'ip' })),
        prefixes.map((v) => ({ value: v, kind: 'url-prefix' })),
      ),
    };
  } catch (e) {
    return {
      applied: false, empty: true, error: String((e && e.message) || e),
      check: () => false,
      keepsHost: () => true, keepsFinding: () => true, keepsValue: () => true,
      hosts: [], ips: [], prefixes: [], authorized: [],
    };
  }
}

// ── campaign + clock ────────────────────────────────────────────────────────
function campaignPayload() {
  try {
    const cc = require('./cc-campaign');
    const c = cc.loadActive();
    if (!c) return null;
    const v = cc.validate(c);
    const d = cc.drift(c);
    return {
      id: c.id, name: c.name || '', client: c.client || '', status: c.status || 'draft',
      host: normalizeHost(c.host),
      roe: c.roe ? { authorized_by: c.roe.authorized_by || null, expires_at: c.roe.expires_at || null } : null,
      window: c.window || null,
      objectives: Array.isArray(c.objectives) ? c.objectives.length : 0,
      surfaces: Array.isArray(c.surfaces) ? c.surfaces : [],
      classes: Array.isArray(c.classes) ? c.classes : [],
      gates: Array.isArray(c.gates) ? c.gates : [],
      validation: { ok: v.ok, errors: v.errors, warnings: v.warnings },
      drift: { stale: !!d.stale, anchored: d.anchored, current: d.current },
    };
  } catch { return null; }
}

function clockPayload(window) {
  const out = { start: null, end: null, elapsed_minutes: null, remaining_minutes: null, expired: false };
  if (!window || typeof window !== 'object') return out;
  out.start = window.start || null;
  out.end = window.end || null;
  const startMs = Date.parse(out.start || '');
  const endMs = Date.parse(out.end || '');
  const now = Date.now();
  if (Number.isFinite(startMs)) out.elapsed_minutes = Math.max(0, Math.round((now - startMs) / 60000));
  if (Number.isFinite(endMs)) {
    out.remaining_minutes = Math.round((endMs - now) / 60000);
    out.expired = now > endMs;
  }
  return out;
}

// ── attribuzione alla campagna attiva ───────────────────────────────────────
// Nessun record dell'harnes porta un campaign_id: l'attribuzione è TEMPORALE e DICHIARATA,
// mai dedotta dal silenzio. Precedenza:
//   window      — la finestra RoE della campagna (start/end espliciti)
//   activation  — l'ultimo evento `activate` di QUESTA campagna nello storico append-only
//   none        — niente è attribuibile: la board lo dice
function campaignTimeline(c) {
  if (!c) return { basis: 'none', from: null, to: null };
  const w = c.window && typeof c.window === 'object' ? c.window : null;
  const start = w ? Date.parse(w.start || '') : NaN;
  const end = w ? Date.parse(w.end || '') : NaN;
  if (Number.isFinite(start) || Number.isFinite(end)) {
    return {
      basis: 'window',
      from: Number.isFinite(start) ? w.start : null,
      to: Number.isFinite(end) ? w.end : null,
    };
  }
  let activation = null;
  try {
    for (const r of require('./cc-campaign').history()) {
      if (r && r.event === 'activate' && r.id === c.id && r.ts) activation = r.ts; // l'ultima attivazione vince
    }
  } catch { /* storico non disponibile: resta non attribuibile */ }
  if (activation) return { basis: 'activation', from: activation, to: null };
  return { basis: 'none', from: null, to: null };
}

function inWindow(ts, t) {
  const x = Date.parse(ts || '');
  if (!Number.isFinite(x)) return false;
  if (t.from && x < Date.parse(t.from)) return false;
  if (t.to && x > Date.parse(t.to)) return false;
  return true;
}

// Aggregati che servono alla board (già filtrati da chi chiama).
function summarizeFindings(rows) {
  const bySev = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  const hosts = new Map();
  for (const f of rows) {
    const s = String(f.severity || 'info').toLowerCase();
    bySev[s] = (bySev[s] || 0) + 1;
    const h = f.host || '(no host)';
    const e = hosts.get(h) || { host: h, findings: 0, critical: 0, high: 0, weight: 0 };
    e.findings++;
    e.weight += SEV_WEIGHT[s] || 0;
    if (s === 'critical') e.critical++;
    else if (s === 'high') e.high++;
    hosts.set(h, e);
  }
  return {
    total: rows.length,
    critical: bySev.critical, high: bySev.high, medium: bySev.medium, low: bySev.low, info: bySev.info,
    verified: rows.filter((f) => f.status === 'verified' || ['exploited', 'proven_impact'].includes(f.verify_level)).length,
    classes: [...new Set(rows.map((f) => f.class).filter(Boolean))].sort(),
    top_hosts: [...hosts.values()]
      .sort((a, b) => b.weight - a.weight || b.findings - a.findings || String(a.host).localeCompare(String(b.host)))
      .slice(0, 6),
  };
}

// Il "record" della campagna attiva, già ristretto allo scope: cosa è entrato, cosa è stato
// autorizzato, cosa è girato. `data` contiene gli array già filtrati.
function campaignRecord(campaign, timeline, data) {
  if (!campaign) return { active: false, attributable: false, basis: 'none', from: null, to: null };
  const t = timeline;
  const attributable = t.basis !== 'none';
  const out = {
    active: true, attributable, basis: t.basis, from: t.from, to: t.to,
    age_minutes: t.from ? Math.max(0, Math.round((Date.now() - Date.parse(t.from)) / 60000)) : null,
    declared_classes: campaign.classes || [],
    declared_gates: campaign.gates || [],
    declared_surfaces: campaign.surfaces || [],
  };
  if (!attributable) return out;

  const fIn = data.findingsInWindow || [];
  out.findings = summarizeFindings(fIn);
  out.findings.untimestamped = data.untimestamped || 0;
  out.findings.excluded_out_of_scope = (data.findingsInWindowAll || []).length - fIn.length;
  // Con un focus attivo il record di campagna resta dell'intera campagna e mostra a parte la
  // fetta dell'host in focus: nessuno dei due numeri sostituisce l'altro.
  if (data.findingsFocusInWindow) {
    const m = summarizeFindings(data.findingsFocusInWindow);
    out.findings.on_focus = { host: data.focusHost, total: m.total, critical: m.critical, high: m.high, verified: m.verified };
  }
  out.approvals = {
    requested: data.approvals.filter((a) => inWindow(a.created_at, t)).length,
    granted: data.approvals.filter((a) => a.status === 'granted' && inWindow(a.decision_ts, t)).length,
    denied: data.approvals.filter((a) => a.status === 'denied' && inWindow(a.decision_ts, t)).length,
  };
  const runs = data.runs.filter((r) => inWindow(r.ts, t));
  out.runs = {
    started: runs.length,
    blocked: runs.filter((r) => r.blocked === true).length,
    dry_run: runs.filter((r) => r.dry_run === true).length,
    failures: runs.filter((r) => r.error_class).length,
    excluded_out_of_scope: (data.runsAll || []).filter((r) => inWindow(r.ts, t)).length - runs.length,
    // Refusals against out-of-scope hosts are the guard working, not campaign activity: they
    // are excluded from the totals but still surfaced on the attention rail.
    refused_out_of_scope: (data.runsAll || []).filter((r) => inWindow(r.ts, t) && r.blocked === true).length
      - runs.filter((r) => r.blocked === true).length,
  };
  let gateRows = [];
  try { gateRows = require('./cc-ledger').gateRows(); } catch { gateRows = []; }
  const phases = [];
  for (const r of gateRows) {
    if (!inWindow(r.ts, t) || String(r.verdict || '').toLowerCase() !== 'pass') continue;
    const phase = String(r.gate || '').includes('/') ? String(r.gate).split('/')[1] : String(r.gate || '');
    if (phase && !phases.includes(phase)) phases.push(phase);
  }
  out.gates = { passed: phases, passed_count: phases.length };
  const live = Array.isArray(data.jobs) ? data.jobs : [];
  out.jobs = {
    started: live.filter((j) => inWindow(j.startedAt, t)).length,
    failed: live.filter((j) => j.state === 'error' && inWindow(j.startedAt, t)).length,
  };
  return out;
}

// ── focus host ──────────────────────────────────────────────────────────────
// Dichiarato in campaign.host. Senza focus la board resta sullo scope intero; l'ultimo target
// del pipeline (se in scope) viene offerto come suggerimento, mai applicato da solo.
function resolveFocus(campaign, filter) {
  const declared = normalizeHost(campaign && campaign.host);
  if (declared) return { host: declared, source: 'campaign', in_scope: filter.check(declared), suggestion: null };
  let last = null;
  try {
    const tm = require('./target-model');
    const db = tm.open();
    try { last = require('./state').lastRun(db); } finally { if (db && typeof db.close === 'function') db.close(); }
  } catch { last = null; }
  const target = last && last.target ? String(last.target) : null;
  return {
    host: null, source: null, in_scope: null,
    suggestion: target && filter.check(target)
      ? { host: target, run: { id: last.id, status: last.status || null, started_at: last.started_at || null } }
      : null,
  };
}

// Un focus dichiarato E in scope restringe la board a quell'host e ai suoi derivati (stessa
// interfaccia del filtro di scope, così ogni payload resta scritto una volta sola). Un focus
// FUORI scope non filtra nulla: lo segnala l'attention rail e la board resta sullo scope intero,
// invece di svuotarsi per un errore di configurazione.
function focusFacet(host, base) {
  const { identities } = hostIdentities(host);
  const matches = identityMatcher(identities);
  return {
    applied: true, empty: base.empty, focus: true, host, identities, base,
    // Restringere, mai allargare: sul focus vale SOLO l'host in focus e i suoi derivati (lo
    // scope era già l'altro livello di filtro, non va riapplicato qui).
    check: (v) => !!(v && matches(v)),
    keepsHost: (h) => !h ? false : (matches(h.address) || matches(h.hostname) || (h.targets || []).some((t) => matches(t))),
    keepsFinding: (f) => !f ? false : (matches(f.host) || matches(endpointHost(f))),
    keepsValue: (v) => !v ? true : matches(v),
  };
}

// Identità di un host, fuse col graph (address/hostname/targets): l'IP e il suo reverse, o un
// sottodominio, sono lo STESSO host — senza la fusione le righe del ledger si perderebbero.
function hostIdentities(host) {
  const low = String(host).toLowerCase();
  const ids = new Set([low]);
  let gHost = null;
  try {
    const g = require('./cc-graph').build();
    gHost = (g.hosts || []).find((h) => [h.address, h.hostname].concat(h.targets || [])
      .filter(Boolean).some((x) => {
        const s = String(x).toLowerCase();
        return s === low || s.endsWith('.' + low) || low.endsWith('.' + s);
      })) || null;
  } catch { gHost = null; }
  if (gHost) {
    for (const x of [gHost.address, gHost.hostname].concat(gHost.targets || [])) if (x) ids.add(String(x).toLowerCase());
  }
  return { identities: [...ids].sort(), gHost };
}

// Un valore (host di un finding, hostname di un endpoint, host di un'approvazione) appartiene
// all'host in focus anche quando è un suo sottodominio.
function identityMatcher(identities) {
  return (v) => {
    if (!v) return false;
    const s = String(v).toLowerCase();
    for (const id of identities) if (s === id || s.endsWith('.' + id)) return true;
    return false;
  };
}

// L'host in focus con i suoi derivati: identità, sottodomini, porte e servizi aperti, endpoint,
// finding che lo nominano, e le attività che lo toccano.
function focusPayload(focus, filter, findingsRows, data) {
  const host = focus && focus.host ? String(focus.host) : null;
  if (!host) return null;
  const { identities, gHost } = hostIdentities(host);
  const matches = identityMatcher(identities);
  const mine = findingsRows.filter((f) => matches(f.host) || matches(endpointHost(f)));
  const sev = summarizeFindings(mine);
  // Lo stesso conteggio ristretto alla finestra di campagna: sulla stessa board convivono i
  // totali "di sempre" dell'host e quelli della campagna, quindi vanno tenuti distinti.
  const t = data.timeline;
  const sevInCampaign = t && t.basis !== 'none' ? summarizeFindings(mine.filter((f) => inWindow(f.ts, t))) : null;
  const approvals = (data.approvals || []).filter((a) => matches(a.host));
  const sessions = (data.sessions || []).filter((s) => matches(s.host));
  const runs = (data.runs || []).filter((r) => (Array.isArray(r.hosts) ? r.hosts.some((h) => filter.check(h)) && r.hosts.some(matches) : false));
  return {
    host,
    in_scope: filter.check(host),
    in_graph: !!gHost,
    identities,
    findings: {
      total: sev.total, critical: sev.critical, high: sev.high, verified: sev.verified,
      in_campaign: sevInCampaign
        ? { total: sevInCampaign.total, critical: sevInCampaign.critical, high: sevInCampaign.high, verified: sevInCampaign.verified }
        : null,
      recent: mine.slice()
        .sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')))
        .slice(0, 8)
        .map((f) => ({
          ts: f.ts || null, severity: f.severity || 'Info', title: f.title || f.class || 'finding',
          endpoint: f.endpoint || f.url || null, status: f.status || null,
          in_campaign: t && t.basis !== 'none' ? inWindow(f.ts, t) : null,
        })),
    },
    ports: gHost && gHost.port_counts
      ? { open: gHost.port_counts.open, filtered: gHost.port_counts.filtered, closed: gHost.port_counts.closed, total: gHost.port_counts.total }
      : null,
    services: gHost ? (gHost.services || []).map((s2) => ({ name: s2.name, ports: s2.ports, versions: s2.versions })) : [],
    endpoints: gHost ? (gHost.endpoints || []).slice(0, 10) : [],
    approvals: approvals.length,
    sessions: sessions.length,
    runs: runs.length,
  };
}

// ── budget burn (dal payload di mission, stessa spawn della CLI) ────────────
// L'ETA è la proiezione al RITMO MEDIO dall'inizio del periodo (richieste/minuto): è etichettata
// come tale anche in UI — una stima, non una misura del ritmo recente.
function burnPayload(budget) {
  const counters = budget.counters || null;
  const caps = budget.caps || null;
  if (!budget.enabled || !counters || !caps) {
    return { available: false, requests: null, wall: null, tokens: null, eta_minutes: null, note: (budget.detail || null) };
  }
  const requests = typeof caps.max_requests === 'number' ? { used: counters.requests, cap: caps.max_requests, pct: pct(counters.requests, caps.max_requests) } : null;
  const wall = typeof caps.max_wall_minutes === 'number' ? { used: counters.wall_minutes, cap: caps.max_wall_minutes, pct: pct(counters.wall_minutes, caps.max_wall_minutes) } : null;
  const tokens = counters.tokens != null && typeof caps.max_tokens === 'number' ? { used: counters.tokens, cap: caps.max_tokens, pct: pct(counters.tokens, caps.max_tokens) } : null;
  let eta_minutes = null;
  if (requests && counters.requests > 0 && counters.wall_minutes > 0) {
    const rate = counters.requests / counters.wall_minutes; // requests/min (media del periodo)
    eta_minutes = Math.max(0, Math.round((caps.max_requests - counters.requests) / rate));
  }
  return { available: true, requests, wall, tokens, eta_minutes, note: caps.max_tokens_note || null };
}

// ── jobs (dal runner in-process, passato dal router; in CLI non esistono) ───
// I job non portano un host: restano attività dell'engagement, non filtrabili per host.
function jobsPayload(jobs) {
  const list = Array.isArray(jobs) ? jobs : [];
  const compact = (j) => ({
    id: j.id, name: j.name, state: j.state, exitCode: j.exitCode == null ? null : j.exitCode,
    startedAt: j.startedAt || null, finishedAt: j.finishedAt || null,
    age_minutes: j.state === 'running' ? Math.max(0, Math.round(ageMinutes(j.startedAt) || 0)) : null,
  });
  return {
    source: Array.isArray(jobs) ? 'server' : 'cli',
    host_attributable: false,
    running: list.filter((j) => j.state === 'running').map(compact),
    failed: list.filter((j) => j.state === 'error').slice(0, 5).map(compact),
    total: list.length,
  };
}

// ── sessions (registry di teardown: chi è dentro, su cosa, con che artefatti aperti) ──
// `base` è il filtro di scope: `excluded` sono le sessioni di altri engagement, `hidden` quelle
// in scope che il focus host ha lasciato fuori. Nessuna delle due sparisce in silenzio.
function sessionsPayload(filter, base) {
  try {
    const file = process.env.SESSIONS_JSON || path.join(root(), 'reports', 'sessions.json');
    const reg = require('./sessions').loadRegistry(file);
    const all = Object.entries(reg.sessions || {}).map(([id, s]) => ({
      id, host: s.host || null, status: s.status || 'unknown',
      user: s.user || s.username || null, platform: s.platform || null,
      ts: s.ts || s.opened_at || null,
      open_artifacts: (s.artifacts || []).filter((a) => a.removed !== true).length,
    }));
    const keptBase = base && base.applied ? all.filter((r) => base.keepsValue(r.host)) : all;
    const rows = filter === base ? keptBase : keptBase.filter((r) => filter.keepsValue(r.host));
    const rank = { active: 0, open: 1, live: 1, pending: 2 };
    rows.sort((a, b) => (rank[a.status] == null ? 3 : rank[a.status]) - (rank[b.status] == null ? 3 : rank[b.status]) || String(a.id).localeCompare(String(b.id)));
    return {
      active: rows.filter((r) => ['active', 'open', 'live'].includes(r.status)).length,
      pending: rows.filter((r) => r.status === 'pending').length,
      total: rows.length,
      excluded: all.length - keptBase.length,
      hidden: keptBase.length - rows.length,
      rows: rows.slice(0, 12),
    };
  } catch (e) {
    return { active: 0, pending: 0, total: 0, excluded: 0, rows: [], error: String((e && e.message) || e) };
  }
}

// ── exposure (mappa host del graph, ristretta allo scope e al focus) ────────
// Un solo build del graph per entrambi i livelli di filtro (lo snapshot gira ogni 5s).
function exposurePayload(filter, base) {
  try {
    const g = require('./cc-graph').build();
    const all = g.hosts || [];
    const keptBase = base && base.applied ? all.filter((h) => base.keepsHost(h)) : all;
    const kept = filter === base ? keptBase : keptBase.filter((h) => filter.keepsHost(h));
    const top = kept.slice(0, 8).map((h) => ({
      host: h.address || h.hostname || '?',
      risk: Math.round((h.risk || 0) * 10) / 10,
      findings: (h.sev && h.sev.total) || 0,
      critical: (h.sev && h.sev.critical) || 0,
      high: (h.sev && h.sev.high) || 0,
      open_ports: (h.port_counts && h.port_counts.open) || 0,
      source: h.source || null,
      in_ledger: !!h.in_ledger,
    }));
    return {
      counts: g.counts || null,
      scoped: {
        hosts: kept.length,
        open_ports: kept.reduce((n, h) => n + ((h.port_counts && h.port_counts.open) || 0), 0),
        findings: kept.reduce((n, h) => n + ((h.sev && h.sev.total) || 0), 0),
      },
      excluded_hosts: all.length - keptBase.length,
      hidden_scope_hosts: keptBase.length - kept.length,
      top,
      error: g.error || null,
    };
  } catch (e) {
    return { counts: null, scoped: null, excluded_hosts: 0, hidden_scope_hosts: 0, top: [], error: String((e && e.message) || e) };
  }
}

// Ultimi finding del ledger (finestra fissa, 60 min), ristretti allo scope: cosa è APPENA entrato.
function recentFindings(windowMinutes, filter) {
  const cutoff = Date.now() - windowMinutes * 60000;
  const rows = filter && filter.applied ? u.readJsonl(findingsFile()).filter(filter.keepsFinding) : u.readJsonl(findingsFile());
  return rows
    .map((f) => ({ ts: f.ts || null, host: f.host || null, severity: f.severity || 'Info', title: f.title || f.class || 'finding', status: f.status || null, verify_level: f.verify_level || null }))
    .filter((f) => f.ts && Date.parse(f.ts) >= cutoff)
    .sort((a, b) => String(b.ts).localeCompare(String(a.ts)))
    .slice(0, 8);
}

// Attribuzione di una riga del ledger: solo approvazioni (host) e audit (hosts dell'entry)
// hanno un host; le altre restano `null` — non attribuibili, mai "dentro" per silenzio.
function rowInScope(r, filter) {
  if (!filter.applied) return null;
  if (r.kind === 'approval') return filter.keepsValue(r.host);
  if (r.kind === 'audit') {
    const hosts = r.entry && Array.isArray(r.entry.hosts) ? r.entry.hosts : null;
    if (!hosts || !hosts.length) return null;
    return hosts.some((h) => filter.check(h));
  }
  return null;
}

// Stessa cosa per l'host in focus: `true`/`false` quando la riga è attribuibile, `null` quando
// non lo è (e in modalità focus resta visibile, perché non possiamo escluderla con certezza).
function rowOnFocus(r, matches) {
  if (!matches) return null;
  if (r.kind === 'approval') return !!matches(r.host);
  if (r.kind === 'audit') {
    const hosts = r.entry && Array.isArray(r.entry.hosts) ? r.entry.hosts : null;
    if (!hosts || !hosts.length) return null;
    return hosts.some(matches);
  }
  return null;
}

// ── attention rail: solo cose su cui l'operatore può/deve agire ─────────────
const TONE_RANK = { crit: 0, warn: 1, info: 2 };
function attentionOf(p) {
  const items = [];
  const add = (id, tone, label, detail, tab) => items.push({ id, tone, label, detail: detail || '', tab: tab || null });

  if (p.scope.fail_closed) add('scope-fail-closed', 'crit', 'Scope fail-closed', 'scope.json is empty — every action is blocked', 'scope');
  // Ciò che i filtri hanno escluso resta visibile come NUMERO: se la board è più stretta di
  // mission, l'operatore deve sapere perché — altrimenti sembra che il piano sia vuoto.
  const ex = (p.engagement && p.engagement.excluded) || {};
  if (ex.actions) add('actions-out-of-scope', 'warn', ex.actions + ' planned action(s) are out of scope', 'the planner targets hosts outside scope.json — marked blocked in Mission and hidden here', 'mission');
  if (ex.findings) add('findings-out-of-scope', 'info', ex.findings + ' finding(s) from other engagements hidden', 'recorded on hosts outside this scope — the full history is in Findings', 'findings');
  if (p.campaign_scope && p.campaign_scope.runs && p.campaign_scope.runs.refused_out_of_scope) {
    add('runs-out-of-scope', 'warn', p.campaign_scope.runs.refused_out_of_scope + ' run(s) refused against out-of-scope hosts', 'the guard blocked them during this campaign — they are not campaign activity', 'ledger');
  }
  const focus = p.engagement && p.engagement.focus;
  if (focus && !focus.in_scope) {
    add('focus-out-of-scope', 'crit', 'Focus host is out of scope', focus.host + ' is not authorized by scope.json — nothing will run against it', 'scope');
  }
  if (!p.campaign) add('no-campaign', 'warn', 'No active campaign', 'create one from a template and activate it', 'campaign');
  else {
    if (p.campaign_scope && !p.campaign_scope.attributable) {
      add('campaign-not-attributable', 'info', 'Campaign data not attributable', 'no RoE window and no activation entry — campaign numbers are unavailable', 'campaign');
    }
    if (p.campaign.drift.stale) add('scope-stale', 'warn', 'Scope drifted since anchoring', 'scope.json changed after the campaign anchored its hash — review or re-anchor', 'campaign');
    if (!p.campaign.validation.ok) add('campaign-invalid', 'warn', 'Campaign invalid', p.campaign.validation.errors.join('; '), 'campaign');
    if (p.campaign.validation.warnings.length) add('campaign-warnings', 'info', p.campaign.validation.warnings.length + ' RoE warning(s)', p.campaign.validation.warnings.slice(0, 2).join('; '), 'campaign');
    if (p.clock.expired) add('window-expired', 'crit', 'Engagement window closed', 'the RoE window ended — stop and re-authorize', 'campaign');
  }
  if (p.ledger.chain && !p.ledger.chain.ok) add('chain-broken', 'crit', 'Findings hash-chain broken', p.ledger.chain.detail || 'verify with gate.js', 'ledger');
  if (p.budget.halted) add('budget-halted', 'crit', 'Budget halt', p.budget.detail || (p.budget.operator_action || 'agent stopped until an operator resets'), 'mission');
  else for (const e of p.budget.exceeded || []) add('budget-' + e.cap, 'crit', 'Budget exceeded: ' + e.cap, 'observed ' + e.observed + ' / limit ' + e.limit, 'mission');
  if (p.approvals.pending) add('approvals-pending', 'warn', p.approvals.pending + ' pending approval(s)', 'operator decision required', 'approvals');
  for (const j of p.jobs.running) {
    if (j.age_minutes != null && j.age_minutes >= 30) add('job-long-' + j.id, 'warn', 'Job running ' + j.age_minutes + 'm: ' + j.name, 'still running — check it or panic', 'mission');
  }
  for (const j of p.jobs.failed) add('job-failed-' + j.id, 'warn', 'Job failed: ' + j.name, 'exit ' + j.exitCode, 'mission');
  for (const s of p.sessions.rows) {
    if (s.status === 'pending') add('session-pending-' + s.id, 'warn', 'Session pending teardown: ' + s.id, s.host || '', 'sessions');
  }
  if (p.coverage.remaining) add('coverage-gaps', 'info', p.coverage.remaining + ' coverage gap(s)', 'classes still untested on in-scope hosts', 'coverage');
  if (p.gates.missing.length) add('gates-missing', 'info', p.gates.missing.length + ' gate(s) not passed', p.gates.missing.slice(0, 3).join(', '), 'mission');
  return items.sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone] || a.id.localeCompare(b.id));
}

// ── snapshot ────────────────────────────────────────────────────────────────
function build(opts) {
  const o = opts || {};
  const mission = require('./cc-mission').build();
  const campaign = campaignPayload();
  const scope = scopePayload();
  const base = scopeFilter();                       // filtro di scope: gli host autorizzati
  const timeline = campaignTimeline(campaign);
  const attributable = !!campaign && timeline.basis !== 'none';
  const liveJobs = Array.isArray(o.jobs) ? o.jobs : [];
  // Filtro di vista: lo scope, ristretto all'host in focus quando ce n'è uno in scope.
  const focus = resolveFocus(campaign, base);
  const facet = focus.host && focus.in_scope ? focusFacet(focus.host, base) : base;
  const focused = facet !== base;
  const focusMatches = focus.host ? identityMatcher(hostIdentities(focus.host).identities) : null;

  // Finding: una lettura, quattro viste (vista, scope, finestra di campagna, intera per gli
  // esclusi). `facetFindings` è ciò che la board conta, `scopeFindings` è il resto dell'engagement.
  const allFindings = u.readJsonl(findingsFile());
  const scopeFindings = base.applied ? allFindings.filter(base.keepsFinding) : allFindings;
  const facetFindings = focused ? scopeFindings.filter(facet.keepsFinding) : scopeFindings;
  const campaignFindingsAll = attributable ? allFindings.filter((f) => inWindow(f.ts, timeline)) : [];
  const campaignFindings = attributable ? scopeFindings.filter((f) => inWindow(f.ts, timeline)) : [];
  const campaignFindingsFocus = attributable && focused ? facetFindings.filter((f) => inWindow(f.ts, timeline)) : null;
  const summary = summarizeFindings(facetFindings);
  summary.untimestamped = allFindings.filter((f) => !f.ts).length;
  summary.scope_total = scopeFindings.length;

  // Approvazioni e run: "in vista" in cima, poi "in scope": i due livelli non si confondono.
  let approvalsAll = [];
  try { approvalsAll = require('./cc-approvals').list({ all: true }); } catch { approvalsAll = []; }
  // L'inbox resta dell'engagement: un'approvazione in attesa su un altro host in scope è
  // operativa (e nasconderla sarebbe pericoloso), quindi il filtro host non la tocca.
  const approvalsKept = base.applied ? approvalsAll.filter((a) => base.keepsValue(a.host)) : approvalsAll;
  const runsAll = u.readJsonl(auditFile());
  const runsKept = base.applied
    ? runsAll.filter((r) => !Array.isArray(r.hosts) || !r.hosts.length || r.hosts.some((h) => base.check(h)))
    : runsAll;

  const sessions = sessionsPayload(facet, base);
  const exposure = exposurePayload(facet, base);

  // Stesso file dei finding che legge la mappa di esposizione (FINDINGS_JSONL/CC_ROOT): in produzione
  // coincide col default di gate.js, nei workspace alternativi (demo, test) resta coerente.
  const ledger = require('./cc-ledger').build({ tail: Math.max(120, safeInt(o.tail, 120)), findingsFile: findingsFile() });
  const feed = ((ledger.timeline && ledger.timeline.rows) || []).map((r) => Object.assign({}, r, {
    in_campaign: attributable ? inWindow(r.ts, timeline) : null,
    in_scope: rowInScope(r, base),
    on_focus: rowOnFocus(r, focusMatches),
  }));

  const gates = Array.isArray(mission.gates) ? mission.gates : [];
  const coverageAll = Array.isArray(mission.coverage) ? mission.coverage : [];
  const coverageKeptBase = base.applied ? coverageAll.filter((r) => base.keepsValue(r.host)) : coverageAll;
  const coverageKept = focused ? coverageKeptBase.filter((r) => facet.keepsValue(r.host)) : coverageKeptBase;
  const actionsAll = Array.isArray(mission.actions) ? mission.actions : [];
  // Le azioni senza host (budget reset, ...) restano: non sono di un host, sono dell'engagement.
  const actionsKeptBase = base.applied ? actionsAll.filter((a) => !a.host || base.check(a.host)) : actionsAll;
  const actionsKept = focused ? actionsKeptBase.filter((a) => !a.host || facet.check(a.host)) : actionsKeptBase;
  const coverageRemaining = coverageKept.reduce((n, r) => n + ((r.gaps || []).length), 0);

  const p = {
    generated_at: u.nowIso(),
    scope,
    campaign,
    clock: clockPayload(campaign && campaign.window),
    // Headline ricalcolato sui numeri filtrati: le tile non devono rileggere mission.
    headline: Object.assign({}, mission.headline || {}, {
      open_actions: actionsKept.filter((a) => !a.blocked && a.tier === 'auto').length,
      blocked: actionsKept.filter((a) => a.blocked).length,
      needs_approval: actionsKept.filter((a) => a.requires_approval).length,
      pending_approvals: approvalsKept.filter((a) => a.status === 'pending').length,
      coverage_remaining: coverageRemaining,
    }),
    gates: {
      passed: gates.filter((g) => g.passed).length,
      total: gates.length,
      missing: gates.filter((g) => !g.passed).map((g) => g.id),
    },
    budget: {
      enabled: !!mission.budget.enabled,
      halted: !!(mission.budget.halted),
      exceeded: mission.budget.exceeded || [],
      operator_action: mission.budget.operator_action || null,
      detail: mission.budget.detail || null,
      counters: mission.budget.counters || null,
      caps: mission.budget.caps || null,
      burn: burnPayload(mission.budget),
    },
    approvals: {
      pending: approvalsKept.filter((a) => a.status === 'pending').length,
      excluded: approvalsAll.length - approvalsKept.length,
      rows: approvalsKept.slice(0, 20).map((a) => ({
        id: a.id, host: a.host, action_class: a.action_class, status: a.status,
        reason: a.reason || null, requested_by: a.requested_by || null, created_at: a.created_at || null,
      })),
    },
    actions: {
      auto: actionsKept.filter((a) => a.tier === 'auto' && !a.blocked).length,
      confirm: actionsKept.filter((a) => a.tier === 'confirm').length,
      blocked: actionsKept.filter((a) => a.blocked).length,
      excluded: actionsAll.length - actionsKeptBase.length,
      hidden_scope: actionsKeptBase.length - actionsKept.length,
      top: actionsKept.slice(0, 8).map((a) => ({
        source: a.source, label: a.label, why: a.why, tier: a.tier, host: a.host || null,
        blocked: !!a.blocked, blocked_reason: a.blocked_reason || null,
        requires_approval: !!a.requires_approval,
      })),
    },
    coverage: {
      remaining: coverageRemaining,
      excluded: coverageAll.length - coverageKeptBase.length,
      hidden_scope: coverageKeptBase.length - coverageKept.length,
      hosts: coverageKept
        .map((r) => ({ host: r.host, coverage_pct: r.coverage_pct, gaps: r.gaps || [] }))
        .sort((a, b) => b.gaps.length - a.gaps.length || String(a.host).localeCompare(String(b.host)))
        .slice(0, 8),
    },
    sessions,
    jobs: jobsPayload(o.jobs),
    exposure,
    ledger: {
      chain: ledger.chain, counts: ledger.counts, feed,
      timeline_total: (ledger.timeline && ledger.timeline.total) || 0,
    },
    campaign_scope: campaignRecord(campaign, timeline, {
      findingsInWindow: campaignFindings,
      findingsInWindowAll: campaignFindingsAll,
      findingsFocusInWindow: campaignFindingsFocus,
      focusHost: focus.host,
      untimestamped: summary.untimestamped,
      approvals: approvalsKept,
      runs: runsKept,
      runsAll,
      jobs: liveJobs,
    }),
    host_focus: focusPayload(focus, facet, scopeFindings, {
      approvals: approvalsKept, sessions: sessions.rows, runs: runsKept, timeline,
    }),
    findings: Object.assign({
      recent_window_minutes: 60,
      recent: recentFindings(60, facet),
      excluded_out_of_scope: allFindings.length - scopeFindings.length,
      source_total: allFindings.length,
    }, summary),
    // Tutto ciò che i due filtri hanno escluso, per numero: niente sparisce in silenzio.
    engagement: {
      scope_applied: base.applied,
      fail_closed: base.empty,
      hosts: base.hosts.length,
      ips: base.ips.length,
      prefixes: base.prefixes.length,
      authorized: base.authorized,
      // `excluded` = altri engagement (fuori scope). `hidden` = in scope ma fuori dall'host in
      // focus: due livelli distinti, per numero, così nessuno dei due sembra una sparizione.
      excluded: {
        findings: allFindings.length - scopeFindings.length,
        findings_total: allFindings.length,
        hosts: exposure.excluded_hosts,
        hosts_total: (exposure.counts && exposure.counts.hosts) || null,
        actions: actionsAll.length - actionsKeptBase.length,
        approvals: approvalsAll.length - approvalsKept.length,
        sessions: sessions.excluded,
        runs: runsAll.length - runsKept.length,
      },
      hidden: focused ? {
        findings: scopeFindings.length - facetFindings.length,
        hosts: exposure.hidden_scope_hosts,
        actions: actionsKeptBase.length - actionsKept.length,
        sessions: sessions.hidden,
        coverage: coverageKeptBase.length - coverageKept.length,
      } : null,
      focus: focus.host ? { host: focus.host, source: focus.source, in_scope: focus.in_scope, applied: focused } : null,
      focus_suggestion: focus.suggestion || null,
    },
  };
  p.attention = attentionOf(p);
  return p;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function main(argv) {
  const cmd = argv[0] || 'show';
  if (cmd === 'show') {
    const ti = argv.indexOf('--tail');
    console.log(JSON.stringify(build({ tail: ti >= 0 ? safeInt(argv[ti + 1], 120) : 120 }), null, 2));
    return 0;
  }
  console.error('usage: node tools/cc-warroom.js show [--tail N]');
  return 2;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = {
  build, attentionOf, burnPayload, clockPayload, jobsPayload, sessionsPayload, scopePayload,
  scopeFilter, focusFacet, exposurePayload, recentFindings, campaignTimeline, campaignRecord, resolveFocus,
  focusPayload, summarizeFindings, rowInScope, normalizeHost, hostIdentities, identityMatcher, rowOnFocus,
};
