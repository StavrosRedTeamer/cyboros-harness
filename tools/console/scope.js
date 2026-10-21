// Console — the engagement authorization file (scope.json).
//
// Why it is its own module: this is the one file the console writes that decides what
// is allowed to happen, so its rules — GUI-side validation, backup before write, a
// fingerprint note naming the actor, explicit consent before shrinking the
// authorization — live together and nowhere else. scope-guard stays the runtime
// truth; this module never replaces it, it only edits the file it reads.
'use strict';
const fs = require('fs');
const net = require('net');

function createScopeStore(opts) {
  const scopeFile = opts.scopeFile;
  const files = opts.files;

  function load() {
    const raw = files.readJsonFile(scopeFile, {});
    const hosts = Array.isArray(raw.allowed_hosts) ? raw.allowed_hosts : [];
    const prefixes = Array.isArray(raw.allowed_url_prefixes) ? raw.allowed_url_prefixes : [];
    const ips = Array.isArray(raw.allowed_ips) ? raw.allowed_ips : [];
    const rps = raw.max_requests_per_second;
    return {
      allowed_hosts: hosts, allowed_url_prefixes: prefixes, allowed_ips: ips,
      max_requests_per_second: typeof rps === 'number' ? rps : 2,
      host_ops: raw.host_ops || null, notes: raw.notes || '', _comment: raw._comment || '',
      failClosed: hosts.length === 0 && prefixes.length === 0 && ips.length === 0,
      mtime: files.fileMtime(scopeFile),
    };
  }

  function check(url) {
    try {
      const sg = require('../scope-guard');
      return sg.inScope(url, sg.loadScope());
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  }

  // ── scope validation (GUI-side rules; scope-guard stays the runtime truth) ──
  function validate(body) {
    const problems = [];
    const hosts = [];
    for (const raw of Array.isArray(body.allowed_hosts) ? body.allowed_hosts : []) {
      const h = String(raw).trim().toLowerCase();
      if (!h) continue;
      if (/\s|\/|:/.test(h) || h.includes('://')) { problems.push('invalid host: ' + h); continue; }
      hosts.push(h);
    }
    const prefixes = [];
    for (const raw of Array.isArray(body.allowed_url_prefixes) ? body.allowed_url_prefixes : []) {
      const p = String(raw).trim();
      if (!p) continue;
      if (!/^https?:\/\//.test(p) || /\s/.test(p)) { problems.push('invalid url prefix: ' + p); continue; }
      prefixes.push(p);
    }
    const ips = [];
    for (const raw of Array.isArray(body.allowed_ips) ? body.allowed_ips : []) {
      const ip = String(raw).trim();
      if (!ip) continue;
      if (ip.includes('/')) {
        const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(ip);
        if (!m) { problems.push('invalid CIDR: ' + ip); continue; }
        if (m[1].split('.').some((o) => parseInt(o, 10) > 255) || parseInt(m[2], 10) > 32) {
          problems.push('invalid CIDR: ' + ip); continue;
        }
      } else if (net.isIP(ip) === 0) { problems.push('invalid IP: ' + ip); continue; }
      ips.push(ip);
    }
    let rps = 2;
    if (body.max_requests_per_second != null) {
      rps = parseInt(body.max_requests_per_second, 10);
      if (!Number.isFinite(rps) || rps < 1 || rps > 600) { problems.push('max_requests_per_second must be 1..600'); rps = 2; }
    }
    return { hosts, prefixes, ips, rps, problems };
  }

  function save(body, actor) {
    const v = validate(body);
    if (v.problems.length) return { ok: false, problems: v.problems };
    const cur = files.readJsonFile(scopeFile, {});
    const prevHosts = new Set(Array.isArray(cur.allowed_hosts) ? cur.allowed_hosts.map((h) => h.toLowerCase()) : []);
    const added = v.hosts.filter((h) => !prevHosts.has(h));
    const removed = [...prevHosts].filter((h) => !v.hosts.includes(h));
    const stamp = new Date().toISOString();
    const noteBits = [];
    if (added.length) noteBits.push('added ' + added.length + ' host(s): ' + added.join(', '));
    if (removed.length) noteBits.push('removed ' + removed.length + ' host(s): ' + removed.join(', '));
    if (noteBits.length || cur.max_requests_per_second !== v.rps) {
      if (cur.max_requests_per_second !== v.rps) noteBits.push('rps ' + (cur.max_requests_per_second || 2) + ' -> ' + v.rps);
    }
    const next = Object.assign({}, cur, {
      allowed_hosts: v.hosts,
      allowed_url_prefixes: v.prefixes,
      allowed_ips: v.ips,
      max_requests_per_second: v.rps,
    });
    if (noteBits.length) {
      // Who authorized the change belongs in the authorization file itself: the
      // note is what a reviewer reads when asking "who widened scope?".
      const by = actor ? ' by ' + actor : '';
      const line = stamp.slice(0, 10) + ': Cyboros Console update' + by + ' — ' + noteBits.join('; ');
      next.notes = (cur.notes ? cur.notes.trimEnd() + '\n' : '') + line;
    }
    // L'autorizzazione scritta non si accorcia per sbaglio: togliere host è l'unica modifica che
    // può rendere inutilizzabile un engagement partito bene, quindi pretende un consenso esplicito.
    if (removed.length && body.confirm_removals !== true) {
      return { ok: false, problems: [`rimuoverebbe ${removed.length} host dall'autorizzazione (${removed.join(', ')}): conferma con confirm_removals:true`] };
    }
    const serialized = JSON.stringify(next, null, 2) + '\n';
    try { JSON.parse(serialized); } catch (e) {
      return { ok: false, problems: ['il risultato non è JSON valido, scrittura annullata: ' + e.message] };
    }
    // Una copia di sicurezza prima di ogni scrittura (scope.*.bak.json è gitignored): se qualcosa
    // dovesse produrre un file inutilizzabile, la versione precedente è ancora sul disco.
    try {
      if (fs.existsSync(scopeFile)) fs.copyFileSync(scopeFile, scopeFile + '.bak.json');
    } catch { /* la copia è un'assicurazione, non un requisito: non blocca la scrittura */ }
    files.atomicWrite(scopeFile, serialized);
    const after = load();
    return { ok: true, failClosed: after.failClosed, added: added.length, removed: removed.length, mtime: after.mtime };
  }

  return { load, check, save };
}

module.exports = { createScopeStore };
