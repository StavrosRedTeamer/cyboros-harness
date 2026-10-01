#!/usr/bin/env node
// WP6 — Graph: read-only projection of the engagement into a HOST-CENTRIC exposure map.
//
// Two sources, merged, because they are two halves of the same truth:
//   · the target model (reports/state.db) — what was SCANNED: hosts, ports, services,
//     endpoints and the findings ingested from nuclei;
//   · the ledger (reports/findings.jsonl) — what the operator PROVED: the findings written by
//     record-finding.js, which never live in the model.
// Reading only the model made the map answer "what did nmap see" instead of "what is exposed":
// on a real engagement it showed 4 scanned hosts while the ledger held 128 findings over 27
// hosts, and the operator had no way to tell the difference from the panel.
//
// The unit is still the host — one entry per address/hostname, merged across targets, so an
// asset reached both by IP and by name is one host instead of two. Never writes to state.db
// (target-model.open is read-only wrt the model) and never touches scope/guard.
//
// CLI: node tools/cc-graph.js [--json]   (env STATE_DB, FINDINGS_JSONL, CC_ROOT)
'use strict';
const path = require('path');
const u = require('./cc-util');

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];
const SEV_WEIGHT = { critical: 10, high: 5, medium: 2, low: 1, info: 0 };

const root = () => process.env.CC_ROOT || u.ROOT;
const findingsFile = () => process.env.FINDINGS_JSONL || path.join(root(), 'reports', 'findings.jsonl');

function severityOf(v) {
  const s = String(v == null ? '' : v).toLowerCase();
  return SEVERITIES.includes(s) ? s : 'info';
}

function stateBucket(state) {
  const st = String(state == null ? '' : state).toLowerCase();
  if (st === 'open') return 'open';
  if (st.includes('filtered')) return 'filtered';
  if (st === 'closed') return 'closed';
  return 'other';
}

function emptySev() {
  const out = { total: 0 };
  for (const s of SEVERITIES) out[s] = 0;
  return out;
}

function failure(error) {
  return {
    generated_at: new Date().toISOString(),
    targets: [], hosts: [], unassigned: { endpoints: [], vulns: [] }, empty_targets: [],
    counts: { targets: 0, hosts: 0, ports: 0, open_ports: 0, endpoints: 0, vulns: 0, ledger_findings: 0, hosts_with_findings: 0, empty_targets: 0, findings: emptySev() },
    error: String((error && error.message) || error),
  };
}

// One line of reports/findings.jsonl -> the shape the map reasons about.
function ledgerFindings() {
  return u.readJsonl(findingsFile())
    .map((f) => ({
      host: f.host ? String(f.host) : null,
      title: f.title || f.class || 'finding',
      class: f.class || null,
      severity: severityOf(f.severity),
      url: f.endpoint || f.url || null,
      status: f.status || null,
      verify_level: f.verify_level || null,
      cvss: f.cvss != null ? f.cvss : null,
      ts: f.ts || null,
    }))
    .filter((f) => f.host);
}

const urlKey = (v) => String(v || '').toLowerCase().replace(/\/+$/, '');

function build() {
  let snap = { targets: [] };
  let hostnameOf;
  let modelError = null;
  try {
    const tm = require('./target-model');
    hostnameOf = tm.hostnameOf;
    const db = tm.open();
    try { snap = tm.snapshot(db); }
    finally { if (db && typeof db.close === 'function') db.close(); }
  } catch (e) {
    modelError = String((e && e.message) || e);
  }

  const hosts = [];              // ordered list of host records
  const byKey = new Map();       // primary key (address, else hostname) -> host record
  const index = new Map();       // alias (address or lowercase hostname) -> host record
  const unassigned = { endpoints: [], vulns: [] };

  // A host is keyed by its address; a host without an address falls back to its hostname.
  // Every address/hostname alias points at the same record, so a target seen by IP and a
  // target seen by name merge into one host instead of fragmenting the model.
  function ensureHost(address, hostname, os, alive) {
    const key = String(address || hostname || '').toLowerCase();
    if (!key) return null;
    let host = byKey.get(key);
    if (!host) {
      host = {
        id: 'host:' + key,
        address: address || null,
        hostname: hostname || null,
        os: os || null,
        alive: alive !== false,
        in_model: false,
        in_ledger: false,
        targets: [],
        ports: [],
        endpoints: [],
        vulns: [],
        _ports: new Map(),
        _endpoints: new Set(),
        _vulns: new Set(),
      };
      byKey.set(key, host);
      hosts.push(host);
    } else {
      if (!host.address && address) host.address = address;
      if (!host.hostname && hostname) host.hostname = hostname;
      if (!host.os && os) host.os = os;
      if (host.alive === false && alive !== false) host.alive = true;
    }
    if (address) index.set(String(address).toLowerCase(), host);
    if (hostname) index.set(String(hostname).toLowerCase(), host);
    return host;
  }

  for (const t of (snap.targets || [])) {
    const targetHosts = [];
    for (const h of (t.hosts || [])) {
      const host = ensureHost(h.address, h.hostname, h.os, h.alive);
      if (!host) continue;
      host.in_model = true;
      if (!host.targets.includes(t.host)) host.targets.push(t.host);
      targetHosts.push(host);
      for (const p of (h.ports || [])) {
        const pk = p.port + '/' + (p.protocol || 'tcp');
        const seen = host._ports.get(pk);
        if (seen) {
          // Same port observed under two targets: keep the richest fingerprint and let a
          // later "open" win — a port is actionable if any scan saw it open.
          if (!seen.service && p.service) seen.service = p.service;
          if (!seen.version && p.version) seen.version = p.version;
          if (seen.state !== 'open' && p.state === 'open') seen.state = 'open';
          continue;
        }
        host._ports.set(pk, {
          port: p.port,
          protocol: p.protocol || 'tcp',
          service: p.service || null,
          version: p.version || null,
          state: p.state || 'unknown',
        });
      }
    }
    // When a target has exactly one host, hostname URLs that don't resolve in the index still
    // belong to it (the operator scanned one box and then browsed it by name).
    const fallback = targetHosts.length === 1 ? targetHosts[0] : null;

    for (const e of (t.endpoints || [])) {
      const host = index.get(String(hostnameOf(e.url) || '').toLowerCase()) || fallback;
      if (!host) { unassigned.endpoints.push({ target: t.host, url: e.url, method: e.method || 'GET', tech: e.tech || null, auth: !!e.auth }); continue; }
      const ek = (e.method || 'GET') + ' ' + e.url;
      if (host._endpoints.has(ek)) continue;
      host._endpoints.add(ek);
      host.endpoints.push({ method: e.method || 'GET', url: e.url, tech: e.tech || null, auth: !!e.auth });
    }

    for (const v of (t.vulns || [])) {
      const host = index.get(String(hostnameOf(v.url) || '').toLowerCase())
        || index.get(String(v.host || '').toLowerCase())
        || fallback;
      const row = {
        class: v.class || null,
        template_id: v.template_id || null,
        label: v.template_id || v.class || 'finding',
        severity: severityOf(v.severity),
        cve: v.cve || null,
        url: v.url || null,
        source: 'model',
        status: null,
        verify_level: null,
        cvss: null,
      };
      if (!host) { unassigned.vulns.push(Object.assign({ target: t.host }, row)); continue; }
      const vk = [row.template_id, row.url, row.class].join('|');
      if (host._vulns.has(vk)) continue;
      host._vulns.add(vk);
      host.vulns.push(row);
    }
  }

  // ── ledger findings: what the operator recorded, whether or not it was ever scanned ──────
  // A finding whose host has no model row still gets a host card: otherwise the engagement is
  // invisible exactly where it matters most (a proven finding on an asset we never port-scanned).
  let ledgerCount = 0;
  for (const f of ledgerFindings()) {
    const host = index.get(f.host.toLowerCase()) || ensureHost(null, f.host, null, true);
    if (!host) { unassigned.vulns.push(Object.assign({ target: null }, f)); continue; }
    host.in_ledger = true;
    if (!host.targets.includes(f.host)) host.targets.push(f.host);
    const key = 'ledger|' + (f.url || '') + '|' + f.title;
    // Skip only a genuine duplicate of an INGESTED finding; two ledger findings on the same
    // endpoint are two findings, not one (deduping on url+severity silently lost 8 of 128).
    const already = host._vulns.has(key)
      || (f.url && host.vulns.some((v) => v.source === 'model' && urlKey(v.url) === urlKey(f.url) && v.severity === f.severity));
    if (already) continue;
    host._vulns.add(key);
    host.vulns.push({
      class: f.class, template_id: null, label: f.title, severity: f.severity, cve: null,
      url: f.url, source: 'ledger', status: f.status, verify_level: f.verify_level, cvss: f.cvss, ts: f.ts,
    });
    ledgerCount++;
  }

  const counts = { targets: (snap.targets || []).length, hosts: hosts.length, ports: 0, open_ports: 0, endpoints: unassigned.endpoints.length, vulns: unassigned.vulns.length, ledger_findings: ledgerCount, hosts_with_findings: 0, empty_targets: 0, findings: emptySev() };

  for (const host of hosts) {
    host.ports = [...host._ports.values()].sort((a, b) => a.port - b.port);
    delete host._ports;
    delete host._endpoints;
    delete host._vulns;

    const port_counts = { open: 0, filtered: 0, closed: 0, other: 0, total: host.ports.length };
    for (const p of host.ports) port_counts[stateBucket(p.state)]++;

    // Services are what the operator reasons about; the raw port list is noise. Group by the
    // fingerprinted service name and keep the ports that advertise it — OPEN only: a filtered
    // or closed port with a fingerprint is not exposure and must not be read as one.
    const svc = new Map();
    for (const p of host.ports) {
      if (!p.service || stateBucket(p.state) !== 'open') continue;
      if (!svc.has(p.service)) svc.set(p.service, { name: p.service, ports: [], versions: [] });
      const g = svc.get(p.service);
      if (!g.ports.includes(p.port)) g.ports.push(p.port);
      if (p.version && !g.versions.includes(p.version)) g.versions.push(p.version);
    }
    host.services = [...svc.values()].sort((a, b) => a.ports[0] - b.ports[0]);
    host.port_counts = port_counts;
    host.source = host.in_model ? (host.in_ledger ? 'both' : 'model') : 'ledger';

    const sev = emptySev();
    for (const v of host.vulns) sev[v.severity]++;
    sev.total = host.vulns.length;
    host.sev = sev;
    host.risk = SEVERITIES.reduce((n, s) => n + sev[s] * SEV_WEIGHT[s], 0) + (port_counts.open ? 0.5 : 0);

    host.endpoints.sort((a, b) => String(a.url).localeCompare(String(b.url)));
    host.vulns.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || String(a.label).localeCompare(String(b.label)));

    counts.ports += port_counts.total;
    counts.open_ports += port_counts.open;
    counts.endpoints += host.endpoints.length;
    counts.vulns += host.vulns.length;
    if (host.vulns.length) counts.hosts_with_findings++;
    for (const s of SEVERITIES) counts.findings[s] += sev[s];
  }
  counts.findings.total = counts.findings.critical + counts.findings.high + counts.findings.medium + counts.findings.low + counts.findings.info;

  // A target that contributed nothing — no host, no endpoint, no finding, and no ledger finding
  // naming it — is a scan that created the target and ingested nothing. It used to be invisible,
  // which is why the panel could claim 8 targets over 4 drawn hosts.
  const covered = new Set();
  for (const host of hosts) for (const t of host.targets) covered.add(t);
  const emptyTargets = (snap.targets || [])
    .filter((t) => !(t.hosts || []).length && !(t.endpoints || []).length && !(t.vulns || []).length)
    .map((t) => t.host)
    .filter((t) => !covered.has(t));
  counts.empty_targets = emptyTargets.length;

  // Highest risk first; ties broken by address so the same engagement always draws the same order.
  hosts.sort((a, b) => b.risk - a.risk
    || String(a.address || a.hostname || '').localeCompare(String(b.address || b.hostname || '')));

  return {
    generated_at: new Date().toISOString(),
    targets: (snap.targets || []).map((t) => t.host),
    hosts,
    empty_targets: emptyTargets,
    unassigned,
    counts,
    error: modelError,
    findings_source: findingsFile(),
  };
}

if (require.main === module) {
  console.log(JSON.stringify(build(), null, 2));
}

module.exports = { build };
