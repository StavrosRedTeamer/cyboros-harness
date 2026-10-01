#!/usr/bin/env node
// SARIF 2.1.0 emitter for findings.jsonl — the interoperable face of the harness.
//
//   node tools/report-sarif.js [--findings <f>] [--out <f>] [--host <h>]
//   -> <f> (default reports/findings.sarif) or stdout with --out -
//
// Why this exists: report-html.js emits a standalone HTML page, findings.jsonl is the machine
// source of truth, and before this module there was NO machine-readable output at all — even
// though tools/radar-profiler.js already listed 'sarif' among the reporting capabilities this
// harness claims. SARIF is the OASIS standard for exactly this shape of data, accepted by GitHub
// code scanning and DefectDojo out of the box, with consumer-side deduplication.
//
// The interesting part is not the JSON, it is the `properties.stavros` bag: a finding here
// carries a verification level, a status, and a machine-re-executed oracle, and its severity is
// bounded by that evidence (record-finding.js refuses the incoherent combinations). SARIF has no
// field for that, so it would be silently dropped on export — and severity capped by evidence is
// the one thing this harness does that a generic consumer cannot infer. It is therefore carried
// explicitly, and the tool REFUSES to emit a result whose severity exceeds its recorded level.
//
// Offline and zero-dependency: SARIF is JSON, this is a pure function over findings.jsonl.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FINDINGS = () => process.env.FINDINGS_JSONL || path.join(ROOT, 'reports', 'findings.jsonl');

// SARIF levels are numeric, most severe first. `none`/`note` for informational.
const SARIF_LEVEL = { Critical: 'error', High: 'error', Medium: 'warning', Low: 'note', Info: 'note' };
const SARIF_SECURITY = { Critical: '8.9', High: '7.5', Medium: '5.5', Low: '3.0', Info: '0.0' };
// Same ladder record-finding.js enforces. Kept here so the exporter can REFUSE an incoherent
// record rather than laundering it into a standards document where the ceiling is invisible.
const VERIFY_LEVELS = ['suspected', 'triggered', 'exploited', 'proven_impact'];
const SEVERITY_CEILING = { suspected: 'Low', triggered: 'Medium', exploited: 'High', proven_impact: 'Critical' };
const SEV_ORDER = ['Critical', 'High', 'Medium', 'Low', 'Info'];

function severityAllowedAt(level, severity) {
  const cap = SEVERITY_CEILING[level];
  if (!cap) return false;
  return SEV_ORDER.indexOf(severity) >= SEV_ORDER.indexOf(cap);
}

// Findings with no verify_level are unclassified: they predate the ladder or came in from an
// operator by hand. They are emitted, flagged `unclassified`, and never silently promoted.
function levelOf(f) {
  return VERIFY_LEVELS.includes(f.verify_level) ? f.verify_level : null;
}

// A stable, content-derived fingerprint. SARIF lets a consumer dedupe on `partialFingerprints`;
// deriving it from (host, class|cwe, title) means re-running the exporter on the same findings
// produces the same id, and two engagements against the same target collide the way a real
// duplicate should. Node's crypto is a built-in, so this stays zero-dependency.
function fingerprint(f) {
  const crypto = require('crypto');
  const key = [f.host || '', f.class || f.cwe || '', f.title || ''].join('|').toLowerCase();
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 32);
}

function logicalLocation(f) {
  // SARIF locations are file/URI-shaped. A pentest endpoint is not a file, so it goes in
  // `logicalLocations` (which is exactly "a named place in the system under test") and the
  // evidence URI points at the PoC as a data: URI — no filesystem path is invented.
  return [{ name: String(f.endpoint || f.host || 'target'), kind: 'resource' }];
}

function artifactLocation(f, uri) {
  return { uri };
}

function toResult(f, idx) {
  const sev = SEV_ORDER.includes(f.severity) ? f.severity : 'Info';
  const level = levelOf(f);
  const ref = f.verifications && f.verifications.length ? f.verifications.length : (f.verified ? 1 : 0);

  const props = {
    severity: sev,
    verify_level: level || 'unclassified',
    // The ceiling this record was admitted under, so a consumer can see WHY the severity is
    // what it is even if it has never seen the harness's ladder.
    severity_ceiling: level ? SEVERITY_CEILING[level] : null,
    cvss: typeof f.cvss === 'number' ? f.cvss : null,
    cvss_vector: f.cvss_vector || null,
    cwe: f.cwe || null,
    cve: f.cve || (Array.isArray(f.cves) && f.cves.length ? f.cves[0] : null),
    epss: typeof f.epss === 'number' ? f.epss : null,
    kev: f.kev === true,
    status: f.status || null,
    // `oracle` on disk is an OBJECT ({type, ref, token}), not a string — read the field names
    // actually written by record-finding.js/oracle.js rather than inventing a flat one.
    oracle_ref: (f.oracle && (f.oracle.ref || f.oracle.id)) || f.oracle_ref || f.verify_ref || null,
    oracle_type: (f.oracle && f.oracle.type) || null,
    // The re-executable proof and the evidence quote are the two things a consumer cannot get
    // anywhere else. Dropped silently they would make every finding look equally proven.
    verify: f.verify || null,
    evidence_ref: (f.evidence && (f.evidence.ref || f.evidence.path)) || f.evidence || null,
    finding_id: f.id || null,
    technique: f.technique || null,
    ref_id: f.ref_id || null,
    // How many times the oracle re-executed the finding. Distinct from `status` on purpose:
    // "verified" is a claim, this is a count.
    verifications: ref || 0,
  };

  return {
    ruleId: f.class || f.cwe || 'unclassified',
    level: SARIF_LEVEL[sev],
    message: { text: String(f.title || '(untitled)') },
    locations: [{
      physicalLocation: {
        artifactLocation: artifactLocation(f, `findings.jsonl#L${idx + 1}`),
        region: { startLine: idx + 1 },
      },
      logicalLocations: logicalLocation(f),
      properties: { host: f.host || null, endpoint: f.endpoint || null },
    }],
    partialFingerprints: { stavrosFindingId: fingerprint(f) },
    // SARIF has no PoC field. The evidence goes in properties so nothing is lost, and so the
    // harness's own report remains the human-readable artifact while this is the machine one.
    properties: { stavros: props },
  };
}

// Build the run. Pure over its input so the test can assert on the object, not on stdout.
function buildSarif(findings, opts) {
  const o = opts || {};
  const tool = {
    driver: {
      name: 'StavrosRedTeamer',
      version: require('../package.json').version,
      informationUri: 'https://github.com/CSI-entitymorton/stavrosredteamer',
      rules: [],
    },
  };
  const results = [];
  const refused = [];

  findings.forEach((f, i) => {
    const sev = SEV_ORDER.includes(f.severity) ? f.severity : 'Info';
    const level = levelOf(f);
    // Refuse, do not downgrade. record-finding.js already refuses to WRITE such a record; this
    // closes the other direction — a hand-edited or merged findings.jsonl that bypassed the
    // writer must not reach a standards document claiming a severity the evidence can't carry.
    if (level && !severityAllowedAt(level, sev)) {
      refused.push({ index: i, title: f.title, severity: sev, verify_level: level, reason: 'severity exceeds verification level' });
      return;
    }
    results.push(toResult(f, i));

    const id = f.class || f.cwe || 'unclassified';
    if (!tool.driver.rules.some((r) => r.id === id)) {
      tool.driver.rules.push({
        id,
        name: String(f.class || id).replace(/[^A-Za-z0-9_]/g, '_'),
        shortDescription: { text: f.class ? `Stavros vulnerability class: ${f.class}` : (f.cwe || 'unclassified') },
        defaultConfiguration: { level: SARIF_LEVEL[sev] },
        properties: { tags: ['security', ...(f.class ? [f.class] : []), ...(f.cwe ? [f.cwe] : [])] },
      });
    }
  });

  const run = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool,
      results,
      // OriginalUriBaseIds omitted: nothing here resolves to a filesystem path, and inventing
      // one would be a claim about where the evidence lives that the harness cannot back.
      invocations: [{
        executionSuccessful: refused.length === 0,
        // Declared explicitly because it is load-bearing for this harness and a consumer has no
        // way to infer it: which findings the runtime itself re-executed, and how many times.
        properties: {
          stavros: {
            findings_total: findings.length,
            findings_emitted: results.length,
            findings_refused: refused.length,
            refused,
            severity_bounded_by_evidence: true,
          },
        },
      }],
    }],
  };
  if (o.host) run.runs[0].properties = { host: o.host };
  return run;
}

function loadFindings(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    try {
      const f = JSON.parse(t);
      if (f && typeof f === 'object') out.push(f);
    } catch { /* a torn line is skipped, never fatal: the log is append-only and may end mid-write */ }
  }
  return out;
}

function main(argv) {
  const a = argv || process.argv.slice(2);
  const arg = (name, dflt) => {
    const i = a.indexOf(name);
    return i >= 0 && a[i + 1] ? a[i + 1] : dflt;
  };
  const findingsFile = arg('--findings', FINDINGS());
  const out = arg('--out', path.join(ROOT, 'reports', 'findings.sarif'));
  const host = arg('--host', null);

  const findings = loadFindings(findingsFile);
  const doc = buildSarif(findings, { host });
  const json = JSON.stringify(doc, null, 2);

  if (out === '-') { console.log(json); return 0; }
  try {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, json);
  } catch (e) {
    console.error(JSON.stringify({ error: 'write_failed', detail: String(e && e.message || e) }));
    return 1;
  }
  const inv = doc.runs[0].invocations[0].properties.stavros;
  console.log(JSON.stringify({
    ok: true, out, sarifVersion: '2.1.0',
    findings_total: inv.findings_total, emitted: inv.findings_emitted, refused: inv.findings_refused,
  }));
  // Non-zero when the exporter refused something: a consumer must not treat a run that dropped
  // records as a clean scan. The caller sees it on the exit code, not by reading the JSON.
  return inv.findings_refused ? 2 : 0;
}

if (require.main === module) process.exit(main());

module.exports = { buildSarif, severityAllowedAt, levelOf, fingerprint, loadFindings, main };