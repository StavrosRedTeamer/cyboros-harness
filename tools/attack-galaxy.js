#!/usr/bin/env node
// Attack galaxy — the engagement as a single self-contained HTML view.
//
// report-html.js answers "what did we find"; this answers "what is the SHAPE of the
// engagement": which host carries the most risk, how findings cluster per host, and how
// the pairs that chain.js flagged amplify each other. Same source of truth
// (reports/findings.jsonl), same enrichers (cvss/epss/cwe/confidence) — no second
// parser, no duplicated severity rules.
//
//   node tools/attack-galaxy.js [--findings <file>] [--out <file>] [--host <h>]
//   node tools/attack-galaxy.js --print        # layout summary on stdout, no HTML
//
// Design constraints (this workspace is opsec-by-construction, see AGENTS.md):
//   - zero npm deps, zero network: the payload is inlined, there is no CDN, no font
//     fetch, no <img src>. The generated file works from a USB stick on an air-gapped box.
//   - deterministic: layout seed derives from the findings hash-chain head, so the same
//     corpus always produces the same picture (diffable across runs).
//   - read-only: touches findings.jsonl and reports/ for output. Never rewrites evidence.
//
// The HTML is data-driven: buildGalaxy() is a pure function and buildHtml() embeds only
// the JSON payload plus the renderer, both unit-tested in tools/test-attack-galaxy.js.
const fs = require('fs');
const path = require('path');
const { buildChains } = require('./chain');
const { enrichFinding, loadFindings, htmlEscape } = require('./report-html');

const ROOT = path.join(__dirname, '..');
const OUT_DEFAULT = path.join(ROOT, 'reports', 'attack-galaxy.html');

const SEV_ORDER = { Critical: 5, High: 4, Medium: 3, Low: 2, Info: 1 };

// ─── payload ────────────────────────────────────────────────────────────────────

// FNV-1a over the corpus: the layout seed. Same findings -> same arrangement, and a
// changed corpus -> a visibly different one (no Math.random anywhere in the output path).
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

// mulberry32 — small, fast, seeded. Used for initial node placement only; the physics
// then converges deterministically because the force order is fixed by id sort.
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dayKey(ts) {
  const s = String(ts || '');
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : 'unknown';
}

// Pure: enriched findings + chains -> graph payload consumed by the renderer.
// Node ids are stable strings so the layout seed, the DOM and the tests all agree:
//   host     "h:<host>"      kind 'host',    size from finding count
//   finding  "f:<chainseq>"  kind 'finding', colour from severity, size from CVSS
function buildGalaxy(findings, chains) {
  const list = (findings || []).map(enrichFinding);
  const seed = fnv1a(list.map((f) => `${f.host}|${f.title}|${f.severity}|${f.cvss}`).join('\n'));

  const hosts = new Map();
  for (const f of list) {
    const h = String(f.host || 'unknown');
    if (!hosts.has(h)) hosts.set(h, { host: h, findings: [], severity_top: 0, verified: 0, chain_hits: 0 });
    const e = hosts.get(h);
    e.findings.push(f);
    e.severity_top = Math.max(e.severity_top, SEV_ORDER[f.severity] || 0);
    if (f.status === 'verified' || f.status === 'confirmed') e.verified++;
  }

  // chain.js speaks in "title [Severity]" strings; map those back onto node ids so the
  // renderer can draw real chain edges instead of free text.
  //
  // The key separator MUST be a byte that cannot occur in a host/title/severity. With a
  // space it is not: {host:'a b', title:'c'} and {host:'a', title:'b c'} would produce the
  // same key, and a chain edge would silently attach to the wrong finding. NUL (written as
  // an escape so this file stays plain text) is the one character that cannot appear in any
  // of the three fields.
  const SEP = '\u0000';
  const byTitle = new Map();
  for (const f of list) byTitle.set(f.host + SEP + f.title + SEP + f.severity, f);

  const nodes = [];
  const links = [];
  const chainEdges = [];

  const rand = rng(seed);
  // Golden-angle spiral keeps the initial layout even and seed-independent in shape.
  const place = (i) => {
    const r = 60 * Math.sqrt(i + 1);
    const a = i * 2.399963;
    return [Math.cos(a) * r + (rand() - 0.5) * 8, Math.sin(a) * r + (rand() - 0.5) * 8];
  };

  for (const h of [...hosts.values()].sort((a, b) => a.host.localeCompare(b.host))) {
    const [x, y] = place(nodes.length);
    nodes.push({
      id: 'h:' + h.host,
      kind: 'host',
      label: h.host,
      host: h.host,
      count: h.findings.length,
      severity_top: h.severity_top,
      severity: Object.keys(SEV_ORDER).find((k) => SEV_ORDER[k] === h.severity_top) || 'Info',
      verified: h.verified,
      chain_hits: 0,
      seed_x: Math.round(x * 100) / 100,
      seed_y: Math.round(y * 100) / 100,
    });
  }

  list.forEach((f, i) => {
    const host = String(f.host || 'unknown');
    const id = 'f:' + (f.chain && f.chain.seq != null ? f.chain.seq : i);
    const [x, y] = place(nodes.length);
    nodes.push({
      id,
      kind: 'finding',
      label: f.title,
      host,
      severity: f.severity || 'Info',
      severity_rank: SEV_ORDER[f.severity] || 0,
      status: f.status || 'unknown',
      verify_level: f.verify_level || '',
      class: f.class || 'other',
      endpoint: f.endpoint || '',
      cvss: f.cvss,
      epss: f.epss,
      cwe: f.cwe || '',
      cwe_title: f.cwe_title || '',
      cves: f.cves || [],
      confidence: f.confidence || null,
      day: dayKey(f.ts),
      ts: f.ts || '',
      title: f.title,
      poc: f.poc || '',
      impact: f.impact || '',
      remediation: f.remediation || '',
      standards: f.standards || null,
      seed_x: Math.round(x * 100) / 100,
      seed_y: Math.round(y * 100) / 100,
    });
    links.push({ source: 'h:' + host, target: id, kind: 'host' });
  });

  // Chain edges link every finding of a chain to the chain's first one (a star), so a
  // 3-finding chain is visually one object instead of three unrelated dots.
  for (const hostChains of chains || []) {
    for (const ch of hostChains.chains || []) {
      const ids = [];
      for (const label of ch.findings || []) {
        const m = String(label).match(/^(.*) \[(Critical|High|Medium|Low|Info)\]$/);
        if (!m) continue;
        const f = byTitle.get(hostChains.host + SEP + m[1] + SEP + m[2]);
        if (f) {
          const idx = list.indexOf(f);
          ids.push('f:' + ((f.chain && f.chain.seq != null) ? f.chain.seq : idx));
        }
      }
      if (ids.length < 2) continue;
      const anchor = ids[0];
      const members = ids.slice(1);
      for (const m of members) {
        links.push({ source: anchor, target: m, kind: 'chain' });
        chainEdges.push({ host: hostChains.host, name: ch.name });
      }
      const hostNode = nodes.find((n) => n.id === 'h:' + hostChains.host);
      if (hostNode) hostNode.chain_hits++;
      for (const id of ids) {
        const n = nodes.find((x) => x.id === id);
        if (n) n.in_chain = (n.in_chain || 0) + 1;
      }
    }
  }

  // Stable id order: the physics loop is order-dependent, so it must not depend on
  // Map/object iteration accidents.
  nodes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  links.sort((a, b) => (a.source + '>' + a.target < b.source + '>' + b.target ? -1 : 1));

  const days = [...new Set(list.map((f) => dayKey(f.ts)))].filter((d) => d !== 'unknown').sort();
  const byDay = days.map((d) => ({ day: d, total: list.filter((f) => dayKey(f.ts) === d).length }));

  return {
    seed,
    nodes,
    links,
    chain_edges: chainEdges,
    days: byDay,
    stats: {
      findings: list.length,
      hosts: hosts.size,
      chains: (chains || []).reduce((a, c) => a + (c.chains || []).length, 0),
      severity: list.reduce((a, f) => { a[f.severity] = (a[f.severity] || 0) + 1; return a; }, {}),
      verified: list.filter((f) => f.status === 'verified' || f.status === 'confirmed').length,
      with_cvss: list.filter((f) => f.cvss != null).length,
      max_epss: list.reduce((m, f) => (f.epss != null && f.epss > m ? f.epss : m), 0),
    },
  };
}

// ─── HTML ────────────────────────────────────────────────────────────────────────

// JSON embedded in a <script> must not be able to close the tag or break out of the
// string literal. Escaping <, >, & and the JS line separators is the whole job.
function embedJson(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function buildHtml(galaxy, meta) {
  const m = meta || {};
  const g = galaxy || buildGalaxy([], []);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Attack galaxy — ${htmlEscape(m.host || 'all hosts')}</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #08060d; --bg2: #050409; --surface: #0f0b18; --surface-2: #160f26;
    --line: #261a3d; --line-2: #3a2a5c;
    --ink: #eae7f7; --muted: #9b90b8; --faint: #665b84;
    --cyan: #24e3ff; --magenta: #ff2d95;
    --crit: #ff2b5e; --high: #ff8324; --med: #ffd60a; --low: #2ad4ff; --info: #8090ab;
    --green: #24e38b;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    --sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { background: radial-gradient(1200px 700px at 70% -10%, #170f2b 0%, var(--bg) 55%) fixed, var(--bg2);
         color: var(--ink); font-family: var(--sans); font-size: 14px; overflow: hidden; }
  header { display: flex; align-items: baseline; gap: 18px; flex-wrap: wrap;
           padding: 12px 18px; border-bottom: 1px solid var(--line); background: rgba(8,6,13,.82); }
  h1 { font-size: 15px; margin: 0; letter-spacing: .16em; text-transform: uppercase; color: var(--cyan); }
  h1 span { color: var(--magenta); }
  .kpis { display: flex; gap: 14px; flex-wrap: wrap; }
  .kpi { font-family: var(--mono); font-size: 11px; color: var(--muted); }
  .kpi b { color: var(--ink); font-size: 14px; margin-right: 4px; }
  .kpi.crit b { color: var(--crit); } .kpi.high b { color: var(--high); }
  .kpi.med b { color: var(--med); } .kpi.low b { color: var(--low); }
  .kpi.green b { color: var(--green); }
  #stage { position: relative; height: calc(100% - 104px); }
  canvas { display: block; width: 100%; height: 100%; cursor: grab; }
  canvas.dragging { cursor: grabbing; }
  #toolbar { position: absolute; top: 12px; left: 12px; display: flex; gap: 6px; flex-wrap: wrap;
             max-width: 60%; }
  #toolbar button, #toolbar input {
    font-family: var(--mono); font-size: 11px; color: var(--muted);
    background: var(--surface); border: 1px solid var(--line); border-radius: 3px; padding: 4px 8px;
  }
  #toolbar button { cursor: pointer; }
  #toolbar button:hover, #toolbar button[aria-pressed="true"] { color: var(--cyan); border-color: var(--cyan); }
  #toolbar input:focus-visible, #toolbar button:focus-visible, .drawer a:focus-visible {
    outline: 2px solid var(--cyan); outline-offset: 1px;
  }
  #legend { position: absolute; bottom: 12px; left: 12px; right: 200px; display: flex; gap: 12px; flex-wrap: wrap;
            font-family: var(--mono); font-size: 10.5px; color: var(--faint); }
  #days { display: block; width: 100%; }
  #days a { color: var(--faint); text-decoration: none; margin-right: 7px; }
  #days a:hover { color: var(--cyan); }
  #legend i { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 4px; }
  #tip { position: absolute; pointer-events: none; opacity: 0; transition: opacity .1s;
         background: var(--surface-2); border: 1px solid var(--line-2); border-radius: 3px;
         padding: 6px 9px; font-family: var(--mono); font-size: 11px; max-width: 420px; z-index: 5; }
  #tip b { color: var(--ink); } #tip .m { color: var(--faint); }
  aside { position: absolute; top: 0; right: 0; width: 380px; max-width: 46vw; height: 100%;
          background: rgba(15,11,24,.96); border-left: 1px solid var(--line);
          overflow-y: auto; padding: 16px; transform: translateX(100%); transition: transform .18s ease; }
  aside[data-open="1"] { transform: none; }
  aside h2 { font-size: 13px; margin: 0 0 4px; line-height: 1.35; }
  aside h3 { font-size: 10px; text-transform: uppercase; letter-spacing: .12em; color: var(--faint);
            margin: 18px 0 4px; border-top: 1px solid var(--line); padding-top: 10px; }
  aside p, aside li { font-size: 12px; line-height: 1.5; color: var(--muted); margin: 4px 0; }
  aside ul { padding-left: 16px; margin: 4px 0; }
  .chips { display: flex; gap: 6px; flex-wrap: wrap; margin: 6px 0; }
  .chip { font-family: var(--mono); font-size: 10.5px; padding: 1px 6px; border-radius: 3px;
          border: 1px solid var(--line-2); color: var(--ink); }
  .sev-Critical { color: var(--crit); border-color: var(--crit); } .sev-High { color: var(--high); border-color: var(--high); }
  .sev-Medium { color: var(--med); border-color: var(--med); } .sev-Low { color: var(--low); border-color: var(--low); }
  .sev-Info { color: var(--info); border-color: var(--info); }
  .mono { font-family: var(--mono); font-size: 11px; word-break: break-all; }
  #close { float: right; cursor: pointer; background: none; border: none; color: var(--faint); font-size: 16px; }
  footer { position: absolute; bottom: 12px; right: 14px; font-family: var(--mono); font-size: 10px;
           color: var(--faint); text-align: right; }
  @media (prefers-reduced-motion: reduce) { .drawer, aside { transition: none; } }
</style>
</head>
<body>
<header>
  <h1>Attack <span>Galaxy</span></h1>
  <div class="kpis" id="kpis"></div>
</header>
<div id="stage">
  <canvas id="c"></canvas>
  <div id="toolbar" role="toolbar" aria-label="Filters">
    <input id="q" type="search" placeholder="filter title, endpoint, class…" aria-label="Filter findings">
    <button data-sev="Critical" aria-pressed="false">Critical</button>
    <button data-sev="High" aria-pressed="false">High</button>
    <button data-sev="Medium" aria-pressed="false">Medium</button>
    <button data-sev="Low" aria-pressed="false">Low</button>
    <button data-sev="Info" aria-pressed="false">Info</button>
    <button id="chains" aria-pressed="false">chains only</button>
    <button id="reheat">re-heat</button>
  </div>
  <div id="legend"></div>
  <div id="tip" role="status" aria-live="polite"></div>
  <aside id="drawer" data-open="0" aria-label="Finding detail"></aside>
  <footer id="foot"></footer>
</div>
<script id="payload" type="application/json">${embedJson(g)}</script>
<script>
(function () {
  'use strict';
  var G = JSON.parse(document.getElementById('payload').textContent);
  var cvs = document.getElementById('c'), ctx = cvs.getContext('2d');
  var tip = document.getElementById('tip'), drawer = document.getElementById('drawer');
  var stage = document.getElementById('stage');
  var COLORS = { Critical: '#ff2b5e', High: '#ff8324', Medium: '#ffd60a', Low: '#2ad4ff', Info: '#8090ab' };
  var reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var byId = {}; G.nodes.forEach(function (n) { byId[n.id] = n; });

  // Seeded initial placement comes from the payload (computed in node), so the physics
  // is deterministic here too — no Math.random in the render path.
  G.nodes.forEach(function (n, i) {
    n.x = n.seed_x; n.y = n.seed_y; n.vx = 0; n.vy = 0;
    n.r = n.kind === 'host' ? 7 + Math.min(14, n.count * 1.1) : 3.4 + Math.min(6, (n.cvss || 0) * 0.7);
    n.halo = n.kind === 'host' ? 16 + n.r : 0;
    byId[n.id] = n;
  });

  var view = { x: 0, y: 0, k: 1 };
  var alpha = 1, frames = 0, raf = null;
  var sel = null, hover = null;
  var filters = { sev: {}, q: '', chainsOnly: false, day: null };

  // ── physics: Barnes-Hut-free O(n^2) repulsion (n is in the hundreds here), spring links
  function step() {
    var nodes = G.nodes, i, j, a, b, dx, dy, d2, d, f;
    for (i = 0; i < nodes.length; i++) {
      a = nodes[i];
      for (j = i + 1; j < nodes.length; j++) {
        b = nodes[j];
        dx = b.x - a.x; dy = b.y - a.y;
        d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { dx = (i - j) * 0.01 + 0.01; dy = 0.01; d2 = 0.0002; }
        if (d2 > 90000) continue;                 // far pairs contribute nothing visible
        d = Math.sqrt(d2);
        f = (a.kind === 'host' && b.kind === 'host' ? 9000 : (a.kind === 'host' || b.kind === 'host' ? 2600 : 620)) / d2;
        var fx = dx / d * f, fy = dy / d * f;
        a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy;
      }
    }
    for (i = 0; i < G.links.length; i++) {
      var L = G.links[i]; a = byId[L.source]; b = byId[L.target];
      dx = b.x - a.x; dy = b.y - a.y; d = Math.max(1, Math.hypot(dx, dy));
      var rest = L.kind === 'chain' ? 46 : (a.kind === 'host' ? 78 : 64);
      f = (d - rest) * (L.kind === 'chain' ? 0.06 : 0.035);
      var ux = dx / d * f, uy = dy / d * f;
      if (L.kind === 'chain') { a.vx += ux * 0.6; a.vy += uy * 0.6; b.vx -= ux * 0.6; b.vy -= uy * 0.6; }
      else { a.vx += ux * 0.35; a.vy += uy * 0.35; b.vx -= ux * 0.35; b.vy -= uy * 0.35; }
    }
    for (i = 0; i < nodes.length; i++) {
      a = nodes[i];
      var pull = a.kind === 'host' ? 0.020 : 0.004;
      a.vx -= a.x * pull; a.vy -= a.y * pull;
      a.vx *= 0.86; a.vy *= 0.86;
      if (a.fixed) { a.vx = a.vy = 0; continue; }
      a.x += a.vx * alpha; a.y += a.vy * alpha;
    }
    alpha *= 0.985;
    if (alpha < 0.02) alpha = 0.02;
  }

  function visible(n) {
    if (n.kind === 'host') return true;
    if (filters.sev[n.severity]) return true;
    var host = byId['h:' + n.host];
    if (host && !host.hidden) return true;
    return false;
  }
  function matches(n) {
    if (filters.day && n.day !== filters.day) return false;
    if (n.kind === 'host') return true;
    if (filters.chainsOnly && !n.in_chain) return false;
    if (filters.sev[n.severity]) return true;
    if (filters.q) {
      var q = filters.q.toLowerCase();
      return (n.title + ' ' + (n.endpoint || '') + ' ' + (n.class || '') + ' ' + n.host).toLowerCase().indexOf(q) >= 0;
    }
    var host = byId['h:' + n.host];
    return !(host && host.hidden);
  }
  function dim(n) { return !matches(n); }

  function draw() {
    var dpr = window.devicePixelRatio || 1;
    var w = stage.clientWidth, h = stage.clientHeight;
    if (cvs.width !== w * dpr || cvs.height !== h * dpr) { cvs.width = w * dpr; cvs.height = h * dpr; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#050409';
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.translate(w / 2 + view.x, h / 2 + view.y);
    ctx.scale(view.k, view.k);

    var i, L, a, b;
    for (i = 0; i < G.links.length; i++) {
      L = G.links[i]; a = byId[L.source]; b = byId[L.target];
      if (L.kind === 'chain' && (dim(a) || dim(b))) continue;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = L.kind === 'chain' ? 'rgba(255,45,149,.55)' : 'rgba(120,100,180,.16)';
      ctx.lineWidth = (L.kind === 'chain' ? 1.6 : 1) / view.k;
      ctx.stroke();
    }

    var pulse = reduced ? 1 : 0.85 + 0.15 * Math.sin(performance.now() / 500);
    for (i = 0; i < G.nodes.length; i++) {
      a = G.nodes[i];
      var d2 = dim(a);
      ctx.globalAlpha = d2 ? 0.10 : 1;
      if (a.halo) {
        ctx.beginPath(); ctx.arc(a.x, a.y, a.halo * pulse, 0, 6.2832);
        ctx.fillStyle = 'rgba(36,227,255,' + (0.05 + (a.severity_rank ? 0 : 0.06)) + ')';
        ctx.fill();
      }
      ctx.beginPath(); ctx.arc(a.x, a.y, a.r, 0, 6.2832);
      ctx.fillStyle = a.kind === 'host' ? '#eae7f7' : (COLORS[a.severity] || '#8090ab');
      ctx.fill();
      if (a.kind === 'finding' && a.severity === 'Critical' && !d2) {
        ctx.strokeStyle = 'rgba(255,43,94,.8)'; ctx.lineWidth = 2 / view.k; ctx.stroke();
      }
      if (a.kind === 'host' || a === sel || a === hover) {
        ctx.fillStyle = a.kind === 'host' ? '#24e3ff' : '#eae7f7';
        ctx.font = (a.kind === 'host' ? 600 : 400) + ' ' + (11 / view.k) + 'px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(a.label.length > 34 ? a.label.slice(0, 33) + '…' : a.label, a.x, a.y - a.r - 4 / view.k);
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    // minimap-ish day strip is DOM-side; here just keep the frame cheap
    frames++;
    if (!reduced && (alpha > 0.02 || frames < 240)) tick();
  }

  function tick() { step(); draw(); raf = requestAnimationFrame(function () { raf = null; draw(); }); }
  function reheat() { alpha = 1; if (!raf) tick(); }

  // ── interaction ────────────────────────────────────────────────────────────────
  function toWorld(ev) {
    var r = cvs.getBoundingClientRect();
    return { x: (ev.clientX - r.left - r.width / 2 - view.x) / view.k,
             y: (ev.clientY - r.top - r.height / 2 - view.y) / view.k };
  }
  function pick(p) {
    var best = null, bd = 1e9;
    for (var i = 0; i < G.nodes.length; i++) {
      var n = G.nodes[i];
      if (dim(n)) continue;
      var d = Math.hypot(n.x - p.x, n.y - p.y);
      if (d < Math.max(n.r + 5 / view.k, 9) && d < bd) { bd = d; best = n; }
    }
    return best;
  }
  var drag = null;
  cvs.addEventListener('pointerdown', function (ev) {
    var p = toWorld(ev), n = pick(p);
    drag = { n: n, px: ev.clientX, py: ev.clientY, vx: view.x, vy: view.y, moved: false };
    if (n) { n.fixed = true; cvs.setPointerCapture(ev.pointerId); }
    cvs.classList.add('dragging');
  });
  cvs.addEventListener('pointermove', function (ev) {
    var p = toWorld(ev);
    if (drag) {
      if (Math.abs(ev.clientX - drag.px) + Math.abs(ev.clientY - drag.py) > 3) drag.moved = true;
      if (drag.n) { drag.n.x = p.x; drag.n.y = p.y; reheat(); }
      else { view.x = drag.vx + (ev.clientX - drag.px); view.y = drag.vy + (ev.clientY - drag.py); draw(); }
      return;
    }
    var n = pick(p);
    if (n !== hover) { hover = n; draw(); }
    if (n) {
      tip.style.opacity = 1;
      tip.innerHTML = n.kind === 'host'
        ? '<b>' + esc(n.label) + '</b> <span class="m">' + n.count + ' findings · ' + n.verified + ' verified · top ' + esc(n.severity) + '</span>'
        : '<b>' + esc(n.severity) + '</b> ' + esc(n.label) + '<br><span class="m">' + esc(n.host) + ' · ' + esc(n.class || '') +
          (n.cvss != null ? ' · cvss ' + n.cvss : '') + (n.epss != null ? ' · epss ' + (n.epss * 100).toFixed(1) + '%' : '') +
          (n.in_chain ? ' · in chain' : '') + '</span>';
      var r = stage.getBoundingClientRect();
      var x = ev.clientX - r.left + 14, y = ev.clientY - r.top + 14;
      if (x + tip.offsetWidth > r.width) x = r.width - tip.offsetWidth - 8;
      if (y + tip.offsetHeight > r.height) y = y - tip.offsetHeight - 28;
      tip.style.left = x + 'px'; tip.style.top = y + 'px';
    } else { tip.style.opacity = 0; }
  });
  cvs.addEventListener('pointerup', function (ev) {
    if (drag && drag.n) drag.n.fixed = false;
    if (drag && !drag.moved && drag.n) showNode(drag.n);
    drag = null; cvs.classList.remove('dragging');
  });
  cvs.addEventListener('pointerleave', function () { tip.style.opacity = 0; hover = null; draw(); });
  cvs.addEventListener('wheel', function (ev) {
    ev.preventDefault();
    var k = view.k * (ev.deltaY < 0 ? 1.12 : 1 / 1.12);
    view.k = Math.max(0.2, Math.min(5, k));
    draw();
  }, { passive: false });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') { sel = null; drawer.dataset.open = '0'; draw(); }
  });

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function showNode(n) {
    sel = n;
    if (n.kind === 'host') {
      drawer.innerHTML = '<button id="close" aria-label="Close">×</button>' +
        '<h2>' + esc(n.label) + '</h2>' +
        '<p class="mono">' + n.count + ' findings · ' + n.verified + ' verified/confirmed · ' + n.chain_hits + ' chain links</p>' +
        '<h3>Findings</h3><ul>' + G.nodes.filter(function (x) { return x.kind === 'finding' && x.host === n.host; })
          .sort(function (x, y) { return y.severity_rank - x.severity_rank; })
          .map(function (x) { return '<li><span class="chip sev-' + esc(x.severity) + '">' + esc(x.severity) + '</span> ' + esc(x.title) + '</li>'; }).join('') + '</ul>';
    } else {
      drawer.innerHTML = '<button id="close" aria-label="Close">×</button>' +
        '<h2>' + esc(n.title) + '</h2>' +
        '<div class="chips"><span class="chip sev-' + esc(n.severity) + '">' + esc(n.severity) + '</span>' +
        '<span class="chip">' + esc(n.class) + '</span><span class="chip">' + esc(n.status) + '</span>' +
        (n.cvss != null ? '<span class="chip">cvss ' + n.cvss + '</span>' : '') +
        (n.epss != null ? '<span class="chip">epss ' + (n.epss * 100).toFixed(1) + '%</span>' : '') +
        (n.confidence ? '<span class="chip">conf ' + Math.round(n.confidence.score * 100) + '%</span>' : '') +
        (n.in_chain ? '<span class="chip">' + n.in_chain + ' chain</span>' : '') + '</div>' +
        (n.endpoint ? '<h3>Endpoint</h3><p class="mono">' + esc(n.endpoint) + '</p>' : '') +
        (n.poc ? '<h3>PoC</h3><p>' + esc(n.poc) + '</p>' : '') +
        (n.impact ? '<h3>Impact</h3><p>' + esc(n.impact) + '</p>' : '') +
        (n.remediation ? '<h3>Remediation</h3><p>' + esc(n.remediation) + '</p>' : '') +
        (n.cwe || (n.cves && n.cves.length) ? '<h3>Standards</h3><p class="mono">' +
          esc([n.cwe ? n.cwe + (n.cwe_title ? ' (' + n.cwe_title + ')' : '') : ''].concat(n.cves || []).filter(Boolean).join(' · ')) + '</p>' : '');
    }
    drawer.dataset.open = '1';
    var b = document.getElementById('close');
    if (b) b.onclick = function () { sel = null; drawer.dataset.open = '0'; draw(); };
    draw();
  }

  // ── chrome ─────────────────────────────────────────────────────────────────────
  var s = G.stats;
  document.getElementById('kpis').innerHTML =
    '<span class="kpi"><b>' + s.findings + '</b>findings</span>' +
    '<span class="kpi"><b>' + s.hosts + '</b>hosts</span>' +
    '<span class="kpi crit"><b>' + (s.severity.Critical || 0) + '</b>critical</span>' +
    '<span class="kpi high"><b>' + (s.severity.High || 0) + '</b>high</span>' +
    '<span class="kpi med"><b>' + (s.severity.Medium || 0) + '</b>medium</span>' +
    '<span class="kpi green"><b>' + s.verified + '</b>verified</span>' +
    '<span class="kpi"><b>' + s.chains + '</b>chains</span>';
  document.getElementById('legend').innerHTML =
    Object.keys(COLORS).map(function (k) { return '<span><i style="background:' + COLORS[k] + '"></i>' + k + '</span>'; }).join('') +
    '<span><i style="background:#eae7f7"></i>host</span>' +
    '<span><i style="background:var(--magenta)"></i>chain</span>' +
    '<span id="days">days: ' + (G.days.length ? G.days.map(function (d) {
      return '<a href="#" data-day="' + d.day + '" style="color:var(--faint)">' + d.day.slice(5) + '(' + d.total + ')</a>';
    }).join(' ') : '—') + '</span>';
  function paintDays() {
    var el = document.getElementById('days');
    if (!el) return;
    el.innerHTML = 'days: ' + G.days.map(function (d) {
      return '<a href="#" data-day="' + d.day + '" style="color:' + (filters.day === d.day ? 'var(--cyan)' : 'var(--faint)') + '">' +
        d.day.slice(5) + '(' + d.total + ')</a>';
    }).join(' ');
  }
  document.getElementById('foot').textContent =
    'seed ' + G.seed.toString(16) + ' · generated ' + (${JSON.stringify(String(m.generatedAt || ''))}) +
    ' · zero egress, no external requests';

  var tb = document.getElementById('toolbar');
  tb.addEventListener('click', function (ev) {
    var b = ev.target.closest('button'); if (!b) return;
    if (b.dataset.sev) {
      var on = !filters.sev[b.dataset.sev];
      if (on) filters.sev[b.dataset.sev] = 1; else delete filters.sev[b.dataset.sev];
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    } else if (b.id === 'chains') {
      filters.chainsOnly = !filters.chainsOnly;
      b.setAttribute('aria-pressed', filters.chainsOnly ? 'true' : 'false');
    } else if (b.id === 'reheat') { alpha = 1; }
    draw();
  });
  document.getElementById('legend').addEventListener('click', function (ev) {
    var a = ev.target.closest('a[data-day]'); if (!a) return;
    ev.preventDefault();
    filters.day = filters.day === a.dataset.day ? null : a.dataset.day;
    paintDays();
    draw();
  });
  var q = document.getElementById('q');
  q.addEventListener('input', function () { filters.q = q.value.trim(); draw(); });

  // Frame the whole engagement: run the physics to convergence BEFORE the first paint, then
  // fit the view to the bounding box. Without this, a host seeded far out lands off-canvas
  // and the operator has to hunt for it.
  function fit() {
    var w = stage.clientWidth, h = stage.clientHeight;
    var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    G.nodes.forEach(function (n) {
      var pad = n.r + 18;                       // room for the label above the node
      x0 = Math.min(x0, n.x - pad); y0 = Math.min(y0, n.y - pad);
      x1 = Math.max(x1, n.x + pad); y1 = Math.max(y1, n.y + pad);
    });
    if (!(x1 > x0)) return;
    view.k = Math.max(0.2, Math.min(2.4, Math.min(w / (x1 - x0), h / (y1 - y0)) * 0.92));
    view.x = -((x0 + x1) / 2) * view.k;
    view.y = -((y0 + y1) / 2) * view.k;
  }
  function settle(n) { for (var i = 0; i < n; i++) step(); alpha = 1; }

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { settle(120); fit(); draw(); }, 120);
  });
  settle(reduced ? 600 : 420);
  fit();
  draw();
  if (!reduced) reheat();
})();
</script>
</body>
</html>
`;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────────
function main() {
  const argv = process.argv.slice(2);
  const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  const findingsFile = opt('--findings') || process.env.FINDINGS_JSONL || path.join(ROOT, 'reports', 'findings.jsonl');
  const outFile = opt('--out') || OUT_DEFAULT;
  const hostFilter = opt('--host');

  const findings = loadFindings(findingsFile);
  const filtered = hostFilter
    ? findings.filter((f) => String(f.host || '').replace(/^https?:\/\//, '') === hostFilter)
    : findings;
  const chains = buildChains(filtered);
  const galaxy = buildGalaxy(filtered, chains);

  if (argv.includes('--print')) {
    const hosts = galaxy.nodes.filter((n) => n.kind === 'host')
      .sort((a, b) => b.count - a.count || a.host.localeCompare(b.host))
      .map((n) => `${n.severity.padEnd(8)} ${String(n.count).padStart(2)}  ${n.host} (${n.chain_hits} chain links)`);
    console.log(JSON.stringify({ seed: galaxy.seed, stats: galaxy.stats, hosts }, null, 2));
    return;
  }

  const html = buildHtml(galaxy, { host: hostFilter || 'all hosts', generatedAt: new Date().toISOString() });
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const tmp = outFile + '.' + process.pid;
  fs.writeFileSync(tmp, html);
  fs.renameSync(tmp, outFile);
  console.log(JSON.stringify({ ok: true, out: outFile, findings: galaxy.stats.findings, hosts: galaxy.stats.hosts, chains: galaxy.stats.chains, bytes: html.length }));
}

if (require.main === module) main();

module.exports = { buildGalaxy, buildHtml, embedJson, fnv1a, rng, dayKey, SEV_ORDER };
