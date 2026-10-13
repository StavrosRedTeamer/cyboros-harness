// Offline self-check for the wireless runner (wifi.js). No network, no wireless NIC, no real
// binaries: a fake runWifi / runBinary returns canned output, and we assert scope + tier logic,
// command assembly and the airodump CSV parser. Run: node tools/test-wifi.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
require('./testkit').hermetic('wifi'); // stato condiviso in fixture, non nel workspace (vedi testkit.js)
const wifi = require('./wifi');

const BSSID = 'AA:BB:CC:DD:EE:FF';
const BSSID_L = 'aa:bb:cc:dd:ee:ff';

// ---- target extraction ----
assert.deepStrictEqual(
  wifi.extractTargets(['-a', BSSID, 'wlan0mon']),
  { bssids: [BSSID_L], essids: [], channels: [], ifaces: ['wlan0mon'] },
  'bssid + iface extracted from -a flag'
);
assert.deepStrictEqual(
  wifi.extractTargets(['--bssid', 'aa-bb-cc-dd-ee-ff']),
  { bssids: [BSSID_L], essids: [], channels: [], ifaces: [] },
  'bssid normalized from dash form'
);
assert.deepStrictEqual(
  wifi.extractTargets(['-e', 'MyLabWiFi', '--channel', '6']),
  { bssids: [], essids: ['MyLabWiFi'], channels: [6], ifaces: [] },
  'essid + channel extracted'
);
assert.deepStrictEqual(
  wifi.extractTargets(['wlan0mon']),
  { bssids: [], essids: [], channels: [], ifaces: ['wlan0mon'] },
  'iface-only yields an iface target (for mac/sniff)'
);
assert.deepStrictEqual(
  wifi.extractTargets(['cap.cap', '-w', 'rockyou.txt']),
  { bssids: [], essids: [], channels: [], ifaces: [] },
  'no iface mistaken in an offline crack argv'
);

// ---- classification (bin + args -> action class / tier) ----
const scope = {
  bssids: [BSSID],
  essids: ['MyLabWiFi'],
  stations: ['11:22:33:44:55:66'],
  channels: [1, 6, 11],
  max_requests_per_second: 1000,
};
assert.deepStrictEqual(wifi.classify('airodump-ng', ['wlan0mon'], scope), { actionClass: 'scan', tier: 'auto' }, 'passive scan = auto');
assert.deepStrictEqual(wifi.classify('aircrack-ng', ['cap.cap', '-w', 'rockyou.txt'], scope), { actionClass: 'crack', tier: 'auto' }, 'offline crack = auto');
assert.deepStrictEqual(wifi.classify('aireplay-ng', ['-0', '3', '-a', BSSID, 'wlan0mon'], scope), { actionClass: 'deauth', tier: 'confirm' }, 'deauth = confirm');
assert.deepStrictEqual(wifi.classify('reaver', ['-i', 'wlan0mon', '-b', BSSID], scope), { actionClass: 'wps', tier: 'confirm' }, 'wps = confirm');
assert.deepStrictEqual(wifi.classify('wifite', [], scope), { actionClass: 'automated', tier: 'confirm' }, 'wifite = confirm');
assert.deepStrictEqual(wifi.classify('hcxdumptool', ['-i', 'wlan0mon'], scope), { actionClass: 'capture', tier: 'confirm' }, 'hcxdumptool = confirm');
assert.deepStrictEqual(wifi.classify('macchanger', ['-r', 'wlan0'], scope), { actionClass: 'mac_spoof', tier: 'confirm' }, 'macchanger = mac_spoof (confirm)');
assert.deepStrictEqual(wifi.classify('nmcli', ['device', 'wifi', 'connect', 'MyLabWiFi'], scope), { actionClass: 'join', tier: 'confirm' }, 'nmcli = join (confirm)');
assert.deepStrictEqual(wifi.classify('tcpdump', ['-i', 'wlan0', '-w', 'x.pcap'], scope), { actionClass: 'sniff', tier: 'auto' }, 'tcpdump = sniff (auto)');
assert.deepStrictEqual(wifi.classify('hostapd', ['reports/wifi/rogue/hostapd.conf'], scope), { actionClass: 'rogue_ap', tier: 'confirm' }, 'hostapd = rogue_ap (confirm)');
assert.deepStrictEqual(wifi.classify('dnsmasq', ['-C', 'reports/wifi/rogue/dnsmasq.conf'], scope), { actionClass: 'rogue_ap', tier: 'confirm' }, 'dnsmasq = rogue_ap (confirm)');
assert.deepStrictEqual(wifi.classify('ip', ['addr', 'add', '10.0.0.1/24', 'dev', 'wlan0'], scope), { actionClass: 'rogue_ap', tier: 'confirm' }, 'ip addr add = rogue_ap (confirm)');
assert.deepStrictEqual(wifi.classify('sysctl', ['-w', 'net.ipv4.ip_forward=1'], scope), { actionClass: 'rogue_ap', tier: 'confirm' }, 'sysctl ip_forward=1 = rogue_ap (confirm)');
assert.deepStrictEqual(wifi.classify('ip', ['addr', 'del', '10.0.0.1/24', 'dev', 'wlan0'], scope), { actionClass: 'cleanup', tier: 'auto' }, 'ip addr del = cleanup (auto)');
assert.deepStrictEqual(wifi.classify('sysctl', ['-w', 'net.ipv4.ip_forward=0'], scope), { actionClass: 'cleanup', tier: 'auto' }, 'sysctl ip_forward=0 = cleanup (auto)');
assert.deepStrictEqual(wifi.classify('node', ['tools/portal.js', 'serve', '--confirm', 'x'], scope), { actionClass: 'portal_serve', tier: 'confirm' }, 'portal.js serve = portal_serve (confirm)');
assert.deepStrictEqual(wifi.classify('unknown-bin', [], scope), { actionClass: 'unknown', tier: 'confirm' }, 'unknown = confirm (fail closed)');

// ---- command assembly (pure) ----
const scanCmds = wifi.scanCommands('wlan0');
assert.deepStrictEqual(scanCmds[0].bin, 'airmon-ng');
assert.deepStrictEqual(scanCmds[1].bin, 'airodump-ng');
assert.ok(scanCmds[1].args.includes('wlan0mon'), 'monitor iface = <iface>mon');

const capDeauth = wifi.captureCommands(BSSID, { channel: 6 });
assert.strictEqual(capDeauth[0].bin, 'airodump-ng');
assert.strictEqual(capDeauth[1].bin, 'aireplay-ng', 'handshake capture adds deauth');
assert.ok(capDeauth[1].args.includes('-0'), 'deauth uses -0');

const capPmkid = wifi.captureCommands(BSSID, { channel: 6, pmkid: true });
assert.strictEqual(capPmkid.length, 1, 'pmkid capture is a single tool');
assert.strictEqual(capPmkid[0].bin, 'hcxdumptool');

const crackCmd = wifi.crackCommands('cap.cap', {});
assert.strictEqual(crackCmd[0].bin, 'aircrack-ng');
assert.ok(crackCmd[0].args.includes('cap.cap'));

const wpsCmd = wifi.wpsCommands(BSSID, { channel: 6 });
assert.strictEqual(wpsCmd[0].bin, 'reaver');

const joinCmd = wifi.joinCommands('MyLabWiFi', {});
assert.strictEqual(joinCmd[0].bin, 'nmcli');
assert.ok(joinCmd[0].args.includes('MyLabWiFi'), 'join carries the SSID');
const joinBssid = wifi.joinCommands('MyLabWiFi', { bssid: BSSID });
assert.ok(joinBssid[0].args.includes('bssid') && joinBssid[0].args.includes(BSSID_L), 'join pins the BSSID when given');

assert.deepStrictEqual(wifi.macCommands('random', 'wlan0')[0], { bin: 'macchanger', args: ['-r', 'wlan0'] }, 'mac random');
assert.deepStrictEqual(wifi.macCommands('reset', 'wlan0')[0], { bin: 'macchanger', args: ['-p', 'wlan0'] }, 'mac reset');
assert.deepStrictEqual(wifi.macCommands('clone', 'wlan0', { mac: BSSID })[0], { bin: 'macchanger', args: ['-m', BSSID_L, 'wlan0'] }, 'mac clone normalizes');
assert.throws(() => wifi.macCommands('clone', 'wlan0', {}), /requires --mac/, 'mac clone without --mac throws');
assert.throws(() => wifi.macCommands('bogus', 'wlan0'), /random\|clone\|reset/, 'mac mode validated');

const sniffCmd = wifi.sniffCommands('wlan0', {});
assert.strictEqual(sniffCmd[0].bin, 'tcpdump');
assert.ok(sniffCmd[0].args.includes('-w') && sniffCmd[0].args[sniffCmd[0].args.length - 1].endsWith('.pcap'), 'sniff writes a pcap');

// ---- rogue AP config/plan (pure) ----
const cfg = wifi.rogueConfigs('MyLabWiFi', { channel: 6, iface: 'wlan0' });
assert.ok(cfg.hostapd.includes('ssid=MyLabWiFi'), 'hostapd carries the SSID');
assert.ok(cfg.hostapd.includes('channel=6'), 'hostapd carries the channel');
assert.ok(/^wpa=0$/m.test(cfg.hostapd), 'rogue AP is open (no WPA)');
assert.ok(cfg.dnsmasq.includes('address=/#/10.0.0.1'), 'wildcard DNS points every name at the gateway');
assert.ok(cfg.dnsmasq.includes('dhcp-option=3,10.0.0.1'), 'DHCP gateway = our host');

const rogueCmds = wifi.rogueCommands('MyLabWiFi', { channel: 6 });
assert.deepStrictEqual(rogueCmds.map((c) => c.bin), ['ip', 'sysctl', 'hostapd', 'dnsmasq'], 'rogue plan order');
assert.deepStrictEqual(rogueCmds.map((c) => c.mode), ['run', 'run', 'background', 'background'], 'setup steps run, daemons background');
assert.deepStrictEqual(wifi.rogueStopCommands({ iface: 'wlan0' }).map((c) => c.bin), ['sysctl', 'ip'], 'stop plan');

// ---- R4: ESSID validation (hostapd.conf injection + 802.11 length) ----
assert.strictEqual(wifi.validateEssid('MyLabWiFi'), 'MyLabWiFi', 'valid ESSID passes');
assert.throws(() => wifi.rogueConfigs('bad\ninterface=evil', { channel: 6 }), /newlines/, 'ESSID with a newline rejected');
assert.throws(() => wifi.rogueConfigs('bad=1', { channel: 6 }), /must not contain "="/, 'ESSID with = rejected');
assert.throws(() => wifi.rogueConfigs('   ', { channel: 6 }), /non-empty/, 'blank ESSID rejected');
assert.throws(() => wifi.rogueConfigs('x'.repeat(33), { channel: 6 }), /32 bytes/, 'over-long ESSID rejected');

// ---- parseArgs: the CLI flag parser for the new verbs ----
assert.deepStrictEqual(
  wifi.parseArgs(['MyLabWiFi', '--channel', '6', '--iface', 'wlan0', '--gw', '10.0.0.1', '--portal', 'dir', '--portal-port', '8080', '--collect', '--confirm', 'lab']),
  { opts: { channel: 6, iface: 'wlan0', gw: '10.0.0.1', portal: 'dir', portalPort: 8080, collect: true, confirm: 'lab' }, pos: ['MyLabWiFi'] },
  'parseArgs: rogue flags'
);
assert.deepStrictEqual(
  wifi.parseArgs(['random', 'wlan0', '--mac', BSSID, '--confirm', 'x']),
  { opts: { mac: BSSID, confirm: 'x' }, pos: ['random', 'wlan0'] },
  'parseArgs: mac flags'
);
assert.deepStrictEqual(wifi.parseArgs(['--pmkid', '--write', 'cap']).opts, { pmkid: true, write: 'cap' }, 'parseArgs: capture flags');

// ---- airodump CSV parser ----
const CSV = [
  'BSSID, First time seen, Last time seen, channel, Speed, Privacy, Cipher, Authentication, Power, # beacons, # IV, LAN IP, ID-length, ESSID, Key',
  BSSID + ', 2026-08-18 10:00:00, 2026-08-18 10:05:00, 6, 130, WPA2, CCMP, PSK, -45, 100, 0, 0.0.0.0, 8, MyLabWiFi,',
  '11:22:33:44:55:66, 2026-08-18 10:00:00, 2026-08-18 10:05:00, 11, 54, OPN, , OPN, -70, 20, 0, 0.0.0.0, 7, OpenNet,',
  '',
  'Station MAC, First time seen, Last time seen, Power, # packets, BSSID, Probed ESSIDs',
  '99:88:77:66:55:44, 2026-08-18 10:00:00, 2026-08-18 10:05:00, -50, 12, ' + BSSID + ', MyLabWiFi',
].join('\n');
const aps = wifi.parseAirodumpCsv(CSV);
assert.strictEqual(aps.length, 2, 'two APs parsed');
assert.deepStrictEqual(aps[0], { bssid: BSSID_L, channel: 6, privacy: 'WPA2', cipher: 'CCMP', auth: 'PSK', essid: 'MyLabWiFi' }, 'AP record normalized');
assert.deepStrictEqual(aps[1].bssid, '11:22:33:44:55:66', 'second AP bssid');
assert.strictEqual(aps[1].privacy, 'OPN', 'open network');
assert.deepStrictEqual(wifi.parseAirodumpCsv('garbage\nnope'), [], 'malformed -> []');
assert.deepStrictEqual(wifi.parseAirodumpCsv(null), [], 'null -> []');

// ---- open-network detection ----
assert.strictEqual(wifi.isOpen(aps[1]), true, 'OPN privacy = open');
assert.strictEqual(wifi.isOpen(aps[0]), false, 'WPA2 = not open');
assert.strictEqual(wifi.isOpen(null), false, 'null ap = not open');

// ---- station parser ----
const st = wifi.parseAirodumpStations(CSV);
assert.strictEqual(st.length, 1, 'one station parsed');
assert.deepStrictEqual(st[0], { station: '99:88:77:66:55:44', power: -50, packets: 12, bssid: BSSID_L, probed: 'MyLabWiFi' }, 'station record normalized');
assert.deepStrictEqual(wifi.parseAirodumpStations('garbage\nnope'), [], 'malformed stations -> []');
assert.deepStrictEqual(wifi.parseAirodumpStations(null), [], 'null stations -> []');

// ---- AP store (appendAps dedups, env override) ----
const tmpDir = path.join(os.tmpdir(), 'wifi-test-' + process.pid);
fs.mkdirSync(tmpDir, { recursive: true });
process.env.WIFI_APS_JSONL = path.join(tmpDir, 'wifi-aps.jsonl');
assert.strictEqual(wifi.appendAps(aps), 2, 'two APs appended');
assert.strictEqual(wifi.appendAps([aps[0]]), 0, 'duplicate AP not appended');
assert.strictEqual(wifi.status().aps, 2, 'status reports two APs');
delete process.env.WIFI_APS_JSONL;

// ---- defaultRunWifi: fail-closed (scope + tier), injectable exec ----
const scopeFile = path.join(tmpDir, 'wifi-scope.json');
fs.writeFileSync(scopeFile, JSON.stringify(scope));
process.env.WIFI_SCOPE_JSON = scopeFile;
const fakeExec = () => ({ status: 0, stdout: '', stderr: '' });

(async () => {
  // confirm-tier without --confirm -> rejected
  await assert.rejects(
    wifi.defaultRunWifi('aireplay-ng', ['-0', '3', '-a', BSSID, 'wlan0mon'], { runBinary: fakeExec }),
    /confirm-tier/
  );
  // out-of-scope bssid -> rejected (even for an auto-tier scan bin)
  await assert.rejects(
    wifi.defaultRunWifi('airodump-ng', ['--bssid', '66:55:44:33:22:11', 'wlan0mon'], { runBinary: fakeExec }),
    /out-of-scope/
  );
  // offline crack (no live target, auto tier) is allowed — it works on a capture file
  const crackOk = await wifi.defaultRunWifi('aircrack-ng', ['cap.cap', '-w', 'rockyou.txt'], { runBinary: fakeExec });
  assert.strictEqual(crackOk.status, 0, 'offline crack runs without a live target');
  // confirm-tier bin with a confirm flag but no target -> fail closed
  await assert.rejects(
    wifi.defaultRunWifi('reaver', ['-i', 'wlan0mon'], { runBinary: fakeExec, confirm: 'lab' }),
    /no in-scope wireless target/
  );
  // confirm-tier bin without --confirm -> rejected at the tier gate (before any target check)
  await assert.rejects(
    wifi.defaultRunWifi('wifite', [], { runBinary: fakeExec }),
    /confirm-tier/
  );
  // passive scan (no target, auto tier) is allowed
  const scanOk = await wifi.defaultRunWifi('airodump-ng', ['wlan0mon'], { runBinary: fakeExec });
  assert.strictEqual(scanOk.status, 0, 'passive scan runs');
  // passive sniff (tcpdump, auto) is allowed
  const sniffOk = await wifi.defaultRunWifi('tcpdump', ['-i', 'wlan0', '-w', 'x.pcap'], { runBinary: fakeExec });
  assert.strictEqual(sniffOk.status, 0, 'passive sniff runs');
  // confirm-tier MAC spoof (local NIC) runs with --confirm; no AP target needed beyond the iface
  const macOk = await wifi.defaultRunWifi('macchanger', ['-r', 'wlan0'], { runBinary: fakeExec, confirm: 'rotate MAC to test MAC-auth bypass' });
  assert.strictEqual(macOk.status, 0, 'confirmed MAC randomization runs');
  // join is confirm-tier and its positional SSID is scope-checked via opts.targets
  const joinOk = await wifi.defaultRunWifi('nmcli', ['device', 'wifi', 'connect', 'MyLabWiFi'], { runBinary: fakeExec, confirm: 'authorized open lab SSID', targets: { essids: ['MyLabWiFi'] } });
  assert.strictEqual(joinOk.status, 0, 'confirmed join to in-scope ESSID runs');
  await assert.rejects(
    wifi.defaultRunWifi('nmcli', ['device', 'wifi', 'connect', 'OtherWiFi'], { runBinary: fakeExec, confirm: 'x', targets: { essids: ['OtherWiFi'] } }),
    /out-of-scope/,
    'join to out-of-scope ESSID refused'
  );
  // confirm-tier WITH --confirm + in-scope target runs
  const deauthOk = await wifi.defaultRunWifi('aireplay-ng', ['-0', '3', '-a', BSSID, 'wlan0mon'], { runBinary: fakeExec, confirm: 'authorized lab AP' });
  assert.strictEqual(deauthOk.status, 0, 'confirmed deauth runs');
  delete process.env.WIFI_SCOPE_JSON;

  // ---- subcommands with a fake runWifi (command assembly, no real exec) ----
  process.env.WIFI_APS_JSONL = path.join(tmpDir, 'wifi-aps.jsonl');
  const fakeRunWifi = async (bin, args, opts) => ({ status: 0, stdout: '', stderr: '' });
  const sc = await wifi.scan('wlan0', { runWifi: fakeRunWifi, csvText: CSV });
  assert.strictEqual(sc.results.length, 2, 'scan runs airmon-ng + airodump-ng');

  // ---- open-network recon: surfaces OPN APs and correlates their clients ----
  const CSV_OPEN = [
    'BSSID, First time seen, Last time seen, channel, Speed, Privacy, Cipher, Authentication, Power, # beacons, # IV, LAN IP, ID-length, ESSID, Key',
    '11:22:33:44:55:66, 2026-08-18 10:00:00, 2026-08-18 10:05:00, 11, 54, OPN, , OPN, -70, 20, 0, 0.0.0.0, 7, OpenNet,',
    '',
    'Station MAC, First time seen, Last time seen, Power, # packets, BSSID, Probed ESSIDs',
    '99:88:77:66:55:44, 2026-08-18 10:00:00, 2026-08-18 10:05:00, -50, 12, 11:22:33:44:55:66, OpenNet',
  ].join('\n');
  const op = await wifi.open('wlan0', { runWifi: fakeRunWifi, csvText: CSV_OPEN });
  assert.strictEqual(op.open.length, 1, 'one open AP surfaced');
  assert.strictEqual(op.open[0].bssid, '11:22:33:44:55:66', 'open AP bssid');
  assert.strictEqual(op.open[0].essid, 'OpenNet', 'open AP essid');
  assert.deepStrictEqual(op.open[0].stations, ['99:88:77:66:55:44'], 'open AP clients correlated');

  // ---- rogue AP orchestration: gate every step, only daemons spawn, configs land in opts.dir ----
  {
    const rogueDir = path.join(tmpDir, 'rogue');
    const pidsFile = path.join(tmpDir, 'rogue-pids.json');
    const gateCalls = [];
    const spawned = [];
    const rogueGate = async (bin, args, o) => { gateCalls.push({ bin, args, gateOnly: !!(o && o.gateOnly) }); return { gated: true }; };
    const fakeSpawn = (bin, args, o) => { spawned.push({ bin, log: o && o.logFile }); return { pid: 1000 + spawned.length, logFile: o && o.logFile }; };
    const rg = await wifi.rogue('MyLabWiFi', {
      channel: 6, dir: rogueDir, pidsFile,
      runWifi: rogueGate, spawnBg: fakeSpawn,
      runBinary: async () => ({ status: 0, stdout: '', stderr: '' }),
    });
    assert.strictEqual(gateCalls.length, 4, 'every rogue step goes through the gate');
    assert.ok(gateCalls.every((c) => c.gateOnly), 'rogue gates without executing');
    assert.deepStrictEqual(spawned.map((s) => s.bin), ['hostapd', 'dnsmasq'], 'only daemons spawn in background');
    assert.deepStrictEqual(rg.started.map((s) => s.pid), [1001, 1002], 'daemon pids recorded');
    assert.ok(fs.existsSync(path.join(rogueDir, 'hostapd.conf')), 'hostapd.conf written');
    assert.ok(fs.existsSync(path.join(rogueDir, 'dnsmasq.conf')), 'dnsmasq.conf written');
    assert.strictEqual(wifi.readPids({ pidsFile }).length, 2, 'pids persisted for rogue-stop');

    // rogue-stop kills the recorded daemons and rewrites the (now empty) pid list
    const killed = [];
    const st = await wifi.rogueStop({ pidsFile, runWifi: rogueGate, kill: (pid) => { killed.push(pid); return true; } });
    assert.deepStrictEqual(killed.sort(), [1001, 1002], 'recorded daemons killed');
    assert.strictEqual(st.stopped, 2, 'stopped count');
    assert.strictEqual(wifi.readPids({ pidsFile }).length, 0, 'pid list cleared');
  }
  const cap = await wifi.capture(BSSID, { runWifi: fakeRunWifi, channel: 6, confirm: 'lab' });
  assert.strictEqual(cap.results.length, 2, 'capture runs dump + deauth');
  assert.strictEqual(cap.bssid, BSSID_L, 'capture normalizes bssid');
  const ck = await wifi.crack('cap.cap', { runWifi: fakeRunWifi });
  assert.strictEqual(ck.status, 0, 'crack runs');
  const wp = await wifi.wps(BSSID, { runWifi: fakeRunWifi, channel: 6, confirm: 'lab' });
  assert.strictEqual(wp.status, 0, 'wps runs');

  // ---- defaultSpawnBg: a REAL detached spawn returns a numeric pid and writes the log ----
  {
    const logFile = path.join(tmpDir, 'spawn-bg.log');
    const bg = wifi.defaultSpawnBg(process.execPath, ['-e', 'console.log("bg-ok")'], { logFile });
    assert.strictEqual(typeof bg.pid, 'number', 'spawn returns a numeric pid');
    assert.strictEqual(bg.logFile, logFile, 'spawn returns the log path');
    assert.ok(fs.existsSync(logFile), 'spawn creates the log file');
    try { process.kill(bg.pid, 'SIGTERM'); } catch {}
  }

  // ---- rogueStop through the REAL gate (defaultRunWifi): cleanup is auto-tier + iface-targeted,
  //      so it must run WITHOUT --confirm; execution is injected so nothing touches the host ----
  {
    const scopeFile3 = path.join(tmpDir, 'wifi-scope-stop.json');
    fs.writeFileSync(scopeFile3, JSON.stringify({ bssids: [BSSID], essids: ['MyLabWiFi'], stations: [], channels: [1, 6, 11], max_requests_per_second: 1000 }));
    process.env.WIFI_SCOPE_JSON = scopeFile3;
    process.env.WIFI_AUDIT_JSONL = path.join(tmpDir, 'stop-audit.jsonl');
    const pidsFile = path.join(tmpDir, 'stop-pids.json');
    wifi.writePids([{ bin: 'hostapd', pid: 424242, log: 'x' }], { pidsFile });
    const execCalls = [];
    const stopRes = await wifi.rogueStop({
      pidsFile, iface: 'wlan0', kill: () => true,
      runBinary: async (bin, args) => { execCalls.push(bin + ' ' + args.join(' ')); return { status: 0, stdout: '', stderr: '' }; },
    });
    assert.strictEqual(stopRes.stopped, 1, 'recorded daemon counted as killed');
    assert.strictEqual(stopRes.results.length, 2, 'both cleanup steps went through the real gate');
    assert.ok(stopRes.results.every((r) => !r.blocked && r.status === 0), 'cleanup runs without --confirm (auto tier)');
    assert.ok(execCalls.some((c) => c.startsWith('sysctl')), 'ip_forward=0 rollback executed');
    assert.ok(execCalls.some((c) => c.startsWith('ip addr del')), 'gateway IP removed');
    assert.strictEqual(wifi.readPids({ pidsFile }).length, 0, 'pid list cleared');
    delete process.env.WIFI_SCOPE_JSON;
    delete process.env.WIFI_AUDIT_JSONL;
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
  // ---- rogue AP through the REAL gate: scope + confirm enforced ----
  {
    fs.mkdirSync(tmpDir, { recursive: true }); // the earlier block removed it
    const rScope = { bssids: [BSSID], essids: ['MyLabWiFi'], stations: [], channels: [1, 6, 11], max_requests_per_second: 1000 };
    const scopeFile2 = path.join(tmpDir, 'wifi-scope-rogue.json');
    fs.writeFileSync(scopeFile2, JSON.stringify(rScope));
    process.env.WIFI_SCOPE_JSON = scopeFile2;
    process.env.WIFI_AUDIT_JSONL = path.join(tmpDir, 'rogue-audit.jsonl');
    const rogueDir = path.join(tmpDir, 'rogue2');
    const okRogue = await wifi.rogue('MyLabWiFi', {
      channel: 6, confirm: 'authorized rogue AP test', dir: rogueDir, pidsFile: path.join(tmpDir, 'p2.json'),
      spawnBg: () => ({ pid: 7, logFile: 'x' }), runBinary: async () => ({ status: 0 }),
    });
    assert.strictEqual(okRogue.started.length, 2, 'rogue AP starts with confirm + in-scope ESSID/channel');
    await assert.rejects(
      wifi.rogue('MyLabWiFi', { channel: 6, dir: path.join(tmpDir, 'rogue3'), pidsFile: path.join(tmpDir, 'p3.json'), spawnBg: () => ({ pid: 1 }), runBinary: async () => ({ status: 0 }) }),
      /confirm-tier/,
      'rogue AP refused without --confirm'
    );
    await assert.rejects(
      wifi.rogue('OtherWiFi', { channel: 6, confirm: 'x', dir: path.join(tmpDir, 'rogue4'), pidsFile: path.join(tmpDir, 'p4.json'), spawnBg: () => ({ pid: 1 }), runBinary: async () => ({ status: 0 }) }),
      /out-of-scope/,
      'rogue AP refused for an out-of-scope ESSID'
    );
    delete process.env.WIFI_SCOPE_JSON;
    delete process.env.WIFI_AUDIT_JSONL;
  }

  console.log('wifi: all tests passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
