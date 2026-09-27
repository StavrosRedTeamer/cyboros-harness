/* Stavros Console — control views (Graph, Coverage, Config/Team/Arsenal/Knowledge/Radar/Doctor).
 * Zero-build sibling of views-engagement.js; declares functions only. */
'use strict';

// ── Graph ─────────────────────────────────────────────────────────────────────
// Real section (WP6 data): the target model is drawn as a left-to-right chain
// target → host → port → endpoint → vuln, so "what is exposed where" reads in one
// look. Deterministic layout (layer = kind, row = index, rows sorted by host) so the same
// engagement always draws the same picture — no physics, no dependency. Every layer is
// capped (CC_PER_KIND) and can be switched off: 40 ports in one canvas helps nobody, and the
// chips say exactly what is being hidden.
const CC_KIND_ORDER = ['target', 'host', 'port', 'endpoint', 'vuln'];
const CC_KIND_COLOR = { target: 'var(--magenta)', host: 'var(--cyan)', port: 'var(--low)', endpoint: 'var(--med)', vuln: 'var(--crit)' };
const CC_KIND_R = { target: 8, host: 6, port: 4, endpoint: 4.5, vuln: 6 };
const CC_PER_KIND = 20;
const ccGraphOff = new Set();   // layers the operator switched off (kept across refreshes)

// Panels that need the whole grid row (wide tables, the canvas): cc-grid is an auto-fit
// grid, so a dense table in a 320px column would only ever scroll.
function ccWide(node) { node.style.gridColumn = '1 / -1'; return node; }

function ccGraphKinds(g) {
  const counts = g.counts || {};
  return CC_KIND_ORDER.concat(Object.keys(counts).filter((k) => !CC_KIND_ORDER.includes(k) && counts[k]));
}

// Honour the toggles, then cap each layer so the canvas stays readable.
function ccGraphSelect(g) {
  const shown = [];
  const perKind = {};
  for (const n of (g.nodes || [])) {
    if (ccGraphOff.has(n.kind)) continue;
    perKind[n.kind] = (perKind[n.kind] || 0) + 1;
    if (perKind[n.kind] <= CC_PER_KIND) shown.push(n);
  }
  return { shown, perKind, kinds: ccGraphKinds(g).filter((k) => perKind[k]) };
}

function ccGraphLayout(nodes, kinds) {
  const byKind = {};
  for (const n of nodes) (byKind[n.kind] = byKind[n.kind] || []).push(n);
  // same order as the host layer above them → fewer crossings
  for (const k of kinds) byKind[k].sort((a, b) => String(a.host || '').localeCompare(String(b.host || '')) || String(a.label || '').localeCompare(String(b.label || '')));
  const maxRows = Math.max(1, ...kinds.map((k) => byKind[k].length));
  const rowH = 20, colW = 220, padX = 120, padY = 46;
  const height = Math.max(200, padY * 2 + (maxRows - 1) * rowH);
  const pos = new Map();
  kinds.forEach((k, ci) => {
    const list = byKind[k];
    list.forEach((n, ri) => {
      const x = padX + ci * colW;
      const y = list.length === 1 ? height / 2 : padY + ri * ((height - padY * 2) / (list.length - 1));
      pos.set(n.id, { x, y });
    });
  });
  return { pos, kinds, width: padX * 2 + Math.max(0, kinds.length - 1) * colW, height };
}

function ccGraphCanvas(g) {
  const sel = ccGraphSelect(g);
  if (!sel.shown.length) {
    return el('div', { class: 'muted', style: { padding: '14px' } },
      ccGraphOff.size ? 'every layer is switched off — turn one back on below' : 'no target model yet — run recon/map to populate reports/state.db');
  }
  const nodes = sel.shown;
  const ids = new Set(nodes.map((n) => n.id));
  const edges = (g.edges || []).filter((e) => ids.has(e.from) && ids.has(e.to));
  const lay = ccGraphLayout(nodes, sel.kinds);
  const edgeSvg = edges.map((e) => {
    const a = lay.pos.get(e.from), b = lay.pos.get(e.to);
    return '<line class="cc-edge" x1="' + a.x.toFixed(1) + '" y1="' + a.y.toFixed(1) + '" x2="' + b.x.toFixed(1) + '" y2="' + b.y.toFixed(1) + '"><title>' + esc(e.kind || '') + '</title></line>';
  }).join('');
  const nodeSvg = nodes.map((n) => {
    const p = lay.pos.get(n.id);
    const col = CC_KIND_COLOR[n.kind] || 'var(--info)';
    const r = (CC_KIND_R[n.kind] || 5) + (String(n.severity || '').toLowerCase() === 'critical' ? 2 : 0);
    const tip = n.kind + ': ' + (n.label || '') + (n.severity ? ' [' + n.severity + ']' : '') + (n.service ? ' · ' + n.service : '');
    return '<g><title>' + esc(tip) + '</title>' +
      '<circle cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="' + r + '" fill="var(--surface)" stroke="' + col + '" stroke-width="1.6"/>' +
      '<text class="cc-node-label" x="' + p.x.toFixed(1) + '" y="' + (p.y - 10).toFixed(1) + '" text-anchor="middle">' + esc(String(n.label || '').slice(0, 26)) + '</text></g>';
  }).join('');
  return el('div', { class: 'cc-graph' }, el('div', {
    html: '<svg viewBox="0 0 ' + lay.width + ' ' + lay.height + '" width="' + lay.width + '" height="' + lay.height + '" role="img" aria-label="target model: ' + nodes.length + ' nodes, ' + edges.length + ' edges">' + edgeSvg + nodeSvg + '</svg>',
  }));
}

// Clickable legend: counts per layer, and a layer can be hidden (the cap is stated).
function ccGraphLegend(g, repaint) {
  const sel = ccGraphSelect(g);
  const counts = g.counts || {};
  // only layers that actually exist here: a toggle for an absent kind is noise
  const items = ccGraphKinds(g).filter((k) => (counts[k] || 0) > 0).map((k) => {
    const off = ccGraphOff.has(k);
    const capped = !off && sel.perKind[k] > CC_PER_KIND;
    return el('button', {
      class: 'cc-legend-btn' + (off ? ' off' : ''),
      'aria-pressed': off ? 'false' : 'true',
      title: (off ? 'show ' : 'hide ') + k,
      onClick: () => { if (off) ccGraphOff.delete(k); else ccGraphOff.add(k); repaint(); },
    }, [el('i', { style: { background: CC_KIND_COLOR[k] || 'var(--info)' } }), k + ' ' + (counts[k] || 0) + (capped ? ' (showing ' + CC_PER_KIND + ')' : '')]);
  });
  return el('div', { class: 'cc-legend' }, items);
}

function ccGraphPaint(pane, g) {
  const nodes = g.nodes || [];
  const tiles = el('div', { class: 'cc-stats' }, Object.entries(g.counts || {}).map(([k, v]) => statTile({ label: k, value: v })));
  tiles.appendChild(statTile({ label: 'edges', value: (g.edges || []).length }));
  tiles.appendChild(statTile({ label: 'targets', value: g.targets != null ? g.targets : '—' }));
  if (g.error) tiles.appendChild(el('div', { class: 'hint err' }, g.error));
  const paint = () => {
    pane.replaceChildren(el('div', { class: 'cc-grid' }, [
      tiles,
      ccWide(ccPanel('Asset graph', [ccGraphCanvas(g), ccGraphLegend(g, paint)], 'target → host → port → endpoint → vuln · click a layer to hide it')),
      ccWide(ccPanel('Nodes', [dataTable({
        columns: [
          { key: 'kind', label: 'kind', cell: (r) => ccBadge(r.kind, r.kind === 'vuln' ? (SEV_CHIP[r.severity] || 'info') : 'info') },
          { key: 'label', label: 'label', cell: (r) => r.label },
          { key: 'host', label: 'host', cell: (r) => r.host || '' },
          { key: 'service', label: 'service', cell: (r) => r.service || (r.port != null ? 'port ' + r.port : '') },
          { key: 'severity', label: 'sev', cell: (r) => (r.severity ? ccBadge(r.severity, SEV_CHIP[r.severity] || 'info') : '') },
        ],
          rows: nodes.slice(0, 300), empty: 'no target model yet',
        })])),
        ccWide(ccPanel('Edges', [dataTable({
          columns: [
            { key: 'from', label: 'from', tdClass: 'mono', cell: (r) => r.from },
            { key: 'kind', label: 'kind', cell: (r) => ccBadge(r.kind || 'edge', 'info') },
            { key: 'to', label: 'to', tdClass: 'mono', cell: (r) => r.to },
          ],
          rows: (g.edges || []).slice(0, 300), empty: 'no edges',
        })])),
      ]));
  };
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
