/* Stavros Console — control views (Graph, Coverage, Config/Team/Arsenal/Knowledge/Radar/Doctor).
 * Zero-build sibling of views-engagement.js; declares functions only. */
'use strict';

// ── Graph · host exposure map ─────────────────────────────────────────────────
// WP6 data, redesigned. The unit here is the HOST, not the port: the previous node-link
// canvas drew every scanned port as an equal node and — with a projection that read
// `h.host`/`h.state` where the snapshot exposes `address`/`alive` — collapsed every host into
// one blank `host:undefined` dot, with endpoints and findings orphaned off canvas. The map now
// reads like a triage board: one card per host with the services it advertises, its per-state
// port counts, the web endpoints and the findings that belong to it, searchable and sortable,
// with the full port/endpoint/finding tables in a detail drawer. Endpoints are rendered as
// text, never as links: this console is read-only and must not fire requests at a target just
// because a tab was opened.
const CC_SEV_ORDER = ['critical', 'high', 'medium', 'low', 'info'];
const CC_SEV_TONE = { critical: 'crit', high: 'high', medium: 'med', low: 'low', info: 'info' };
const CC_SORT_LABEL = { risk: 'rischio', findings: 'finding', ports: 'porte aperte', address: 'host' };
const ccGraphView = { q: '', onlyFindings: false, sort: 'risk', showTopo: true };
let ccGraphFocus = null;   // host id under focus: the other bands dim
let ccGraphPath = null;    // selected finding { host, idx, label }: its chain stays lit

// Panels that need the whole grid row (wide tables, the drawer grids): cc-grid is an auto-fit
// grid, so a dense table in a 320px column would only ever scroll.
function ccWide(node) { node.style.gridColumn = '1 / -1'; return node; }

function ccSevChips(sev) {
  return CC_SEV_ORDER.filter((s) => (sev || {})[s]).map((s) => ccBadge(s + ' ' + sev[s], CC_SEV_TONE[s]));
}

function ccHostRow(k, kids) {
  return el('div', { class: 'cc-host-row' }, [el('span', { class: 'cc-host-k' }, k), el('span', { class: 'cc-host-v' }, kids)]);
}

// Search haystack: everything visible on the card, so one query reaches a port, a service, a
// URL or a template id without the operator picking a field first.
function ccHostHaystack(h) {
  return [
    h.address, h.hostname, h.os, ...(h.targets || []),
    ...(h.services || []).map((s) => s.name + ' ' + s.ports.join(' ')),
    ...(h.ports || []).map((p) => p.port + ' ' + (p.service || '')),
    ...(h.endpoints || []).map((e) => e.url),
    ...(h.vulns || []).map((v) => v.label + ' ' + (v.class || '') + ' ' + (v.cve || '')),
  ].filter(Boolean).join(' ').toLowerCase();
}

function ccStateTone(state) {
  const s = String(state || '').toLowerCase();
  if (s === 'open') return 'low';
  if (s.includes('filtered')) return 'warn';
  return 'info';
}

// ── topology: the relationship view (host → open services → findings) ─────────
// One horizontal band per host keeps the graph honest as it grows: a host's services and
// findings never interleave with another host's, so there are no crossings between clusters
// and the layout is deterministic — no physics, no dependency. Services are AGGREGATED
// (`http 80, 443, 8080, 8443` is one node, not four) and only open ports are drawn, which is
// the difference between this and the canvas that drew every scanned port as an equal node.
const CC_TOPO_ROW = 24, CC_TOPO_GAP = 16, CC_TOPO_PAD = 12;
const CC_TOPO_MAX = 8;        // hosts drawn before the canvas stops being readable
const CC_TOPO_FINDINGS = 8;   // findings drawn per band, worst first (the rest is "… +N")
const CC_TOPO = {
  hostX: 10, hostW: 186, hostH: 36,
  svcX: 258, svcW: 244, svcH: 20,
  findX: 550, labelW: 240,
  width: 806,
};

function ccTrunc(s, n) {
  const t = String(s == null ? '' : s);
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function ccPortFromUrl(url) {
  try {
    const u = new URL(String(url).includes('://') ? String(url) : 'http://' + url);
    if (u.port) return Number(u.port);
    return u.protocol === 'https:' ? 443 : 80;
  } catch { return null; }
}

// A host can carry dozens of findings (one real one had 28): draw the worst N and label the
// rest, but never hide the finding whose path is lit — the last slot is swapped for it.
function ccTopoFindings(host, path) {
  const all = host.vulns || [];
  const idxs = all.map((v, i) => i).slice(0, CC_TOPO_FINDINGS);
  const sel = path && path.host === host.id ? path.idx : -1;
  if (sel >= 0 && sel < all.length && !idxs.includes(sel)) idxs[idxs.length - 1] = sel;
  return { all, idxs, hidden: all.length - idxs.length };
}

function ccTopoGraph(hosts, focusId, path, onOpen, onPath) {
  const T = CC_TOPO;
  const pathHost = path ? path.host : null;
  const bands = [];
  let y = CC_TOPO_PAD;
  for (const host of hosts) {
    const svc = host.services || [];
    const sel = ccTopoFindings(host, path);
    const rows = Math.max(svc.length, sel.idxs.length + (sel.hidden ? 1 : 0), 1);
    const h = rows * CC_TOPO_ROW + CC_TOPO_GAP;
    bands.push({ host, svc, sel, rows, top: y, h });
    y += h;
  }
  const height = Math.max(80, y);

  const out = [];
  for (const b of bands) {
    const { host, svc, sel, rows, top } = b;
    const cy = top + (rows * CC_TOPO_ROW) / 2;
    const svcOff = ((rows - svc.length) * CC_TOPO_ROW) / 2;
    const svcPos = svc.map((s, i) => ({ s, y: top + CC_TOPO_ROW / 2 + svcOff + i * CC_TOPO_ROW }));

    // A finding hangs off the service that owns its URL port when the port is known, and off
    // the host otherwise; the order follows the anchor so the edges stay short and local.
    const anchors = sel.idxs.map((vi) => {
      const port = ccPortFromUrl(sel.all[vi].url);
      return port == null ? -1 : svc.findIndex((s) => s.ports.includes(port));
    });
    const order = sel.idxs.map((v, i) => i).sort((a, c) => {
      const ya = anchors[a] >= 0 ? svcPos[anchors[a]].y : cy;
      const yb = anchors[c] >= 0 ? svcPos[anchors[c]].y : cy;
      return ya - yb;
    });
    const drawn = sel.idxs.length + (sel.hidden ? 1 : 0);
    const findOff = ((rows - drawn) * CC_TOPO_ROW) / 2;
    const findPos = order.map((k, i) => ({ v: sel.all[sel.idxs[k]], anchor: anchors[k], vi: sel.idxs[k], y: top + CC_TOPO_ROW / 2 + findOff + i * CC_TOPO_ROW }));
    const hiddenY = sel.hidden ? top + CC_TOPO_ROW / 2 + findOff + order.length * CC_TOPO_ROW : null;

    // Selected finding: its chain (host → service → finding) stays lit while everything else in
    // the band fades, so "why is this host exposed" reads in one look instead of by eye.
    const inPath = pathHost === host.id;
    const pathIdx = inPath ? path.idx : -1;
    const pathPos = sel.idxs.indexOf(pathIdx);
    const pathAnchor = inPath && pathPos >= 0 ? anchors[pathPos] : -1;
    const eCls = (on) => (inPath ? (on ? ' on-path' : ' faded') : '');
    const dim = (focusId && focusId !== host.id) || (pathHost && pathHost !== host.id);

    const draw = [];
    svcPos.forEach((sp, si) => {
      draw.push('<path class="cc-edge' + eCls(si === pathAnchor) + '" d="M ' + (T.hostX + T.hostW) + ' ' + cy + ' C ' + (T.hostX + T.hostW + 34) + ' ' + cy + ', ' + (T.svcX - 34) + ' ' + sp.y + ', ' + T.svcX + ' ' + sp.y + '"/>');
    });
    for (const fp of findPos) {
      const a = fp.anchor >= 0 ? svcPos[fp.anchor] : null;
      const x1 = a ? T.svcX + T.svcW : T.hostX + T.hostW;
      const y1 = a ? a.y : cy;
      draw.push('<path class="cc-edge sev-' + esc(fp.v.severity) + eCls(fp.vi === pathIdx) + '" d="M ' + x1 + ' ' + y1 + ' C ' + (x1 + 30) + ' ' + y1 + ', ' + (T.findX - 30) + ' ' + fp.y + ', ' + T.findX + ' ' + fp.y + '"/>');
    }

    const hasSub = host.hostname && host.hostname !== host.address;
    draw.push(
      '<g class="cc-node cc-hostnode' + (inPath ? ' on-path' : '') + (host.port_counts.total ? '' : ' noports') + '" data-host="' + esc(host.id) + '" tabindex="0" role="button" aria-label="host ' + esc(host.address || '') + '">'
        + '<title>' + esc([host.address, host.hostname, host.os].filter(Boolean).join(' · ')) + ' — ' + svc.length + ' servizi aperti, ' + sel.all.length + ' finding</title>'
        + '<rect x="' + T.hostX + '" y="' + (cy - T.hostH / 2) + '" width="' + T.hostW + '" height="' + T.hostH + '" rx="3"/>'
        + '<text class="cc-hid" x="' + (T.hostX + 10) + '" y="' + (hasSub ? cy - 2 : cy + 4) + '">' + esc(ccTrunc(host.address || host.hostname || '?', 26)) + '</text>'
        + (hasSub ? '<text class="cc-hsub" x="' + (T.hostX + 10) + '" y="' + (cy + 12) + '">' + esc(ccTrunc(host.hostname, 30)) + '</text>' : '')
        + (host.sev.critical ? '<circle cx="' + (T.hostX + T.hostW - 12) + '" cy="' + (cy - 6) + '" r="3.5" fill="var(--crit)"/>' : '')
      + '</g>'
    );
    svcPos.forEach((sp, si) => {
      const ports = sp.s.ports.join(', ') + (sp.s.ports.length > 4 ? ' +' + (sp.s.ports.length - 4) : '');
      const room = Math.max(6, Math.floor((T.svcW - 24 - sp.s.name.length * 6.6) / 6.6));
      draw.push(
        '<g class="cc-node cc-svcnode' + eCls(si === pathAnchor) + '" data-host="' + esc(host.id) + '" tabindex="0" role="button" aria-label="servizio ' + esc(sp.s.name) + '">'
          + '<title>' + esc(sp.s.name + ': ' + sp.s.ports.join(', ') + (sp.s.versions.length ? ' · ' + sp.s.versions.join(', ') : '')) + '</title>'
          + '<rect x="' + T.svcX + '" y="' + (sp.y - T.svcH / 2) + '" width="' + T.svcW + '" height="' + T.svcH + '" rx="10"/>'
          + '<text class="cc-lbl" x="' + (T.svcX + 10) + '" y="' + (sp.y + 3.5) + '"><tspan class="cc-svcname">' + esc(ccTrunc(sp.s.name, 16)) + '</tspan><tspan class="cc-svcports" dx="8">' + esc(ccTrunc(ports, room)) + '</tspan></text>'
        + '</g>'
      );
    });
    for (const fp of findPos) {
      const on = fp.vi === pathIdx;
      draw.push(
        '<g class="cc-node cc-findnode' + eCls(on) + '" data-fhost="' + esc(host.id) + '" data-finding="' + fp.vi + '" tabindex="0" role="button" aria-pressed="' + (on ? 'true' : 'false') + '" aria-label="finding ' + esc(fp.v.label) + '">'
          + '<title>' + esc(fp.v.severity + ' · ' + fp.v.label + (fp.v.cve ? ' · ' + fp.v.cve : '')) + (on ? '' : ' — clic per accendere il percorso') + '</title>'
          + '<circle class="sev-' + esc(fp.v.severity) + '" cx="' + T.findX + '" cy="' + fp.y + '" r="5"/>'
          + '<text class="cc-lbl" x="' + (T.findX + 12) + '" y="' + (fp.y + 3.5) + '">' + esc(ccTrunc(fp.v.label, 32)) + '</text>'
        + '</g>'
      );
    }
    if (sel.hidden) {
      draw.push('<text class="cc-lbl cc-more" x="' + T.findX + '" y="' + (hiddenY + 3.5) + '">… +' + sel.hidden + ' finding (vedi dettagli)</text>');
    }
    out.push('<g class="cc-band' + (dim ? ' dim' : '') + (inPath ? ' path' : '') + '">' + draw.join('') + '</g>');
  }

  const svg = '<svg viewBox="0 0 ' + T.width + ' ' + height + '" width="' + T.width + '" height="' + height + '" role="img" aria-label="topologia: '
    + hosts.length + ' host, ' + hosts.reduce((n, h) => n + (h.services || []).length, 0) + ' servizi, '
    + hosts.reduce((n, h) => n + (h.vulns || []).length, 0) + ' finding">' + out.join('') + '</svg>';
  const wrap = el('div', { class: 'cc-topo' }, el('div', { html: svg }));
  const byId = new Map(hosts.map((h) => [h.id, h]));
  const on = (node, go) => {
    node.addEventListener('click', (e) => { e.stopPropagation(); go(); });
    node.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  };
  wrap.querySelectorAll('[data-host]').forEach((node) => {
    const go = () => { const h = byId.get(node.getAttribute('data-host')); if (h) onOpen(h); };
    on(node, go);
  });
  wrap.querySelectorAll('[data-fhost]').forEach((node) => {
    const go = () => {
      const h = byId.get(node.getAttribute('data-fhost'));
      const idx = Number(node.getAttribute('data-finding'));
      if (h && h.vulns && h.vulns[idx]) onPath(h, idx, h.vulns[idx].label);
    };
    on(node, go);
  });
  return wrap;
}

// Full detail for one host: the compact card stays readable, the tables live here.
function ccHostDrawer(host, opts) {
  const body = el('div', { class: 'cc-grid' }, [
    el('div', { class: 'cc-row' }, [
      ccBadge(host.alive ? 'alive' : 'down', host.alive ? 'ok' : 'crit'),
      host.hostname ? el('span', { class: 'mono faint' }, host.hostname) : null,
      host.os ? el('span', { class: 'muted' }, host.os) : null,
      ...ccSevChips(host.sev),
    ]),
    el('div', { class: 'muted' }, 'target: ' + (host.targets || []).join(' · ')),
    ccWide(ccPanel('Ports (' + host.port_counts.total + ')', [dataTable({
      columns: [
        { key: 'port', label: 'port', tdClass: 'mono', cell: (r) => r.port + '/' + r.protocol },
        { key: 'state', label: 'state', cell: (r) => ccBadge(r.state, ccStateTone(r.state)) },
        { key: 'service', label: 'service', cell: (r) => r.service || '' },
        { key: 'version', label: 'version', tdClass: 'muted', cell: (r) => r.version || '' },
      ],
      rows: host.ports, empty: 'no ports recorded',
    })])),
    ccWide(ccPanel('Endpoints (' + host.endpoints.length + ')', [dataTable({
      columns: [
        { key: 'method', label: 'method', cell: (r) => r.method },
        { key: 'url', label: 'url', tdClass: 'mono endpoint', cell: (r) => r.url },
        { key: 'tech', label: 'tech', tdClass: 'muted', cell: (r) => r.tech || '' },
        { key: 'auth', label: 'auth', cell: (r) => ccBadge(r.auth ? 'auth' : 'anon', r.auth ? 'warn' : 'info') },
      ],
      rows: host.endpoints, empty: 'no endpoints recorded',
    })])),
    ccWide(ccPanel('Findings (' + host.vulns.length + ')', [dataTable({
      columns: [
        { key: 'severity', label: 'sev', cell: (r) => ccBadge(r.severity, CC_SEV_TONE[r.severity] || 'info') },
        { key: 'label', label: 'finding', cell: (r) => r.label },
        { key: 'status', label: 'status', cell: (r) => (r.status ? ccBadge(r.status, r.status === 'verified' ? 'ok' : 'info') : '') },
        { key: 'verify_level', label: 'verify', tdClass: 'muted', cell: (r) => r.verify_level || '' },
        { key: 'cvss', label: 'cvss', num: true, cell: (r) => (r.cvss != null ? r.cvss : '') },
        { key: 'url', label: 'url', tdClass: 'mono endpoint', cell: (r) => r.url || '' },
      ],
      rows: host.vulns, empty: 'no findings on this host',
    })])),
  ]);
  drawer({ title: 'Host ' + (host.address || host.hostname || '?'), body, onClose: opts && opts.onClose });
}

function ccHostCard(host) {
  const id = host.address || host.hostname || '?';
  const riskCls = host.sev.critical ? ' crit' : host.sev.high ? ' high' : '';
  const head = el('div', { class: 'cc-host-head' }, [
    el('span', { class: 'cc-host-id mono' }, id),
    host.hostname && host.hostname !== id ? el('span', { class: 'cc-host-name mono faint' }, host.hostname) : null,
    host.source === 'ledger'
      ? el('span', { class: 'chip warn', title: 'host presente solo nel ledger: nessuna porta scansionata nel target model' }, 'solo ledger')
      : ccBadge(host.alive ? 'alive' : 'down', host.alive ? 'ok' : 'crit'),
    host.os ? el('span', { class: 'cc-host-os muted' }, host.os) : null,
    el('span', { class: 'cc-spacer' }),
    ...ccSevChips(host.sev),
    el('button', { class: 'btn btn-sm', onClick: () => ccHostDrawer(host) }, 'dettagli'),
  ]);

  const svc = (host.services || []).length
    ? host.services.map((s) => el('span', { class: 'cc-svc', title: (s.versions || []).join(', ') }, [el('b', null, s.name), ' ', s.ports.join(', ')]))
    : el('span', { class: 'muted' }, 'nessun servizio fingerprintato');
  // A host known only from the ledger was never port-scanned: say so instead of drawing a row
  // of zeros, which reads like a negative scan result.
  const ports = host.port_counts.total
    ? [
        ccBadge(host.port_counts.open + ' open', host.port_counts.open ? 'low' : 'info'),
        host.port_counts.filtered ? ccBadge(host.port_counts.filtered + ' filtered', 'warn') : null,
        host.port_counts.closed ? ccBadge(host.port_counts.closed + ' closed', 'info') : null,
        host.port_counts.other ? ccBadge(host.port_counts.other + ' altro', 'info') : null,
        el('span', { class: 'faint mono' }, host.port_counts.total + ' scansionate'),
      ]
    : el('span', { class: 'muted' }, 'nessuna porta nel target model — host noto solo dal ledger');
  const eps = (host.endpoints || []).slice(0, 4).map((e) => el('span', { class: 'cc-ep mono', title: e.tech || '' }, e.url));
  if (host.endpoints.length > 4) eps.push(el('span', { class: 'muted' }, '+' + (host.endpoints.length - 4)));
  const vulns = [];
  for (const v of (host.vulns || []).slice(0, 4)) {
    vulns.push(ccBadge(v.severity, CC_SEV_TONE[v.severity] || 'info'));
    vulns.push(el('span', { class: 'cc-finding', title: [v.cve, v.class].filter(Boolean).join(' · ') }, v.label));
  }
  if (host.vulns.length > 4) vulns.push(el('span', { class: 'muted' }, '+' + (host.vulns.length - 4)));

  return el('div', { class: 'cc-host' + riskCls, role: 'group', 'aria-label': 'host ' + id }, [
    head,
    el('div', { class: 'cc-host-targets faint mono' }, 'target: ' + (host.targets || []).join(' · ')),
    el('div', { class: 'cc-host-body' }, [
      ccHostRow('services', svc),
      ccHostRow('ports', ports),
      ccHostRow('endpoints', eps.length ? eps : el('span', { class: 'muted' }, '—')),
      ccHostRow('findings', vulns.length ? vulns : el('span', { class: 'muted' }, '—')),
    ]),
  ]);
}

function ccGraphPaint(pane, g) {
  const hosts = g.hosts || [];
  const c = g.counts || {};
  const f = c.findings || {};
  const tiles = el('div', { class: 'cc-stats' }, [
    statTile({ label: 'host', value: c.hosts != null ? c.hosts : hosts.length, tone: 'live', hint: c.hosts_with_findings != null ? c.hosts_with_findings + ' con finding' : null }),
    statTile({ label: 'porte aperte', value: c.open_ports != null ? c.open_ports : '—', hint: (c.ports || 0) + ' scansionate', tone: c.open_ports ? 'low' : 'ok' }),
    statTile({ label: 'endpoint', value: c.endpoints != null ? c.endpoints : '—' }),
    statTile({ label: 'finding', value: f.total != null ? f.total : '—', tone: f.critical ? 'crit' : f.high ? 'high' : f.total ? 'med' : 'ok', hint: f.critical != null ? f.critical + 'C ' + f.high + 'H ' + f.medium + 'M' + (c.ledger_findings ? ' · ' + c.ledger_findings + ' dal ledger' : '') : null }),
    statTile({ label: 'target', value: c.targets != null ? c.targets : '—', tone: c.empty_targets ? 'med' : null, hint: c.empty_targets ? c.empty_targets + ' senza host' : (g.targets || []).slice(0, 2).join(' · ') }),
  ]);
  if (g.error) tiles.appendChild(el('div', { class: 'hint err' }, g.error));

  if (!hosts.length) {
    pane.replaceChildren(el('div', { class: 'cc-grid' }, [tiles,
      ccWide(ccPanel('Host exposure map', [el('div', { class: 'muted', style: { padding: '8px' } }, 'no target model yet — run recon/map to populate reports/state.db')],
        'un host per indirizzo · servizi, porte, endpoint e finding'))]));
    return;
  }

  const q = el('input', { type: 'search', placeholder: 'filtra host, servizio, porta, endpoint, finding…', 'aria-label': 'filtra la mappa di esposizione', value: ccGraphView.q });
  const only = el('button', {
    class: 'chip chip-toggle' + (ccGraphView.onlyFindings ? ' active' : ''),
    'aria-pressed': ccGraphView.onlyFindings ? 'true' : 'false',
    onClick: (e) => {
      ccGraphView.onlyFindings = !ccGraphView.onlyFindings;
      e.currentTarget.classList.toggle('active', ccGraphView.onlyFindings);
      e.currentTarget.setAttribute('aria-pressed', ccGraphView.onlyFindings ? 'true' : 'false');
      paint();
    },
  }, 'solo con finding');
  const sortSel = el('select', { 'aria-label': 'ordina gli host', onChange: (e) => { ccGraphView.sort = e.target.value; paint(); } }, [
    el('option', { value: 'risk', selected: ccGraphView.sort === 'risk' }, 'rischio'),
    el('option', { value: 'findings', selected: ccGraphView.sort === 'findings' }, 'finding'),
    el('option', { value: 'ports', selected: ccGraphView.sort === 'ports' }, 'porte aperte'),
    el('option', { value: 'address', selected: ccGraphView.sort === 'address' }, 'host'),
  ]);
  const count = el('span', { class: 'muted' }, '');
  const list = el('div', { class: 'cc-hosts' });

  // Topology: the same filtered/sorted hosts as the cards, capped so the canvas stays readable.
  const topoHost = el('div');
  const topoNote = el('span', { class: 'muted' }, '');
  const topoBtn = el('button', { class: 'btn btn-sm', 'aria-expanded': String(ccGraphView.showTopo) }, ccGraphView.showTopo ? 'nascondi' : 'mostra');
  const topoPathInfo = el('span', { class: 'muted' }, '');
  const topoClear = el('button', { class: 'btn btn-sm', hidden: true }, '✕ percorso');
  topoClear.addEventListener('click', () => { ccGraphPath = null; paint(); });
  const applyTopo = () => {
    topoHost.hidden = !ccGraphView.showTopo;
    topoBtn.textContent = ccGraphView.showTopo ? 'nascondi' : 'mostra';
    topoBtn.setAttribute('aria-expanded', String(ccGraphView.showTopo));
  };
  topoBtn.addEventListener('click', () => { ccGraphView.showTopo = !ccGraphView.showTopo; applyTopo(); });

  const paint = () => {
    const needle = (ccGraphView.q || '').trim().toLowerCase();
    const shown = hosts.filter((h) => (!needle || ccHostHaystack(h).includes(needle))
      && (!ccGraphView.onlyFindings || (h.vulns || []).length));
    const by = {
      risk: (a, b) => b.risk - a.risk || String(a.address || '').localeCompare(String(b.address || '')),
      findings: (a, b) => (b.sev.total - a.sev.total) || b.risk - a.risk,
      ports: (a, b) => (b.port_counts.open - a.port_counts.open) || b.risk - a.risk,
      address: (a, b) => String(a.address || a.hostname || '').localeCompare(String(b.address || b.hostname || '')),
    };
    shown.sort(by[ccGraphView.sort] || by.risk);
    count.textContent = shown.length === hosts.length ? hosts.length + ' host' : shown.length + ' / ' + hosts.length + ' host';
    list.replaceChildren(...(shown.length ? shown.map(ccHostCard) : [el('div', { class: 'muted', style: { padding: '10px' } }, 'nessun host corrisponde al filtro')]));
    // A path whose host fell out of the filter would dim every band: drop it instead.
    if (ccGraphPath && !shown.some((h) => h.id === ccGraphPath.host)) ccGraphPath = null;
    const top = shown.slice(0, CC_TOPO_MAX);
    topoNote.textContent = shown.length > top.length
      ? 'top ' + top.length + ' per ' + (CC_SORT_LABEL[ccGraphView.sort] || 'rischio') + ' su ' + shown.length + ' host visibili · filtra per restringere'
      : shown.length + ' host · ' + shown.reduce((n, h) => n + (h.vulns || []).length, 0) + ' finding';
    topoPathInfo.textContent = ccGraphPath ? 'percorso: ' + ccGraphPath.label : '';
    topoClear.hidden = !ccGraphPath;
    topoHost.replaceChildren(top.length
      ? ccTopoGraph(top, ccGraphFocus, ccGraphPath,
          (host) => {
            ccGraphPath = null;
            ccGraphFocus = host.id;
            paint();   // dim the other bands before the drawer covers the panel
            ccHostDrawer(host, { onClose: () => { ccGraphFocus = null; paint(); } });
          },
          (host, idx, label) => {
            const same = ccGraphPath && ccGraphPath.host === host.id && ccGraphPath.idx === idx;
            ccGraphPath = same ? null : { host: host.id, idx, label };
            paint();
          })
      : el('div', { class: 'muted', style: { padding: '10px' } }, 'nessun host da disegnare'));
    applyTopo();
  };
  q.addEventListener('input', () => { ccGraphView.q = q.value; paint(); });

  const controls = el('div', { class: 'cc-graph-controls' }, [q, only, sortSel, count]);
  const topoPanel = ccWide(ccPanel('Topology · host → servizi aperti → finding', [
    el('div', { class: 'cc-row' }, [topoBtn, topoClear, topoPathInfo, topoNote]),
    topoHost,
  ], 'clic su un nodo per i dettagli · clic su un finding per accendere il percorso host → servizio → finding'));

  // Findings/endpoints the model cannot attach to any host still have to be visible.
  const ua = g.unassigned || {};
  const orphanTotal = (ua.endpoints || []).length + (ua.vulns || []).length;
  const orphans = orphanTotal
    ? ccWide(ccPanel('Senza host nel modello (' + orphanTotal + ')', [dataTable({
        columns: [
          { key: 'kind', label: 'tipo', cell: (r) => ccBadge(r.kind, 'info') },
          { key: 'target', label: 'target', tdClass: 'mono', cell: (r) => r.target },
          { key: 'label', label: 'elemento', tdClass: 'mono endpoint', cell: (r) => r.label || r.url },
          { key: 'severity', label: 'sev', cell: (r) => (r.severity ? ccBadge(r.severity, CC_SEV_TONE[r.severity] || 'info') : '') },
        ],
        rows: [
          ...(ua.endpoints || []).map((e) => ({ kind: 'endpoint', target: e.target, label: e.url, severity: '' })),
          ...(ua.vulns || []).map((v) => ({ kind: 'finding', target: v.target, label: v.label, severity: v.severity })),
        ],
        empty: '—',
      })], 'elementi che il modello non aggancia a nessun host'))
    : null;

  // Targets that exist in the model and never got a host: saying so is the difference between
  // "the graph is broken" and "that scan ingested nothing".
  const emptyTargets = g.empty_targets || [];
  const emptyPanel = emptyTargets.length
    ? ccWide(ccPanel('Target senza host (' + emptyTargets.length + ')', [
        el('div', { class: 'muted' }, "il target esiste nel modello ma nessuna scansione ha ingerito host o porte (nmap/httpx), e nessun finding del ledger lo nomina: non c'e' niente da disegnare"),
        el('div', { class: 'cc-row' }, emptyTargets.map((t) => el('span', { class: 'cc-svc mono' }, t))),
      ], 'target creati e mai popolati'))
    : null;

  pane.replaceChildren(el('div', { class: 'cc-grid' }, [
    tiles,
    topoPanel,
    ccWide(ccPanel('Host exposure map', [controls, list], 'un host per indirizzo · clic su dettagli per le tabelle complete')),
    emptyPanel,
    orphans,
  ]));
  paint();
}

function renderGraphTab() {
  const pane = byId('tab-graph');
  api('/api/cc/graph')
    .then((g) => ccGraphPaint(pane, g))
    .catch((e) => { pane.replaceChildren(el('div', { class: 'hint err' }, String(e.message || e))); });
}

function renderCoverageTab() {
  const pane = byId('tab-coverage');
  api('/api/cc/coverage').then((c) => {
    const atk = c.attack || {};
    pane.replaceChildren(el('div', { class: 'cc-grid' }, [
      el('div', { class: 'cc-stats' }, [
        statTile({ label: 'gap residui', value: c.remaining, tone: c.remaining ? 'med' : 'ok' }),
        statTile({ label: 'ATT&CK eseguite', value: atk.executed != null ? atk.executed : '—' }),
        statTile({ label: 'ATT&CK pianificate', value: atk.planned != null ? atk.planned : '—' }),
      ]),
      ccPanel('Class coverage per host', [dataTable({
        columns: [
          { key: 'host', label: 'host', cell: (r) => r.host },
          { key: 'pct', label: '%', num: true, cell: (r) => r.coverage_pct },
          { key: 'covered', label: 'covered', cell: (r) => (r.covered || []).join(', ') },
          { key: 'gaps', label: 'gaps', cell: (r) => (r.gaps || []).join(', ') || '—' },
        ],
        rows: c.hosts || [], empty: 'no hosts modelled',
      })]),
      ccPanel('ATT&CK', atk.error ? [el('div', { class: 'hint err' }, atk.error)] : [dataTable({
        columns: [
          { key: 'technique', label: 'T', cell: (r) => r.technique },
          { key: 'name', label: 'technique', cell: (r) => r.name },
          { key: 'tactic', label: 'tactic', cell: (r) => r.tactic },
          { key: 'executed', label: 'exec', num: true, cell: (r) => r.executed },
        ],
        rows: (atk.rows || []).slice(0, 200), empty: '—',
      })]),
    ]));
  }).catch((e) => { pane.replaceChildren(el('div', { class: 'hint err' }, String(e.message || e))); });
}

function renderControlTab() {
  const pane = byId('tab-control');
  const grid = el('div', { class: 'cc-grid' });

  // Config
  const cfgBox = el('div', { class: 'cc-grid' });
  api('/api/cc/config').then((c) => {
    const sc = c.scope || {};
    const present = (name, obj) => el('div', { class: 'cc-row' }, [ccBadge(name, obj ? 'ok' : 'info'), el('span', { class: 'muted' }, obj ? 'present' : 'absent')]);
    cfgBox.replaceChildren(
      el('div', { class: 'cc-row' }, [
        ccBadge('hosts: ' + ((sc.allowed_hosts || []).length), 'info'),
        ccBadge('ips: ' + ((sc.allowed_ips || []).length), 'info'),
        ccBadge('prefixes: ' + ((sc.allowed_url_prefixes || []).length), 'info'),
        sc.max_requests_per_second != null ? ccBadge('rps: ' + sc.max_requests_per_second, 'info') : null,
      ]),
      present('auth.json', c.auth), present('wifi-scope.json', c.wifi_scope),
      present('mobile-scope.json', c.mobile_scope), present('c2.json', c.c2),
    );
  }).catch((e) => cfgBox.replaceChildren(el('div', { class: 'hint err' }, String(e.message || e))));
  grid.appendChild(ccPanel('Config (read-only view, secrets redacted)', [cfgBox]));

  // Team
  const teamBox = el('div', { class: 'muted' }, 'loading…');
  api('/api/cc/team').then((t) => {
    const teams = (t.teams || []).map((tm) => el('div', { class: 'cc-row' }, [ccBadge(tm.name || '?', 'info'), el('span', { class: 'muted' }, ((tm.agents || []).length) + ' agents')]));
    teamBox.replaceChildren(...(teams.length ? teams : [el('div', { class: 'muted' }, t.error || 'no fleet file (dry-run plan)')]));
  }).catch((e) => teamBox.replaceChildren(el('div', { class: 'hint err' }, String(e.message || e))));
  grid.appendChild(ccPanel('Team (fleet plan, dry-run)', [teamBox]));

  // Arsenal
  const arsBox = el('div', { class: 'muted' }, 'loading…');
  api('/api/cc/arsenal').then((a) => {
    const doc = a.doctor || {};
    arsBox.replaceChildren(el('pre', { class: 'cc-pre' }, JSON.stringify({ tool_plane: a.tool_plane, doctor: doc }, null, 2).slice(0, 4000)));
  }).catch((e) => arsBox.replaceChildren(el('div', { class: 'hint err' }, String(e.message || e))));
  grid.appendChild(ccPanel('Arsenal (tool-plane + doctor)', [arsBox]));

  // Knowledge
  const kbInput = el('input', { type: 'text', placeholder: 'query the knowledge base…' });
  const kbOut = el('pre', { class: 'cc-pre' }, '');
  const kbBtn = el('button', { class: 'btn', onClick: () => {
    if (!kbInput.value.trim()) return;
    api('/api/cc/knowledge?q=' + encodeURIComponent(kbInput.value)).then((r) => { kbOut.textContent = r.stdout || r.error || ''; }).catch((e) => { kbOut.textContent = String(e.message || e); });
  } }, 'Search');
  grid.appendChild(ccPanel('Knowledge', [el('div', { class: 'cc-row' }, [kbInput, kbBtn]), kbOut]));

  // Radar (declared egress)
  const radarBox = el('div', { class: 'muted' }, 'loading…');
  api('/api/cc/radar').then((r) => {
    radarBox.replaceChildren(el('div', { class: 'cc-row' }, [ccBadge('egress: ' + r.egress, 'warn')]),
      el('pre', { class: 'cc-pre' }, JSON.stringify(r.cache || {}, null, 2).slice(0, 2000)));
  }).catch((e) => radarBox.replaceChildren(el('div', { class: 'hint err' }, String(e.message || e))));
  grid.appendChild(ccPanel('Radar', [radarBox]));

  // Doctor
  const docBox = el('div', { class: 'muted' }, 'loading…');
  api('/api/cc/doctor').then((d) => { docBox.replaceChildren(el('pre', { class: 'cc-pre' }, JSON.stringify(d, null, 2).slice(0, 4000))); })
    .catch((e) => docBox.replaceChildren(el('div', { class: 'hint err' }, String(e.message || e))));
  grid.appendChild(ccPanel('Doctor', [docBox]));

  pane.replaceChildren(grid);
}

// ── Arsenal ───────────────────────────────────────────────────────────────────
// Two things in one section: the tool inventory of THIS device (from doctor --json, the
// single source of truth) and the one-click "install what is missing". The button starts a
// job running tools/install-all.js (fixed argv) and streams it into the job modal; the typed
// confirmation is enforced by the server too, so the UI is a convenience, never the gate.
function arsenalInstall(mode, confirm) {
  const body = { mode };
  if (confirm) body.confirm = confirm;
  api('/api/cc/arsenal/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then((r) => { toast(mode === 'plan' ? 'plan: building report' : 'install started', ''); openJobModal(r.jobId, mode === 'plan' ? 'install-all --plan' : 'install-all'); })
    .catch((e) => toast('install refused: ' + String(e.message || e), 'err'));
}

function renderArsenalTab() {
  const pane = byId('tab-arsenal');
  api('/api/cc/arsenal').then((d) => {
    const inv = (d && d.inventory) || {};
    const c = inv.counts || {};
    const inst = inv.install || {};
    const groups = inv.groups || {};
    const readOnly = !CC_TOKEN;

    const tiles = el('div', { class: 'cc-stats' }, [
      statTile({ label: 'registry', value: (c.registry_present != null ? c.registry_present + '/' + c.registry_total : '—'), tone: c.registry_missing ? 'med' : 'ok', hint: 'binari usati da run.js' }),
      statTile({ label: 'missing', value: c.missing_total != null ? c.missing_total : '—', tone: c.missing_total ? 'high' : 'ok', hint: 'da installare' }),
      statTile({ label: 'runtime', value: c.runtime_missing ? c.runtime_missing + ' mancanti' : 'ok', tone: c.runtime_missing ? 'med' : 'ok' }),
      statTile({ label: 'vendor', value: c.vendor_missing ? c.vendor_missing + ' mancanti' : 'ok', tone: c.vendor_missing ? 'med' : 'ok' }),
      statTile({ label: 'solo manuali', value: c.manual_missing != null ? c.manual_missing : '—', tone: c.manual_missing ? 'med' : 'ok', hint: 'non installabili da qui' }),
    ]);
    if (inv.ok === false) tiles.appendChild(el('div', { class: 'hint err' }, inv.error || 'inventory unavailable'));

    // ── install box: typed confirmation gates the button, the server gates the request
    const phrase = inst.confirm_phrase || 'INSTALL';
    const confirmInput = el('input', {
      type: 'text', autocomplete: 'off', spellcheck: 'false',
      placeholder: 'type ' + phrase, 'aria-label': 'type ' + phrase + ' to unlock the install button',
    });
    const runBtn = el('button', { class: 'btn btn-primary', disabled: true }, 'Download & install missing');
    const planBtn = el('button', { class: 'btn' }, 'Preview plan (read-only)');
    const gate = () => { runBtn.disabled = readOnly || confirmInput.value.trim() !== phrase; };
    confirmInput.addEventListener('input', gate);
    planBtn.addEventListener('click', () => arsenalInstall('plan', null));
    runBtn.addEventListener('click', () => arsenalInstall('run', confirmInput.value.trim()));
    gate();

    const installBox = el('div', { class: 'cc-install' }, [
      el('div', { class: 'muted' }, 'One button: installs every tool Stavros needs that is not on this device. It runs, in order, '),
      el('div', { class: 'cc-pre' }, [
        '1. node tools/doctor.js --yes     # runtime + registry (apt / go / pipx) · needs root',
        '2. ./install-tools.sh             # extended arsenal + vendor binaries',
        '3. node tools/doctor.js --json    # final verification',
      ].join('\n')),
      el('div', { class: 'cc-row' }, [confirmInput, runBtn, planBtn]),
      el('div', { class: 'muted' }, readOnly
        ? 'READ-ONLY page (no session token): installing is disabled — open the tokenized URL printed by the server.'
        : (inst.note || '')),
      inst.windows ? el('div', { class: 'hint err' }, 'Windows: run install-tools.ps1 once in PowerShell; this button only drives the POSIX installers.') : null,
      c.core_broken ? el('div', { class: 'hint err' }, 'workspace incompleto (file cardine mancanti): ripristinali prima di installare tool') : null,
    ]);

    const doctorDetails = el('details', null, [
      el('summary', { class: 'muted' }, 'doctor --json (raw)'),
      el('pre', { class: 'cc-pre' }, JSON.stringify({ tool_plane: d.tool_plane, doctor: d.doctor }, null, 2).slice(0, 4000)),
    ]);

    const how = (r) => r.how === 'apt' ? 'apt:' + (r.pkg || '?') : r.how === 'go' ? 'go install' : r.how === 'pipx' ? 'pipx install ' + (r.pipx || '') : (r.manual ? 'manuale' : r.how || '—');
    const state = (r) => ccBadge(r.installed ? 'present' : 'missing', r.installed ? 'ok' : 'crit');

    const registryTable = dataTable({
      columns: [
        { key: 'bin', label: 'bin', tdClass: 'mono', cell: (r) => r.bin },
        { key: 'cat', label: 'cat', cell: (r) => ccBadge(r.cat || '', 'info') },
        { key: 'state', label: 'state', cell: state },
        { key: 'how', label: 'install', tdClass: 'muted', cell: how },
        { key: 'note', label: 'note', tdClass: 'muted', cell: (r) => r.note || '' },
      ],
      rows: groups.registry || [], empty: 'registry unavailable',
    });
    const extrasTable = dataTable({
      columns: [
        { key: 'bin', label: 'bin', tdClass: 'mono', cell: (r) => r.bin },
        { key: 'state', label: 'state', cell: state },
        { key: 'how', label: 'install', tdClass: 'muted', cell: how },
        { key: 'note', label: 'note', tdClass: 'muted', cell: (r) => r.note || '' },
      ],
      rows: groups.extras || [], empty: 'no extras detected',
    });
    const vendorList = (groups.vendor || []).map((v) => el('div', { class: 'cc-row' }, [
      ccBadge(v.installed ? 'present' : 'missing', v.installed ? 'ok' : 'crit'),
      el('span', null, v.what || v.path),
      v.installed ? null : el('span', { class: 'muted' }, v.fix || ''),
    ]));
    const manualList = (groups.manual || []).map((m) => el('div', { class: 'cc-row' }, [
      ccBadge(m.bin, 'warn'), el('span', { class: 'muted' }, m.manual || ''),
    ]));
    const runtimeList = (groups.runtime || []).map((r) => el('div', { class: 'cc-row' }, [
      state(r), el('span', { class: 'mono' }, r.bin), el('span', { class: 'muted' }, r.installed ? '' : (r.how || '')),
    ]));

    pane.replaceChildren(el('div', { class: 'cc-grid' }, [
      tiles,
      ccWide(ccPanel('Install missing', [installBox, doctorDetails], 'doctor --json → install-all.js')),
      ccPanel('Runtime', runtimeList.length ? runtimeList : [el('div', { class: 'muted' }, '—')]),
      ccWide(ccPanel('Registry run.js', [registryTable], (c.registry_present != null ? c.registry_present + '/' + c.registry_total + ' presenti' : ''))),
      ccPanel('Extra tool-plane', [extrasTable]),
      ccPanel('Vendor (gitignored)', vendorList.length ? vendorList : [el('div', { class: 'muted' }, 'nothing tracked')]),
      ccPanel('Solo installazione manuale', manualList.length ? manualList : [el('div', { class: 'muted' }, 'nessuno')]),
    ]));
  }).catch((e) => { pane.replaceChildren(el('div', { class: 'hint err' }, String(e.message || e))); });
}
