/* Cyboros Console — War Room (WP10): live situation board.
 * Loaded as a zero-build script before app.js; only declares functions, which resolve the
 * shared helpers (el/api/toast/switchTab/statTile/...) at call time.
 *
 * Design: Mission says what to do, Ledger what happened, the War Room what is happening NOW.
 * The snapshot endpoint is stateless; the DELTA is computed here, comparing each tick with
 * the previous one and flashing what changed (tiles) and what just arrived (ledger feed).
 * Polling is visibility-gated and stops the moment the tab is left (warStop). */

'use strict';

const WAR_POLL_MS = 5000;
const WAR_POLL_TV_MS = 2000;
const WAR_TONES = ['crit', 'warn', 'info'];

let warTimer = null;
let warLast = null;        // previous snapshot (baseline for delta highlighting)
let warSeenFeed = {};      // per feed scope: Set of keys already shown (absent until first paint)
let warLastFeed = null;    // last feed rows (frozen copy while paused)
let warFeedScope = 'campaign'; // feed scope: 'focus' | 'campaign' | 'workspace'
let warFeedFocus = undefined;  // focus host the current feed scope was chosen for (a new focus re-scopes)
let warPaused = false;
let warShowRuns = false;   // routine audit `run` rows are hidden by default: the feed is for decisions
let warTv = false;
let warInit = false;

// Called by app.js renderTab on every tab change that is not the War Room.
function warStop() { if (warTimer) { clearTimeout(warTimer); warTimer = null; } }

function warAt(obj, dotted) {
  return String(dotted).split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}
function warChanged(prev, d, path) {
  if (!prev) return false;
  return String(warAt(prev, path)) !== String(warAt(d, path));
}
function warDur(minutes) {
  if (minutes == null) return '—';
  if (minutes < 0) return 'expired';
  const m = Math.round(minutes);
  if (m < 90) return m + 'm';
  return Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm';
}
function warToneClass(tone) { return tone === 'crit' ? 'crit' : tone === 'warn' ? 'warn' : ''; }

function warTile(o) {
  const t = statTile({
    label: o.label, value: o.value, hint: o.hint, tone: o.tone,
    onClick: o.tab ? () => switchTab(o.tab) : undefined,
  });
  if (o.flash) t.classList.add('wr-flash');
  if (String(o.value).length > 10) t.classList.add('wr-long');
  return t;
}

function warKv(k, v, tone) {
  return el('div', { class: 'wr-kv' + (tone ? ' tone-' + tone : '') }, [
    el('span', { class: 'wr-kv-k' }, k),
    el('span', { class: 'wr-kv-v' }, v == null || v === '' ? '—' : String(v)),
  ]);
}

// Ogni pannello dichiara il proprio perimetro: con un host in focus è quello (e ciò che il
// focus ha lasciato fuori resta un numero), altrimenti è lo scope intero.
function warScopeLabel(d, hiddenCount, hiddenWord) {
  const f = d.host_focus;
  if (f) return 'on ' + f.host + (hiddenCount ? ' · ' + hiddenCount + ' ' + (hiddenWord || 'in scope hidden') : '');
  return 'in scope';
}

function warFeedKey(r) {
  return [r.ts || '', r.kind || '', r.action || r.gate || r.tool || r.artifact || r.id || '', r.detail || r.verdict || r.status || ''].join('|');
}
function warFeedTone(kind) {
  if (kind === 'approval') return 'warn';
  if (kind === 'gate') return 'info';
  return 'info';
}

// ── panels ──────────────────────────────────────────────────────────────────
function warAttentionPanel(d) {
  const items = d.attention || [];
  const body = items.length
    ? items.map((it) => {
      const row = el('div', {
        class: 'wr-attn-item tone-' + it.tone + (it.tab ? ' clickable' : ''),
        role: it.tab ? 'button' : null,
        tabindex: it.tab ? '0' : null,
        onClick: it.tab ? () => switchTab(it.tab) : undefined,
      }, [
        el('span', { class: 'chip ' + warToneClass(it.tone) }, it.tone.toUpperCase()),
        el('div', { class: 'wr-attn-body' }, [
          el('strong', null, it.label),
          it.detail ? el('div', { class: 'muted wr-attn-detail' }, it.detail) : null,
        ]),
      ]);
      if (it.tab) row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); switchTab(it.tab); }
      });
      return row;
    })
    : [el('div', { class: 'muted' }, 'all clear — nothing needs the operator right now')];
  return ccPanel('Attention', body, items.length ? items.length + ' item(s)' : 'quiet');
}

function warFeedPanel(d) {
  const attrib = !!(d.campaign_scope && d.campaign_scope.attributable);
  const focusHost = d.host_focus ? d.host_focus.host : null;
  // Modes available right now: host focus first (tightest), then campaign, then everything.
  const modes = [];
  if (focusHost) modes.push('focus');
  if (attrib) modes.push('campaign');
  modes.push('workspace');
  // A new focus (or clearing it) re-scopes the feed; an explicit choice is kept otherwise.
  if (warFeedFocus !== focusHost || !modes.includes(warFeedScope)) { warFeedScope = modes[0]; warFeedFocus = focusHost; }
  const scope = warFeedScope;
  const all = warPaused && warLastFeed ? warLastFeed : (d.ledger.feed || []);
  const inScope = scope === 'focus' ? all.filter((r) => r.on_focus !== false)
    : scope === 'campaign' ? all.filter((r) => r.in_campaign === true)
      : all;
  const hiddenRuns = inScope.filter((r) => r.kind === 'audit').length;
  const rows = warShowRuns ? inScope : inScope.filter((r) => r.kind !== 'audit');
  const seen = warSeenFeed[scope] || null;
  const firstPaint = !seen;
  // Newness is tracked against the same scope's previous tick, so toggling never flashes old rows.
  const decorated = rows.slice(0, 60).map((r) => ({ r, fresh: !firstPaint && !seen.has(warFeedKey(r)) }));
  if (!warPaused) warSeenFeed[scope] = new Set(inScope.map(warFeedKey));

  const feed = el('div', { class: 'wr-feed' }, decorated.length ? decorated.map(({ r, fresh }) => el('div', {
    class: 'wr-feed-row' + (fresh ? ' wr-new' : ''),
  }, [
    el('span', { class: 'wr-ts' }, shortTs(r.ts)),
    ccBadge(r.kind || '?', warFeedTone(r.kind)),
    el('span', { class: 'wr-what' }, [
      el('strong', null, String(r.action || r.gate || r.tool || r.artifact || r.id || '')),
      (r.detail || r.verdict || r.status) ? el('span', { class: 'muted' }, ' — ' + String(r.detail || r.verdict || r.status).slice(0, 160)) : null,
      r.in_scope === false ? ccBadge('other engagement', 'crit') : null,
    ]),
  ])) : [el('div', { class: 'muted' }, scope === 'campaign'
    ? 'nothing recorded in this campaign yet' + (hiddenRuns ? ' (' + hiddenRuns + ' routine run(s) hidden)' : '')
    : scope === 'focus'
      ? 'nothing touching ' + focusHost + ' yet'
      : (hiddenRuns ? hiddenRuns + ' routine run(s) hidden — show them to see raw activity' : 'no ledger entries yet'))]);

  const titles = {
    focus: 'rows touching ' + focusHost + ' (rows with no host stay: they are not attributable)',
    campaign: 'rows recorded since the campaign started',
    workspace: 'every ledger row, campaign or not',
  };
  const labels = { focus: focusHost || 'host', campaign: 'campaign', workspace: 'workspace' };
  const head = ccPanel('Live feed', [feed], scope === 'focus' ? 'in host focus' : scope === 'campaign' ? 'in campaign' : 'workspace').querySelector('.cc-panel-head');
  if (modes.length > 1) {
    for (const m of modes) head.appendChild(el('button', {
      class: 'btn btn-sm' + (scope === m ? ' active' : ''),
      title: titles[m],
      onClick: () => { warFeedScope = m; renderWarroom(); },
    }, labels[m]));
  }
  head.appendChild(el('button', { class: 'btn btn-sm', title: 'routine audit rows (tool runs)', onClick: () => { warShowRuns = !warShowRuns; renderWarroom(); } }, warShowRuns ? 'hide runs (' + hiddenRuns + ')' : 'show runs (' + hiddenRuns + ')'));
  head.appendChild(el('button', { class: 'btn btn-sm', onClick: () => { warPaused = !warPaused; renderWarroom(); } }, warPaused ? '▶ resume' : '❚❚ pause'));
  const panel = head.parentNode;
  if (warPaused) panel.classList.add('paused');
  return panel;
}

// ── campaign record: what this engagement has actually produced ─────────────
function warCampaignPanel(d) {
  const c = d.campaign, cs = d.campaign_scope || {};
  if (!c) return ccPanel('Campaign record', [el('div', { class: 'muted' }, 'no active campaign — create one in Campaign')]);
  if (!cs.attributable) {
    return ccPanel('Campaign record', [
      el('div', { class: 'cc-row' }, [ccBadge(c.status, c.status === 'active' ? 'ok' : 'warn'), el('strong', null, c.client || c.name || c.id)]),
      el('div', { class: 'muted' }, 'No RoE window and no activation entry for this campaign, so nothing can be attributed to it: the numbers on this board stay scope-wide (never campaign-wide).'),
      el('button', { class: 'btn', onClick: () => switchTab('campaign') }, 'Open in Campaign →'),
    ], 'not attributable');
  }
  const f = cs.findings || {};
  const declared = cs.declared_classes || [];
  const tested = new Set(f.classes || []);
  return ccPanel('Campaign record', [
    el('div', { class: 'cc-row' }, [
      ccBadge(cs.basis === 'window' ? 'RoE window' : 'since activation', 'info'),
      el('span', { class: 'muted' }, cs.from ? shortTs(cs.from) : ''),
      cs.age_minutes != null ? el('span', { class: 'muted' }, '· ' + warDur(cs.age_minutes) + ' ago') : null,
      cs.to ? el('span', { class: 'muted' }, '· until ' + shortTs(cs.to)) : null,
    ]),
    warKv('findings', (f.total || 0) + '  (' + (f.critical || 0) + 'C · ' + (f.high || 0) + 'H · ' + (f.verified || 0) + ' verified)', f.critical ? 'crit' : f.high ? 'high' : 'ok'),
    f.on_focus ? el('div', { class: 'muted' }, 'of which on ' + f.on_focus.host + ': ' + f.on_focus.total + '  (' + f.on_focus.critical + 'C · ' + f.on_focus.high + 'H · ' + f.on_focus.verified + ' verified)') : null,
    (f.excluded_out_of_scope || 0) > 0 ? el('div', { class: 'muted' }, f.excluded_out_of_scope + ' finding(s) in this window belong to other engagements (out of scope, not counted)') : null,
    f.untimestamped ? el('div', { class: 'muted' }, f.untimestamped + ' finding(s) have no ts and cannot be attributed') : null,
    warKv('runs', (cs.runs.started || 0) + ' started · ' + (cs.runs.blocked || 0) + ' refused · ' + (cs.runs.failures || 0) + ' failed' + (cs.runs.dry_run ? ' · ' + cs.runs.dry_run + ' dry-run' : ''), cs.runs.blocked || cs.runs.failures ? 'warn' : 'ok'),
    (cs.runs.excluded_out_of_scope || 0) > 0 ? el('div', { class: 'muted' }, cs.runs.excluded_out_of_scope + ' run(s) in this window were against out-of-scope hosts') : null,
    warKv('approvals', (cs.approvals.requested || 0) + ' requested · ' + (cs.approvals.granted || 0) + ' granted · ' + (cs.approvals.denied || 0) + ' denied', cs.approvals.denied ? 'warn' : 'ok'),
    warKv('gate passes', (cs.gates.passed || []).join(', ') || 'none yet', (cs.gates.passed || []).length ? 'ok' : 'warn'),
    warKv('jobs (live runner)', (cs.jobs.started || 0) + ' started · ' + (cs.jobs.failed || 0) + ' failed', cs.jobs.failed ? 'warn' : 'ok'),
    declared.length ? el('div', { class: 'wr-decl' }, [
      el('span', { class: 'wr-kv-k' }, 'classes with findings · ' + tested.size + '/' + declared.length),
      el('div', { class: 'cc-row' }, declared.map((cl) => el('span', {
        class: 'chip ' + (tested.has(cl) ? 'ok' : ''),
        title: tested.has(cl) ? 'at least one finding in this campaign' : 'no finding yet in this campaign — test it or record a skip',
      }, cl))),
    ]) : null,
    (f.top_hosts || []).length ? el('div', { class: 'wr-decl' }, [
      el('span', { class: 'wr-kv-k' }, 'top hosts in campaign'),
      ...f.top_hosts.map((h) => el('div', { class: 'wr-row-2' }, [
        el('span', { class: 'wr-host mono' }, h.host),
        ccBadge(h.findings + ' finding', h.critical ? 'crit' : h.high ? 'high' : 'info'),
        h.critical ? ccBadge(h.critical + 'C', 'crit') : null,
        h.high ? ccBadge(h.high + 'H', 'high') : null,
      ])),
    ]) : el('div', { class: 'muted' }, 'no findings recorded in this campaign yet'),
  ], (cs.basis === 'window' ? 'RoE window' : 'activation') + (f.on_focus ? ' · whole campaign, not host-scoped' : ''));
}

function warActionsPanel(d) {
  const cards = (d.actions.top || []).map((a) => {
    const card = el('div', {
      class: 'cc-card' + (a.blocked ? ' blocked' : '') + ' clickable',
      role: 'button', tabindex: '0',
      onClick: () => switchTab('mission'),
    }, [
      el('div', { class: 'cc-row' }, [
        el('strong', null, a.label),
        ccBadge(a.tier, a.tier === 'confirm' ? 'warn' : 'ok'),
        a.blocked ? ccBadge('blocked', 'crit') : null,
      ]),
      el('div', { class: 'muted' }, a.blocked ? (a.blocked_reason || 'out of scope') : (a.why || '')),
    ]);
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); switchTab('mission'); } });
    return card;
  });
  return ccPanel('Actions', [
    el('div', { class: 'cc-row' }, [
      ccBadge(d.actions.auto + ' auto', 'ok'),
      ccBadge(d.actions.confirm + ' confirm', 'warn'),
      ccBadge(d.actions.blocked + ' blocked', 'crit'),
      d.actions.hidden_scope ? el('span', { class: 'muted', title: 'planned for other in-scope hosts — hidden by the host focus' }, '· ' + d.actions.hidden_scope + ' hidden') : null,
    ]),
    ...(cards.length ? cards : [el('div', { class: 'muted' }, d.host_focus ? 'no planned action on this host' : 'plan is quiet')]),
    el('button', { class: 'btn', onClick: () => switchTab('mission') }, 'Open in Mission →'),
  ], d.host_focus ? warScopeLabel(d, d.actions.hidden_scope) : 'dispatch lives in Mission');
}

function warCoveragePanel(d) {
  const hosts = d.coverage.hosts || [];
  const exc = d.coverage.excluded || 0;
  return ccPanel('Coverage', hosts.length ? hosts.map((h) => el('div', { class: 'wr-row-2' }, [
    el('span', { class: 'wr-host mono' }, h.host),
    el('span', { class: 'muted' }, h.coverage_pct + '%'),
    el('span', { class: 'cc-row' }, (h.gaps || []).slice(0, 4).map((g) => ccBadge(g, 'info'))),
  ])) : [el('div', { class: 'muted' }, d.host_focus ? 'no coverage row for this host yet' : 'no coverage rows for the in-scope hosts — no run yet')],
  warScopeLabel(d, d.coverage.hidden_scope, 'in-scope host(s) hidden') + (exc ? ' · ' + exc + ' other engagement' : ''));
}

function warExposurePanel(d) {
  const top = d.exposure.top || [];
  const s = d.exposure.scoped || null;
  const exc = d.exposure.excluded_hosts || 0;
  return ccPanel('Exposure', [
    el('div', { class: 'cc-row' }, [
      ccBadge((s ? s.hosts : (d.exposure.counts && d.exposure.counts.hosts)) || 0, 'info'),
      el('span', { class: 'muted' }, 'hosts'),
      ccBadge((s ? s.open_ports : (d.exposure.counts && d.exposure.counts.open_ports)) || 0, 'info'),
      el('span', { class: 'muted' }, 'open ports'),
      (s && s.findings) ? ccBadge(s.findings + ' finding', 'info') : null,
      exc ? el('span', { class: 'muted', title: 'hosts mapped for other engagements — not part of this scope' }, '· ' + exc + ' other engagement') : null,
      d.exposure.hidden_scope_hosts ? el('span', { class: 'muted', title: 'in-scope hosts hidden by the host focus' }, '· ' + d.exposure.hidden_scope_hosts + ' off-focus') : null,
    ]),
    ...(top.length ? top.map((h) => el('div', { class: 'wr-row-2' }, [
      el('span', { class: 'wr-host mono', title: h.source || '' }, h.host),
      el('span', { class: 'cc-row' }, [
        ccBadge('risk ' + h.risk, h.critical ? 'crit' : h.high ? 'high' : 'info'),
        h.findings ? ccBadge(h.findings + ' finding', h.critical ? 'crit' : h.high ? 'high' : 'info') : null,
        h.open_ports ? ccBadge(h.open_ports + ' open', 'info') : null,
      ]),
    ])) : [el('div', { class: 'muted' }, 'no hosts in the exposure map')]),
    el('button', { class: 'btn', onClick: () => switchTab('graph') }, 'Open in Graph →'),
  ], warScopeLabel(d, d.exposure.hidden_scope_hosts, 'in-scope host(s) hidden') + (exc ? ' · ' + exc + ' other engagement' : ''));
}

function warSessionsPanel(d) {
  return ccPanel('Sessions', [dataTable({
    columns: [
      { key: 'id', label: 'id', cell: (r) => r.id },
      { key: 'host', label: 'host', cell: (r) => r.host || '' },
      { key: 'status', label: 'status', cell: (r) => ccBadge(r.status, r.status === 'active' ? 'ok' : r.status === 'pending' ? 'warn' : 'info') },
      { key: 'art', label: 'artifacts', cell: (r) => r.open_artifacts },
    ],
    rows: d.sessions.rows || [],
    empty: d.host_focus ? 'no session on this host' : 'no sessions registered',
  })], warScopeLabel(d, d.sessions.hidden, 'in-scope session(s) hidden'));
}

function warBudgetPanel(d) {
  const b = d.budget;
  const rows = [];
  if (!b.enabled) rows.push(el('div', { class: 'muted' }, b.detail || 'budgets disabled (no config)'));
  else {
    const burn = b.burn || {};
    if (burn.requests) rows.push(warKv('requests', burn.requests.used + ' / ' + burn.requests.cap + '  (' + burn.requests.pct + '%)', burn.requests.pct >= 80 ? 'crit' : burn.requests.pct >= 60 ? 'warn' : 'ok'));
    if (burn.wall) rows.push(warKv('wall', burn.wall.used + 'm / ' + burn.wall.cap + 'm  (' + burn.wall.pct + '%)', burn.wall.pct >= 80 ? 'crit' : burn.wall.pct >= 60 ? 'warn' : 'ok'));
    if (burn.tokens) rows.push(warKv('tokens', burn.tokens.used + ' / ' + burn.tokens.cap + '  (' + burn.tokens.pct + '%)', burn.tokens.pct >= 80 ? 'crit' : 'ok'));
    if (burn.eta_minutes != null) rows.push(warKv('eta (avg rate)', warDur(burn.eta_minutes), 'info'));
    if (burn.note) rows.push(el('div', { class: 'muted' }, burn.note));
    for (const e of b.exceeded || []) rows.push(el('div', { class: 'hint err' }, 'exceeded ' + e.cap + ': ' + e.observed + ' / ' + e.limit));
    if (b.operator_action) rows.push(el('div', { class: 'hint err' }, b.operator_action));
  }
  return ccPanel('Budget', rows.length ? rows : [el('div', { class: 'muted' }, 'no budget counters')], b.halted ? 'HALTED' : (b.enabled ? 'active' : 'off'));
}

// ── host focus: the ONE host the board is scoped to, with its derivatives ───
function warSetFocus(host) {
  api('/api/cc/warroom/focus', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ host: host || null }),
  }).then((d) => {
    const pane = byId('tab-warroom');
    warLast = null;            // a scope change invalidates the delta baseline
    warSeenFeed = {};
    warFeedFocus = undefined;  // the feed re-scopes to the new focus on the next render
    toast(host ? 'focus: ' + host : 'focus cleared', '');
    if (pane) warRender(pane, d); // the POST answers with the new snapshot: no second round trip
  }).catch((e) => toast(String(e.message || e), 'err'));
}

function warHostPanel(d) {
  const f = d.host_focus;
  const eng = d.engagement || {};
  const readOnly = !CC_TOKEN;
  if (f) {
    return ccPanel('Host focus', [
      el('div', { class: 'cc-row' }, [
        ccBadge(f.in_scope ? 'in scope' : 'OUT OF SCOPE', f.in_scope ? 'ok' : 'crit'),
        f.in_graph ? ccBadge('mapped in graph', 'info') : ccBadge('not in graph yet', 'warn'),
        f.identities.length > 1 ? el('span', { class: 'muted' }, f.identities.length + ' fused identities') : null,
      ]),
      el('div', { class: 'cc-row' }, f.identities.map((x) => el('span', { class: 'chip mono', title: 'identity of the focus host, fused from the exposure graph (IP, hostname, targets)' }, x))),
      warKv('findings (all time)', (f.findings.total || 0) + '  (' + (f.findings.critical || 0) + 'C · ' + (f.findings.high || 0) + 'H · ' + (f.findings.verified || 0) + ' verified)', f.findings.critical ? 'crit' : f.findings.high ? 'high' : 'ok'),
      f.findings.in_campaign ? el('div', { class: 'muted' }, 'of which in this campaign: ' + f.findings.in_campaign.total
        + '  (' + f.findings.in_campaign.critical + 'C · ' + f.findings.in_campaign.high + 'H · ' + f.findings.in_campaign.verified + ' verified)') : null,
      f.ports ? warKv('ports', f.ports.open + ' open · ' + f.ports.filtered + ' filtered · ' + f.ports.total + ' probed', f.ports.open ? 'info' : 'ok') : null,
      f.services.length
        ? warKv('services', f.services.slice(0, 6).map((s2) => s2.name + (s2.ports && s2.ports.length ? ':' + s2.ports.join(',') : '')).join(' · '))
        : el('div', { class: 'muted' }, 'no service mapped on this host yet'),
      f.endpoints.length ? warKv('endpoints', f.endpoints.length + ' observed') : null,
      warKv('activity', f.runs + ' run · ' + f.approvals + ' approval(s) · ' + f.sessions + ' session(s)'),
      f.findings.recent.length ? el('div', { class: 'wr-decl' }, [
        el('span', { class: 'wr-kv-k' }, 'findings on this host'),
        ...f.findings.recent.map((r) => el('div', { class: 'wr-row-2' }, [
          el('span', { class: 'wr-ts mono' }, shortTs(r.ts)),
          ccBadge(r.severity, String(r.severity).toLowerCase() === 'critical' ? 'crit' : String(r.severity).toLowerCase() === 'high' ? 'high' : 'info'),
          el('span', { class: 'wr-what' }, [
            el('strong', null, r.title),
            r.endpoint ? el('span', { class: 'muted' }, ' — ' + r.endpoint) : null,
            r.in_campaign ? ccBadge('in campaign', 'info') : null,
          ]),
        ])),
      ]) : el('div', { class: 'muted' }, 'no finding on this host yet'),
      el('div', { class: 'cc-row' }, [
        el('button', { class: 'btn btn-sm', onClick: () => switchTab('graph') }, 'Open in Graph →'),
        readOnly ? null : el('button', { class: 'btn btn-sm', title: 'back to every in-scope host', onClick: () => warSetFocus(null) }, 'clear focus'),
      ]),
    ], 'campaign.host');
  }
  const authHosts = (eng.authorized || []).filter((a) => a.kind === 'host').map((a) => a.value);
  const sug = eng.focus_suggestion;
  const rows = [
    el('div', { class: 'muted' }, 'No focus host: the board spans every in-scope host (' + authHosts.length + ' authorized). Focus one to see only that host and its derivatives.'),
  ];
  if (sug) rows.push(el('div', { class: 'cc-row' }, [
    el('span', { class: 'muted' }, 'last pipeline target'),
    el('span', { class: 'wr-host mono' }, sug.host),
    readOnly ? null : el('button', { class: 'btn btn-sm', onClick: () => warSetFocus(sug.host) }, 'focus'),
  ]));
  if (!readOnly) {
    const input = el('input', { class: 'wr-input', type: 'text', placeholder: 'host or URL', spellcheck: 'false', autocomplete: 'off' });
    const go = () => { const v = input.value.trim(); if (v) warSetFocus(v); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    rows.push(el('div', { class: 'cc-row' }, [input, el('button', { class: 'btn btn-sm', onClick: go }, 'focus')]));
  }
  if (authHosts.length) rows.push(el('div', { class: 'cc-row' }, authHosts.slice(0, 10).map((h) => (readOnly
    ? el('span', { class: 'chip mono' }, h)
    : el('button', { class: 'btn btn-sm', title: 'focus this in-scope host', onClick: () => warSetFocus(h) }, h)))));
  return ccPanel('Host focus', rows, 'off');
}

// ── header (campaign · clock · chain · live tick) ───────────────────────────
function warHeader(d) {
  const c = d.campaign;
  const cs = d.campaign_scope || {};
  return el('div', { class: 'wr-head' }, [
    c
      ? el('div', { class: 'cc-row' }, [
        ccBadge(c.status, c.status === 'active' ? 'ok' : 'warn'),
        el('strong', null, c.client || c.name || c.id),
        d.clock.remaining_minutes != null ? ccBadge(warDur(d.clock.remaining_minutes) + ' left', d.clock.expired ? 'crit' : 'info') : null,
        d.clock.elapsed_minutes != null ? el('span', { class: 'muted' }, 'elapsed ' + warDur(d.clock.elapsed_minutes)) : null,
        cs.attributable
          ? ccBadge('data: ' + (cs.basis === 'window' ? 'RoE window' : 'since activation' + (cs.age_minutes != null ? ' ' + warDur(cs.age_minutes) + ' ago' : '')), 'info')
          : ccBadge('data: not attributable', 'warn'),
        d.host_focus
          ? ccBadge('focus: ' + d.host_focus.host + (d.host_focus.in_scope ? '' : ' · OUT OF SCOPE'), d.host_focus.in_scope ? 'ok' : 'crit')
          : null,
      ])
      : el('span', { class: 'muted' }, 'no active campaign'),
    el('span', { class: 'cc-spacer' }),
    (d.engagement && d.engagement.excluded && d.engagement.excluded.findings)
      ? el('span', { class: 'muted', title: 'findings recorded by other engagements — not shown on this board' }, d.engagement.excluded.findings + ' finding(s) out of scope hidden')
      : null,
    (d.engagement && d.engagement.hidden && d.engagement.hidden.findings)
      ? el('span', { class: 'muted', title: 'in-scope findings that are not on the focus host' }, '· ' + d.engagement.hidden.findings + ' hidden by focus')
      : null,
    ccBadge('chain ' + (d.ledger.chain && d.ledger.chain.ok ? 'intact' : 'BROKEN'), d.ledger.chain && d.ledger.chain.ok ? 'ok' : 'crit'),
    ccBadge('scope ' + (d.scope.fail_closed ? 'FAIL-CLOSED' : d.scope.hosts + 'h · ' + d.scope.ips + 'ip'), d.scope.fail_closed ? 'crit' : 'ok'),
    el('span', { class: 'wr-live', title: 'last tick ' + new Date().toLocaleTimeString() }, [el('span', { class: 'wr-dot' }), warTv ? 'TV · 2s' : 'live · 5s']),
    el('button', { class: 'btn btn-sm', onClick: warToggleTv }, warTv ? '⤢ exit TV' : '⛶ TV mode'),
    el('button', { class: 'btn btn-sm', disabled: !(typeof CC_TOKEN !== 'undefined' && CC_TOKEN), title: 'stop harness-owned processes', onClick: warPanicDrawer }, '⏹ PANIC'),
  ]);
}

// ── panic (typed confirmation reaches the server too) ───────────────────────
function warPanicDrawer() {
  const input = el('input', { type: 'text', placeholder: 'type PANIC', spellcheck: 'false', autocomplete: 'off' });
  const go = el('button', { class: 'btn btn-danger', disabled: true }, 'Stop harness-owned processes');
  input.addEventListener('input', () => { go.disabled = input.value.trim().toUpperCase() !== 'PANIC'; });
  go.addEventListener('click', () => {
    api('/api/cc/warroom/panic', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: input.value.trim() }),
    }).then((r) => {
      toast('panic: stopped ' + (r.stopped || 0) + ' process(es)', '');
      closeDrawer();
      renderWarroom();
    }).catch((e) => toast(String(e.message || e), 'err'));
  });
  drawer({
    title: 'Panic — kill switch',
    body: el('div', { class: 'cc-panel-body' }, [
      el('div', { class: 'muted' }, 'Stops ONLY processes the harness owns: registered scan tasks and the PTY bridges of THIS workspace. Never arbitrary pids. The action is written to the audit ledger.'),
      input,
      go,
    ]),
  });
}

// ── TV mode (fullscreen + scaled board; read-only friendly) ─────────────────
function warToggleTv() {
  warTv = !warTv;
  document.body.classList.toggle('tv', warTv);
  try {
    if (warTv && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
    if (!warTv && document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
  } catch { /* fullscreen is optional */ }
  if (activeTab === 'warroom') renderWarroom();
}
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && warTv) {
    warTv = false;
    document.body.classList.remove('tv');
    if (activeTab === 'warroom') renderWarroom();
  }
});

// ── board ───────────────────────────────────────────────────────────────────
function warRender(pane, d) {
  const prev = warLast;
  const c = d.campaign;
  // When the active campaign is attributable, the KPI tiles lead with ITS numbers and keep the
  // workspace figure in the hint — the board is about the running engagement, not the laptop.
  const cs = d.campaign_scope || {};
  const scoped = !!cs.attributable;
  const cFind = cs.findings || {};
  const gateTotal = scoped ? ((cs.declared_gates || []).length || d.gates.total) : d.gates.total;
  const exc = (d.engagement && d.engagement.excluded) || {};
  const outScope = exc.findings || 0;
  const focused = !!(d.host_focus && d.engagement && d.engagement.hidden);

  const tiles = el('div', { class: 'cc-stats' }, [
    warTile({
      label: 'campaign', value: c ? (c.client || c.name || c.id) : 'none',
      hint: c ? (c.status + (d.clock.remaining_minutes != null ? ' · ' + warDur(d.clock.remaining_minutes) + ' left' : '')) : 'create + activate one',
      tone: !c ? 'med' : (d.clock.expired ? 'crit' : 'ok'), tab: 'campaign', flash: warChanged(prev, d, 'campaign.id'),
    }),
    warTile({
      label: 'window', value: d.clock.remaining_minutes != null ? warDur(d.clock.remaining_minutes) : (d.clock.elapsed_minutes != null ? warDur(d.clock.elapsed_minutes) : '—'),
      hint: d.clock.remaining_minutes != null ? 'remaining' : (d.clock.elapsed_minutes != null ? 'elapsed (no end set)' : 'no window in campaign'),
      tone: d.clock.expired ? 'crit' : 'info', tab: 'campaign', flash: warChanged(prev, d, 'clock.remaining_minutes'),
    }),
    warTile({
      label: 'open actions', value: (d.headline && d.headline.open_actions) || 0,
      hint: d.actions.blocked + ' blocked' + (d.actions.hidden_scope ? ' · ' + d.actions.hidden_scope + ' off-focus' : ''),
      tone: 'ok', tab: 'mission', flash: warChanged(prev, d, 'headline.open_actions'),
    }),
    warTile({
      label: 'needs approval', value: d.approvals.pending, hint: 'scope inbox · ' + (d.approvals.rows.length ? 'has rows' : 'empty'),
      tone: d.approvals.pending ? 'med' : 'ok', tab: 'approvals', flash: warChanged(prev, d, 'approvals.pending'),
    }),
    warTile({
      label: 'running jobs', value: d.jobs.running.length,
      hint: d.jobs.running.length ? d.jobs.running.map((j) => j.name).join(', ') : (d.jobs.failed.length ? d.jobs.failed.length + ' recent failure(s)' : 'idle'),
      tone: d.jobs.running.length ? 'live' : (d.jobs.failed.length ? 'med' : ''), tab: 'mission', flash: warChanged(prev, d, 'jobs.running.length'),
    }),
    warTile({
      label: 'budget', value: d.budget.halted ? 'HALT' : (d.budget.burn.available && d.budget.burn.requests ? d.budget.burn.requests.pct + '%' : (d.budget.burn.available && d.budget.burn.wall ? d.budget.burn.wall.pct + '%' : 'off')),
      hint: d.budget.burn.eta_minutes != null ? 'eta ' + warDur(d.budget.burn.eta_minutes) + ' (avg rate)' : (d.budget.enabled ? 'no request cap' : 'disabled'),
      tone: d.budget.halted ? 'crit' : (d.budget.burn.requests && d.budget.burn.requests.pct >= 80 ? 'crit' : d.budget.burn.requests && d.budget.burn.requests.pct >= 60 ? 'med' : 'ok'),
      tab: 'mission', flash: warChanged(prev, d, 'budget.halted') || warChanged(prev, d, 'budget.burn.requests.pct'),
    }),
    warTile({
      label: 'coverage gaps', value: (d.headline && d.headline.coverage_remaining) || 0,
      hint: d.host_focus
        ? 'on ' + d.host_focus.host + ' · ' + (d.coverage.hidden_scope || 0) + ' in-scope host(s) hidden'
        : (exc.hosts ? exc.hosts + ' host(s) hidden · ' : '') + 'classes untested in scope',
      tone: (d.headline && d.headline.coverage_remaining) ? 'med' : 'ok', tab: 'coverage', flash: warChanged(prev, d, 'headline.coverage_remaining'),
    }),
    warTile(scoped ? {
      label: 'findings · campaign', value: cFind.total || 0,
      hint: (cFind.critical || 0) + 'C · ' + (cFind.high || 0) + 'H in campaign · ' + (focused && cFind.on_focus
        ? cFind.on_focus.total + ' on ' + d.host_focus.host
        : outScope + ' out of scope'),
      tone: (cFind.critical || 0) > 0 ? 'crit' : (cFind.high || 0) > 0 ? 'high' : 'ok',
      tab: 'findings', flash: warChanged(prev, d, 'campaign_scope.findings.total'),
    } : {
      label: 'findings', value: d.findings.total == null ? '—' : d.findings.total,
      hint: (d.findings.critical || 0) + 'C · ' + (d.findings.high || 0) + 'H · ' + (d.host_focus ? 'on ' + d.host_focus.host : 'in scope') + (outScope ? ' · ' + outScope + ' hidden' : ''),
      tone: (d.findings.critical || 0) > 0 ? 'crit' : (d.findings.high || 0) > 0 ? 'high' : 'ok',
      tab: 'findings', flash: warChanged(prev, d, 'findings.total'),
    }),
    warTile({
      label: 'gates',
      value: (scoped ? (cs.gates.passed_count || 0) : d.gates.passed) + '/' + gateTotal,
      hint: scoped
        ? 'campaign · workspace ' + d.gates.passed + '/' + d.gates.total
        : (d.gates.missing.length ? d.gates.missing.slice(0, 3).join(', ') : 'all passed'),
      tone: scoped ? ((cs.gates.passed_count || 0) ? 'ok' : 'med') : (d.gates.missing.length ? 'med' : 'ok'),
      tab: 'mission', flash: warChanged(prev, d, scoped ? 'campaign_scope.gates.passed_count' : 'gates.passed'),
    }),
    warTile({
      label: 'sessions', value: d.sessions.active,
      hint: d.sessions.pending ? d.sessions.pending + ' pending teardown' : (d.sessions.active + ' active · ' + d.sessions.total + (d.host_focus ? ' on host' : ' registered')),
      tone: d.sessions.pending ? 'med' : (d.sessions.active ? 'live' : ''), tab: 'sessions', flash: warChanged(prev, d, 'sessions.active'),
    }),
  ]);

  const board = el('div', { class: 'cc-grid wr-board' }, [
    warHeader(d),
    tiles,
    el('div', { class: 'wr-main' }, [
      warAttentionPanel(d),
      warHostPanel(d),
      warCampaignPanel(d),
      warFeedPanel(d),
      warActionsPanel(d),
      warBudgetPanel(d),
      warCoveragePanel(d),
      warExposurePanel(d),
      d.findings.recent.length ? ccPanel('Fresh findings · 60m' + (d.host_focus ? ' · on ' + d.host_focus.host : ' · in scope'), d.findings.recent.map((f) => el('div', { class: 'wr-row-2' }, [
        el('span', { class: 'wr-ts mono' }, shortTs(f.ts)),
        ccBadge(f.severity, String(f.severity).toLowerCase() === 'critical' ? 'crit' : String(f.severity).toLowerCase() === 'high' ? 'high' : 'info'),
        el('span', { class: 'wr-what' }, [el('strong', null, f.title), el('span', { class: 'muted' }, ' — ' + (f.host || '?') + (f.status ? ' · ' + f.status : ''))]),
      ])), d.host_focus ? 'on host' : 'in scope') : null,
      warSessionsPanel(d),
    ]),
  ]);
  const feedEl = pane.querySelector('.wr-feed');
  const scrollTop = feedEl ? feedEl.scrollTop : 0;
  pane.replaceChildren(board);
  const nextFeed = pane.querySelector('.wr-feed');
  if (nextFeed && scrollTop) nextFeed.scrollTop = scrollTop;
  warLast = d;
}

// ── polling loop ────────────────────────────────────────────────────────────
function warPoll() {
  if (activeTab !== 'warroom') return;
  api('/api/cc/warroom').then((d) => {
    const pane = byId('tab-warroom');
    if (!pane) return;
    warLastFeed = d.ledger.feed || [];
    warRender(pane, d);
    warSchedule();
  }).catch((e) => {
    const pane = byId('tab-warroom');
    if (warLast) toast('war room refresh failed: ' + String(e.message || e), 'err');
    else if (pane) pane.replaceChildren(el('div', { class: 'hint err' }, String(e.message || e)));
    warSchedule();
  });
}

function warSchedule() {
  if (warTimer) clearTimeout(warTimer);
  warTimer = setTimeout(() => {
    if (activeTab !== 'warroom') { warTimer = null; return; }
    if (document.hidden) return warSchedule(); // re-check on the next tick, don't poll hidden tabs
    warPoll();
  }, warTv ? WAR_POLL_TV_MS : WAR_POLL_MS);
}

function renderWarroom() {
  if (!warInit) {
    warInit = true;
    if (/[?&]tv=1\b/.test(location.search)) { warTv = true; document.body.classList.add('tv'); }
  }
  const pane = byId('tab-warroom');
  if (!pane) return;
  warStop();
  if (!warLast) showSkeleton('warroom');
  warPoll();
}
