#!/usr/bin/env node
// Stavros cloud-enum — cloud asset & IAM enumeration. Today the cloud surface is only metadata-via-
// SSRF; this adds (1) public bucket/asset discovery (S3/GCS/Azure) and (2) READ-ONLY IAM
// enumeration from a LOOTED key. Both stay inside the harness invariants:
//   - Bucket probes are scope-checked (the derived bucket host must be authorized in scope.json —
//     add the cloud asset domains/buckets to scope before probing). Fail-closed like every request.
//   - IAM enumeration uses a key pulled from the gitignored loot vault (never argv/env-in-audit).
//     Read-only calls (sts get-caller-identity, iam get-*/list-*) are AUTO; any write/create/delete
//     action is CONFIRM-tier and is NOT assembled here.
//
//   node tools/cloud-enum.js buckets <base> [--wordlist f]     candidate names + public-ACL probe
//   node tools/cloud-enum.js classify <url>                    provider fingerprint of a URL
//   node tools/cloud-enum.js iam --provider aws --loot-id <id> read-only identity/permission enum
//
// ponytail: bucket naming is heuristic and provider ACL semantics differ; a "public" verdict is a
// lead — confirm the listing/objects per report. IAM output is provider CLI text, parsed loosely.
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const { loadScope, inScope } = require('./scope-guard');
const { resolveAndGuard } = require('./net');
const run = require('./run');

const LOOT = () => process.env.LOOT_JSONL || path.join(__dirname, '..', 'reports', 'loot.jsonl');
const AUDIT_FILE = () => process.env.RUN_AUDIT_FILE || path.join(__dirname, '..', 'reports', 'tmp', 'run-audit.jsonl');
function audit(e) { try { const p = AUDIT_FILE(); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.appendFileSync(p, JSON.stringify(Object.assign({ ts: new Date().toISOString(), tool: 'cloud-enum' }, e)) + '\n'); } catch {} }

// ---- provider fingerprint ---------------------------------------------------
function classify(url) {
  const u = String(url || '');
  if (/\.s3[.-][\w-]*\.?amazonaws\.com|\.s3\.amazonaws\.com|s3\.amazonaws\.com\//i.test(u)) return 'aws-s3';
  if (/storage\.googleapis\.com|\.storage\.googleapis\.com/i.test(u)) return 'gcs';
  if (/\.blob\.core\.windows\.net/i.test(u)) return 'azure-blob';
  return null;
}

// ---- bucket name candidates (pure) ------------------------------------------
function candidates(base, extra) {
  const b = String(base || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
  const affixes = ['', '-dev', '-prod', '-staging', '-backup', '-backups', '-assets', '-static', '-media', '-uploads', '-data', '-logs', '-public', '-private', '-cdn', '-www'];
  const names = new Set();
  for (const a of affixes) { names.add(b + a); names.add(a.replace(/^-/, '') + '-' + b); }
  for (const w of extra || []) names.add(`${b}-${w}`);
  names.delete('-' + b); names.delete(b + '-');
  return [...names].filter(Boolean);
}

function bucketUrls(name) {
  return {
    'aws-s3': `https://${name}.s3.amazonaws.com/`,
    gcs: `https://storage.googleapis.com/${name}/`,
    'azure-blob': `https://${name}.blob.core.windows.net/?comp=list`,
  };
}

// ---- scope-safe HEAD/GET (injectable) ---------------------------------------
function realProbe(url, timeoutMs) {
  return new Promise((resolve) => {
    const scope = loadScope();
    const g = inScope(url, scope);
    if (!g.ok) return resolve({ blocked: g.reason });
    resolveAndGuard(url, scope).then((pin) => {
      if (pin.blocked) return resolve({ blocked: pin.reason });
      const U = new URL(url);
      const opts = { hostname: pin.address, port: 443, path: U.pathname + U.search, method: 'GET', headers: { Host: U.hostname, 'User-Agent': 'stavros-cloud/0.1' }, timeout: timeoutMs || 8000, lookup: (h, o, cb) => cb(null, pin.address, pin.family) };
      const req = https.request(opts, (res) => { let d = ''; res.on('data', (c) => (d += c.length > 2048 ? '' : c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d })); });
      req.on('timeout', () => { req.destroy(); resolve({ blocked: 'timeout' }); });
      req.on('error', (e) => resolve({ blocked: e.message }));
      req.end();
    });
  });
}

function classifyBucketResult(provider, res) {
  if (!res || res.blocked) return { state: 'skipped', reason: res && res.blocked };
  const s = res.status;
  const body = String(res.body || '');
  if (s === 200 && (/<ListBucketResult|<EnumerationResults|"items"|<Contents>/i.test(body) || provider === 'gcs')) return { state: 'public-listable', severity: 'High' };
  if (s === 200) return { state: 'public', severity: 'Medium' };
  if (s === 403) return { state: 'exists-private', severity: 'Info' };
  if (s === 404) return { state: 'absent' };
  return { state: 'unknown', status: s };
}

async function probeBuckets(base, opts) {
  opts = opts || {};
  const probe = opts.probe || realProbe;
  const names = candidates(base, opts.extra);
  const providers = opts.providers || ['aws-s3', 'gcs', 'azure-blob'];
  const hits = [];
  for (const name of names) {
    const urls = bucketUrls(name);
    for (const prov of providers) {
      const url = urls[prov];
      const res = await probe(url, opts.timeoutMs);
      const verdict = classifyBucketResult(prov, res);
      audit({ op: 'bucket', provider: prov, name, state: verdict.state });
      if (verdict.state && verdict.state !== 'absent' && verdict.state !== 'skipped') hits.push({ provider: prov, name, url, ...verdict });
    }
  }
  return { ok: true, base, tested: names.length, hits };
}

// ---- IAM enumeration from a looted key (read-only command assembly) ---------
function readLootKey(lootId) {
  try {
    const lines = fs.readFileSync(LOOT(), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    return lootId ? lines.find((e) => e.loot_id === lootId) : lines.find((e) => /AKIA|aws|access.?key/i.test(e.title || '') || /^AKIA/.test(e.secret || ''));
  } catch { return null; }
}

// Read-only enumeration commands per provider. NO write/create/delete verbs are ever emitted here.
function iamReadCommands(provider) {
  if (provider === 'aws') return [['aws', ['sts', 'get-caller-identity']], ['aws', ['iam', 'get-account-authorization-details', '--max-items', '50']], ['aws', ['iam', 'list-attached-user-policies', '--user-name', 'self']]];
  if (provider === 'gcp') return [['gcloud', ['auth', 'list']], ['gcloud', ['projects', 'list']]];
  if (provider === 'azure') return [['az', ['account', 'show']], ['az', ['role', 'assignment', 'list']]];
  return [];
}

async function enumIam(provider, opts) {
  opts = opts || {};
  const key = opts.key || readLootKey(opts.lootId);
  if (!key) return { ok: false, reason: 'no cloud key in loot vault (record one via record-finding.js secret field first)' };
  const cmds = iamReadCommands(provider);
  if (!cmds.length) return { ok: false, reason: `unknown provider '${provider}'` };
  audit({ op: 'iam-enum', provider, loot_id: key.loot_id, cmds: cmds.length });

  const runner = opts.runner || ((bin, args, env) => run.runBinary(bin, args, { capture: true, timeoutMs: 30000, env }));
  // Credentials go to the child via ENV, never argv (so they never hit the audit line / process table).
  const env = Object.assign({}, process.env);
  if (provider === 'aws' && /:/.test(key.secret || '')) { const [id, sec] = key.secret.split(':'); env.AWS_ACCESS_KEY_ID = id; env.AWS_SECRET_ACCESS_KEY = sec; }
  const out = [];
  for (const [bin, args] of cmds) { const r = await runner(bin, args, env); out.push({ cmd: `${bin} ${args.join(' ')}`, status: r && r.status, sample: String((r && (r.stdout || r.output)) || '').slice(0, 400) }); }
  return { ok: true, provider, loot_id: key.loot_id, results: out };
}

module.exports = { classify, candidates, bucketUrls, classifyBucketResult, probeBuckets, iamReadCommands, enumIam, readLootKey };

// ---- CLI --------------------------------------------------------------------
async function main() {
  const [cmd, arg] = process.argv.slice(2);
  const rest = process.argv.slice(4);
  const get = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
  if (cmd === 'classify') { console.log(classify(arg) || 'unknown'); return; }
  if (cmd === 'buckets') { const res = await probeBuckets(arg, {}); console.log(JSON.stringify(res, null, 2)); process.exit(res.ok ? 0 : 1); }
  if (cmd === 'iam') { const res = await enumIam(get('--provider'), { lootId: get('--loot-id') }); console.log(JSON.stringify(res, null, 2)); process.exit(res.ok ? 0 : 1); }
  console.error('usage: node tools/cloud-enum.js <buckets <base>|classify <url>|iam --provider aws --loot-id <id>>');
  process.exit(2);
}
if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
