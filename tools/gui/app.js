/* Cyboros Console — frontend (vanilla, no deps) */
'use strict';

const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const byId = (id) => document.getElementById(id);

// ── session token ───────────────────────────────────────────────────────────
// Writes (POST/DELETE) and the interactive streams require it. It arrives once as
// ?token=<hex> (printed by the server, injected by the desktop shell), is kept in
// sessionStorage and stripped from the URL so it never lands in history/bookmarks.
const CC_TOKEN = (() => {
  try {
    const u = new URL(location.href);
    const t = u.searchParams.get('token');
    if (t) {
      sessionStorage.setItem('cc_token', t);
      u.searchParams.delete('token');
      const qs = u.searchParams.toString();
      history.replaceState(null, '', u.pathname + (qs ? '?' + qs : '') + u.hash);
      return t;
    }
    return sessionStorage.getItem('cc_token') || '';
  } catch { return ''; }
})();
// append the token to a URL that cannot carry headers (EventSource: SSE)
const withToken = (p) => (CC_TOKEN ? p + (p.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(CC_TOKEN) : p);

// Shown once if a write comes back 403 tokenRequired: the page was opened without
// a token (e.g. a bare http://127.0.0.1:8787 bookmark), so it is read-only.
function readOnlyBanner() {
  if (byId('cc-readonly')) return;
  const bar = document.createElement('div');
  bar.id = 'cc-readonly';
  bar.className = 'readonly-banner';
  bar.setAttribute('role', 'status');
  bar.textContent = 'READ-ONLY — this page has no session token: write actions (scope, pipeline, terminal) are disabled. Open the tokenized URL printed by the server, or relaunch with ./start-command-center.sh';
  const rail = byId('status-rail');
  if (rail && rail.parentNode) rail.parentNode.insertBefore(bar, rail.nextSibling);
  else document.body.insertBefore(bar, document.body.firstChild);
}

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const fmtBytes = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n > 1024 ? Math.round(n / 1024) + ' KB' : n + ' B');
const fmtTs = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
const shortTs = (iso) => (iso ? new Date(iso).toLocaleDateString() + ' ' + new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—');
// compact duration between two ISO timestamps (for pipeline phase nodes)
const fmtDur = (a, b) => {
  if (!a || !b) return '';
  const ms = new Date(b) - new Date(a);
  if (!(ms >= 0)) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm' + (s % 60 ? ' ' + (s % 60) + 's' : '');
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
};

const SEV_CHIP = { Critical: 'crit', High: 'high', Medium: 'med', Low: 'low', Info: 'info' };
const SEV_ROW = { Critical: 's-crit', High: 's-high', Medium: 's-med', Low: 's-low', Info: 's-info' };
const SEV_BAR = { Critical: 's-crit', High: 's-high', Medium: 's-med', Low: 's-low', Info: 's-info' };

// CVSS → colour grade (weights the number by risk band)
const cvssGrade = (v) => (v == null ? 'none' : v >= 9 ? 'crit' : v >= 7 ? 'high' : v >= 4 ? 'med' : 'low');

// engagement status → proof level, encoded as shape in the UI:
//   proven  = solid dot  (verified / exploited / proven impact)
//   confirmed = ring
//   weak    = dashed ring (suspected / triggered / inconclusive / reported)
const PROOF_STRONG = new Set(['verified', 'exploited', 'proven', 'proven_impact']);
const proofLevel = (s) => {
  const k = String(s || '').toLowerCase();
  if (PROOF_STRONG.has(k)) return 'proven';
  if (k === 'confirmed') return 'confirmed';
  return 'weak';
};

// break long endpoints at path separators (never mid-token). Escapes first,
// then inserts <wbr> after the (already-escaped) separators.
const epBreak = (s) => esc(s).replace(/(\/|\?|=|&amp;|_|-)/g, '$1<wbr>');

async function api(path, opts) {
  const o = Object.assign({}, opts);
  if (CC_TOKEN) o.headers = Object.assign({}, (opts && opts.headers) || {}, { 'X-Stavros-Token': CC_TOKEN });
  const res = await fetch(path, o);
  let body = null;
  try { body = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    if (res.status === 403 && body && body.tokenRequired) readOnlyBanner();
    throw new Error((body && body.error) || ('HTTP ' + res.status));
  }
  return body;
}

// ── vanilla component primitives (redesign foundation) ──────────────────────
// Small composable helpers so each render<Tab>() builds nodes instead of
// concatenating ad-hoc HTML strings. No framework, no deps.

// el(tag, props, children) — mini hyperscript.
//   props: { class, style:{}, dataset:{}, html:'<..>', onClick:fn, <attr>:val }
//   children: string | Node | (string|Node|null|false)[]  (null/false skipped)
function el(tag, props, children) {
  const node = document.createElement(tag);
  if (props) for (const k in props) {
    const v = props[k];
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.slice(0, 2) === 'on' && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  appendKids(node, children);
  return node;
}
function appendKids(node, children) {
  if (children == null) return;
  (Array.isArray(children) ? children : [children]).forEach((c) => {
    if (c == null || c === false) return;
    node.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  });
}
// cellContent: Node → as-is; {html} → innerHTML span; else text node.
function cellContent(val) {
  if (val instanceof Node) return val;
  if (val && typeof val === 'object' && 'html' in val) return el('span', { html: val.html });
  return document.createTextNode(val == null ? '' : String(val));
}

function chip(text, cls) { return el('span', { class: 'chip' + (cls ? ' ' + cls : '') }, text); }
function severityChip(sev) { return chip(sev || '—', SEV_CHIP[sev] || ''); }

// statTile({ label, value, tone, hint, onClick }) — clickable KPI card.
//   tone: 'crit'|'high'|'med'|'low'|'ok'|'live' (drives the accent rail)
function statTile(o) {
  const props = { class: 'stat-tile' + (o.tone ? ' tone-' + o.tone : '') + (o.onClick ? ' clickable' : '') };
  if (o.onClick) { props.role = 'button'; props.tabindex = '0'; props.onClick = o.onClick; }
  const tile = el('div', props, [
    el('div', { class: 'stat-value' }, String(o.value)),
    el('div', { class: 'stat-label' }, o.label),
    o.hint != null ? el('div', { class: 'stat-hint' }, o.hint) : null,
  ]);
  if (o.onClick) tile.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); o.onClick(e); }
  });
  return tile;
}

// dataTable({ columns, rows, onRow, rowClass, empty, sticky, sortState, onSort })
//   columns: [{ key, label, cell(row,i), num, thClass, tdClass, sort }]
//     cell may return a Node, an {html} object, or a primitive (rendered as text)
//     sort: a key string → makes the header clickable; onSort(key) is called and
//           sortState {key,dir} drives the ▲/▼ indicator.
//   onRow(row, tr, i) — click handler + .clickable on each row
//   rowClass(row, i) — extra class string per <tr>
// Returns a .table-wrap div (owns horizontal overflow) around the <table>.
function dataTable(spec) {
  const cols = spec.columns || [];
  const ss = spec.sortState || {};
  const thead = el('thead', null, el('tr', null, cols.map((c) => {
    const sortable = c.sort && spec.onSort;
    const arrow = sortable && ss.key === c.sort ? (ss.dir === 'asc' ? ' ▲' : ' ▼') : '';
    const th = el('th', { class: [c.num ? 'num' : '', sortable ? 'sortable' : '', c.thClass || ''].filter(Boolean).join(' ') || null }, c.label + arrow);
    if (sortable) {
      th.setAttribute('role', 'button'); th.tabIndex = 0;
      th.setAttribute('aria-sort', ss.key === c.sort ? (ss.dir === 'asc' ? 'ascending' : 'descending') : 'none');
      const go = () => spec.onSort(c.sort);
      th.addEventListener('click', go);
      th.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    }
    return th;
  })));
  const body = el('tbody');
  const rows = spec.rows || [];
  if (!rows.length) {
    body.appendChild(el('tr', null, el('td', { colspan: cols.length || 1, class: 'muted' }, spec.empty || '—')));
  } else rows.forEach((row, i) => {
    const cls = ['clickable', spec.rowClass ? spec.rowClass(row, i) : ''];
    const tr = el('tr', { class: (spec.onRow ? cls : cls.slice(1)).filter(Boolean).join(' ') || null }, cols.map((c) =>
      el('td', { class: [c.num ? 'num' : '', c.tdClass || ''].filter(Boolean).join(' ') || null },
        cellContent(c.cell ? c.cell(row, i) : row[c.key]))));
    if (spec.onRow) {
      tr.setAttribute('role', 'button'); tr.tabIndex = 0;
      tr.addEventListener('click', () => spec.onRow(row, tr, i));
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); spec.onRow(row, tr, i); } });
    }
    body.appendChild(tr);
  });
  return el('div', { class: 'table-wrap' + (spec.sticky ? ' sticky' : '') }, el('table', null, [thead, body]));
}

// sparkline(points, { width, height, color, title }) — inline SVG trend line.
function sparkline(points, opts) {
  const o = opts || {};
  const w = o.width || 130, h = o.height || 28, pad = 3;
  const vals = (points || []).map(Number).filter((v) => !Number.isNaN(v));
  if (vals.length < 2) return el('span', { class: 'sparkline faint' }, '—');
  const max = Math.max(...vals), min = Math.min(...vals), span = (max - min) || 1;
  const step = (w - pad * 2) / (vals.length - 1);
  const pts = vals.map((v, i) => (pad + i * step).toFixed(1) + ',' + (h - pad - ((v - min) / span) * (h - pad * 2)).toFixed(1));
  const [lx, ly] = pts[pts.length - 1].split(',');
  const stroke = o.color || 'var(--cyan)';
  const wAttr = o.fluid ? '100%' : w;
  return el('span', { class: 'sparkline' + (o.fluid ? ' fluid' : ''), title: o.title || '', html:
    '<svg viewBox="0 0 ' + w + ' ' + h + '" width="' + wAttr + '" height="' + h + '" preserveAspectRatio="none" aria-hidden="true">' +
      '<polyline fill="none" stroke="' + stroke + '" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" points="' + pts.join(' ') + '"/>' +
      '<circle cx="' + lx + '" cy="' + ly + '" r="2" fill="' + stroke + '"/></svg>' });
}

// drawer({ title, body, onClose }) — singleton right-side detail panel.
let _drawerWrap = null, _drawerOnClose = null;
function drawer(opts) {
  closeDrawer();
  const panel = el('aside', { class: 'drawer-panel', role: 'dialog', 'aria-modal': 'false', 'aria-label': opts.title || 'Details' }, [
    el('div', { class: 'drawer-head' }, [
      el('strong', null, opts.title || ''),
      el('button', { class: 'btn btn-sm', 'aria-label': 'Close (Esc)', onClick: closeDrawer }, '✕'),
    ]),
    el('div', { class: 'drawer-body' }, opts.body || null),
  ]);
  _drawerWrap = el('div', { class: 'drawer-wrap' }, [el('div', { class: 'drawer-scrim', onClick: closeDrawer }), panel]);
  _drawerOnClose = opts.onClose || null;
  document.body.appendChild(_drawerWrap);
  requestAnimationFrame(() => _drawerWrap.classList.add('open'));
  setTimeout(() => { const b = panel.querySelector('.drawer-head button'); if (b) b.focus(); }, 30);
  return _drawerWrap;
}
function drawerOpen() { return !!_drawerWrap; }
function closeDrawer() {
  if (!_drawerWrap) return;
  const w = _drawerWrap; _drawerWrap = null;
  const cb = _drawerOnClose; _drawerOnClose = null;
  w.classList.remove('open');
  if (cb) { try { cb(); } catch { /* ignore */ } }
  setTimeout(() => w.remove(), 180);
}

// ── toast ───────────────────────────────────────────────────────────────────
function toast(msg, type) {
  const el = document.createElement('div');
  el.className = 'toast ' + (type || '');
  el.textContent = msg;
  byId('toast-wrap').appendChild(el);
  setTimeout(() => el.remove(), type === 'err' ? 6000 : 3500);
}

// ── tab routing ─────────────────────────────────────────────────────────────
let activeTab = 'overview';
function switchTab(tab) {
  activeTab = tab;
  $$('#tabs .tab').forEach((b) => {
    const on = b.dataset.tab === tab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    b.tabIndex = on ? 0 : -1; // roving tabindex: only the active tab is in the Tab order
  });
  $$('.tabpane').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + tab));
  renderTab(tab);
}

// ── status rail (was: header badges) ─────────────────────────────────────────
// Fetches /api/overview and repaints the persistent status rail. Named
// refreshBadges for continuity — it is the single overview poll used by the
// 15s timer and manual refresh, and still triggers renderOverview.
async function refreshBadges() {
  try {
    const o = await api('/api/overview');
    renderStatusRail(o);
    byId('server-sub').textContent = o.opstate
      ? o.opstate.mode + ' · updated ' + shortTs(o.opstate.updated_at)
      : 'no operation-state.json';
    if (activeTab === 'overview') renderOverview(o);
    return o;
  } catch (e) {
    renderStatusRail(null);
    byId('server-sub').textContent = 'server unreachable — start: node tools/gui-server.js';
  }
}

// railItem({ k, v, tone, title, tab }) — one rail cell; `tab` makes it drill in.
function railItem(o) {
  const props = { class: 'rail-item' + (o.tone ? ' st-' + o.tone : '') + (o.tab ? ' clickable' : '') };
  if (o.title) props.title = o.title;
  if (o.tab) { props.role = 'button'; props.tabindex = '0'; props.onClick = () => switchTab(o.tab); }
  const node = el('div', props, [
    el('span', { class: 'rail-pip' }),
    el('span', { class: 'rail-k' }, o.k),
    el('span', { class: 'rail-v' }, o.v),
  ]);
  if (o.tab) node.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); switchTab(o.tab); }
  });
  return node;
}

function renderStatusRail(o) {
  const rail = byId('status-rail');
  if (!rail) return;
  if (!o) { rail.replaceChildren(railItem({ k: 'server', v: 'offline?', tone: 'bad' })); return; }
  const sc = o.scope, p = o.pipeline, bs = o.findings.bySeverity || {};
  const items = [
    railItem({ k: 'scope', tone: sc.failClosed ? 'bad' : 'ok', title: 'scope.json', tab: 'scope',
      v: sc.failClosed ? 'FAIL-CLOSED' : sc.hosts + ' host · ' + sc.ips + ' ip' }),
    railItem({ k: 'rps', v: String(sc.rps), title: 'max_requests_per_second', tab: 'scope' }),
  ];
  if (!p.db || !p.hasRun) items.push(railItem({ k: 'run', v: 'no run yet', tab: 'pipeline' }));
  else if (p.unclosed) items.push(railItem({ k: 'run', v: 'done (unclosed)', tone: 'warn', tab: 'pipeline',
    title: 'target: ' + (p.runTarget || '') + ' — phases finished, run never closed' }));
  else {
    const s = p.lastRunStatus;
    items.push(railItem({ k: 'run', v: s, tab: 'pipeline', title: 'target: ' + (p.runTarget || ''),
      tone: s === 'running' ? 'live' : s === 'done' ? 'ok' : 'bad' }));
  }
  items.push(railItem({ k: 'sessions', v: String(o.sessions.active), tone: o.sessions.active > 0 ? 'live' : '',
    title: 'active C2 sessions', tab: 'sessions' }));
  items.push(railItem({ k: 'findings', tab: 'findings', title: 'total · critical · high',
    v: (o.findings.total || 0) + ' · ' + (bs.Critical || 0) + 'C ' + (bs.High || 0) + 'H',
    tone: (bs.Critical || 0) > 0 ? 'bad' : (bs.High || 0) > 0 ? 'warn' : 'ok' }));
  items.push(railItem({ k: 'loot', v: String(o.lootCount || 0), title: 'loot rows (contents never shown)' }));
  items.push(el('div', { class: 'rail-spacer' }));
  items.push(el('div', { class: 'rail-item rail-hint', html: 'press <kbd>⌘K</kbd> for commands' }));
  rail.replaceChildren(...items);
}

// ── Overview ────────────────────────────────────────────────────────────────
// severity stat-tile → jumps to Findings pre-filtered by that severity
function overviewSevTile(sev, n) {
  return statTile({
    label: sev, value: n, tone: { Critical: 'crit', High: 'high', Medium: 'med', Low: 'low' }[sev],
    onClick: () => {
      Object.assign(findingsState, { host: '', severity: sev, status: '', q: '', detailOpen: null, page: 1 });
      switchTab('findings');
    },
  });
}

function renderOverview(o) {
  const pane = byId('tab-overview');
  const f = o.findings;
  const bySev = f.bySeverity || {};

  // ── stat-tile row (reNgine-style KPIs, each clickable) ──
  const tiles = ['Critical', 'High', 'Medium', 'Low'].map((s) => overviewSevTile(s, bySev[s] || 0));
  tiles.push(statTile({ label: 'Active sessions', value: o.sessions.active, tone: o.sessions.active > 0 ? 'live' : null, onClick: () => switchTab('sessions') }));
  tiles.push(statTile({ label: 'Loot rows', value: o.lootCount || 0, hint: 'contents never shown', onClick: () => switchTab('sessions') }));
  tiles.push(statTile({ label: 'Req/s cap', value: o.scope.rps, tone: o.scope.failClosed ? 'crit' : null, hint: o.scope.hosts + ' host · ' + o.scope.ips + ' ip', onClick: () => switchTab('scope') }));
  const statRow = el('div', { class: 'stat-row' }, tiles);

  // ── findings triage (severity meter + proof split + weakness classes) ──
  const sevTotal = ['Critical', 'High', 'Medium', 'Low', 'Info'].reduce((a, s) => a + (bySev[s] || 0), 0);
  const sevbarHtml = ['Critical', 'High', 'Medium', 'Low', 'Info'].map((s) => {
    const n = bySev[s] || 0;
    return n ? '<div class="' + (SEV_BAR[s] || 's-info') + '" style="width:' + (sevTotal ? (n / sevTotal) * 100 : 0) + '%" title="' + esc(s + ': ' + n) + '"></div>' : '';
  }).join('');
  const proof = { proven: 0, confirmed: 0, weak: 0 };
  Object.keys(f.byStatus || {}).forEach((st) => { proof[proofLevel(st)] += f.byStatus[st]; });
  const triageCard = el('div', { class: 'card' + ((bySev.Critical || 0) > 0 ? ' keel-crit' : '') }, [
    el('h2', null, 'Findings triage'),
    el('div', { class: 'sevbar', html: sevbarHtml }),
    el('div', { class: 'row', style: { gap: '6px' } }, ['Critical', 'High', 'Medium', 'Low', 'Info'].map((s) => chip(s + ' ' + (bySev[s] || 0), SEV_CHIP[s] || ''))),
    el('div', { class: 'row', style: { marginTop: '14px', gap: '18px' } }, [
      el('span', { class: 'verify v-proven' }, proof.proven + ' proven'),
      el('span', { class: 'verify v-confirmed' }, proof.confirmed + ' confirmed'),
      el('span', { class: 'verify v-weak' }, proof.weak + ' suspected'),
    ]),
    el('div', { class: 'kpi-label', style: { marginTop: '14px' } }, 'recurring weakness classes'),
    el('div', { id: 'ov-classes', class: 'row', style: { gap: '6px', marginTop: '6px' } }, el('span', { class: 'faint' }, 'loading…')),
  ]);

  // ── findings over time (sparkline from findings.trend) ──
  const trend = f.trend || [];
  const counts = trend.map((d) => d.count);
  const trendTotal = counts.reduce((a, b) => a + b, 0);
  const trendCard = el('div', { class: 'card' }, [
    el('h2', null, 'Findings over time'),
    el('div', { class: 'row', style: { alignItems: 'baseline', gap: '16px' } }, [
      el('div', null, [el('div', { class: 'kpi' }, String(f.total)), el('div', { class: 'kpi-label' }, 'total findings')]),
      el('div', { style: { flex: '1', minWidth: '160px' } }, [
        sparkline(counts, { width: 420, height: 46, fluid: true, title: trendTotal + ' recorded in the last ' + trend.length + ' days' }),
        el('div', { class: 'kpi-label', style: { marginTop: '8px' } }, 'last ' + trend.length + ' days · ' + trendTotal + ' recorded'),
      ]),
    ]),
  ]);

  // ── hotspots / latest (filled client-side by fillOverviewRows) ──
  const hotCard = el('div', { class: 'card' }, [el('h2', null, 'Hotspots — targets by risk'), el('div', { id: 'ov-hotspots' }, el('div', { class: 'faint' }, 'loading…'))]);
  const latestCard = el('div', { class: 'card' }, [el('h2', null, 'Latest findings'), el('div', { id: 'ov-latest' }, el('div', { class: 'faint' }, 'loading…'))]);

  // ── last pipeline run ──
  const p = o.pipeline;
  const phases = p.phases || [];
  const doneN = phases.filter((x) => x.status === 'done').length;
  const runCard = el('div', { class: 'card' }, [
    el('h2', null, 'Last pipeline run'),
    (!p.db || !p.hasRun)
      ? el('div', { class: 'muted' }, 'no run yet — start a recon from the Pipeline tab')
      : el('div', null, [
        el('div', { class: 'row', style: { alignItems: 'center', gap: '10px' } }, [
          chip('status: ' + (p.unclosed ? 'done (unclosed)' : p.lastRunStatus)),
          el('span', { class: 'mono muted' }, p.runTarget || ''),
        ]),
        el('div', { style: { margin: '10px 0' } }, phases.map((ph) => el('span', { class: 'phase' }, [el('span', { class: 'dot ' + ph.status }), ph.name]))),
        el('div', { class: 'kpi', style: { fontSize: '16px' } }, doneN + '/' + phases.length + ' phases done'),
        el('button', { class: 'btn btn-sm', style: { marginTop: '10px' }, onClick: () => switchTab('pipeline') }, 'open pipeline →'),
      ]),
  ]);

  // ── recent reports ──
  const openReportNode = (r) => el('li', null, [
    el('span', { class: 'dot done', style: { background: 'var(--cyan)', boxShadow: 'var(--glow-cyan)' } }),
    el('a', { href: '/reports/' + encodeURIComponent(r.name), target: '_blank', rel: 'noopener', class: 'mono' }, r.name),
    el('span', { class: 'faint', style: { marginLeft: 'auto' } }, shortTs(r.mtime) + ' · ' + fmtBytes(r.size)),
  ]);
  const reportsCard = el('div', { class: 'card' }, [
    el('h2', null, 'Recent reports'),
    (o.reportsRecent && o.reportsRecent.length)
      ? el('ul', { class: 'list-plain' }, o.reportsRecent.map(openReportNode))
      : el('div', { class: 'faint' }, 'no HTML reports yet — generate one from the Reports tab.'),
  ]);

  pane.replaceChildren(
    statRow,
    el('div', { class: 'grid cols-2', style: { marginTop: '14px' } }, [triageCard, trendCard]),
    el('div', { class: 'grid cols-2', style: { marginTop: '14px' } }, [hotCard, latestCard]),
    el('div', { class: 'grid cols-2', style: { marginTop: '14px' } }, [runCard, reportsCard]),
  );

  // rows-derived panels (hotspots / latest / classes) — fetched client-side
  api('/api/findings').then((d) => fillOverviewRows(d.rows || [])).catch(() => {});
}

const SEV_WEIGHT = { Critical: 10000, High: 100, Medium: 5, Low: 1, Info: 0 };

function fillOverviewRows(rows) {
  if (!byId('tab-overview').classList.contains('active')) return;

  // ── hotspots: aggregate findings per host, rank by severity weight ──
  const hosts = {};
  rows.forEach((f) => {
    const h = f.host || '(no host)';
    const b = hosts[h] || (hosts[h] = { host: h, Critical: 0, High: 0, Medium: 0, Low: 0, Info: 0, total: 0, score: 0 });
    if (b[f.severity] != null) b[f.severity]++;
    b.total++;
    b.score += (SEV_WEIGHT[f.severity] || 0);
  });
  const top = Object.values(hosts).sort((a, b) => b.score - a.score || b.total - a.total).slice(0, 8);
  const hotEl = byId('ov-hotspots');
  if (hotEl) {
    hotEl.innerHTML = top.length
      ? '<table><thead><tr><th>Host</th><th class="num">Crit</th><th class="num">High</th><th class="num">Total</th></tr></thead><tbody>' +
        top.map((h) =>
          '<tr class="clickable" data-ov-host="' + esc(h.host) + '" title="Filter findings by ' + esc(h.host) + '"><td class="mono" style="font-size:12px">' + esc(h.host) + '</td>' +
          '<td class="num"><span class="cvss ' + (h.Critical ? 'g-crit' : 'g-none') + '">' + h.Critical + '</span></td>' +
          '<td class="num"><span class="cvss ' + (h.High ? 'g-high' : 'g-none') + '">' + h.High + '</span></td>' +
          '<td class="num mono">' + h.total + '</td></tr>').join('') +
        '</tbody></table>'
      : '<div class="faint">no findings yet</div>';
  }

  // ── latest findings: most recent by timestamp ──
  const latest = rows.slice().sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || ''))).slice(0, 7);
  const latEl = byId('ov-latest');
  if (latEl) {
    latEl.innerHTML = latest.length
      ? '<ul class="list-plain">' + latest.map((f) => {
          const title = (f.title || '').length > 68 ? (f.title || '').slice(0, 66) + '…' : (f.title || '');
          return '<li class="clickable" data-ov-host="' + esc(f.host || '') + '" title="Filter findings by ' + esc(f.host || '') + '" style="gap:10px">' +
            '<span class="chip ' + (SEV_CHIP[f.severity] || '') + '" style="flex:0 0 auto">' + esc(f.severity || '—') + '</span>' +
            '<span style="flex:1;min-width:0">' + esc(title) +
              ' <span class="faint mono" style="font-size:11px">' + esc(f.host || '') + '</span></span>' +
            '<span class="verify v-' + proofLevel(f.status) + '" style="flex:0 0 auto" title="' + esc(f.status || '') + '"></span>' +
            '<span class="faint mono" style="font-size:11px;flex:0 0 auto">' + shortTs(f.ts) + '</span></li>';
        }).join('') + '</ul>'
      : '<div class="faint">no findings yet</div>';
  }

  // ── recurring weakness classes ──
  const classes = {};
  rows.forEach((f) => {
    const c = f.class || (Array.isArray(f.cwe) ? f.cwe[0] : f.cwe) || null;
    if (c) classes[c] = (classes[c] || 0) + 1;
  });
  const topClasses = Object.entries(classes).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const clsEl = byId('ov-classes');
  if (clsEl) {
    clsEl.innerHTML = topClasses.length
      ? topClasses.map(([c, n]) => '<span class="chip">' + esc(c) + ' <span class="mono" style="color:var(--cyan)">' + n + '</span></span>').join('')
      : '<span class="faint">none classified</span>';
  }
}

// ── Findings ────────────────────────────────────────────────────────────────
// Filters (host/severity/status/q) are applied server-side via /api/findings.
// Sorting + pagination are client-side over the returned rows. Row click opens
// a detail drawer (no page change). pageSize 0 = "show all".
const findingsState = { host: '', severity: '', status: '', q: '', rows: [], page: 1, pageSize: 50, sortKey: '', sortDir: 'desc', lastData: null };

// client-side sort over the server-filtered rows (default = server order)
function sortFindings(rows) {
  const { sortKey, sortDir } = findingsState;
  if (!sortKey) return rows;
  const dir = sortDir === 'asc' ? 1 : -1;
  const val = (f) => {
    switch (sortKey) {
      case 'severity': return f.sevRank || 0;
      case 'cvss': return f.cvss == null ? -1 : Number(f.cvss);
      case 'ts': return String(f.ts || '');
      case 'status': return proofLevel(f.status);
      default: return String(f[sortKey] || '').toLowerCase();
    }
  };
  return rows.slice().sort((a, b) => { const va = val(a), vb = val(b); return (va < vb ? -1 : va > vb ? 1 : 0) * dir; });
}
function findingsSort(key) {
  if (findingsState.sortKey === key) findingsState.sortDir = findingsState.sortDir === 'asc' ? 'desc' : 'asc';
  else { findingsState.sortKey = key; findingsState.sortDir = key === 'title' || key === 'host' ? 'asc' : 'desc'; }
  renderFindings(findingsState.lastData);
}

// toggle chip for a single-select facet (severity / status) → refetch
function facetChip(text, cls, active, onToggle) {
  const c = chip(text, (cls || '') + (active ? ' active' : ''));
  c.classList.add('chip-toggle');
  c.setAttribute('role', 'button'); c.tabIndex = 0;
  c.setAttribute('aria-pressed', active ? 'true' : 'false');
  c.addEventListener('click', onToggle);
  c.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } });
  return c;
}

function renderFindings(data) {
  findingsState.lastData = data;
  findingsState.rows = data.rows || [];
  const pane = byId('tab-findings');

  // ── filters: search + host select + reset ──
  const q = el('input', { type: 'search', id: 'f-q', placeholder: 'search title / endpoint / host / cwe…', value: findingsState.q });
  q.addEventListener('input', debounce(() => { findingsState.q = q.value.trim(); fetchFindings(); }, 350));
  const hostSel = el('select', { id: 'f-host' }, [el('option', { value: '' }, 'all hosts'),
    ...(data.hosts || []).map((h) => el('option', { value: h, selected: h === findingsState.host }, h))]);
  hostSel.addEventListener('change', () => { findingsState.host = hostSel.value; fetchFindings(); });
  const resetBtn = el('button', { class: 'btn', id: 'f-reset' }, 'reset');
  resetBtn.addEventListener('click', () => { Object.assign(findingsState, { host: '', severity: '', status: '', q: '' }); fetchFindings(); });
  const filters = el('div', { class: 'filters' }, [
    el('div', { class: 'f wide' }, q),
    el('div', { class: 'f' }, hostSel),
    el('div', { class: 'f', style: { flex: '0 0 auto' } }, resetBtn),
  ]);

  // ── quick-filter chips: severity + status (toggle, single-select each) ──
  const sevChips = ['Critical', 'High', 'Medium', 'Low', 'Info'].map((s) =>
    facetChip(s + ' ' + ((data.bySeverity || {})[s] || 0), SEV_CHIP[s] || '', findingsState.severity === s,
      () => { findingsState.severity = findingsState.severity === s ? '' : s; fetchFindings(); }));
  const statusKeys = Object.keys(data.byStatus || {});
  const statusChips = statusKeys.map((s) =>
    facetChip(s + ' ' + data.byStatus[s], 'st-' + proofLevel(s), findingsState.status === s,
      () => { findingsState.status = findingsState.status === s ? '' : s; fetchFindings(); }));
  const quickRow = el('div', { class: 'card quick-filters', style: { marginBottom: '12px' } }, [
    el('span', { class: 'chip' }, data.total + ' findings'),
    ...sevChips,
    statusChips.length ? el('span', { class: 'qf-sep' }) : null,
    ...statusChips,
  ]);

  // ── table (sorted + paginated) ──
  const sorted = sortFindings(findingsState.rows);
  const total = sorted.length;
  const pageSize = findingsState.pageSize > 0 ? findingsState.pageSize : (total || 1);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  findingsState.page = Math.min(Math.max(1, findingsState.page), pageCount);
  const start = (findingsState.page - 1) * pageSize;
  const pageRows = sorted.slice(start, start + pageSize);

  const cvssCell = (f) => el('span', { class: 'cvss g-' + (f.cvss != null ? cvssGrade(Number(f.cvss)) : 'none') }, f.cvss != null ? Number(f.cvss).toFixed(1) : '—');
  const confCell = (f) => f.confidence
    ? el('span', null, [el('span', { class: 'conf ' + f.confidence.label }, f.confidence.score.toFixed(2)), document.createTextNode(' '), el('span', { class: 'faint' }, f.confidence.label)])
    : el('span', { class: 'faint' }, '—');
  const cweCell = (f) => { const c = Array.isArray(f.cwe) ? f.cwe : (f.cwe ? [f.cwe] : []); return el('span', null, c.map((x) => chip(x))); };
  const table = dataTable({
    sticky: true,
    sortState: { key: findingsState.sortKey, dir: findingsState.sortDir },
    onSort: findingsSort,
    rowClass: (f) => 'sev-row ' + (SEV_ROW[f.severity] || 's-info'),
    onRow: (f) => openFindingDrawer(f),
    empty: 'no findings match',
    columns: [
      { label: 'Severity', sort: 'severity', cell: (f) => severityChip(f.severity) },
      { label: 'Title', sort: 'title', cell: (f) => f.title || '' },
      { label: 'Host', sort: 'host', tdClass: 'mono', cell: (f) => f.host || '' },
      { label: 'Endpoint', tdClass: 'endpoint', cell: (f) => ({ html: epBreak(f.endpoint || '') }) },
      { label: 'CWE', cell: cweCell },
      { label: 'CVSS', sort: 'cvss', num: true, cell: cvssCell },
      { label: 'Conf', cell: confCell },
      { label: 'Status', sort: 'status', cell: (f) => f.status ? el('span', { class: 'verify v-' + proofLevel(f.status) }, f.status) : el('span', { class: 'faint' }, '—') },
      { label: 'Detected', sort: 'ts', tdClass: 'faint mono', cell: (f) => shortTs(f.ts) },
    ],
    rows: pageRows,
  });
  const tableCard = el('div', { class: 'card', style: { padding: '0' } }, table);

  // ── pager ──
  const pagerInfo = total === 0 ? '0 risultati'
    : 'Pagina ' + findingsState.page + ' / ' + pageCount + ' · ' + (start + 1) + '–' + Math.min(start + pageSize, total) + ' di ' + total;
  const prev = el('button', { class: 'btn btn-sm', id: 'f-prev', disabled: findingsState.page <= 1, 'aria-label': 'Pagina precedente' }, '‹ Prev');
  prev.addEventListener('click', () => { findingsState.page--; renderFindings(findingsState.lastData); });
  const next = el('button', { class: 'btn btn-sm', id: 'f-next', disabled: findingsState.page >= pageCount, 'aria-label': 'Pagina successiva' }, 'Next ›');
  next.addEventListener('click', () => { findingsState.page++; renderFindings(findingsState.lastData); });
  const sizeSel = el('select', { id: 'f-size' }, [
    ...[25, 50, 100].map((n) => el('option', { value: n, selected: findingsState.pageSize === n }, String(n))),
    el('option', { value: 0, selected: findingsState.pageSize === 0 }, 'Tutti'),
  ]);
  sizeSel.addEventListener('change', () => { findingsState.pageSize = parseInt(sizeSel.value, 10) || 0; findingsState.page = 1; renderFindings(findingsState.lastData); });
  const pager = el('div', { class: 'pager' }, [
    prev, el('span', { class: 'pager-info', 'aria-live': 'polite' }, pagerInfo), next,
    el('label', { class: 'pager-size' }, ['per pagina ', sizeSel]),
  ]);

  pane.replaceChildren(filters, quickRow, tableCard, pager);
}

// finding detail fields for the drawer (skips empty). Same data already served
// by /api/findings — no new server exposure; loot is untouched (count only).
function findingDetailFields(f) {
  const cwes = Array.isArray(f.cwe) ? f.cwe : (f.cwe ? [f.cwe] : []);
  return [
    ['Host', f.host],
    ['Endpoint', f.endpoint],
    ['Class', f.class],
    ['CWE', cwes.join(', ')],
    ['CVSS', f.cvss != null ? Number(f.cvss).toFixed(1) + (f.cvss_vector ? ' · ' + f.cvss_vector : '') : ''],
    ['CVE', f.cve || (f.cves ? f.cves.join(', ') : '')],
    ['EPSS', f.epss != null ? (Number(f.epss) * 100).toFixed(1) + '%' : ''],
    ['Confidence', f.confidence ? f.confidence.score.toFixed(2) + ' · ' + f.confidence.label : ''],
    ['Status', f.status],
    ['Verify level', f.verify_level],
    ['Verified at', f.verified_at ? shortTs(f.verified_at) : ''],
    ['Detected', f.ts ? shortTs(f.ts) : ''],
    ['Impact', f.impact],
    ['PoC', f.poc],
    ['Remediation', f.remediation],
    ['Evidence', f.evidence_quote],
    ['Oracle', f.oracle ? (f.oracle.type || '') + (f.oracle.ref ? ' · ' + f.oracle.ref : '') : ''],
    ['Standards', Array.isArray(f.standards) ? f.standards.join(', ') : f.standards],
    ['Chain', Array.isArray(f.chain) ? f.chain.join(' → ') : f.chain],
  ].filter(([, v]) => v != null && v !== '');
}
function openFindingDrawer(f) {
  const detailEl = el('div', { class: 'detail' });
  findingDetailFields(f).forEach(([k, v]) => { detailEl.appendChild(el('h4', null, k)); detailEl.appendChild(el('p', null, String(v))); });
  const body = el('div', null, [
    el('div', { class: 'row', style: { alignItems: 'center', gap: '10px', marginBottom: '14px' } }, [
      severityChip(f.severity),
      f.cvss != null ? el('span', { class: 'cvss g-' + cvssGrade(Number(f.cvss)) }, Number(f.cvss).toFixed(1)) : null,
      f.status ? el('span', { class: 'verify v-' + proofLevel(f.status) }, f.status) : null,
    ]),
    detailEl,
  ]);
  drawer({ title: f.title || 'Finding', body });
}

function fetchFindings() {
  findingsState.page = 1; // a new filtered result set always starts on page 1
  const p = new URLSearchParams();
  if (findingsState.host) p.set('host', findingsState.host);
  if (findingsState.severity) p.set('severity', findingsState.severity);
  if (findingsState.status) p.set('status', findingsState.status);
  if (findingsState.q) p.set('q', findingsState.q);
  api('/api/findings?' + p.toString()).then((d) => renderFindings(d)).catch((e) => toast(String(e.message || e), 'err'));
}

// ── Pipeline ────────────────────────────────────────────────────────────────
// one node in the horizontal phase DAG (Trickest-style). Status drives colour;
// duration shown when the phase has both started_at and finished_at.
function dagNode(ph) {
  const dur = fmtDur(ph.started_at, ph.finished_at);
  const meta = dur ? ph.status + ' · ' + dur : ph.status;
  return el('div', { class: 'dag-node st-' + ph.status, role: 'listitem', title: ph.name + ' — ' + meta }, [
    el('span', { class: 'dag-name' }, [el('span', { class: 'dot ' + ph.status }), ph.name]),
    el('span', { class: 'dag-meta' }, meta),
  ]);
}

function renderPipeline(data) {
  const pane = byId('tab-pipeline');
  if (!data.db) {
    pane.replaceChildren(el('div', { class: 'card' }, [
      el('h2', null, 'Pipeline'),
      el('div', { class: 'muted', html: 'no <span class="mono">reports/state.db</span> yet — run <code>node tools/cyboros.js recon &lt;host&gt;</code> first.' }),
    ]));
    return;
  }
  const lastRun = data.lastRun;
  const phases = data.phases || [];
  const doneN = phases.filter((p) => p.status === 'done').length;

  // re-render with fresh data after a run mutation (guard-safe wrappers only)
  const refetchPipeline = () => api('/api/pipeline').then((d) => { renderPipeline(d); refreshBadges(); }).catch((e) => toast(String(e.message || e), 'err'));
  const runAction = (id, act) => {
    if (act === 'close') {
      if (!confirm('Mark run #' + id + ' as done?')) return;
      api('/api/pipeline/runs/' + id + '/close', { method: 'POST' })
        .then(() => { toast('run #' + id + ' marked done'); refetchPipeline(); })
        .catch((e) => toast(String(e.message || e), 'err'));
    } else {
      if (!confirm('Delete run #' + id + ' and its phases? Targets/hosts/ports data is kept.')) return;
      api('/api/pipeline/runs/' + id, { method: 'DELETE' })
        .then(() => { toast('run #' + id + ' removed'); refetchPipeline(); })
        .catch((e) => toast(String(e.message || e), 'err'));
    }
  };
  const actBtn = (label, title, fn) => { const b = el('button', { class: 'btn btn-sm', title }, label); b.addEventListener('click', (e) => { e.stopPropagation(); fn(); }); return b; };

  // ── phase graph card ──
  const dagKids = [];
  phases.forEach((ph, i) => { if (i > 0) dagKids.push(el('span', { class: 'dag-edge', 'aria-hidden': 'true' })); dagKids.push(dagNode(ph)); });
  const dagCard = el('div', { class: 'card' }, [
    el('h2', null, [document.createTextNode('Phase graph'), lastRun ? el('span', { class: 'faint mono', style: { marginLeft: '8px', textTransform: 'none', letterSpacing: '0' } }, doneN + '/' + phases.length + ' done') : null]),
    phases.length ? el('div', { class: 'dag', role: 'list', 'aria-label': 'pipeline phases' }, dagKids) : el('div', { class: 'muted' }, 'no phases recorded for the last run'),
  ]);

  // ── last run card ──
  const resumeBtn = data.resumePossible
    ? actBtn('▶ Resume incomplete run', 'resume the incomplete run', () => startJob('resume', '/api/pipeline/resume', 'cyboros.js resume'))
    : el('button', { class: 'btn', disabled: true, title: 'no genuinely incomplete phase to resume (a done scan-only run is not incomplete)' }, '▶ Resume (nothing to resume)');
  if (data.resumePossible) resumeBtn.classList.add('btn-primary');
  const lastCtl = (lastRun && lastRun.status !== 'done') ? [
    actBtn('✓ mark done', 'mark run #' + lastRun.id + ' as done', () => runAction(lastRun.id, 'close')),
    actBtn('✕ remove run', 'delete run #' + lastRun.id + ' + its phases', () => runAction(lastRun.id, 'remove')),
  ] : [];
  const unclosedHint = (data.unclosed && lastRun)
    ? el('div', { class: 'hint', style: { color: 'var(--yellow)', margin: '4px 0 8px' } }, '⚠ run finished its phases but was never closed — mark it done or remove it')
    : null;
  const lastCard = el('div', { class: 'card' }, [
    el('h2', null, 'Last run' + (lastRun ? ' #' + lastRun.id : '')),
    lastRun ? el('div', null, [
      el('div', { class: 'row', style: { alignItems: 'center', gap: '10px' } }, [chip('status: ' + lastRun.status), el('span', { class: 'mono muted' }, lastRun.target || '')]),
      el('div', { class: 'kpi', style: { fontSize: '16px', marginTop: '10px' } }, doneN + '/' + phases.length + ' phases done'),
      el('div', { class: 'hint', style: { marginBottom: '8px' } }, (lastRun.command || '') + ' · started ' + shortTs(lastRun.started_at)),
      unclosedHint,
      el('div', { class: 'row', style: { gap: '6px', marginTop: '6px' } }, [resumeBtn, ...lastCtl]),
    ]) : el('div', { class: 'muted' }, 'no runs recorded yet'),
  ]);

  // ── targets card ──
  const targetsCard = el('div', { class: 'card' }, [
    el('h2', null, 'Targets (' + (data.targets || []).length + ')'),
    dataTable({
      empty: '—', rows: data.targets || [],
      columns: [
        { label: 'Host', tdClass: 'mono', cell: (t) => t.host },
        { label: 'Hosts', num: true, cell: (t) => t.hosts },
        { label: 'Ports', num: true, cell: (t) => t.ports },
        { label: 'Endpoints', num: true, cell: (t) => t.endpoints },
        { label: 'Last seen', tdClass: 'muted', cell: (t) => shortTs(t.last_seen) },
      ],
    }),
  ]);

  // ── recent runs card ──
  const runsCard = el('div', { class: 'card', style: { marginTop: '12px' } }, [
    el('h2', null, 'Recent runs'),
    dataTable({
      empty: '—', rows: data.runs || [],
      columns: [
        { label: '#', tdClass: 'mono muted', cell: (r) => '#' + r.id },
        { label: 'Command', cell: (r) => r.command || '' },
        { label: 'Target', tdClass: 'mono', cell: (r) => r.target || '' },
        { label: 'Status', cell: (r) => el('span', null, [el('span', { class: 'dot ' + r.status }), document.createTextNode(' ' + r.status)]) },
        { label: 'Started', tdClass: 'muted', cell: (r) => shortTs(r.started_at) },
        { label: 'Actions', cell: (r) => el('span', { class: 'row', style: { gap: '6px' } },
          [r.status !== 'done' ? actBtn('✓', 'mark run #' + r.id + ' as done', () => runAction(r.id, 'close')) : null,
            actBtn('✕', 'delete run #' + r.id + ' + its phases', () => runAction(r.id, 'remove'))].filter(Boolean)) },
      ],
    }),
    el('div', { class: 'hint', style: { marginTop: '6px' } }, '✓ = close a stale run (status stuck at running), ✕ = delete run + phases (targets/ports data is kept).'),
  ]);

  pane.replaceChildren(dagCard, el('div', { class: 'grid cols-2', style: { marginTop: '12px' } }, [lastCard, targetsCard]), runsCard);
}

// ── Scope ───────────────────────────────────────────────────────────────────
let scopeData = null;
function renderScope(data) {
  scopeData = data;
  const pane = byId('tab-scope');

  const banner = data.failClosed
    ? el('div', { class: 'card', style: { borderColor: '#7c2530', background: '#2a1216' }, html: '<b style="color:#ff5d6c">⚠ FAIL-CLOSED</b> — no hosts, prefixes or IPs allowed: scope-guard blocks everything until you add targets.' })
    : el('div', { class: 'card', style: { borderColor: '#1e5c3d', background: '#10251a' }, html: '<b style="color:#3ddc84">✓ Scope active</b> — ' + data.allowed_hosts.length + ' host(s), ' + data.allowed_url_prefixes.length + ' prefix(es), ' + data.allowed_ips.length + ' IP/CIDR.' });

  const field = (id, labelText, control) => [el('label', { for: id }, labelText), control];
  const ta = (id, val) => el('textarea', { id }, val);
  const editorCard = el('div', { class: 'card' }, [
    el('h2', null, 'scope.json editor'),
    ...field('sc-hosts', 'allowed_hosts (one per line — covers host + subdomains)', ta('sc-hosts', data.allowed_hosts.join('\n'))),
    ...field('sc-prefixes', 'allowed_url_prefixes (one per line, must end with /)', ta('sc-prefixes', data.allowed_url_prefixes.join('\n'))),
    ...field('sc-ips', 'allowed_ips / CIDR (internal, SSRF, lab)', ta('sc-ips', data.allowed_ips.join('\n'))),
    ...field('sc-rps', 'max_requests_per_second (global pacing)', el('input', { type: 'number', id: 'sc-rps', min: '1', max: '600', value: data.max_requests_per_second })),
    el('div', { class: 'row', style: { marginTop: '14px', alignItems: 'center' } }, [
      el('button', { class: 'btn btn-primary', id: 'sc-save' }, '💾 Save scope.json'),
      el('span', { id: 'sc-save-hint', class: 'hint' }),
    ]),
    el('div', { class: 'hint', style: { marginTop: '8px' }, html: 'Host/IP/CIDR entries are validated server-side before writing. The runtime truth stays <span class="mono">tools/scope-guard.js</span> — the GUI never bypasses it. Every save appends a timestamped note.' }),
  ]);

  const checkCard = el('div', { class: 'card' }, [
    el('h2', null, 'Verify a URL against the guard'),
    el('input', { type: 'text', id: 'sc-url', placeholder: 'https://target.example/path?x=1' }),
    el('div', { class: 'row', style: { marginTop: '8px', alignItems: 'center' } }, [
      el('button', { class: 'btn', id: 'sc-check' }, 'Check scope'),
      el('span', { id: 'sc-check-out', class: 'hint' }, 'type a URL — checked live against scope-guard'),
    ]),
  ]);
  const notesCard = el('div', { class: 'card' }, [
    el('h2', null, 'Notes (history)'),
    el('pre', { style: { maxHeight: '220px', overflow: 'auto', font: '11px/1.5 var(--mono)', color: 'var(--muted)', whiteSpace: 'pre-wrap' } }, data.notes || ''),
  ]);

  pane.replaceChildren(banner, el('div', { class: 'grid cols-2', style: { marginTop: '12px' } }, [editorCard, el('div', { class: 'stack' }, [checkCard, notesCard])]));

  byId('sc-save').addEventListener('click', saveScope);
  byId('sc-check').addEventListener('click', checkScope);
  byId('sc-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') checkScope(); });
  // live validation as you type (debounced; read-only guard check, no write)
  byId('sc-url').addEventListener('input', debounce(() => { if (byId('sc-url').value.trim()) checkScope(); else { const o = byId('sc-check-out'); o.textContent = 'type a URL — checked live against scope-guard'; o.className = 'hint'; } }, 400));
}

function parseList(textarea) {
  return textarea.value.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
}
async function saveScope() {
  const hosts = parseList(byId('sc-hosts'));
  const prefixes = parseList(byId('sc-prefixes'));
  const ips = parseList(byId('sc-ips'));
  const rps = parseInt(byId('sc-rps').value, 10);
  const willEmpty = hosts.length === 0 && prefixes.length === 0 && ips.length === 0;
  if (willEmpty && !confirm('You are about to empty the scope → FAIL-CLOSED (everything blocked). Continue?')) return;
  const out = byId('sc-save-hint');
  out.textContent = 'saving…'; out.className = 'hint';
  try {
    const r = await api('/api/scope', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ allowed_hosts: hosts, allowed_url_prefixes: prefixes, allowed_ips: ips, max_requests_per_second: rps }) });
    out.textContent = 'saved' + (r.added ? ' · +' + r.added + ' host(s)' : '') + (r.removed ? ' · -' + r.removed + ' host(s)' : '') + (r.failClosed ? ' · ⚠ FAIL-CLOSED' : '');
    out.className = 'hint ' + (r.failClosed ? 'err' : 'ok');
    toast(r.failClosed ? 'Scope saved — FAIL-CLOSED (empty scope!)' : 'Scope saved', r.failClosed ? 'err' : 'ok');
    refreshBadges();
    renderScope(await api('/api/scope'));
  } catch (e) { out.textContent = String(e.message || e); out.className = 'hint err'; }
}
async function checkScope() {
  const u = byId('sc-url').value.trim();
  const out = byId('sc-check-out');
  if (!u) { out.textContent = 'enter a URL first'; out.className = 'hint err'; return; }
  out.textContent = 'checking…'; out.className = 'hint';
  try {
    const r = await api('/api/scope/check?url=' + encodeURIComponent(u));
    if (r.ok) { out.textContent = '✓ IN SCOPE — allowed'; out.className = 'hint ok'; }
    else { out.textContent = '✗ OUT OF SCOPE' + (r.reason ? ' — ' + r.reason : ''); out.className = 'hint err'; }
  } catch (e) { out.textContent = String(e.message || e); out.className = 'hint err'; }
}

// ── Sessions ────────────────────────────────────────────────────────────────
// row click → detail drawer. Artifacts/meta shown are the same fields the
// ledger already exposed; loot stays count-only (contents never shown). No
// per-session PTY exists server-side, so the drawer links to the shared
// operator console (Freebuff) rather than faking a live shell per session.
function openSessionDrawer(s) {
  const detailEl = el('div', { class: 'detail' });
  const push = (k, v) => { if (v != null && v !== '') { detailEl.appendChild(el('h4', null, k)); detailEl.appendChild(el('p', null, String(v))); } };
  push('Status', s.status); push('Host', s.host); push('Obtained via', s.obtained_via);
  Object.keys(s.meta || {}).forEach((k) => push(k, s.meta[k]));
  const arts = s.artifacts || [];
  const consoleBtn = el('button', { class: 'btn btn-sm' }, 'open operator console →');
  consoleBtn.addEventListener('click', () => { closeDrawer(); switchTab('freebuff'); });
  const body = el('div', null, [
    el('div', { class: 'row', style: { alignItems: 'center', gap: '10px', marginBottom: '14px' } }, [chip(s.status), el('span', { class: 'mono muted' }, s.host || '')]),
    detailEl,
    el('div', { class: 'kpi-label', style: { marginTop: '16px', marginBottom: '6px' } }, 'Artifacts (' + arts.length + ')'),
    arts.length ? el('ul', { class: 'list-plain' }, arts.map((a) => el('li', { class: 'mono', style: { fontSize: '12px' } }, typeof a === 'string' ? a : JSON.stringify(a)))) : el('div', { class: 'faint' }, 'none'),
    el('div', { style: { marginTop: '16px' } }, consoleBtn),
  ]);
  drawer({ title: 'Session ' + s.id, body });
}

function renderSessions(data) {
  const pane = byId('tab-sessions');
  const lootTile = statTile({ label: 'Loot rows', value: '…', hint: 'contents never shown' });
  const statRow = el('div', { class: 'stat-row' }, [
    statTile({ label: 'Active sessions', value: data.active, tone: data.active > 0 ? 'live' : null }),
    statTile({ label: 'Artifacts (teardown)', value: data.artifactsTotal }),
    lootTile,
  ]);

  const tableCard = el('div', { class: 'card', style: { padding: '0', marginTop: '12px' } }, dataTable({
    sticky: true, empty: 'no sessions in reports/sessions.json',
    onRow: (s) => openSessionDrawer(s),
    rows: data.rows || [],
    columns: [
      { label: 'Session', tdClass: 'mono', cell: (s) => s.id },
      { label: 'Status', cell: (s) => chip(s.status) },
      { label: 'Host', tdClass: 'mono', cell: (s) => s.host || '' },
      { label: 'Obtained via', tdClass: 'mono', cell: (s) => s.obtained_via || '' },
      { label: 'Artifacts', num: true, cell: (s) => s.artifacts.length },
    ],
  }));

  const hint = el('div', { class: 'hint', style: { marginTop: '8px' }, html: 'Teardown ledger — <span class="mono">stavros-cleanup</span> empties it at engagement end. GUI is read-only here: cleanup is a confirm-tier action run from the CLI. Click a row for artifacts + meta.' });

  pane.replaceChildren(statRow, tableCard, hint);
  api('/api/loot/count').then((r) => { lootTile.querySelector('.stat-value').textContent = r.count; }).catch(() => { lootTile.querySelector('.stat-value').textContent = '—'; });
}

// ── Reports ─────────────────────────────────────────────────────────────────
function reportIsHtml(r) { return r.kind === 'report' || /\.html$/.test(r.name); }
function openReportDrawer(r) {
  const href = '/reports/' + encodeURIComponent(r.name);
  const openBtn = el('a', { class: 'btn btn-sm', href, target: '_blank', rel: 'noopener' }, 'open in new tab ↗');
  const body = el('div', null, [
    el('div', { class: 'row', style: { alignItems: 'center', gap: '10px', marginBottom: '12px' } }, [chip(r.kind), el('span', { class: 'faint mono' }, fmtBytes(r.size) + ' · ' + shortTs(r.mtime)), openBtn]),
    reportIsHtml(r)
      ? el('iframe', { class: 'report-preview', src: href, title: 'Preview of ' + r.name, loading: 'lazy' })
      : el('div', { class: 'faint' }, 'markdown file — open in a new tab to view (' + r.name + ')'),
  ]);
  drawer({ title: r.name, body });
}

function renderReports(data) {
  const pane = byId('tab-reports');
  const genBtn = el('button', { class: 'btn btn-primary', id: 'btn-gen-report' }, '⚙ Generate report.html');
  genBtn.addEventListener('click', () => startJob('report-html', '/api/reports/generate', 'tools/report-html.js'));
  const genCard = el('div', { class: 'card', style: { marginBottom: '12px' } },
    el('div', { class: 'row', style: { alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' } }, [
      el('div', null, [el('b', null, 'Standalone HTML report'), el('div', { class: 'hint' }, 'consolidates findings.jsonl + state.db + attack chains via tools/report-html.js (severity · CVSS · CWE · EPSS · confidence)')]),
      genBtn,
    ]));

  const tableCard = el('div', { class: 'card', style: { padding: '0' } }, dataTable({
    sticky: true, empty: 'reports/ is empty', rows: data || [],
    onRow: (r) => openReportDrawer(r),
    columns: [
      { label: 'File', tdClass: 'mono', cell: (r) => r.name },
      { label: 'Kind', cell: (r) => chip(r.kind) },
      { label: 'Size', num: true, tdClass: 'muted', cell: (r) => fmtBytes(r.size) },
      { label: 'Modified', tdClass: 'muted', cell: (r) => shortTs(r.mtime) },
      { label: '', cell: (r) => reportIsHtml(r)
        ? el('a', { class: 'btn btn-sm', href: '/reports/' + encodeURIComponent(r.name), target: '_blank', rel: 'noopener', onClick: (e) => e.stopPropagation() }, 'open ↗')
        : el('span', { class: 'faint mono', style: { fontSize: '11px' } }, 'reports/' + r.name) },
    ],
  }));

  pane.replaceChildren(genCard, tableCard);
}

// ── jobs / live log modal ───────────────────────────────────────────────────
function startJob(name, path, title) {
  api(path, { method: 'POST' }).then((r) => {
    toast('started: ' + title, '');
    openJobModal(r.jobId, title);
  }).catch((e) => toast('failed to start job: ' + String(e.message || e), 'err'));
}

function openJobModal(jobId, title) {
  const modal = byId('job-modal');
  const logEl = byId('job-log');
  const doneEl = byId('job-modal-done');
  byId('job-modal-title').textContent = title + ' — ' + jobId;
  byId('job-modal-state').textContent = 'running';
  logEl.textContent = '';
  doneEl.style.display = 'none';
  doneEl.innerHTML = '';
  modal.classList.remove('hidden');
  const es = new EventSource(withToken('/api/jobs/' + jobId + '/events'));
  es.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'line') {
      logEl.textContent += msg.line + '\n';
      logEl.scrollTop = logEl.scrollHeight;
    } else if (msg.type === 'done') {
      byId('job-modal-state').textContent = msg.exitCode === 0 ? 'done' : 'error (exit ' + msg.exitCode + ')';
      byId('job-modal-state').style.color = msg.exitCode === 0 ? 'var(--green)' : 'var(--red)';
      doneEl.style.display = 'block';
      if (msg.out) doneEl.innerHTML = '<a class="btn btn-primary" href="' + esc(msg.out) + '" target="_blank" rel="noopener">Open generated report ↗</a>';
      if (msg.error) doneEl.innerHTML += '<div class="hint err" style="margin-top:6px">' + esc(msg.error) + '</div>';
      es.close();
    }
  };
  es.onerror = () => { /* transient — EventSource retries */ };
  modal._es = es;
}

function closeJobModal() {
  const modal = byId('job-modal');
  if (modal._es) modal._es.close();
  modal.classList.add('hidden');
}

// ── command palette (⌘/Ctrl-K) — client-side navigator + quick actions ───────
// Pure client-side: tab jumps + wrappers over existing endpoints. No new API.
function cmdkActions() {
  return [
    { kind: 'tab', label: 'Overview', run: () => switchTab('overview') },
    { kind: 'tab', label: 'Campaign', run: () => switchTab('campaign') },
    { kind: 'tab', label: 'Mission control', run: () => switchTab('mission') },
    { kind: 'tab', label: 'War Room (live board)', run: () => switchTab('warroom') },
    { kind: 'tab', label: 'Approvals inbox', run: () => switchTab('approvals') },
    { kind: 'tab', label: 'Ledger', run: () => switchTab('ledger') },
    { kind: 'tab', label: 'Findings', run: () => switchTab('findings') },
    { kind: 'tab', label: 'Pipeline', run: () => switchTab('pipeline') },
    { kind: 'tab', label: 'Sessions', run: () => switchTab('sessions') },
    { kind: 'tab', label: 'Graph', run: () => switchTab('graph') },
    { kind: 'tab', label: 'Coverage', run: () => switchTab('coverage') },
    { kind: 'tab', label: 'Scope', run: () => switchTab('scope') },
    { kind: 'tab', label: 'Arsenal (tools of this device + install missing)', run: () => switchTab('arsenal') },
    { kind: 'tab', label: 'Control (config/team/knowledge/radar/doctor)', run: () => switchTab('control') },
    { kind: 'tab', label: 'Reports', run: () => switchTab('reports') },
    { kind: 'tab', label: 'Freebuff terminal', run: () => switchTab('freebuff') },
    { kind: 'action', label: 'Refresh current tab', run: () => renderTab(activeTab) },
    { kind: 'action', label: 'Resume incomplete pipeline run', run: cmdkResumePipeline },
    { kind: 'action', label: 'Generate report.html', run: () => startJob('report-html', '/api/reports/generate', 'tools/report-html.js') },
    { kind: 'action', label: 'Build evidence bundle', run: () => api('/api/cc/ledger/evidence', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((r) => toast('bundle: ' + (r.tar || r.manifest), '')).catch((e) => toast(String(e.message || e), 'err')) },
  ];
}
let cmdkItems = [], cmdkIdx = 0;
function cmdkIsOpen() { return !byId('cmdk').classList.contains('hidden'); }
function cmdkOpen() {
  byId('cmdk').classList.remove('hidden');
  const input = byId('cmdk-input');
  input.value = '';
  cmdkFilter('');
  input.focus();
}
function cmdkClose() { byId('cmdk').classList.add('hidden'); }
function cmdkFilter(q) {
  const ql = q.trim().toLowerCase();
  const all = cmdkActions();
  cmdkItems = ql ? all.filter((a) => a.label.toLowerCase().includes(ql)) : all;
  cmdkIdx = 0;
  cmdkRender();
}
function cmdkRender() {
  const list = byId('cmdk-list');
  if (!cmdkItems.length) { list.replaceChildren(el('li', { class: 'cmdk-empty' }, 'no matching command')); return; }
  list.replaceChildren(...cmdkItems.map((a, i) => el('li', {
    role: 'option', 'aria-selected': i === cmdkIdx ? 'true' : 'false', onClick: () => cmdkRun(i),
  }, [el('span', { class: 'cmdk-kind' }, a.kind), el('span', { class: 'cmdk-label' }, a.label)])));
  const sel = list.children[cmdkIdx];
  if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });
}
function cmdkMove(d) {
  if (!cmdkItems.length) return;
  cmdkIdx = (cmdkIdx + d + cmdkItems.length) % cmdkItems.length;
  cmdkRender();
}
function cmdkRun(i) {
  const a = cmdkItems[i == null ? cmdkIdx : i];
  if (!a) return;
  cmdkClose();
  try { a.run(); } catch (e) { toast(String(e.message || e), 'err'); }
}
function cmdkResumePipeline() {
  api('/api/pipeline').then((d) => {
    if (d.resumePossible) startJob('resume', '/api/pipeline/resume', 'cyboros.js resume');
    else toast('nothing to resume — no genuinely incomplete run', '');
  }).catch((e) => toast(String(e.message || e), 'err'));
}

// ── wiring ──────────────────────────────────────────────────────────────────
function debounce(fn, ms) {
  let t;
  return function () { clearTimeout(t); t = setTimeout(fn, ms); };
}

// brief loading skeleton shown while an async tab fetches (local, usually one
// frame). Only on tab entry — not on in-tab refetches (filters/pagination).
function showSkeleton(tab) {
  const pane = byId('tab-' + tab);
  if (!pane || pane.childElementCount > 0) return; // keep existing content — no flash on refresh/poll
  pane.replaceChildren(el('div', { class: 'grid cols-2' }, [
    el('div', { class: 'skeleton', style: { minHeight: '140px' } }),
    el('div', { class: 'skeleton', style: { minHeight: '140px' } }),
  ]));
}

function renderTab(tab) {
  // Leaving the War Room stops its poller; it restarts on entry (renderWarroom).
  if (tab !== 'warroom' && typeof warStop === 'function') warStop();
  if (tab === 'overview') refreshBadges();
  else if (tab === 'campaign') { showSkeleton('campaign'); renderCampaign(); }
  else if (tab === 'mission') { showSkeleton('mission'); renderMission(); }
  else if (tab === 'warroom') renderWarroom();
  else if (tab === 'approvals') { showSkeleton('approvals'); renderApprovals(); }
  else if (tab === 'ledger') { showSkeleton('ledger'); renderLedger(); }
  else if (tab === 'findings') { showSkeleton('findings'); fetchFindings(); }
  else if (tab === 'pipeline') { showSkeleton('pipeline'); api('/api/pipeline').then(renderPipeline).catch((e) => toast(String(e.message || e), 'err')); }
  else if (tab === 'sessions') { showSkeleton('sessions'); api('/api/sessions').then(renderSessions).catch((e) => toast(String(e.message || e), 'err')); }
  else if (tab === 'graph') { showSkeleton('graph'); renderGraphTab(); }
  else if (tab === 'coverage') { showSkeleton('coverage'); renderCoverageTab(); }
  else if (tab === 'scope') { showSkeleton('scope'); api('/api/scope').then(renderScope).catch((e) => toast(String(e.message || e), 'err')); }
  else if (tab === 'arsenal') { showSkeleton('arsenal'); renderArsenalTab(); }
  else if (tab === 'control') { showSkeleton('control'); renderControlTab(); }
  else if (tab === 'reports') { showSkeleton('reports'); api('/api/reports').then(renderReports).catch((e) => toast(String(e.message || e), 'err')); }
  else if (tab === 'freebuff') renderFreebuffTab();
}


(() => {
  const tabBtns = $$('#tabs .tab');
  tabBtns.forEach((b, idx) => {
    b.addEventListener('click', () => switchTab(b.dataset.tab));
    // WAI-ARIA tablist keyboard pattern: ←/→ move between tabs, Home/End jump to ends.
    b.addEventListener('keydown', (e) => {
      let ni = null;
      if (e.key === 'ArrowRight') ni = (idx + 1) % tabBtns.length;
      else if (e.key === 'ArrowLeft') ni = (idx - 1 + tabBtns.length) % tabBtns.length;
      else if (e.key === 'Home') ni = 0;
      else if (e.key === 'End') ni = tabBtns.length - 1;
      if (ni == null) return;
      e.preventDefault();
      switchTab(tabBtns[ni].dataset.tab);
      tabBtns[ni].focus();
    });
  });
})();
byId('btn-refresh').addEventListener('click', () => renderTab(activeTab));

// command palette wiring
byId('btn-cmdk').addEventListener('click', cmdkOpen);
byId('cmdk-input').addEventListener('input', (e) => cmdkFilter(e.target.value));
byId('cmdk-input').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); cmdkMove(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); cmdkMove(-1); }
  else if (e.key === 'Enter') { e.preventDefault(); cmdkRun(); }
});
byId('cmdk').addEventListener('click', (e) => { if (e.target.id === 'cmdk') cmdkClose(); });
// ⌘K / Ctrl-K toggles the palette from anywhere (except while typing in the term)
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    cmdkIsOpen() ? cmdkClose() : cmdkOpen();
  }
});

// Overview → Findings drill-down: clicking a hotspot row or a latest finding
// filters the Findings tab by that host. Delegated so it survives the periodic
// re-render of the overview panels.
byId('tab-overview').addEventListener('click', (e) => {
  const el = e.target.closest('[data-ov-host]');
  if (!el) return;
  let host = el.getAttribute('data-ov-host') || '';
  if (host === '(no host)') host = '';
  Object.assign(findingsState, { host, severity: '', status: '', q: '', detailOpen: null });
  switchTab('findings');
});
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-action]');
  if (a && a.dataset.action === 'job-close') closeJobModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    // order: command palette → detail drawer → terminal fullscreen → job modal
    if (cmdkIsOpen()) { cmdkClose(); return; }
    if (drawerOpen()) { closeDrawer(); return; }
    // exit terminal fullscreen (Esc in the terminal textarea is handled by its
    // own attachCustomKeyEventHandler), then the job modal
    if (activeTab === 'freebuff') {
      const stage = byId('term-stage-' + activeTab);
      if (stage && stage.classList.contains('max')) { fbToggleMax(activeTab); return; }
    }
    if (!byId('job-modal').classList.contains('hidden')) closeJobModal();
  }
});

// ── embedded TUI terminal tab (Freebuff): xterm.js over server PTY
// Generic multi-session client. Each tab maps to a server-side direct-PTY
// session (TERM_DEFS in gui-server.js). Keystrokes go raw into that session's
// PTY; output streams back over SSE with a byte-exact replay on (re)connect.
const TERM_TAB_DEFS = {
  freebuff: { label: 'Freebuff', cmdPlaceholder: 'freebuff', startLabel: '▶ Start Freebuff', stopConfirm: "Stop della sessione Freebuff? Il processo verrà terminato." },
};
const TERM_TABS = new Map();
function termState(t) {
  let st = TERM_TABS.get(t);
  if (!st) {
    st = { built: false, term: null, fit: null, evt: null, reconnectT: null, backoff: 1000, lastCols: 0, lastRows: 0, resizeObs: null };
    TERM_TABS.set(t, st);
  }
  return st;
}

const fbEnc = new TextEncoder();

function fbB64FromBytes(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function fbBytesFromB64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function renderTermTab(tab) {
  const def = TERM_TAB_DEFS[tab];
  const st = termState(tab);
  if (!st.built) {
    st.built = true;
    byId('tab-' + tab).innerHTML =
      '<div class="term-banner">Real interactive <b>' + def.label + '</b> terminal. The session lives in the server ' +
      '(survives browser reloads) and streams here through a live pseudo-terminal — full colour, arrow-key ' +
      'navigation and the model picker all work. <b>Click the terminal and type.</b></div>' +
      '<div id="term-toolbar-' + tab + '">' +
        '<span class="status" id="term-status-' + tab + '"><span class="status-dot off"></span> <span id="term-status-txt-' + tab + '">checking…</span></span>' +
        '<button class="btn btn-primary" id="term-start-' + tab + '">' + def.startLabel + '</button>' +
        '<button class="btn btn-danger" id="term-stop-' + tab + '">■ Stop</button>' +
        '<button class="btn" id="term-max-' + tab + '" aria-expanded="false" aria-controls="term-stage-' + tab + '" title="schermo intero (F11 / Esc per uscire) — trascina il bordo inferiore per ridimensionare">⛶ Fullscreen</button>' +
        '<input type="text" id="term-cmd-' + tab + '" value="' + def.cmdPlaceholder + '" spellcheck="false" title="command to run in the session (empty = harness default)">' +
      '</div>' +
      '<div id="term-stage-' + tab + '">' +
        '<i class="term-grip grip-b" data-dir="b" aria-hidden="true" title="trascina per ridimensionare (doppio clic = reset)"></i>' +
        '<i class="term-grip grip-l" data-dir="l" aria-hidden="true" title="trascina per ridimensionare in larghezza"></i>' +
        '<i class="term-grip grip-r" data-dir="r" aria-hidden="true" title="trascina per ridimensionare in larghezza"></i>' +
        '<i class="term-grip grip-bl" data-dir="bl" aria-hidden="true"></i>' +
        '<i class="term-grip grip-br" data-dir="br" aria-hidden="true"></i>' +
        '<div id="term-xterm-' + tab + '"></div></div>';

    // create the Terminal FIRST — the handlers below attach to it
    st.term = new Terminal({
      cols: 120, rows: 32, scrollback: 5000, cursorBlink: true, allowProposedApi: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "DejaVu Sans Mono", monospace',
      fontSize: 13,
      theme: { background: '#0b0f14', foreground: '#d7e0ea', cursor: '#7fd1ff', selectionBackground: '#274156' },
    });
    st.fit = new FitAddon.FitAddon();
    st.term.loadAddon(st.fit);
    st.term.open(byId('term-xterm-' + tab));

    byId('term-start-' + tab).addEventListener('click', () => fbStart(tab));
    byId('term-stop-' + tab).addEventListener('click', () => fbStop(tab));
    byId('term-cmd-' + tab).addEventListener('keydown', (e) => { if (e.key === 'Enter') fbStart(tab); });
    byId('term-max-' + tab).addEventListener('click', () => fbToggleMax(tab));
    st.term.attachCustomKeyEventHandler((ev) => {
      if (ev.type === 'keydown' && ev.key === 'F11' && !ev.altKey && !ev.ctrlKey && !ev.metaKey) { fbToggleMax(tab); return false; }
      return true;
    });
    st.term.onResize(({ cols, rows }) => {
      if (cols < 4 || rows < 4) return; // degenerate fit (hidden stage) — ignore
      st.lastCols = cols; st.lastRows = rows;
      fbPost('/api/term/resize', { name: tab, cols, rows });
    });
    fbMakeResizable(tab);

    // keystrokes → this session's server PTY (raw UTF-8 bytes)
    st.term.onData((d) => {
      fbPost('/api/term/input', { name: tab, data: fbB64FromBytes(fbEnc.encode(d)) });
    });
    st.term.onBinary((d) => {
      const bytes = new Uint8Array(d.length);
      for (let i = 0; i < d.length; i++) bytes[i] = d.charCodeAt(i) & 255;
      fbPost('/api/term/input', { name: tab, data: fbB64FromBytes(bytes) });
    });
    // click anywhere on the stage gives focus to the hidden xterm textarea
    byId('term-stage-' + tab).addEventListener('click', () => { if (st.term) st.term.focus(); });

    if (window.ResizeObserver) {
      st.resizeObs = new ResizeObserver(() => fbDebouncedFit(tab));
      st.resizeObs.observe(byId('term-stage-' + tab));
    } else {
      window.addEventListener('resize', () => fbDebouncedFit(tab));
    }
  }
  // entering / re-entering the tab: fit to current size, then sync state
  setTimeout(() => { fbFitSafe(tab); fbSyncStatus(tab); }, 30);
}

function renderFreebuffTab() { renderTermTab('freebuff'); }

const fbFitT = new Map();
function fbDebouncedFit(tab) {
  if (activeTab !== tab) return;
  clearTimeout(fbFitT.get(tab));
  fbFitT.set(tab, setTimeout(() => fbFitSafe(tab), 120));
}
function fbFitSafe(tab) {
  const st = termState(tab);
  if (!st.fit || !st.term || activeTab !== tab) return;
  const stage = byId('term-stage-' + tab);
  if (!stage || !stage.clientWidth || stage.clientHeight < 80) return; // hidden or collapsed — don't shrink the PTY
  try { st.fit.fit(); } catch { /* not measurable yet */ }
  if (st.term.cols !== st.lastCols || st.term.rows !== st.lastRows) {
    st.lastCols = st.term.cols; st.lastRows = st.term.rows;
    fbPost('/api/term/resize', { name: tab, cols: st.term.cols, rows: st.term.rows });
  }
}

function fbToggleMax(tab) {
  const st = termState(tab);
  const stage = byId('term-stage-' + tab);
  const btn = byId('term-max-' + tab);
  if (!stage || !btn) return;
  const on = !stage.classList.contains('max');
  stage.classList.toggle('max', on);
  btn.textContent = on ? '⛶ Fullscreen ✕' : '⛶ Fullscreen';
  btn.setAttribute('aria-expanded', on ? 'true' : 'false');
  stage.classList.add('anim');
  setTimeout(() => stage.classList.remove('anim'), 240);
  if (!on && stH[tab]) { stage.style.height = stH[tab] + 'px'; } // restore the user height after fullscreen
  setTimeout(() => { fbFitSafe(tab); if (st.term) st.term.focus(); }, 60);
}

// drag-to-resize: bottom edge (vertical), left/right edges (width) and both
// bottom corners (diagonal). Double-click on a grip snaps back to the default.
// Listeners live on DOCUMENT during the drag so the gesture survives even if
// the pointer races off the grip (setPointerCapture not needed).
const stH = {};
const stW = {};
function fbClampH(h) { return Math.min(Math.max(h, 180), window.innerHeight - 140); }
function fbClampW(w) {
  const pane = byId('tab-' + (activeTab || 'freebuff'));
  const maxW = (pane ? pane.clientWidth : window.innerWidth) - 30;
  return Math.min(Math.max(w, 420), Math.max(maxW, 420));
}
function fbMakeResizable(tab) {
  const stage = byId('term-stage-' + tab);
  if (!stage) return;
  stage.querySelectorAll('.term-grip').forEach((grip) => {
    const dir = grip.dataset.dir || 'b';
    if (dir === 'b' || dir === 'bl' || dir === 'br') {
      grip.addEventListener('dblclick', () => {
        stage.style.height = '';
        delete stH[tab];
        fbFitSafe(tab);
      });
    }
    if (dir === 'l' || dir === 'r' || dir === 'bl' || dir === 'br') {
      grip.addEventListener('dblclick', () => {
        stage.style.width = '';
        delete stW[tab];
        fbFitSafe(tab);
      });
    }
    grip.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      if (!byId('term-stage-' + tab)) return;
      const x0 = e.clientX, y0 = e.clientY;
      const h0 = stage.getBoundingClientRect().height;
      const w0 = stage.getBoundingClientRect().width;
      const b = dir.includes('b'), l = dir.includes('l'), r = dir.includes('r');
      document.body.classList.add('term-resizing');
      document.body.dataset.resizing = dir;
      const onMove = (ev) => {
        if (b) {
          const h = fbClampH(h0 + ev.clientY - y0);
          stH[tab] = h;
          stage.style.height = h + 'px';
        }
        if (l || r) {
          const w = fbClampW(r ? w0 + (ev.clientX - x0) : w0 - (ev.clientX - x0));
          stW[tab] = w;
          stage.style.width = w + 'px';
        }
      };
      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('pointercancel', onUp);
        document.body.classList.remove('term-resizing');
        delete document.body.dataset.resizing;
        fbFitSafe(tab); // fires the PTY resize for the final size
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', onUp);
    });
  });
}

function fbSetStatus(tab, running, text) {
  const dot = document.querySelector('#term-status-' + tab + ' .status-dot');
  if (dot) dot.className = 'status-dot ' + (running ? 'on' : 'off');
  const t = byId('term-status-txt-' + tab);
  if (t) t.textContent = text;
}

function fbPost(pathUrl, body) {
  return api(pathUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .catch(() => { /* transient — the status poll surfaces real errors */ });
}

async function fbSyncStatus(tab) {
  const def = TERM_TAB_DEFS[tab];
  const st = termState(tab);
  let s;
  try { s = await api('/api/term/status?name=' + encodeURIComponent(tab)); }
  catch { fbSetStatus(tab, false, 'GUI offline?'); return; }
  if (!s.available) { fbSetStatus(tab, false, s.reason || 'ambiente non disponibile'); fbDisconnect(tab); return; }
  if (s.running) {
    fbSetStatus(tab, true, def.label + ' attivo · ' + (s.viewers || 1) + ' viewer' + (s.cmd ? ' · ' + s.cmd : ''));
    fbConnect(tab);
  } else {
    fbSetStatus(tab, false, 'fermo — premi ▶ Start');
    fbDisconnect(tab);
  }
}

function fbConnect(tab) {
  const st = termState(tab);
  if (st.evt || !st.term) return;
  fbFitSafe(tab);
  const es = new EventSource(withToken('/api/term/stream?name=' + encodeURIComponent(tab)));
  st.evt = es;
  es.onopen = () => { st.backoff = 1000; };
  // the server replays the screen history on connect: wipe local state so the
  // replay paints a clean replica instead of stacking on stale content
  es.addEventListener('id', () => { try { st.term.reset(); } catch { /* ignore */ } st.term.focus(); });
  es.onmessage = (e) => { if (e.data) st.term.write(fbBytesFromB64(e.data)); };
  es.addEventListener('end', () => { fbDisconnect(tab); setTimeout(() => fbSyncStatus(tab), 300); });
  es.onerror = () => {
    fbDisconnect(tab);
    clearTimeout(st.reconnectT);
    st.reconnectT = setTimeout(() => fbSyncStatus(tab), st.backoff);
    st.backoff = Math.min(st.backoff * 2, 5000);
  };
}

function fbDisconnect(tab) {
  const st = termState(tab);
  clearTimeout(st.reconnectT);
  if (st.evt) { try { st.evt.close(); } catch { /* ignore */ } st.evt = null; }
}

async function fbStart(tab) {
  const st = termState(tab);
  const def = TERM_TAB_DEFS[tab];
  const cmdEl = byId('term-cmd-' + tab);
  const cmd = ((cmdEl && cmdEl.value) || '').trim();
  fbFitSafe(tab);
  try {
    fbSetStatus(tab, false, 'avvio…');
    await api('/api/term/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: tab, cmd, cols: st.term ? st.term.cols : undefined, rows: st.term ? st.term.rows : undefined }) });
    toast(def.label + ' avviato', 'ok');
    setTimeout(() => fbSyncStatus(tab), 300);
  } catch (e) { toast(String(e.message || e), 'err'); fbSyncStatus(tab); }
}

async function fbStop(tab) {
  const def = TERM_TAB_DEFS[tab];
  if (!confirm(def.stopConfirm)) return;
  fbDisconnect(tab);
  try {
    await api('/api/term/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: tab }) });
    fbSetStatus(tab, false, 'fermo — premi ▶ Start');
    const st = termState(tab);
    if (st.term) st.term.clear();
    toast('Sessione terminata', 'ok');
  } catch (e) { toast(String(e.message || e), 'err'); }
}

setInterval(() => {
  if (document.hidden) return;
  if (activeTab === 'overview' || activeTab === 'pipeline' || activeTab === 'sessions') renderTab(activeTab);
}, 15000);

// Terminal tabs: light status poll keeps the start/stop state honest
// (reconnects are event-driven; this only fixes label drift + dead streams).
setInterval(() => {
  if (document.hidden) return;
  if (activeTab !== 'freebuff') return;
  const st = termState(activeTab);
  if (!st.term) return;
  api('/api/term/status?name=' + encodeURIComponent(activeTab)).then((s) => {
    if (s.running && !st.evt) fbConnect(activeTab);
    else if (!s.running && st.evt) fbSyncStatus(activeTab);
  }).catch(() => {});
}, 5000);

refreshBadges();
