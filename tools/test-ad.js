#!/usr/bin/env node
// Offline self-check for the AD orchestrator (ad.js). No network, no DC, no real binaries:
// a fake runAd returns canned tool output and we assert scope + tier logic, command assembly
// and the netexec/certipy/impacket parsers. Run: node tools/test-ad.js
'use strict';
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

// Hermetic scope: point SCOPE_JSON at a fixture BEFORE requiring ad.js consumers.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-test-'));
const scopeFile = path.join(tmp, 'scope.json');
fs.writeFileSync(scopeFile, JSON.stringify({ allowed_hosts: ['corp.local', 'dc01.corp.local'], allowed_ips: ['10.0.0.0/24'], max_requests_per_second: 5 }));
process.env.SCOPE_JSON = scopeFile;
process.env.RUN_AUDIT_FILE = path.join(tmp, 'audit.jsonl');
process.env.STAVROS_AD_DIR = path.join(tmp, 'ad');

const ad = require('./ad');
let pass = 0, fail = 0;
function ok(name, fn) { try { fn(); pass++; console.log(`  PASS ${name}`); } catch (e) { fail++; console.log(`  FAIL ${name}: ${e.message}`); } }
async function okA(name, fn) { try { await fn(); pass++; console.log(`  PASS ${name}`); } catch (e) { fail++; console.log(`  FAIL ${name}: ${e.message}`); } }

// ---- tier model -------------------------------------------------------------
ok('enum is auto-tier', () => assert.strictEqual(ad.classify('enum').tier, 'auto'));
ok('roast is auto-tier', () => assert.strictEqual(ad.classify('roast').tier, 'auto'));
ok('adcs is auto-tier', () => assert.strictEqual(ad.classify('adcs').tier, 'auto'));
ok('dcsync is confirm-tier', () => assert.strictEqual(ad.classify('dcsync').tier, 'confirm'));
ok('secretsdump is confirm-tier', () => assert.strictEqual(ad.classify('secretsdump').tier, 'confirm'));
ok('unknown op fails closed to confirm', () => assert.strictEqual(ad.classify('zzz').tier, 'confirm'));

ok('dcsync refused without --confirm', () => { const e = ad.enforce('dcsync', {}); assert.strictEqual(e.ok, false); assert.match(e.reason, /confirm-tier/); });
ok('dcsync allowed with --confirm', () => { const e = ad.enforce('dcsync', { confirm: 'authorized DA test' }); assert.strictEqual(e.ok, true); assert.strictEqual(e.confirmed, true); });
ok('enum allowed with no confirm', () => assert.strictEqual(ad.enforce('enum', {}).ok, true));

// ---- scope ------------------------------------------------------------------
ok('in-scope host passes', () => assert.strictEqual(ad.scopeCheck('dc01.corp.local').ok, true));
ok('in-scope ip passes', () => assert.strictEqual(ad.scopeCheck('10.0.0.5').ok, true));
ok('out-of-scope host fails', () => assert.strictEqual(ad.scopeCheck('evil.example').ok, false));
ok('out-of-scope ip fails', () => assert.strictEqual(ad.scopeCheck('8.8.8.8').ok, false));
ok('empty target fails', () => assert.strictEqual(ad.scopeCheck('').ok, false));

// ---- command assembly -------------------------------------------------------
ok('enum builds netexec smb', () => { const b = ad.buildArgs('enum', '10.0.0.5', { null: true }); assert.strictEqual(b.bin, 'netexec'); assert.deepStrictEqual(b.args.slice(0, 2), ['smb', '10.0.0.5']); assert.ok(b.args.includes('--shares')); });
ok('roast kerberoast builds GetUserSPNs', () => { const b = ad.buildArgs('roast', '10.0.0.5', { domain: 'corp.local', user: 'svc' }); assert.strictEqual(b.bin, 'impacket-GetUserSPNs'); assert.ok(b.args.includes('-request')); });
ok('roast asrep builds GetNPUsers', () => { const b = ad.buildArgs('roast', '10.0.0.5', { asrep: true, domain: 'corp.local', userlist: '/tmp/u.txt' }); assert.strictEqual(b.bin, 'impacket-GetNPUsers'); assert.ok(b.args.includes('-usersfile')); });
ok('adcs builds certipy find -vulnerable', () => { const b = ad.buildArgs('adcs', '10.0.0.5', { user: 'u', domain: 'corp.local' }); assert.strictEqual(b.bin, 'certipy'); assert.deepStrictEqual(b.args.slice(0, 2), ['find', '-u']); assert.ok(b.args.includes('-vulnerable')); });

// ---- parsers ----------------------------------------------------------------
const NXC_BANNER = 'SMB  10.0.0.5  445  DC01  [*] Windows Server 2019 Build 17763 x64 (name:DC01) (domain:corp.local) (signing:False) (SMBv1:True)';
ok('parseNxcSmbBanner extracts signing/domain', () => {
  const h = ad.parseNxcSmbBanner(NXC_BANNER);
  assert.strictEqual(h.length, 1);
  assert.strictEqual(h[0].domain, 'corp.local');
  assert.strictEqual(h[0].signing, false);
  assert.strictEqual(h[0].smbv1, true);
});
ok('parseKerbHashes tags kerberoast + mode 13100', () => {
  const hs = ad.parseKerbHashes('foo\n$krb5tgs$23$*svc$CORP.LOCAL$svc*$abc123def456\nbar');
  assert.strictEqual(hs.length, 1);
  assert.strictEqual(hs[0].kind, 'kerberoast');
  assert.strictEqual(hs[0].hashcat_mode, 13100);
});
ok('parseKerbHashes tags asrep + mode 18200', () => {
  const hs = ad.parseKerbHashes('$krb5asrep$23$user@CORP.LOCAL:aa11bb22');
  assert.strictEqual(hs[0].kind, 'asrep');
  assert.strictEqual(hs[0].hashcat_mode, 18200);
});
ok('parseCertipy extracts ESC ids', () => {
  const c = ad.parseCertipy('Template Name : VulnTemplate\n[!] Vulnerabilities\n  ESC1 : Enrollee supplies subject and client auth\n  ESC8 : Web enrollment');
  const ids = c.vulns.map((v) => v.esc);
  assert.ok(ids.includes('ESC1'));
  assert.ok(ids.includes('ESC8'));
});
ok('parsePolicy extracts lockout threshold', () => {
  const p = ad.parsePolicy('Minimum password length : 8\nAccount Lockout threshold : 5');
  assert.strictEqual(p.min_password_length, 8);
  assert.strictEqual(p.lockout_threshold, 5);
});

// ---- orchestration with injected runner (offline) ---------------------------
(async () => {
  await okA('runAd enum: scope+tier pass, parses hosts via injected runner', async () => {
    const res = await ad.runAd('enum', '10.0.0.5', {
      null: true,
      runAd: async () => ({ status: 0, stdout: NXC_BANNER }),
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.parsed.hosts[0].domain, 'corp.local');
  });

  await okA('runAd refuses out-of-scope BEFORE running', async () => {
    let ran = false;
    const res = await ad.runAd('enum', '8.8.8.8', { null: true, runAd: async () => { ran = true; return { status: 0, stdout: '' }; } });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.stage, 'scope');
    assert.strictEqual(ran, false, 'binary must NOT run out of scope');
  });

  await okA('runAd dcsync refuses without --confirm BEFORE running', async () => {
    let ran = false;
    const res = await ad.runAd('dcsync', 'dc01.corp.local', { user: 'admin', domain: 'corp.local', runAd: async () => { ran = true; return { status: 0, stdout: '' }; } });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.stage, 'tier');
    assert.strictEqual(ran, false, 'confirm-tier op must NOT run without --confirm');
  });

  await okA('runAd roast returns crackable hashes for the loot loop', async () => {
    const res = await ad.runAd('roast', 'dc01.corp.local', {
      domain: 'corp.local', user: 'svc',
      runAd: async () => ({ status: 0, stdout: '$krb5tgs$23$*svc$CORP.LOCAL$svc*$deadbeefcafe' }),
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.parsed.hashes[0].hashcat_mode, 13100);
  });

  console.log(`\nad: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
