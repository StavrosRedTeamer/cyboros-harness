#!/usr/bin/env node
// Cyboros crack — offline hash cracking (hashcat primary, john fallback). Closes the loot loop:
// hashes harvested by ad.js/postex land in the gitignored vault (reports/loot.jsonl); this tool
// cracks them offline and the recovered credentials feed back into auth.json / chain.js.
//
//   node tools/crack.js modes                       known hash-type -> hashcat-mode table
//   node tools/crack.js detect '<hash>'             best-guess mode for a single hash
//   node tools/crack.js loot                        list crackable hashes currently in the vault
//   node tools/crack.js run --hashes <file> [--mode N] [--wordlist w] [--rules r] [--engine hashcat|john]
//   node tools/crack.js run --loot [--mode N] [--wordlist w]     crack everything crackable in the vault
//
// Why AUTO tier: cracking is entirely OFFLINE — it never contacts the target, so scope.json does
// not apply (there is no target host). It is CPU/GPU-bound local work. Every run is still audited.
// Recovered plaintext is a SECRET: it is written back to the loot vault (never argv, never stdout in
// full) so record-finding.js's vaulting discipline holds end to end.
//
// ponytail: hashcat/john are driven as binaries via run.js; their potfile/status output is parsed
// best-effort. Mode auto-detect covers the common red-team formats (krb5tgs/krb5asrep/NetNTLMv2/
// NTLM/bcrypt/sha) — an unknown hash needs an explicit --mode.
'use strict';
const { env } = require('./env');
const fs = require('fs');
const path = require('path');
const run = require('./run');

const LOOT = () => process.env.LOOT_JSONL || path.join(__dirname, '..', 'reports', 'loot.jsonl');
const OUT_DIR = () => env('CRACK_DIR') || path.join(__dirname, '..', 'reports', 'crack');
const AUDIT_FILE = () => process.env.RUN_AUDIT_FILE || path.join(__dirname, '..', 'reports', 'tmp', 'run-audit.jsonl');
const DEFAULT_WORDLIST = () => env('WORDLIST') || '/usr/share/wordlists/rockyou.txt';

function audit(entry) {
  try {
    const p = AUDIT_FILE();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(Object.assign({ ts: new Date().toISOString(), tool: 'crack' }, entry)) + '\n');
  } catch { /* best effort */ }
}

// ---- hash-type detection ----------------------------------------------------
// [regex, hashcat mode, john format, label]. Order matters (most specific first).
const SIGS = [
  [/^\$krb5tgs\$23\$/i, 13100, 'krb5tgs', 'Kerberoast TGS-REP (RC4)'],
  [/^\$krb5tgs\$(17|18)\$/i, 19600, 'krb5tgs-aes', 'Kerberoast TGS-REP (AES)'],
  [/^\$krb5asrep\$23\$/i, 18200, 'krb5asrep', 'AS-REP roast (RC4)'],
  [/^\$krb5pa\$/i, 7500, 'krb5pa-md5', 'Kerberos pre-auth (AS-REQ)'],
  [/^[^:]*::[^:]*:[0-9a-f]{16}:[0-9a-f]{32}:/i, 5600, 'netntlmv2', 'NetNTLMv2'],
  [/^\$2[aby]\$\d\d\$/, 3200, 'bcrypt', 'bcrypt'],
  [/^\$6\$/, 1800, 'sha512crypt', 'sha512crypt (Linux shadow)'],
  [/^\$5\$/, 7400, 'sha256crypt', 'sha256crypt'],
  [/^\$1\$/, 500, 'md5crypt', 'md5crypt'],
  [/^[0-9a-f]{32}:[0-9a-f]{32}$/i, 1000, 'nt', 'NTLM (LM:NT pwdump)'],
  [/^[0-9a-f]{32}$/i, 1000, 'nt', 'NTLM / raw MD5 (assume NT)'],
  [/^[0-9a-f]{40}$/i, 100, 'raw-sha1', 'raw SHA1'],
  [/^[0-9a-f]{64}$/i, 1400, 'raw-sha256', 'raw SHA256'],
];

function detect(hash) {
  const h = String(hash || '').trim();
  for (const [re, mode, john, label] of SIGS) if (re.test(h)) return { mode, john, label };
  return null;
}

function modesTable() {
  return SIGS.map(([, mode, john, label]) => ({ hashcat_mode: mode, john_format: john, label }));
}

// ---- vault access -----------------------------------------------------------
function readLoot() {
  try {
    return fs.readFileSync(LOOT(), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

// A loot entry is "crackable" if its secret looks like a hash we recognise.
function crackableFromLoot() {
  return readLoot().map((e) => ({ entry: e, det: detect(e.secret) })).filter((x) => x.det)
    .map((x) => ({ loot_id: x.entry.loot_id, host: x.entry.host, title: x.entry.title, hash: x.entry.secret, mode: x.det.mode, label: x.det.label }));
}

function appendCracked(rec) {
  // Recovered plaintext is itself a secret → back to the vault, not to a plaintext report.
  try {
    fs.mkdirSync(path.dirname(LOOT()), { recursive: true });
    fs.appendFileSync(LOOT(), JSON.stringify(Object.assign({ ts: new Date().toISOString(), kind: 'cracked-credential' }, rec)) + '\n');
  } catch { /* best effort */ }
}

// ---- cracking (hashcat / john), runner injectable for tests -----------------
function buildHashcat(hashFile, mode, opts) {
  const a = ['-m', String(mode), '-a', '0', hashFile, opts.wordlist || DEFAULT_WORDLIST(), '--quiet'];
  if (opts.rules) a.push('-r', opts.rules);
  if (opts.potfile) a.push('--potfile-path', opts.potfile);
  return { bin: 'hashcat', args: a };
}
function buildJohn(hashFile, john, opts) {
  const a = [`--format=${john}`, hashFile];
  if (opts.wordlist) a.push(`--wordlist=${opts.wordlist}`);
  return { bin: 'john', args: a };
}

// Parse "hash:plaintext" lines (hashcat --show / john --show style, and hashcat --quiet stdout).
function parseCracked(text, hashes) {
  const found = [];
  const byHash = new Map(hashes.map((h) => [String(h.hash).trim(), h]));
  for (const line of String(text || '').split('\n')) {
    const l = line.trim();
    if (!l || l.startsWith('#')) continue;
    const idx = l.lastIndexOf(':');
    if (idx <= 0) continue;
    const hpart = l.slice(0, idx).trim();
    const plain = l.slice(idx + 1);
    // Match either the full hash or a suffix (hashcat sometimes prints the salted hash).
    for (const [k, meta] of byHash) {
      if (k === hpart || k.endsWith(hpart) || hpart.endsWith(k)) { found.push(Object.assign({ plaintext: plain }, meta)); break; }
    }
  }
  return found;
}

async function crack(hashes, opts) {
  opts = opts || {};
  if (!Array.isArray(hashes) || !hashes.length) return { ok: false, reason: 'no hashes to crack' };
  const mode = opts.mode || (hashes[0] && hashes[0].mode);
  if (!mode) return { ok: false, reason: 'could not determine hash mode; pass --mode <n>' };
  const engine = opts.engine || 'hashcat';

  fs.mkdirSync(OUT_DIR(), { recursive: true });
  const hashFile = opts.hashFile || path.join(OUT_DIR(), `hashes-${Date.now()}.txt`);
  if (!opts.hashFile) fs.writeFileSync(hashFile, hashes.map((h) => h.hash).join('\n') + '\n');
  const potfile = opts.potfile || path.join(OUT_DIR(), `pot-${Date.now()}.txt`);

  const det = detect(hashes[0].hash) || {};
  const built = engine === 'john'
    ? buildJohn(hashFile, opts.john || det.john || 'auto', opts)
    : buildHashcat(hashFile, mode, Object.assign({ potfile }, opts));

  audit({ op: 'crack', engine, mode, count: hashes.length, bin: built.bin });

  const runner = opts.runner || ((bin, args) => run.runBinary(bin, args, { capture: true, timeoutMs: opts.timeoutMs || 600000 }));
  const res = await runner(built.bin, built.args, { op: 'crack' });
  const text = String((res && (res.stdout || res.output)) || '');

  const cracked = parseCracked(text, hashes);
  for (const c of cracked) appendCracked({ loot_id: c.loot_id, host: c.host, title: c.title, mode, plaintext: c.plaintext });

  return { ok: true, engine, mode, attempted: hashes.length, cracked: cracked.map((c) => ({ loot_id: c.loot_id, host: c.host, recovered: true })), cracked_count: cracked.length };
}

module.exports = { detect, modesTable, crackableFromLoot, readLoot, buildHashcat, buildJohn, parseCracked, crack, appendCracked };

// ---- CLI --------------------------------------------------------------------
function parseCli(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--loot') o.loot = true;
    else if (a === '--hashes') o.hashFile = argv[++i];
    else if (a === '--mode') o.mode = Number(argv[++i]);
    else if (a === '--wordlist') o.wordlist = argv[++i];
    else if (a === '--rules') o.rules = argv[++i];
    else if (a === '--engine') o.engine = argv[++i];
    else if (a.startsWith('--')) o[a.slice(2)] = argv[++i];
    else o._.push(a);
  }
  return o;
}

async function main() {
  const [cmd] = process.argv.slice(2);
  const o = parseCli(process.argv.slice(3));
  if (cmd === 'modes') { console.log(JSON.stringify(modesTable(), null, 2)); return; }
  if (cmd === 'detect') { const d = detect(process.argv[3]); console.log(JSON.stringify(d || { error: 'unknown hash type; pass --mode explicitly' }, null, 2)); process.exit(d ? 0 : 1); }
  if (cmd === 'loot') { console.log(JSON.stringify(crackableFromLoot().map((h) => ({ loot_id: h.loot_id, host: h.host, mode: h.mode, label: h.label })), null, 2)); return; }
  if (cmd === 'run') {
    let hashes;
    if (o.loot) hashes = crackableFromLoot();
    else if (o.hashFile) hashes = fs.readFileSync(o.hashFile, 'utf8').split('\n').filter(Boolean).map((h) => ({ hash: h.trim(), mode: o.mode || (detect(h) || {}).mode }));
    else { console.error('crack run: need --loot or --hashes <file>'); process.exit(2); }
    const res = await crack(hashes, o);
    console.log(JSON.stringify(res, null, 2));
    process.exit(res.ok ? 0 : 1);
  }
  console.error('usage: node tools/crack.js <modes|detect|loot|run> [opts]');
  process.exit(2);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
