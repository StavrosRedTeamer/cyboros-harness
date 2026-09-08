/* Stavros Console — frontend (vanilla, no deps) */
'use strict';

const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const byId = (id) => document.getElementById(id);

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const fmtBytes = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n > 1024 ? Math.round(n / 1024) + ' KB' : n + ' B');
const fmtTs = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
const shortTs = (iso) => (iso ? new Date(iso).toLocaleDateString() + ' ' + new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—');

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
  const res = await fetch(path, opts);
  let body = null;
  try { body = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new Error((body && body.error) || ('HTTP ' + res.status));
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

// dataTable({ columns, rows, onRow, empty, sticky })
//   columns: [{ key, label, cell(row,i), num, thClass, tdClass }]
//     cell may return a Node, an {html} object, or a primitive (rendered as text)
//   onRow(row, tr, i) — attaches a click handler + .clickable to each row
// Returns a .table-wrap div (owns horizontal overflow) around the <table>.
function dataTable(spec) {
  const cols = spec.columns || [];
  const thead = el('thead', null, el('tr', null,
    cols.map((c) => el('th', { class: [c.num ? 'num' : '', c.thClass || ''].filter(Boolean).join(' ') || null }, c.label))));
  const body = el('tbody');
  const rows = spec.rows || [];
  if (!rows.length) {
    body.appendChild(el('tr', null, el('td', { colspan: cols.length || 1, class: 'muted' }, spec.empty || '—')));
  } else rows.forEach((row, i) => {
    const tr = el('tr', spec.onRow ? { class: 'clickable' } : null, cols.map((c) =>
      el('td', { class: [c.num ? 'num' : '', c.tdClass || ''].filter(Boolean).join(' ') || null },
        cellContent(c.cell ? c.cell(row, i) : row[c.key]))));
    if (spec.onRow) tr.addEventListener('click', () => spec.onRow(row, tr, i));
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
  return el('span', { class: 'sparkline', title: o.title || '', html:
    '<svg viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '" preserveAspectRatio="none" aria-hidden="true">' +
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
function renderOverview(o) {
  const pane = byId('tab-overview');
  const f = o.findings;
  const bySev = f.bySeverity || {};
  const sevTotal = Object.values(bySev).reduce((a, b) => a + b, 0) || 0;
  const sevBars = ['Critical', 'High', 'Medium', 'Low', 'Info'].map((s) => {
    const n = bySev[s] || 0;
    return n ? '<div class="' + (SEV_BAR[s] || 's-info') + '" style="width:' + (sevTotal ? (n / sevTotal) * 100 : 0) + '%" title="' + s + ': ' + n + '"></div>' : '';
  }).join('');
  const sevChips = ['Critical', 'High', 'Medium', 'Low', 'Info'].map((s) =>
    '<span class="chip ' + (SEV_CHIP[s] || '') + '">' + s + ' ' + (bySev[s] || 0) + '</span>').join('');
  // proof-level split — the operator-critical signal (proven vs claimed vs weak)
  const proof = { proven: 0, confirmed: 0, weak: 0 };
  Object.keys(f.byStatus || {}).forEach((st) => { proof[proofLevel(st)] += f.byStatus[st]; });
  const openReport = (r) => '<li><span class="dot done" style="background:var(--cyan);box-shadow:var(--glow-cyan)"></span>' +
    '<a href="/reports/' + encodeURIComponent(r.name) + '" target="_blank" rel="noopener" class="mono">' + esc(r.name) + '</a>' +
    '<span class="faint" style="margin-left:auto">' + shortTs(r.mtime) + ' · ' + fmtBytes(r.size) + '</span></li>';

  pane.innerHTML =
    '<div class="grid cols-2">' +
      '<div class="card' + ((bySev.Critical || 0) > 0 ? ' keel-crit' : '') + '"><h2>Findings triage</h2>' +
        '<div class="row" style="align-items:baseline;gap:16px">' +
          '<div><div class="kpi">' + f.total + '</div><div class="kpi-label">total findings</div></div>' +
          '<div style="flex:1;min-width:180px">' +
            '<div class="sevbar">' + sevBars + '</div>' +
            '<div class="row" style="gap:6px">' + sevChips + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="row" style="margin-top:14px;gap:18px">' +
          '<span class="verify v-proven">' + proof.proven + ' proven</span>' +
          '<span class="verify v-confirmed">' + proof.confirmed + ' confirmed</span>' +
          '<span class="verify v-weak">' + proof.weak + ' suspected</span>' +
        '</div>' +
        '<div class="kpi-label" style="margin-top:14px">recurring weakness classes</div>' +
        '<div id="ov-classes" class="row" style="gap:6px;margin-top:6px"><span class="faint">loading…</span></div>' +
      '</div>' +
      '<div class="card"><h2>Hotspots — targets by risk</h2>' +
        '<div id="ov-hotspots"><div class="faint">loading…</div></div>' +
      '</div>' +
    '</div>' +
    '<div class="grid cols-2" style="margin-top:14px">' +
      '<div class="card"><h2>Latest findings</h2>' +
        '<div id="ov-latest"><div class="faint">loading…</div></div>' +
      '</div>' +
      '<div class="card"><h2>Recent reports</h2>' +
        (o.reportsRecent && o.reportsRecent.length
          ? '<ul class="list-plain">' + o.reportsRecent.map(openReport).join('') + '</ul>'
          : '<div class="faint">no HTML reports yet — generate one from the Reports tab.</div>') +
      '</div>' +
    '</div>';

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
// page/pageSize drive client-side pagination over the already-filtered rows the
// server returns; pageSize 0 means "show all". focusIdx restores keyboard focus
// to a row after the pane is re-rendered (expand/collapse rebuilds innerHTML).
const findingsState = { host: '', severity: '', status: '', q: '', rows: [], detailOpen: null, page: 1, pageSize: 50, focusIdx: null };

function renderFindings(data) {
  findingsState.rows = data.rows || [];
  const pane = byId('tab-findings');
  const sevCounts = ['Critical', 'High', 'Medium', 'Low', 'Info'].map((s) => {
    const n = (data.bySeverity || {})[s] || 0;
    return n ? '<span class="chip ' + (SEV_CHIP[s] || '') + '">' + s + ': ' + n + '</span>' : '';
  }).filter(Boolean).join('');
  const hostOpts = (data.hosts || []).map((h) => '<option value="' + esc(h) + '"' + (h === findingsState.host ? ' selected' : '') + '>' + esc(h) + '</option>').join('');

  const total = findingsState.rows.length;
  const pageSize = findingsState.pageSize > 0 ? findingsState.pageSize : (total || 1);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  findingsState.page = Math.min(Math.max(1, findingsState.page), pageCount);
  const start = (findingsState.page - 1) * pageSize;
  const end = start + pageSize;

  const rows = findingsState.rows.map((f, i) => {
    if (i < start || i >= end) return ''; // outside the current page — i stays the absolute row index
    const cwes = Array.isArray(f.cwe) ? f.cwe : (f.cwe ? [f.cwe] : []);
    const confLabel = f.confidence ? f.confidence.label : '';
    const conf = f.confidence
      ? '<span class="conf ' + esc(confLabel) + '">' + f.confidence.score.toFixed(2) + '</span> <span class="faint">' + esc(confLabel) + '</span>'
      : '<span class="faint">—</span>';
    const cvss = f.cvss != null
      ? '<span class="cvss g-' + cvssGrade(Number(f.cvss)) + '">' + Number(f.cvss).toFixed(1) + '</span>'
      : '<span class="cvss g-none">—</span>';
    const status = f.status
      ? '<span class="verify v-' + proofLevel(f.status) + '">' + esc(f.status) + '</span>'
      : '<span class="faint">—</span>';
    const open = findingsState.detailOpen === i;
    const row =
      '<tr class="clickable sev-row ' + (SEV_ROW[f.severity] || 's-info') + '" data-idx="' + i + '"' +
      ' role="button" tabindex="0" aria-expanded="' + (open ? 'true' : 'false') + '"' +
      ' aria-label="' + esc((open ? 'Comprimi dettaglio' : 'Espandi dettaglio') + ': ' + (f.title || 'finding')) + '">' +
      '<td><span class="chip ' + (SEV_CHIP[f.severity] || '') + '">' + esc(f.severity || '—') + '</span></td>' +
      '<td>' + esc(f.title || '') + '</td>' +
      '<td class="mono" style="font-size:12px">' + esc(f.host || '') + '</td>' +
      '<td class="endpoint">' + epBreak(f.endpoint || '') + '</td>' +
      '<td>' + cwes.map((c) => '<span class="chip">' + esc(c) + '</span>').join(' ') + '</td>' +
      '<td class="num">' + cvss + '</td>' +
      '<td>' + conf + '</td>' +
      '<td>' + status + '</td>' +
      '<td class="faint mono" style="font-size:11px">' + shortTs(f.ts) + '</td>' +
      '</tr>';
    const detail = findingsState.detailOpen === i ? detailRow(f, i) : '';
    return row + detail;
  }).join('');

  const pagerInfo = total === 0
    ? '0 risultati'
    : 'Pagina ' + findingsState.page + ' / ' + pageCount + ' · ' + (start + 1) + '–' + Math.min(end, total) + ' di ' + total;
  const sizeOpts = [25, 50, 100].map((n) => '<option value="' + n + '"' + (findingsState.pageSize === n ? ' selected' : '') + '>' + n + '</option>').join('') +
    '<option value="0"' + (findingsState.pageSize === 0 ? ' selected' : '') + '>Tutti</option>';
  const pager =
    '<div class="pager">' +
      '<button class="btn btn-sm" id="f-prev"' + (findingsState.page <= 1 ? ' disabled' : '') + ' aria-label="Pagina precedente">‹ Prev</button>' +
      '<span class="pager-info" aria-live="polite">' + pagerInfo + '</span>' +
      '<button class="btn btn-sm" id="f-next"' + (findingsState.page >= pageCount ? ' disabled' : '') + ' aria-label="Pagina successiva">Next ›</button>' +
      '<label class="pager-size">per pagina <select id="f-size">' + sizeOpts + '</select></label>' +
    '</div>';

  pane.innerHTML =
    '<div class="filters">' +
      '<div class="f wide"><input type="search" id="f-q" placeholder="search title / endpoint / host / cwe…" value="' + esc(findingsState.q) + '"></div>' +
      '<div class="f"><select id="f-sev">' + '<option value="">all severities</option>' + ['Critical', 'High', 'Medium', 'Low', 'Info'].map((s) => '<option' + (s === findingsState.severity ? ' selected' : '') + '>' + s + '</option>').join('') + '</select></div>' +
      '<div class="f"><select id="f-status">' + '<option value="">all statuses</option>' + Object.keys(data.byStatus || {}).map((s) => '<option' + (s === findingsState.status ? ' selected' : '') + '>' + esc(s) + '</option>').join('') + '</select></div>' +
      '<div class="f"><select id="f-host">' + '<option value="">all hosts</option>' + hostOpts + '</select></div>' +
      '<div class="f" style="flex:0 0 auto"><button class="btn" id="f-reset">reset</button></div>' +
    '</div>' +
    '<div class="card" style="margin-bottom:12px"><div class="row" style="align-items:center;gap:8px"><span class="chip">' + data.total + ' findings</span>' + sevCounts + '</div></div>' +
    '<div class="card" style="padding:0;overflow-x:auto"><table><thead><tr>' +
      '<th>Severity</th><th>Title</th><th>Host</th><th>Endpoint</th><th>CWE</th><th>CVSS</th><th>Conf</th><th>Status</th><th>Detected</th>' +
      '</tr></thead><tbody>' + (rows || '<tr><td colspan="9" class="muted">no findings match</td></tr>') + '</tbody></table></div>' +
    pager;

  byId('f-q').addEventListener('input', debounce(() => { findingsState.q = byId('f-q').value.trim(); fetchFindings(); }, 350));
  byId('f-sev').addEventListener('change', (e) => { findingsState.severity = e.target.value; fetchFindings(); });
  byId('f-status').addEventListener('change', (e) => { findingsState.status = e.target.value; fetchFindings(); });
  byId('f-host').addEventListener('change', (e) => { findingsState.host = e.target.value; fetchFindings(); });
  byId('f-reset').addEventListener('click', () => {
    Object.assign(findingsState, { host: '', severity: '', status: '', q: '', detailOpen: null });
    fetchFindings();
  });
  byId('f-prev').addEventListener('click', () => { findingsState.page--; renderFindings(findingsState.lastData); });
  byId('f-next').addEventListener('click', () => { findingsState.page++; renderFindings(findingsState.lastData); });
  byId('f-size').addEventListener('change', (e) => {
    findingsState.pageSize = parseInt(e.target.value, 10) || 0;
    findingsState.page = 1;
    renderFindings(findingsState.lastData);
  });

  $$('#tab-findings tbody tr.clickable').forEach((tr) => {
    const toggle = () => {
      const i = parseInt(tr.dataset.idx, 10);
      findingsState.detailOpen = findingsState.detailOpen === i ? null : i;
      findingsState.focusIdx = i; // keep keyboard focus on this row across the re-render
      renderFindings(findingsState.lastData);
    };
    tr.addEventListener('click', toggle);
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); toggle(); }
    });
  });

  if (findingsState.focusIdx != null) {
    const t = $('#tab-findings tbody tr[data-idx="' + findingsState.focusIdx + '"]');
    findingsState.focusIdx = null;
    if (t) t.focus();
  }
}

function detailRow(f, i) {
  const fields = [
    ['Class', f.class], ['Verify level', f.verify_level], ['CVE', f.cve || (f.cves ? f.cves.join(', ') : '')],
    ['EPSS', f.epss != null ? (Number(f.epss) * 100).toFixed(1) + '%' : ''],
    ['Impact', f.impact], ['PoC', f.poc], ['Remediation', f.remediation],
    ['Oracle', f.oracle ? (f.oracle.type || '') + (f.oracle.ref ? ' · ' + f.oracle.ref : '') : ''],
  ].filter(([, v]) => v != null && v !== '');
  return '<tr class="detail-row"><td colspan="9"><div class="detail" data-idx="' + i + '">' +
    fields.map(([k, v]) => '<h4>' + esc(k) + '</h4><p>' + esc(v) + '</p>').join('') +
    '</div></td></tr>';
}

function fetchFindings() {
  findingsState.page = 1; // a new filtered result set always starts on page 1
  const p = new URLSearchParams();
  if (findingsState.host) p.set('host', findingsState.host);
  if (findingsState.severity) p.set('severity', findingsState.severity);
  if (findingsState.status) p.set('status', findingsState.status);
  if (findingsState.q) p.set('q', findingsState.q);
  api('/api/findings?' + p.toString()).then((d) => { findingsState.lastData = d; renderFindings(d); }).catch((e) => toast(String(e.message || e), 'err'));
}

// ── Pipeline ────────────────────────────────────────────────────────────────
function renderPipeline(data) {
  const pane = byId('tab-pipeline');
  const lastRun = data.lastRun;
  const phases = data.phases || [];
  const phaseChips = phases.map((p) => '<span class="phase"><span class="dot ' + esc(p.status) + '"></span>' + esc(p.name) + '</span>').join('');
  const doneN = phases.filter((p) => p.status === 'done').length;
  const targetsRows = (data.targets || []).map((t) =>
    '<tr><td class="mono">' + esc(t.host) + '</td><td>' + t.hosts + '</td><td>' + t.ports + '</td><td>' + t.endpoints + '</td><td class="muted">' + shortTs(t.last_seen) + '</td></tr>').join('');

  const resumeBtn = data.resumePossible
    ? '<button class="btn btn-primary" id="btn-resume">▶ Resume incomplete run</button>'
    : '<button class="btn" id="btn-resume" disabled title="no genuinely incomplete phase to resume (a done scan-only run is not incomplete)">▶ Resume (nothing to resume)</button>';

  const unclosedHint = (data.unclosed && lastRun)
    ? '<div class="hint" style="color:var(--yellow);margin:4px 0 8px">⚠ run finished its phases but was never closed — mark it done or remove it</div>'
    : '';
  const lastRunCtl = (lastRun && lastRun.status !== 'done')
    ? '<button class="btn btn-sm" id="btn-close-last" title="mark run #' + lastRun.id + ' as done">✓ mark done</button>' +
      '<button class="btn btn-sm" id="btn-remove-last" title="delete run #' + lastRun.id + ' + its phases" style="margin-left:6px">✕ remove run</button>'
    : '';

  const runsRows = (data.runs || []).map((r) =>
    '<tr>' +
      '<td class="mono muted">#' + r.id + '</td>' +
      '<td>' + esc(r.command || '') + '</td>' +
      '<td class="mono">' + esc(r.target || '') + '</td>' +
      '<td><span class="dot ' + esc(r.status) + '"></span> ' + esc(r.status) + '</td>' +
      '<td class="muted">' + shortTs(r.started_at) + '</td>' +
      '<td>' +
        (r.status !== 'done' ? '<button class="btn btn-sm" data-run-act="close" data-run="' + r.id + '" title="mark run #' + r.id + ' as done">✓</button> ' : '') +
        '<button class="btn btn-sm" data-run-act="remove" data-run="' + r.id + '" title="delete run #' + r.id + ' + its phases">✕</button>' +
      '</td>' +
    '</tr>').join('');

  pane.innerHTML =
    (!data.db
      ? '<div class="card"><h2>Pipeline</h2><div class="muted">no <span class="mono">reports/state.db</span> yet — run <code>node tools/stavros.js recon &lt;host&gt;</code> first.</div></div>'
      :
      '<div class="grid cols-2">' +
        '<div class="card"><h2>Last run' + (lastRun ? ' #' + lastRun.id : '') + '</h2>' +
          (lastRun
            ? '<div class="row" style="align-items:center;gap:10px"><span class="chip">status: ' + esc(lastRun.status) + '</span><span class="mono muted">' + esc(lastRun.target || '') + '</span></div>' +
              '<div style="margin:10px 0">' + phaseChips + '</div>' +
              '<div class="kpi" style="font-size:16px">' + doneN + '/' + phases.length + ' phases done</div>' +
              '<div class="hint" style="margin-bottom:8px">' + esc(lastRun.command || '') + ' · started ' + shortTs(lastRun.started_at) + '</div>' +
              unclosedHint +
              resumeBtn +
              lastRunCtl +
              '<button class="btn" id="btn-reopen-log" style="margin-left:8px" title="last job log">log</button>'
            : '<div class="muted">no runs recorded yet</div>') +
        '</div>' +
        '<div class="card"><h2>Targets (' + (data.targets || []).length + ')</h2>' +
          '<table><thead><tr><th>Host</th><th>Hosts</th><th>Ports</th><th>Endpoints</th><th>Last seen</th></tr></thead>' +
          '<tbody>' + (targetsRows || '<tr><td colspan="5" class="muted">—</td></tr>') + '</tbody></table>' +
        '</div>' +
      '</div>' +
      '<div class="card" style="margin-top:12px"><h2>Recent runs</h2>' +
        '<table><thead><tr><th>#</th><th>Command</th><th>Target</th><th>Status</th><th>Started</th><th>Actions</th></tr></thead>' +
        '<tbody>' + (runsRows || '<tr><td colspan="6" class="muted">—</td></tr>') + '</tbody></table>' +
        '<div class="hint" style="margin-top:6px">✓ = close a stale run (status stuck at running), ✕ = delete run + phases (targets/ports data is kept).</div>' +
      '</div>');

  const rb = byId('btn-resume');
  if (rb && !rb.disabled) rb.addEventListener('click', () => startJob('resume', '/api/pipeline/resume', 'stavros.js resume'));
  const logBtn = byId('btn-reopen-log');
  if (logBtn) logBtn.addEventListener('click', () => toast('no persistent job log for past runs — new runs stream live here', ''));

  // re-render with fresh data after a run mutation
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
  const closeLast = byId('btn-close-last');
  if (closeLast) closeLast.addEventListener('click', () => runAction(lastRun.id, 'close'));
  const removeLast = byId('btn-remove-last');
  if (removeLast) removeLast.addEventListener('click', () => runAction(lastRun.id, 'remove'));
  $$('#tab-pipeline [data-run-act]').forEach((b) => {
    b.addEventListener('click', () => runAction(parseInt(b.dataset.run, 10), b.dataset.runAct));
  });
}

// ── Scope ───────────────────────────────────────────────────────────────────
let scopeData = null;
function renderScope(data) {
  scopeData = data;
  const pane = byId('tab-scope');
  const banner = data.failClosed
    ? '<div class="card" style="border-color:#7c2530;background:#2a1216"><b style="color:#ff5d6c">⚠ FAIL-CLOSED</b> — no hosts, prefixes or IPs allowed: scope-guard blocks everything until you add targets.</div>'
    : '<div class="card" style="border-color:#1e5c3d;background:#10251a"><b style="color:#3ddc84">✓ Scope active</b> — ' + data.allowed_hosts.length + ' host(s), ' + data.allowed_url_prefixes.length + ' prefix(es), ' + data.allowed_ips.length + ' IP/CIDR.</div>';
  pane.innerHTML = banner +
    '<div class="grid cols-2" style="margin-top:12px">' +
      '<div class="card"><h2>scope.json editor</h2>' +
        '<label for="sc-hosts">allowed_hosts (one per line — covers host + subdomains)</label>' +
        '<textarea id="sc-hosts">' + esc(data.allowed_hosts.join('\n')) + '</textarea>' +
        '<label for="sc-prefixes">allowed_url_prefixes (one per line, must end with /)</label>' +
        '<textarea id="sc-prefixes">' + esc(data.allowed_url_prefixes.join('\n')) + '</textarea>' +
        '<label for="sc-ips">allowed_ips / CIDR (internal, SSRF, lab)</label>' +
        '<textarea id="sc-ips">' + esc(data.allowed_ips.join('\n')) + '</textarea>' +
        '<label for="sc-rps">max_requests_per_second (global pacing)</label>' +
        '<input type="number" id="sc-rps" min="1" max="600" value="' + esc(data.max_requests_per_second) + '">' +
        '<div class="row" style="margin-top:14px;align-items:center">' +
          '<button class="btn btn-primary" id="sc-save">💾 Save scope.json</button>' +
          '<span id="sc-save-hint" class="hint"></span>' +
        '</div>' +
        '<div class="hint" style="margin-top:8px">Host/IP/CIDR entries are validated server-side before writing. The runtime truth stays <span class="mono">tools/scope-guard.js</span> — the GUI never bypasses it. Every save appends a timestamped note.</div>' +
      '</div>' +
      '<div class="stack">' +
        '<div class="card"><h2>Verify a URL against the guard</h2>' +
          '<input type="text" id="sc-url" placeholder="https://target.example/path?x=1">' +
          '<div class="row" style="margin-top:8px;align-items:center"><button class="btn" id="sc-check">Check scope</button><span id="sc-check-out" class="hint"></span></div>' +
        '</div>' +
        '<div class="card"><h2>Notes (history)</h2>' +
          '<pre style="max-height:220px;overflow:auto;font:11px/1.5 var(--mono);color:var(--muted);white-space:pre-wrap">' + esc(data.notes || '') + '</pre>' +
        '</div>' +
      '</div>' +
    '</div>';

  byId('sc-save').addEventListener('click', saveScope);
  byId('sc-check').addEventListener('click', checkScope);
  byId('sc-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') checkScope(); });
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
    else out.textContent = '✗ OUT OF SCOPE' + (r.reason ? ' — ' + r.reason : ''); out.className = 'hint err';
  } catch (e) { out.textContent = String(e.message || e); out.className = 'hint err'; }
}

// ── Sessions ────────────────────────────────────────────────────────────────
function renderSessions(data) {
  const pane = byId('tab-sessions');
  const rows = (data.rows || []).map((s) => {
    const metaBits = [];
    for (const k of ['payload', 'luri', 'port', 'opened']) if (s.meta[k] != null) metaBits.push(k + '=' + s.meta[k]);
    return '<tr>' +
      '<td class="mono">' + esc(s.id) + '</td>' +
      '<td><span class="chip">' + esc(s.status) + '</span></td>' +
      '<td class="mono">' + esc(s.host || '') + '</td>' +
      '<td style="font-size:12px">' + esc(s.obtained_via || '') + '</td>' +
      '<td>' + (s.artifacts.length ? s.artifacts.map((a) => esc(typeof a === 'string' ? a : JSON.stringify(a))).join('<br>') : '<span class="muted">none</span>') + '</td>' +
      '<td class="mono muted" style="font-size:11px">' + esc(metaBits.join(' · ')) + '</td>' +
      '</tr>';
  }).join('');
  pane.innerHTML =
    '<div class="grid cols-3">' +
      '<div class="card"><div class="kpi">' + data.active + '</div><div class="kpi-label">active sessions</div></div>' +
      '<div class="card"><div class="kpi">' + data.artifactsTotal + '</div><div class="kpi-label">artifacts (teardown)</div></div>' +
      '<div class="card"><div class="kpi" id="loot-count">…</div><div class="kpi-label">loot rows</div><div class="hint">contents never shown</div></div>' +
    '</div>' +
    '<div class="card" style="margin-top:12px;padding:0;overflow-x:auto"><table><thead><tr>' +
      '<th>Session</th><th>Status</th><th>Host</th><th>Obtained via</th><th>Artifacts</th><th>Meta</th>' +
      '</tr></thead><tbody>' + (rows || '<tr><td colspan="6" class="muted">no sessions in reports/sessions.json</td></tr>') + '</tbody></table></div>' +
    '<div class="hint" style="margin-top:8px">Teardown ledger — <span class="mono">stavros-cleanup</span> empties it at engagement end. GUI is read-only here: cleanup is a confirm-tier action run from the CLI.</div>';
  api('/api/loot/count').then((r) => { byId('loot-count').textContent = r.count; }).catch(() => { byId('loot-count').textContent = '—'; });
}

// ── Reports ─────────────────────────────────────────────────────────────────
function renderReports(data) {
  const pane = byId('tab-reports');
  const kinds = { report: 'report', finding: 'finding', overview: 'overview', doc: 'doc' };
  const rows = data.map((r) =>
    '<tr>' +
    '<td class="mono" style="font-size:12px">' + esc(r.name) + '</td>' +
    '<td><span class="chip">' + kinds[r.kind] + '</span></td>' +
    '<td class="muted">' + fmtBytes(r.size) + '</td>' +
    '<td class="muted">' + shortTs(r.mtime) + '</td>' +
    '<td>' + (r.kind === 'report' || /\.html$/.test(r.name)
      ? '<a class="btn btn-sm" href="/reports/' + encodeURIComponent(r.name) + '" target="_blank" rel="noopener">open ↗</a>'
      : '<span class="muted mono" style="font-size:11px">reports/' + esc(r.name) + '</span>') + '</td>' +
    '</tr>').join('');
  pane.innerHTML =
    '<div class="card" style="margin-bottom:12px">' +
      '<div class="row" style="align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">' +
        '<div><b>Standalone HTML report</b><div class="hint">consolidates findings.jsonl + state.db + attack chains via tools/report-html.js (severity · CVSS · CWE · EPSS · confidence)</div></div>' +
        '<button class="btn btn-primary" id="btn-gen-report">⚙ Generate report.html</button>' +
      '</div>' +
    '</div>' +
    '<div class="card" style="padding:0;overflow-x:auto"><table><thead><tr>' +
      '<th>File</th><th>Kind</th><th>Size</th><th>Modified</th><th></th>' +
      '</tr></thead><tbody>' + (rows || '<tr><td colspan="5" class="muted">reports/ is empty</td></tr>') + '</tbody></table></div>';
  byId('btn-gen-report').addEventListener('click', () => startJob('report-html', '/api/reports/generate', 'tools/report-html.js'));
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
  const es = new EventSource('/api/jobs/' + jobId + '/events');
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
    { kind: 'tab', label: 'Findings', run: () => switchTab('findings') },
    { kind: 'tab', label: 'Pipeline', run: () => switchTab('pipeline') },
    { kind: 'tab', label: 'Scope', run: () => switchTab('scope') },
    { kind: 'tab', label: 'Sessions', run: () => switchTab('sessions') },
    { kind: 'tab', label: 'Reports', run: () => switchTab('reports') },
    { kind: 'tab', label: 'Freebuff terminal', run: () => switchTab('freebuff') },
    { kind: 'action', label: 'Refresh current tab', run: () => renderTab(activeTab) },
    { kind: 'action', label: 'Resume incomplete pipeline run', run: cmdkResumePipeline },
    { kind: 'action', label: 'Generate report.html', run: () => startJob('report-html', '/api/reports/generate', 'tools/report-html.js') },
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
    if (d.resumePossible) startJob('resume', '/api/pipeline/resume', 'stavros.js resume');
    else toast('nothing to resume — no genuinely incomplete run', '');
  }).catch((e) => toast(String(e.message || e), 'err'));
}

// ── wiring ──────────────────────────────────────────────────────────────────
function debounce(fn, ms) {
  let t;
  return function () { clearTimeout(t); t = setTimeout(fn, ms); };
}

function renderTab(tab) {
  if (tab === 'overview') refreshBadges();
  else if (tab === 'findings') fetchFindings();
  else if (tab === 'pipeline') api('/api/pipeline').then(renderPipeline).catch((e) => toast(String(e.message || e), 'err'));
  else if (tab === 'scope') api('/api/scope').then(renderScope).catch((e) => toast(String(e.message || e), 'err'));
  else if (tab === 'sessions') api('/api/sessions').then(renderSessions).catch((e) => toast(String(e.message || e), 'err'));
  else if (tab === 'reports') api('/api/reports').then(renderReports).catch((e) => toast(String(e.message || e), 'err'));
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
  const es = new EventSource('/api/term/stream?name=' + encodeURIComponent(tab));
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
