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
process.env.CYBOROS_AD_DIR = path.join(tmp, 'ad');

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

// ---- P0: relayability / coercion / delegation / mssql (auto) ----------------
ok('enum-relay builds netexec --gen-relay-list', () => {
  const b = ad.buildArgs('enum-relay', '10.0.0.0/24', {});
  assert.strictEqual(b.bin, 'netexec');
  assert.deepStrictEqual(b.args.slice(0, 2), ['smb', '10.0.0.0/24']);
  assert.ok(b.args.includes('--gen-relay-list'));
});
ok('enum-coerce builds read-only fingerprint modules', () => {
  const b = ad.buildArgs('enum-coerce', '10.0.0.5', {});
  assert.strictEqual(b.bin, 'netexec');
  assert.ok(b.args.includes('-M'));
  for (const m of ['spooler-target', 'petitpotam', 'dfss']) assert.ok(b.args.includes(m), `module ${m}`);
  assert.ok(!JSON.stringify(b.args).match(/coerce|relayx/i), 'no coercion/relay action in args');
});
ok('enum-delegation builds impacket-findDelegation', () => {
  const b = ad.buildArgs('enum-delegation', '10.0.0.5', { domain: 'corp.local', user: 'u' });
  assert.strictEqual(b.bin, 'impacket-findDelegation');
});
ok('enum-mssql builds netexec mssql audit', () => {
  const b = ad.buildArgs('enum-mssql', '10.0.0.5', {});
  assert.strictEqual(b.bin, 'netexec');
  assert.strictEqual(b.args[0], 'mssql');
  assert.ok(b.args.includes('--users') && b.args.includes('--db'));
});
ok('coerce/relay buildArgs refuse without listener', () => {
  assert.strictEqual(ad.buildArgs('coerce', '10.0.0.5', {}), null);
  assert.strictEqual(ad.buildArgs('relay', '10.0.0.5', {}), null);
});
ok('coerce buildArgs: fallback coercer quando impacket-dfscoerce manca (which iniettabile)', () => {
  const c = ad.buildArgs('coerce', '10.0.0.5', { listener: '10.0.0.9:9999', user: 'u', passRef: 'P', which: (b) => b === 'coercer' });
  assert.strictEqual(c.bin, 'coercer');
  assert.deepStrictEqual(c.args, ['coerce', '-t', '10.0.0.5', '-l', '10.0.0.9', '-u', 'u', '-p', 'P', '--always-continue']);
  const anon = ad.buildArgs('coerce', '10.0.0.5', { listener: '10.0.0.9:9999', which: (b) => b === 'coercer' });
  assert.ok(anon.args.includes('--no-pass'), 'senza credenziali: --no-pass, mai prompt interattivo');
  const d = ad.buildArgs('coerce', '10.0.0.5', { listener: '10.0.0.9:9999', which: (b) => b === 'impacket-dfscoerce' });
  assert.strictEqual(d.bin, 'impacket-dfscoerce', 'build operator-supplied ha la precedenza');
  const none = ad.buildArgs('coerce', '10.0.0.5', { listener: '10.0.0.9:9999', which: () => false });
  assert.strictEqual(none, null, 'nessun coercer installato: fail-closed');
});
ok('relay buildArgs: SOCKS only, no dump/write flags ever', () => {
  const b = ad.buildArgs('relay', '10.0.0.5', { listener: '127.0.0.1:9999' });
  assert.strictEqual(b.bin, 'impacket-ntlmrelayx');
  const s = b.args.join(' ');
  assert.ok(s.includes('-socks'), 'default SOCKS mode');
  assert.ok(!/--dump|--wa |--add-computer|write/i.test(s), 'no dump/write flags');
  assert.ok(s.includes('-tf'), 'targets file from enum-relay');
});

// ---- P0 parsers --------------------------------------------------------------
ok('parseCoerceModules flags vulnerable spooler', () => {
  const rows = ad.parseCoerceModules('SMB  10.0.0.5  445  DC01  [+] spooler-target: vulnerable\nSMB  10.0.0.6  445  PC02  [-] petitpotam: not vulnerable');
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].host, '10.0.0.5');
  assert.strictEqual(rows[0].machine, 'spoolsv');
  assert.strictEqual(rows[0].vulnerable, true);
  assert.strictEqual(rows[1].machine, 'efs');
  assert.strictEqual(rows[1].vulnerable, false);
});
ok('parseFindDelegation extracts rbcd/constrained', () => {
  const d = ad.parseFindDelegation('Account Name: svc-web\nConstrained w/ Protocol Transition\nAccount Name: winrm-srv\nResource-Based Constrained Delegation');
  assert.strictEqual(d.length, 2);
  assert.strictEqual(d[0].account, 'svc-web');
  assert.strictEqual(d[0].type, 'constrained');
  assert.strictEqual(d[0].protocol_transition, true);
  assert.strictEqual(d[1].type, 'rbcd');
});
ok('parseMssqlAudit extracts dbs + impersonation', () => {
  const a = ad.parseMssqlAudit('catalog: master\ncatalog: msdb\nUser \'svc_sql\' can impersonate: \'sa\'');
  assert.deepStrictEqual(a.dbs, ['master', 'msdb']);
  assert.strictEqual(a.impersonatable[0].user, 'svc_sql');
  assert.strictEqual(a.impersonatable[0].as, 'sa');
});
ok('enum-relay signing=False lands in relay_targets', () => {
  const hosts = ad.parseNxcSmbBanner('SMB  10.0.0.5  445  DC01  [*] Windows Server 2019 (signing:False)\nSMB  10.0.0.6  445  PC02  [*] Windows 10 (signing:True)');
  const relayable = hosts.filter((h) => h.signing === false);
  assert.deepStrictEqual(relayable.map((h) => h.ip), ['10.0.0.5']);
});

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

  await okA('runAd enum-relay parses relay map (auto tier)', async () => {
    const res = await ad.runAd('enum-relay', '10.0.0.5', {
      runAd: async () => ({ status: 0, stdout: NXC_BANNER }),
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.tier, 'auto');
    assert.strictEqual(res.parsed.relay_targets.length, 1);
    assert.strictEqual(res.parsed.relay_targets[0].signing, false);
    assert.ok(res.parsed._relay_map, 'relay map persisted to reports/ad');
  });

  await okA('runAd coerce refuses WITHOUT --confirm (tier before listener)', async () => {
    let ran = false;
    const res = await ad.runAd('coerce', '10.0.0.5', { listener: '127.0.0.1:9999', runAd: async () => { ran = true; return { status: 0, stdout: '' }; } });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.stage, 'tier');
    assert.strictEqual(ran, false);
  });

  await okA('runAd coerce/relay refuse without listener (anti-spray gate)', async () => {
    const c = await ad.runAd('coerce', '10.0.0.5', { confirm: 'lab', runAd: async () => ({ status: 0, stdout: '' }) });
    assert.strictEqual(c.ok, false);
    assert.strictEqual(c.stage, 'listener');
    const r = await ad.runAd('relay', '10.0.0.5', { confirm: 'lab', runAd: async () => ({ status: 0, stdout: '' }) });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.stage, 'listener');
  });

  await okA('runAd relay refuses when listener is NOT registered in sessions ledger', async () => {
    process.env.SESSIONS_JSON = path.join(tmp, 'sessions-empty.json');
    const res = await ad.runAd('relay', '10.0.0.5', { confirm: 'lab', listener: '127.0.0.1:9999', runAd: async () => ({ status: 0, stdout: '' }) });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.stage, 'listener');
    delete process.env.SESSIONS_JSON;
  });

  await okA('runAd relay runs with confirm + registered listener, logs SOCKS session', async () => {
    const sessFile = path.join(tmp, 'sessions.json');
    fs.writeFileSync(sessFile, JSON.stringify({ sessions: { lst1: { status: 'open', host: '127.0.0.1:9999' } } }));
    process.env.SESSIONS_JSON = sessFile;
    const res = await ad.runAd('relay', '10.0.0.5', { confirm: 'lab', listener: '127.0.0.1:9999', runAd: async () => ({ status: 0, stdout: '' }) });
    assert.strictEqual(res.ok, true);
    const reg = JSON.parse(fs.readFileSync(sessFile, 'utf8'));
    const socks = Object.values(reg.sessions).filter((s) => s.type === 'ntlmrelayx-socks');
    assert.strictEqual(socks.length, 1, 'relay SOCKS session recorded in teardown ledger');
    delete process.env.SESSIONS_JSON;
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
