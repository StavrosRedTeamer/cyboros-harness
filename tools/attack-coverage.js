#!/usr/bin/env node
// ATT&CK coverage matrix for the Cyboros harness (P0).
//   node tools/attack-coverage.js                 # matrix to stdout
//   node tools/attack-coverage.js --host <host>   # only this host's executed techniques
//   node tools/attack-coverage.js --json          # machine-readable
//   node tools/attack-coverage.js --write         # write reports/attack-matrix.md (report-gate input)
//
// Two dimensions, mirroring coverage.js semantics:
//   PLANNED  — techniques reachable by a harness vulnerability class, from test-registry.json
//              (`attack` per class + `extra_surfaces`). What the harness CAN cover.
//   EXECUTED — techniques actually recorded on findings.jsonl: an explicit `technique: T####`
//              wins, otherwise the finding's `class` is mapped through the same registry.
//
// A class is never silently dropped: classes without a mapping are listed explicitly, and the
// exit code is 0 while planning is complete (the report gate checks the artifact, not the mode).
//
// Env overrides (tests / out-of-tree runs): CYBOROS_TEST_REGISTRY, CYBOROS_FINDINGS_FILE
// (FINDINGS_JSONL is honored too, matching record-finding.js), CYBOROS_ATTACK_MATRIX.

'use strict';
const { env } = require('./env');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REGISTRY_FILE = () => env('TEST_REGISTRY') || path.join(__dirname, 'test-registry.json');
const FINDINGS_FILE = () => env('FINDINGS_FILE') || process.env.FINDINGS_JSONL || path.join(ROOT, 'reports', 'findings.jsonl');
const OUT_FILE = () => env('ATTACK_MATRIX') || path.join(ROOT, 'reports', 'attack-matrix.md');

// ATT&CK Enterprise tactic order — the matrix Y ordering.
const TACTIC_ORDER = [
  'Reconnaissance', 'Resource Development', 'Initial Access', 'Execution', 'Persistence',
  'Privilege Escalation', 'Defense Evasion', 'Credential Access', 'Discovery', 'Lateral Movement',
  'Collection', 'Command and Control', 'Exfiltration', 'Impact',
];

// Technique catalog — id → {name, tactic}. Only techniques the harness classes map to; a
// technique id coming from a finding that is absent here still shows up (name '(unmapped)').
const TECHNIQUES = {
  T1592: { name: 'Gather Victim Host Information', tactic: 'Reconnaissance' },
  T1190: { name: 'Exploit Public-Facing Application', tactic: 'Initial Access' },
  T1195: { name: 'Supply Chain Compromise', tactic: 'Initial Access' },
  T1078: { name: 'Valid Accounts', tactic: 'Initial Access' },
  T1059: { name: 'Command and Scripting Interpreter', tactic: 'Execution' },
  'T1059.007': { name: 'Command and Scripting Interpreter: JavaScript', tactic: 'Execution' },
  'T1505.003': { name: 'Server Software Component: Web Shell', tactic: 'Persistence' },
  T1611: { name: 'Escape to Host', tactic: 'Privilege Escalation' },
  T1610: { name: 'Deploy Container', tactic: 'Defense Evasion' },
  T1110: { name: 'Brute Force', tactic: 'Credential Access' },
  T1539: { name: 'Steal Web Session Cookie', tactic: 'Credential Access' },
  T1552: { name: 'Unsecured Credentials', tactic: 'Credential Access' },
  'T1552.005': { name: 'Unsecured Credentials: Cloud Instance Metadata API', tactic: 'Credential Access' },
  T1557: { name: 'Adversary-in-the-Middle', tactic: 'Credential Access' },
  T1040: { name: 'Network Sniffing', tactic: 'Discovery' },
  T1083: { name: 'File and Directory Discovery', tactic: 'Discovery' },
  T1613: { name: 'Container and Resource Discovery', tactic: 'Discovery' },
  T1005: { name: 'Data from Local System', tactic: 'Collection' },
  // T4b — host/AD offensive surface (ad.js/privesc.js/mobile.js findings):
  T1003: { name: 'OS Credential Dumping', tactic: 'Credential Access' },
  'T1003.006': { name: 'OS Credential Dumping: DCSync', tactic: 'Credential Access' },
  T1021: { name: 'Remote Services', tactic: 'Lateral Movement' },
  'T1550.002': { name: 'Use Alternate Authentication Material: Pass the Hash', tactic: 'Lateral Movement' },
  'T1557.001': { name: 'Adversary-in-the-Middle: LLMNR/NBT-NS Poisoning and SMB Relay', tactic: 'Credential Access' },
  T1548: { name: 'Abuse Elevation Control Mechanism', tactic: 'Privilege Escalation' },
  T1068: { name: 'Exploitation for Privilege Escalation', tactic: 'Privilege Escalation' },
  'T1552.001': { name: 'Unsecured Credentials: Credentials In Files', tactic: 'Credential Access' },
  // T1 jwt/saml classes (forge web credentials):
  'T1606.001': { name: 'Forge Web Credentials: Web Cookies', tactic: 'Credential Access' },
  'T1606.002': { name: 'Forge Web Credentials: SAML Tokens', tactic: 'Credential Access' },
};

// ATT&CK technique id: parent (T1190) or sub-technique (T1059.007). Threat-intel fields such as
// tactics (TA0001) are deliberately NOT accepted as a technique.
const T_RE = /^T\d{4}(\.\d{3})?$/;

function loadRegistry(file) {
  try { return JSON.parse(fs.readFileSync(file || REGISTRY_FILE(), 'utf8')); } catch { return null; }
}

function loadFindings(file) {
  try {
    return fs.readFileSync(file || FINDINGS_FILE(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

function tacticOf(id) {
  const t = TECHNIQUES[id];
  return t ? t.tactic : 'Unmapped';
}

function nameOf(id) {
  const t = TECHNIQUES[id];
  return t ? `${id} ${t.name}` : id;
}

// Planned: technique → Set(class) from the registry (classes + extra_surfaces).
function plannedMap(reg) {
  const out = new Map();
  if (!reg) return out;
  const add = (cls, ids) => {
    for (const id of ids || []) {
      if (!out.has(id)) out.set(id, new Set());
      out.get(id).add(cls);
    }
  };
  for (const [cls, entry] of Object.entries(reg.classes || {})) {
    if (cls.startsWith('_')) continue;
    add(cls, entry && entry.attack);
  }
  for (const [cls, entry] of Object.entries(reg.extra_surfaces || {})) add(cls, entry && entry.attack);
  return out;
}

// Executed: an explicit `technique` wins; otherwise the finding's `class` is mapped through the
// registry (same source as the planned dimension), so the two stay consistent.
function findingTechniques(f, reg) {
  if (f && typeof f.technique === 'string' && T_RE.test(f.technique.trim())) return [f.technique.trim()];
  const cls = f && f.class;
  const entry = cls && reg && reg.classes ? reg.classes[cls] : null;
  if (entry && Array.isArray(entry.attack)) return entry.attack.slice();
  return [];
}

/** Build the ATT&CK matrix. opts.{registry,registryFile,findings,findingsFile,host} are additive
 * injection points so tests never touch the live registry/findings. */
function buildAttackMatrix(opts) {
  opts = opts || {};
  const reg = opts.registry !== undefined ? opts.registry : loadRegistry(opts.registryFile);
  const host = opts.host || null;
  const findings = (opts.findings !== undefined ? opts.findings : loadFindings(opts.findingsFile))
    .filter((f) => !host || f.host === host || String(f.host || '').includes(host));
  const planned = plannedMap(reg);
  const executed = new Map();
  for (const f of findings) {
    for (const id of findingTechniques(f, reg)) {
      if (!executed.has(id)) executed.set(id, { count: 0, hosts: new Set() });
      const e = executed.get(id);
      e.count += 1;
      if (f.host) e.hosts.add(f.host);
    }
  }
  const ids = new Set([...planned.keys(), ...executed.keys()]);
  const rows = [...ids].map((id) => ({
    technique: id,
    name: TECHNIQUES[id] ? TECHNIQUES[id].name : '(unmapped)',
    tactic: tacticOf(id),
    classes: [...(planned.get(id) || [])].sort(),
    executed: executed.has(id) ? executed.get(id).count : 0,
    hosts: executed.has(id) ? [...executed.get(id).hosts].sort() : [],
  })).sort((a, b) => {
    const ta = TACTIC_ORDER.indexOf(a.tactic), tb = TACTIC_ORDER.indexOf(b.tactic);
    const ka = ta < 0 ? TACTIC_ORDER.length : ta, kb = tb < 0 ? TACTIC_ORDER.length : tb;
    return ka - kb || a.technique.localeCompare(b.technique);
  });
  const unmappedClasses = reg && reg.classes
    ? Object.entries(reg.classes)
      .filter(([k, v]) => !k.startsWith('_') && !(v && Array.isArray(v.attack) && v.attack.length))
      .map(([k]) => k)
    : [];
  return {
    host,
    plannedTechniques: planned.size,
    executedTechniques: executed.size,
    covered: rows.filter((r) => r.classes.length).length,
    executed: rows.filter((r) => r.executed > 0).length,
    rows,
    extraSurfaces: reg && reg.extra_surfaces ? Object.keys(reg.extra_surfaces) : [],
    unmappedClasses,
  };
}

function matrixTable(m) {
  const lines = [
    '# ATT&CK Coverage Matrix', '',
    `Host: ${m.host || 'all'}`,
    `Planned techniques (harness classes): ${m.plannedTechniques}`,
    `Executed techniques (this engagement): ${m.executedTechniques}`,
    '',
    '| Tactic | Technique | Planned by class | Executed |',
    '|---|---|---|---|',
  ];
  for (const r of m.rows) {
    const exec = `${r.executed}${r.hosts.length ? ' (' + r.hosts.join(', ') + ')' : ''}`;
    lines.push(`| ${r.tactic} | ${nameOf(r.technique)} | ${r.classes.join(', ') || '—'} | ${exec} |`);
  }
  lines.push('', `Coverage: ${m.covered}/${m.plannedTechniques} planned techniques are reachable by a harness class; ${m.executed} technique(s) executed this engagement.`);
  if (m.extraSurfaces.length) lines.push(`Extra surfaces (non-registry classes): ${m.extraSurfaces.join(', ')}`);
  if (m.unmappedClasses.length) lines.push(`Classes without an ATT&CK mapping: ${m.unmappedClasses.join(', ')}`);
  return lines.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const hostIdx = args.indexOf('--host');
  const host = hostIdx >= 0 ? args[hostIdx + 1] : null;
  const m = buildAttackMatrix({ host });
  if (args.includes('--json')) console.log(JSON.stringify(m, null, 2));
  else console.log(matrixTable(m));
  if (args.includes('--write')) {
    const out = OUT_FILE();
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, matrixTable(m) + '\n');
    console.log(`\nwrote ${out}`);
  }
}

if (require.main === module) main();

module.exports = {
  TACTIC_ORDER, TECHNIQUES, T_RE, loadRegistry, loadFindings,
  tacticOf, nameOf, plannedMap, findingTechniques, buildAttackMatrix, matrixTable,
};
