/* Stavros Console — control views (Graph, Coverage, Config/Team/Arsenal/Knowledge/Radar/Doctor).
 * Zero-build sibling of views-engagement.js; declares functions only. */
'use strict';

function renderGraphTab() {
  const pane = byId('tab-graph');
  api('/api/cc/graph').then((g) => {
    const tiles = el('div', { class: 'cc-stats' }, Object.entries(g.counts || {}).map(([k, v]) => statTile({ label: k, value: v })));
    if (g.error) tiles.appendChild(el('div', { class: 'hint err' }, g.error));
    pane.replaceChildren(el('div', { class: 'cc-grid' }, [
      tiles,
      ccPanel('Nodes', [dataTable({
        columns: [
          { key: 'kind', label: 'kind', cell: (r) => ccBadge(r.kind, 'info') },
          { key: 'label', label: 'label', cell: (r) => r.label },
          { key: 'host', label: 'host', cell: (r) => r.host || '' },
        ],
        rows: (g.nodes || []).slice(0, 300), empty: 'no target model yet',
      })]),
      ccPanel('Edges', [el('div', { class: 'muted' }, (g.edges || []).length + ' edge(s)')]),
    ]));
  }).catch((e) => { pane.replaceChildren(el('div', { class: 'hint err' }, String(e.message || e))); });
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
