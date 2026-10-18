#!/usr/bin/env node
// Bundle secret/endpoint miner (zero-dep). The harness's best finding source, made deterministic.
//   node tools/analyze-bundle.js <url|localfile>
// URL fetches are scope-guarded (DNS/IP-pinned). Extracts JWTs (decoded), Supabase projects,
// common secret patterns, endpoint paths — and FOLLOWS sourceMappingURL references to pull
// sourcesContent out of the .map files (reconstructed source is where the richest secrets live).
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { loadScope, inScope } = require('./scope-guard');
const { resolveAndGuard } = require('./net');

// Credential VALIDATION (opt-in, egress). Extraction finds candidate secrets; extraction alone
// cannot tell a live key from a revoked one, and that difference is the whole edge between a
// `suspected` finding and an `exploited` one (the one chain.js already models as "leaked key +
// broken authz -> ATO"). TruffleHog closes it: it tries the credential and reports whether it
// authenticates.
//
// Two properties this must not break, both of which the extractor already holds:
//   1. the full secret value is NEVER persisted. Extraction emits value_preview (6+4 chars) and
//      pipes stdout through privacy.tokenize; validation writes the raw value to a 0600 temp file
//      OUTSIDE the workspace and unlinks it in a finally, so nothing lands in reports/ or in git;
//   2. validation is EGRESS — it calls the credential provider's API — so it is confirm-tier.
//      It refuses without an explicit --confirm "<reason>", exactly like portal.js serve.
// Default behaviour (no flag) is unchanged: pure offline extraction.

// A redirect must land back in scope, or the whole point of the guard is gone.
function resolveRedirect(location, base, scope) {
  const next = new URL(location, base).toString();
  if (!inScope(next, scope).ok) throw new Error('redirect to out-of-scope host blocked: ' + next);
  return next;
}

async function fetch(url, scope) {
  const pin = await resolveAndGuard(url, scope);
  if (pin.blocked) throw new Error(pin.reason);
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    lib
      .get(url, { lookup: (h, o, cb) => cb(null, [{ address: pin.address, family: pin.family }]) }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          let next;
          try {
            next = resolveRedirect(res.headers.location, url, scope);
          } catch (e) {
            return reject(e);
          }
          return resolve(fetch(next, scope));
        }
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve(d));
      })
      .on('error', reject);
  });
}

function b64urlJson(seg) {
  try {
    return JSON.parse(Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function uniq(arr) {
  return [...new Set(arr)];
}

// One list of secret patterns, shared by extraction (analyze -> value_preview, masked) and
// validation (secretValues -> the raw value, never persisted). Keeping a single source means the
// two paths cannot drift into disagreeing about what counts as a candidate.
const SECRET_PATTERNS = [
  ['aws_access_key', /AKIA[0-9A-Z]{16}/g],
  ['google_api_key', /AIza[0-9A-Za-z_-]{35}/g],
  ['stripe_live', /sk_live_[0-9A-Za-z]{16,}/g],
  ['github_pat', /ghp_[0-9A-Za-z]{36}/g],
  ['slack_token', /xox[baprs]-[0-9A-Za-z-]{10,}/g],
  ['sentry_dsn', /https:\/\/[0-9a-f]+@o?[0-9]*\.ingest\.[a-z.]*sentry\.io\/[0-9]+/g],
  ['private_key', /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g],
  // generic "key/secret/token/password: 'value'" assignments with a non-trivial value
  ['generic_assignment', /["'`]?(?:api[_-]?key|secret|token|password|auth[_-]?key|apikey)["'`]?\s*[:=]\s*["'`]([^"'`\s]{8,})["'`]/gi],
];

function analyze(text) {
  const out = { jwts: [], supabase_projects: [], secrets: [], sourcemaps: [], endpoints: [] };

  for (const j of text.match(/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]+)?/g) || []) {
    const p = b64urlJson(j.split('.')[1]);
    if (p)
      out.jwts.push({
        role: p.role || null,
        ref: p.ref || null,
        iss: p.iss || null,
        exp: p.exp || null,
        preview: j.slice(0, 24) + '...',
      });
  }
  out.jwts = uniq(out.jwts.map((x) => JSON.stringify(x))).map((s) => JSON.parse(s));

  out.supabase_projects = uniq((text.match(/https:\/\/[a-z0-9]{20}\.supabase\.co/g) || []).map((s) => s));

  for (const [type, re] of SECRET_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const val = m[1] || m[0];
      out.secrets.push({ type, value_preview: val.length > 12 ? val.slice(0, 6) + '…' + val.slice(-4) : val });
    }
  }
  out.secrets = uniq(out.secrets.map((x) => JSON.stringify(x))).map((s) => JSON.parse(s));

  out.sourcemaps = uniq((text.match(/sourceMappingURL=([^\s*]+)/g) || []).map((s) => s.replace('sourceMappingURL=', '')));

  const eps = [];
  for (const m of text.matchAll(/["'`](\/(?:api|rest|functions|v[0-9])\/[A-Za-z0-9_\/.-]{1,80})["'`]/g)) eps.push(m[1]);
  for (const m of text.matchAll(/["'`](\/[A-Za-z0-9_-]{2,40}(?:\/[A-Za-z0-9_:{}-]{1,40}){0,5})["'`]/g)) eps.push(m[1]);
  out.endpoints = uniq(eps).slice(0, 200);

  return out;
}

// Follow sourceMappingURL refs, pull sourcesContent out of each .map (scope-guarded, depth-limited),
// and return the reconstructed texts + the list of map URLs. Recurses into nested maps.
async function mineSourcemaps(text, baseUrl, scope, depth) {
  const seen = new Set();
  const texts = [text];
  const maps = [];

  async function walk(srcText, base, d) {
    if (d > 3) return;
    const re = /sourceMappingURL=([^\s*]+)/g;
    let m;
    while ((m = re.exec(srcText))) {
      let mapUrl;
      try {
        mapUrl = new URL(m[1], base).toString();
      } catch {
        continue;
      }
      if (seen.has(mapUrl)) continue;
      seen.add(mapUrl);
      if (!inScope(mapUrl, scope).ok) continue; // never fetch an out-of-scope map
      let mapText;
      try {
        mapText = await fetch(mapUrl, scope);
      } catch {
        continue;
      }
      let parsed;
      try {
        parsed = JSON.parse(mapText);
      } catch {
        continue;
      }
      maps.push(mapUrl);
      const sources = parsed.sources || [];
      const contents = parsed.sourcesContent || [];
      for (let i = 0; i < sources.length; i++) {
        if (typeof contents[i] === 'string' && contents[i]) {
          texts.push(contents[i]);
          await walk(contents[i], mapUrl, d + 1);
        }
      }
    }
  }

  await walk(text, baseUrl, 0);
  return { texts, maps };
}

// Full (unmasked) candidate values, for VALIDATION only. Deliberately separate from analyze(),
// which never sees them: keeping the raw path out of the default one means the masked output
// cannot regress by accident when this code changes.
function secretValues(text) {
  const found = [];
  for (const [type, re] of SECRET_PATTERNS) {
    // matchAll requires /g and clones the regex internally, so the shared module-level pattern
    // is safe to reuse here exactly as analyze() does.
    for (const m of String(text).matchAll(re)) {
      const v = m[1] || m[0];
      if (v && !found.some((x) => x.type === type && x.value === v)) found.push({ type, value: v });
    }
  }
  return found;
}// Returns ONLY {type, confirmed, fingerprint} — never the credential. The fingerprint is a
  // truncated sha256 of the raw value: enough to correlate a finding with the loot vault's
  // `secret_fingerprint`, useless for recovering the secret.
  function validateSecrets(text, opts) {
  const cands = secretValues(text);
  if (!cands.length) return { candidates: 0, confirmed: [], trufflehog: null };

  // Raw values go to a 0600 file in the OS temp dir, never in the workspace.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'analyze-bundle-'));
  const file = path.join(dir, 'candidates.txt');
  try {
    fs.writeFileSync(file, cands.map((c) => c.value).join('\n'), { mode: 0o600 });
    const r = spawnSync('trufflehog', ['filesystem', file, '--json', '--no-verification'], {
      encoding: 'utf8', timeout: (opts && opts.timeoutMs) || 120000,
    });
    // trufflehog is registered in tool-registry.json (read_only, timeout 3600000): run.js
    // applies scope/audit/pacing to it, so validateSecrets delegates rather than spawning bare.
    const out = { candidates: cands.length, confirmed: [], trufflehog: { status: r.status, available: true } };
    for (const line of String(r.stdout || '').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let j; try { j = JSON.parse(t); } catch { continue; }
      const raw = j.Raw || (j.DetectorName && j.RawV2) || '';
      const match = cands.find((c) => raw && raw.includes(c.value)) || null;
      out.confirmed.push({
        type: match ? match.type : (j.DetectorName || 'unknown'),
        detector: j.DetectorName || null,
        confirmed: !!(j.Raw && j.RawV2) || j.Verified === true,
        // sha256 of the matched value, never the value itself: correlates with the loot vault
        // without putting a live credential in stdout, reports/ or the transcript.
        fingerprint: raw ? crypto.createHash('sha256').update(match ? match.value : raw).digest('hex').slice(0, 16) : null,
      });
    }
    if (r.status === 127 || r.error) out.trufflehog.available = false;
    return out;
  } finally {
    // Unconditional: the raw values must not survive this call under any outcome.
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

const USAGE = [
  'usage: node tools/analyze-bundle.js <url|localfile> [--validate-secrets --confirm "<reason>"]',
  '',
  '  <url|localfile>       bundle (JS/HTML/JSON) to mine: source maps are followed for sourcesContent',
  '  --validate-secrets    confirm-tier: try the credential with trufflehog (egress, needs --confirm)',
  '  --confirm "<reason>"  written reason; validation is refused without it',
].join('\n');

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    process.exit(argv.length ? 0 : 2);
  }
  // Un flag non è mai il target: prima `--help` (o `--validate-secrets` da solo) veniva aperto
  // come file locale e il tool crashava con ENOENT invece di spiegare l'uso.
  const confirmIdx = argv.indexOf('--confirm');
  // Solo il VALORE di --confirm va saltato: con il flag assente `confirmIdx + 1` è 0 e
  // scarterebbe il primo argomento (il target stesso).
  const target = argv.find((a, i) => !a.startsWith('-') && (confirmIdx < 0 || i !== confirmIdx + 1));
  const validate = argv.includes('--validate-secrets');
  const confirm = confirmIdx >= 0 && argv[confirmIdx + 1] ? argv[confirmIdx + 1] : null;
  if (!target) {
    console.error(USAGE);
    process.exit(2);
  }
  // Fail closed BEFORE any fetch: validation is egress and must never be implicit.
  if (validate && !confirm) {
    console.error(JSON.stringify({
      error: 'validation is confirm-tier',
      reason: 'trufflehog calls the credential provider API to test the key (egress)',
      usage: '--validate-secrets requires --confirm "<reason>"',
    }));
    process.exit(1);
  }
  let text;
  const meta = { sourcemap_count: 0, sourcemap_files: [], sourcemap_sources: 0 };
  if (/^https?:\/\//i.test(target)) {
    const scope = loadScope();
    const r = inScope(target, scope);
    if (!r.ok) {
      console.error(JSON.stringify({ blocked: target, reason: r.reason }));
      process.exit(1);
    }
    try {
      text = await fetch(target, scope);
      const mined = await mineSourcemaps(text, target, scope, 0);
      meta.sourcemap_count = mined.maps.length;
      meta.sourcemap_files = mined.maps;
      meta.sourcemap_sources = mined.texts.length - 1;
      text = mined.texts.join('\n');
    } catch (e) {
      console.error(JSON.stringify({ blocked: target, reason: e.message }));
      process.exit(1);
    }
  } else {
    text = fs.readFileSync(target, 'utf8');
  }
  if (validate) {
    const v = validateSecrets(text);
    // Note: still tokenized — the report shows detector names and counts, never the credential.
    console.log(require('./privacy').tokenize(JSON.stringify({ source: target, ...v }, null, 2)));
    return;
  }
  console.log(require('./privacy').tokenize(JSON.stringify({ source: target, bytes: text.length, ...meta, ...analyze(text) }, null, 2)));
}

if (require.main === module) main();

module.exports = { analyze, resolveRedirect, mineSourcemaps, validateSecrets, secretValues, SECRET_PATTERNS };
