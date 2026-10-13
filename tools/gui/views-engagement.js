/* Cyboros Console — engagement views (Campaign, Mission, Approvals, Ledger).
 * Loaded as a separate zero-build script before app.js; only declares functions, which
 * resolve the shared helpers (el/api/esc/toast/...) from app.js at call time. */
'use strict';

function ccBadge(text, tone) { return el('span', { class: 'chip ' + (tone || 'info') }, text); }

function ccPanel(title, children, subtitle) {
  return el('div', { class: 'cc-panel' }, [
    el('div', { class: 'cc-panel-head' }, [el('strong', null, title), subtitle ? el('span', { class: 'muted' }, subtitle) : null]),
    el('div', { class: 'cc-panel-body' }, children),
  ]);
}

function ccDispatchJob(payload, title) {
  api('/api/cc/dispatch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    .then((r) => { toast('dispatched: ' + title, ''); openJobModal(r.jobId, title); })
    .catch((e) => toast('dispatch refused: ' + String(e.message || e), 'err'));
}

// ── Campaign ────────────────────────────────────────────────────────────────
function renderCampaign() {
  const pane = byId('tab-campaign');
  api('/api/cc/campaign').then((d) => {
    const nodes = [];
    if (d.active) {
      const v = d.validation || { errors: [], warnings: [] };
      const drift = d.drift || {};
      nodes.push(ccPanel('Active campaign', [
        el('div', { class: 'cc-row' }, [
          el('strong', null, d.active.name || d.active.id),
          ccBadge(d.active.status || 'draft', d.active.status === 'active' ? 'ok' : 'warn'),
          drift.stale ? ccBadge('scope STALE', 'crit') : ccBadge('scope anchored', 'ok'),
        ]),
        el('div', { class: 'muted' }, d.active.client ? 'client: ' + d.active.client : 'no client'),
        v.warnings.length ? el('div', { class: 'cc-row' }, v.warnings.map((w) => ccBadge(w, 'warn'))) : ccBadge('RoE complete', 'ok'),
        el('div', { class: 'cc-row' }, [
          el('button', { class: 'btn', onClick: () => { api('/api/cc/campaign/resign', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(() => { toast('scope re-anchored', ''); renderCampaign(); }).catch((e) => toast(String(e.message || e), 'err')); } }, 'Re-anchor scope'),
          el('button', { class: 'btn btn-danger', onClick: () => { api('/api/cc/campaign/archive', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(() => { toast('archived', ''); renderCampaign(); }).catch((e) => toast(String(e.message || e), 'err')); } }, 'Archive'),
        ]),
      ]));
    } else {
      nodes.push(ccPanel('No active campaign', [el('div', { class: 'muted' }, 'Create one from a template below, then Activate.')]));
    }

    // wizard
    const sel = el('select', { id: 'cc-tpl' }, (d.templates || []).map((t) => el('option', { value: t }, t)));
    if (d.active) sel.value = d.active.from_template || '';
    const client = el('input', { type: 'text', placeholder: 'client', id: 'cc-client' });
    const name = el('input', { type: 'text', placeholder: 'campaign name', id: 'cc-name' });
    const createBtn = el('button', { class: 'btn btn-primary', onClick: () => {
      api('/api/cc/campaign/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ template: sel.value, client: client.value, name: name.value }) })
        .then((r) => {
          toast('draft created: ' + r.campaign.id, '');
          api('/api/cc/campaign/activate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ campaign: r.campaign }) })
            .then(() => { toast('campaign active', ''); renderCampaign(); })
            .catch((e) => toast(String(e.message || e), 'err'));
        })
        .catch((e) => toast(String(e.message || e), 'err'));
    } }, 'Create + activate');
    nodes.push(ccPanel('Campaign wizard', [
      el('div', { class: 'cc-form' }, [el('label', null, ['Template', sel]), el('label', null, ['Client', client]), el('label', null, ['Name', name]), createBtn]),
    ]));

    nodes.push(ccPanel('Archives', [dataTable({
      columns: [
        { key: 'id', label: 'id', cell: (r) => r.id },
        { key: 'name', label: 'name', cell: (r) => r.name || '' },
        { key: 'client', label: 'client', cell: (r) => r.client || '' },
        { key: 'status', label: 'status', cell: (r) => ccBadge(r.status || '?', r.active ? 'ok' : 'info') },
      ],
      rows: d.list || [], empty: 'no campaigns yet',
    })]));

    pane.replaceChildren(el('div', { class: 'cc-grid' }, nodes));
  }).catch((e) => { pane.replaceChildren(el('div', { class: 'hint err' }, String(e.message || e))); });
}

// ── Mission ─────────────────────────────────────────────────────────────────
function renderMission() {
  const pane = byId('tab-mission');
  api('/api/cc/mission').then((m) => {
    const h = m.headline || {};
    const tiles = el('div', { class: 'cc-stats' }, [
      statTile({ label: 'open actions', value: h.open_actions, tone: 'ok' }),
      statTile({ label: 'needs approval', value: h.needs_approval, tone: h.needs_approval ? 'med' : 'ok' }),
      statTile({ label: 'blocked', value: h.blocked, tone: h.blocked ? 'high' : 'ok' }),
      statTile({ label: 'gates', value: (h.gates_passed || 0) + '/' + (h.gates_total || 0) }),
      statTile({ label: 'coverage gaps', value: h.coverage_remaining, tone: h.coverage_remaining ? 'med' : 'ok' }),
      statTile({ label: 'budget', value: h.budget_halted ? 'HALT' : 'ok', tone: h.budget_halted ? 'crit' : 'ok' }),
    ]);
    if (h.scope_fail_closed) tiles.appendChild(el('div', { class: 'hint err' }, 'scope.json is empty — everything is blocked (fail-closed)'));

    const cards = (m.actions || []).slice(0, 40).map((a) => el('div', { class: 'cc-card' + (a.blocked ? ' blocked' : '') }, [
      el('div', { class: 'cc-row' }, [el('strong', null, a.label), ccBadge(a.source, 'info'), ccBadge(a.tier, a.tier === 'confirm' ? 'warn' : 'ok')]),
      el('div', { class: 'muted' }, a.why || ''),
      a.blocked ? el('div', { class: 'hint err' }, 'blocked: ' + (a.blocked_reason || 'out of scope')) : null,
      a.cmd ? el('code', null, a.cmd) : null,
      el('div', { class: 'cc-row' }, [
        a.tier === 'auto' && a.cmd ? el('button', { class: 'btn', onClick: () => ccDispatchJob({ cmd: a.cmd, name: a.source, tier: 'auto', host: a.host }, a.label) }, 'Dispatch') : null,
        a.tier === 'confirm' && a.cmd ? el('button', { class: 'btn', onClick: () => {
          api('/api/cc/approvals/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host: a.host, action_class: a.ref || a.source, command: a.cmd, reason: a.why }) })
            .then((r) => { toast('approval requested: ' + r.id, ''); switchTab('approvals'); })
            .catch((e) => toast(String(e.message || e), 'err'));
        } }, 'Request approval') : null,
      ]),
    ]));

    pane.replaceChildren(el('div', { class: 'cc-grid' }, [
      tiles,
      ccPanel('Actions', cards.length ? cards : [el('div', { class: 'muted' }, 'nothing to do — plan is quiet')]),
      ccPanel('Gates', (m.gates || []).map((g) => el('div', { class: 'cc-row' }, [ccBadge(g.passed ? 'PASS' : 'MISS', g.passed ? 'ok' : 'warn'), el('span', null, g.id + ' — ' + g.title)]))),
      ccPanel('Pending approvals', (m.approvals || []).length ? (m.approvals || []).map((a) => el('div', { class: 'cc-row' }, [ccBadge(a.status, a.status === 'granted' ? 'ok' : 'warn'), el('span', null, a.action_class + ' → ' + a.host)])) : [el('div', { class: 'muted' }, 'none')]),
    ]));
  }).catch((e) => { pane.replaceChildren(el('div', { class: 'hint err' }, String(e.message || e))); });
}

// ── Approvals ───────────────────────────────────────────────────────────────
function renderApprovals() {
  const pane = byId('tab-approvals');
  function reload() {
    api('/api/cc/approvals?all=1').then((d) => {
      pane.replaceChildren(el('div', { class: 'cc-grid' }, [
        ccPanel('Inbox', [
          el('button', { class: 'btn', onClick: reload }, '⟳ refresh'),
          dataTable({
            columns: [
              { key: 'id', label: 'id', cell: (r) => r.id },
              { key: 'status', label: 'status', cell: (r) => ccBadge(r.status, r.status === 'granted' ? 'ok' : r.status === 'pending' ? 'warn' : 'info') },
              { key: 'action_class', label: 'action', cell: (r) => r.action_class },
              { key: 'host', label: 'host', cell: (r) => r.host },
              { key: 'scope', label: 'scope', cell: (r) => ccBadge(r.scope_verdict, r.scope_verdict === 'allowed' ? 'ok' : 'crit') },
              { key: 'why', label: 'why', cell: (r) => r.reason || '' },
              { key: 'act', label: '', cell: (r) => el('span', { class: 'cc-row' }, [
                r.status === 'pending' ? el('button', { class: 'btn', onClick: () => ccApprove(r.id, 'grant', reload) }, 'grant') : null,
                r.status === 'pending' ? el('button', { class: 'btn', onClick: () => ccApprove(r.id, 'deny', reload) }, 'deny') : null,
                r.status === 'granted' ? el('button', { class: 'btn', onClick: () => ccApprove(r.id, 'revoke', reload) }, 'revoke') : null,
              ]) },
            ],
            rows: d.rows || [], empty: 'no approvals yet',
          }),
        ]),
        ccPanel('Agent contract', [el('pre', { class: 'cc-pre' },
          'node tools/request-approval.js --host <h> --action <class> --command "<cmd>" --reason "..."\n' +
          '# operator grants here; the agent then runs:\n' +
          'node tools/run.js <bin> ... --approval <id>   # policy: scope.json.host_ops.require_approval')]),
      ]));
    }).catch((e) => pane.replaceChildren(el('div', { class: 'hint err' }, String(e.message || e))));
  }
  reload();
}

function ccApprove(id, action, cb) {
  api('/api/cc/approvals/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, actor: 'operator' }) })
    .then(() => { toast(action + ': ' + id, ''); cb(); })
    .catch((e) => toast(String(e.message || e), 'err'));
}

// ── Ledger ──────────────────────────────────────────────────────────────────
function renderLedger() {
  const pane = byId('tab-ledger');
  api('/api/cc/ledger?tail=200').then((d) => {
    const c = d.chain || {};
    pane.replaceChildren(el('div', { class: 'cc-grid' }, [
      ccPanel('Chain', [
        el('div', { class: 'cc-row' }, [
          ccBadge(c.ok ? 'chain intact' : 'CHAIN BROKEN', c.ok ? 'ok' : 'crit'),
          el('span', { class: 'muted' }, c.detail || ''),
        ]),
        el('button', { class: 'btn btn-primary', onClick: () => {
          api('/api/cc/ledger/evidence', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
            .then((r) => toast('bundle: ' + (r.tar || r.manifest), ''))
            .catch((e) => toast(String(e.message || e), 'err'));
        } }, 'Build evidence bundle'),
      ]),
      ccPanel('Counts', Object.entries(d.counts || {}).map(([k, v]) => el('div', { class: 'cc-row' }, [el('span', { class: 'muted' }, k), el('strong', null, String(v))]))),
      ccPanel('Timeline', [dataTable({
        columns: [
          { key: 'ts', label: 'when', cell: (r) => shortTs(r.ts) },
          { key: 'kind', label: 'kind', cell: (r) => ccBadge(r.kind, 'info') },
          { key: 'what', label: 'what', cell: (r) => r.action || r.gate || r.tool || r.artifact || r.id || '' },
          { key: 'detail', label: 'detail', cell: (r) => r.detail || r.verdict || r.status || '' },
        ],
        rows: (d.timeline && d.timeline.rows) || [], empty: 'no ledger entries',
      })]),
    ]));
  }).catch((e) => pane.replaceChildren(el('div', { class: 'hint err' }, String(e.message || e))));
}
