#!/usr/bin/env node
// Wireless scope-enforcing runner + orchestration (Fase 4). Wireless is a SEPARATE mode from
// the web/network pipeline (tools/stavros.js): targets are BSSID/ESSID/station/channel, NOT
// IPs, so run.js/scope-guard.js don't apply here — this is the wireless analog of run.js.
//
//   node tools/wifi.js check <target>                      scope verdict (exit 0 = in scope)
//   node tools/wifi.js scan <iface>                        monitor mode + passive airodump-ng (auto)
//   node tools/wifi.js open <iface>                        passive recon, surface OPEN APs + clients (auto)
//   node tools/wifi.js capture <bssid> [--channel N] [--write <cap>] [--pmkid] [--confirm "reason"]
//   node tools/wifi.js crack <cap> [--wordlist <w>]        offline aircrack-ng (auto)
//   node tools/wifi.js wps <bssid> [--channel N] [--confirm "reason"]
//   node tools/wifi.js join <essid> [--bssid <mac>] [--confirm "reason"]   associate (nmcli), confirm-tier
//   node tools/wifi.js mac <random|clone|reset> <iface> [--mac <m>] [--confirm "reason"]  confirm-tier
//   node tools/wifi.js sniff <iface> [--write <prefix>]    passive tcpdump capture (auto)
//   node tools/wifi.js status                              summary of reports/wifi-aps.jsonl
//
// Every third-party wireless binary runs through runWifi (default = scope-check + tier-check +
// audit + streaming runBinary). Inject a fake runWifi in tests to exercise the command assembly
// offline. Disruptive actions (deauth, WPS, wifite2 automation, hcxdumptool PMKID, join, MAC
// spoofing) are confirm-tier: refused without --confirm "<reason>" (explicit in-session approval),
// mirroring c2-guard.js for host ops. Passive listening (airodump-ng/wash/tcpdump) and offline
// cracking (aircrack-ng) are auto-tier.
//
// ponytail: aircrack-ng/wifite2/reaver/hcxdumptool output is human text (not a stable machine
// format); airodump-ng CSV is parsed best-effort (ESSID may contain commas). The monitor-mode
// interface name convention (<iface>mon) is not universal — verify on the real NIC.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const wg = require('./wifi-guard');
const { runBinary } = require('./run');
const { hasBin } = require('./tool-plane');
const pace = require('./pace');

const APS_FILE = () => process.env.WIFI_APS_JSONL || path.join(__dirname, '..', 'reports', 'wifi-aps.jsonl');
const AUDIT_FILE = () => process.env.WIFI_AUDIT_JSONL || path.join(__dirname, '..', 'reports', 'tmp', 'wifi-audit.jsonl');

// ---- target extraction (BSSID / ESSID / channel from a wireless tool's argv) ----
const MAC_RE = /\b[0-9a-fA-F]{2}(?:[:-][0-9a-fA-F]{2}){5}\b|\b[0-9a-fA-F]{12}\b/g;
const ESSID_FLAGS = new Set(['-e', '--essid', '--essid-regex']);
const CHANNEL_FLAGS = new Set(['-c', '--channel']);
// Interface-looking token (wlan0, wlan0mon, wlp3s0, mon0, ath0...). An interface is a LOCAL NIC,
// not a wireless target, but it is the only "target" of mac/sniff — so it counts toward the
// no-target fail-closed check (mac is confirm-tier, sniff is auto). It is never scope-checked.
const IFACE_RE = /^(?:wlan|wlp|wls|wlx|wl|mon|ath|ra|wdev|phy)\w*\d+\w*$/i;
// Action classes whose operand IS the local NIC (so the iface alone is a legitimate target).
// Everything else that touches a live AP must name an in-scope BSSID/ESSID/channel.
const IFACE_TARGET_CLASSES = new Set(['mac_spoof', 'sniff', 'cleanup']);

function extractTargets(args) {
  const bssids = new Set();
  const essids = new Set();
  const channels = new Set();
  const ifaces = new Set();
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    for (const m of a.match(MAC_RE) || []) {
      const n = wg.normalizeMac(m);
      if (n) bssids.add(n);
    }
    if (ESSID_FLAGS.has(a) && args[i + 1] != null) essids.add(String(args[i + 1]));
    if (CHANNEL_FLAGS.has(a) && wg.isChannel(args[i + 1])) channels.add(Number(args[i + 1]));
    if (IFACE_RE.test(a) && !wg.isMac(a)) ifaces.add(a.toLowerCase());
  }
  return { bssids: [...bssids], essids: [...essids], channels: [...channels], ifaces: [...ifaces] };
}

// ---- action classification (bin + args -> action class) ----
const RULES = [
  [/\baireplay-ng\b|\bmdk[34]\b/i, 'deauth'],
  [/\bmacchanger\b|\bip\s+link\s+set\b/i, 'mac_spoof'],
  [/\bnmcli\b|\bwpa_supplicant\b|\bwpa_cli\b|\biwconfig\b/i, 'join'],
  [/\bhostapd\b|\bdnsmasq\b|\beaphammer\b/i, 'rogue_ap'],
  [/\bportal\.js\b[\s\S]*\bserve\b/i, 'portal_serve'],
  [/\btcpdump\b|\btshark\b|\bdumpcap\b/i, 'sniff'],
  // cleanup is the rollback of our own rogue setup (del gw IP / disable forwarding) -> auto
  [/\bip\s+addr\s+del\b|\bsysctl\b[\s\S]*ip_forward=0\b/i, 'cleanup'],
  [/\bip\s+addr\s+add\b|\bsysctl\b[\s\S]*ip_forward=1\b/i, 'rogue_ap'],
  [/\breaver\b|\bbully\b|\bpixiewps\b/i, 'wps'],
  [/\bwifite2?\b|\bfluxion\b|\bairgeddon\b/i, 'automated'],
  [/\bhcxdumptool\b|\bhcxpcapngtool\b/i, 'capture'],
  [/\bairodump-ng\b|\bairmon-ng\b|\bwash\b/i, 'scan'],
  [/\baircrack-ng\b/i, 'crack'],
];

function classifyRaw(bin, args) {
  const text = [bin].concat(args).join(' ');
  for (const [re, cls] of RULES) if (re.test(text)) return cls;
  return null;
}

function loadTiers(scope) {
  const wo = (scope && scope.wireless_ops) || {};
  return {
    auto: new Set(wo.auto || ['scan', 'crack', 'sniff', 'cleanup']),
    confirm: new Set(wo.confirm || ['deauth', 'capture', 'wps', 'automated', 'join', 'mac_spoof', 'rogue_ap', 'portal_serve']),
  };
}

function classify(bin, args, scope) {
  const tiers = loadTiers(scope);
  const cls = classifyRaw(bin, args);
  if (cls && tiers.auto.has(cls)) return { actionClass: cls, tier: 'auto' };
  return { actionClass: cls || 'unknown', tier: 'confirm' }; // unknown -> confirm (fail closed)
}

// ---- audit trail (same evidence convention as run.js) ----
function auditWifi(entry) {
  try {
    const p = AUDIT_FILE();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(entry) + '\n');
  } catch {}
}

function writeAtomic(file, data) {
  const tmp = file + '.' + process.pid;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

// ---- discovered APs (reports/wifi-aps.jsonl, deduped on bssid) ----
function readAps() {
  try {
    return fs.readFileSync(APS_FILE(), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function appendAps(recs) {
  const existing = readAps();
  const seen = new Set(existing.map((a) => a.bssid));
  let n = 0;
  const lines = [];
  for (const r of recs) {
    if (!r || !r.bssid || seen.has(r.bssid)) continue;
    seen.add(r.bssid);
    lines.push(JSON.stringify(Object.assign({ first_seen: new Date().toISOString() }, r)));
    n++;
  }
  if (lines.length) {
    const p = APS_FILE();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    writeAtomic(p, existing.map((a) => JSON.stringify(a)).concat(lines).join('\n') + '\n');
  }
  return n;
}

// ---- runWifi: injectable, default = scope-check + tier-check + audit + runBinary ----
async function defaultRunWifi(bin, args, opts) {
  opts = opts || {};
  let scope;
  try {
    scope = wg.loadWifiScope();
  } catch {
    const e = new Error('wifi-scope.json missing - nothing is authorized yet');
    e.blocked = true;
    throw e;
  }
  if (wg.scopeEmpty(scope)) {
    const e = new Error('wifi-scope.json empty - nothing is authorized yet');
    e.blocked = true;
    throw e;
  }
  // Extract targets from argv, merged with any explicit opts.targets the caller supplies (e.g.
  // `join <essid>` passes the SSID positionally, since nmcli args carry no -e/--essid flag).
  const extracted = extractTargets(args);
  const explicit = opts.targets || {};
  const bssids = [...new Set(extracted.bssids.concat(explicit.bssids || []).map((m) => wg.normalizeMac(m)).filter(Boolean))];
  const essids = [...new Set(extracted.essids.concat(explicit.essids || []))];
  const channels = [...new Set(extracted.channels.concat(explicit.channels || []))];
  const ifaces = [...new Set(extracted.ifaces.concat(explicit.ifaces || []).map((i) => String(i).toLowerCase()))];
  const { tier, actionClass } = classify(bin, args, scope);
  const confirm = opts.confirm && String(opts.confirm).trim();
  if (tier === 'confirm' && !confirm) {
    const e = new Error(`action '${actionClass}' is confirm-tier: pass --confirm "<reason>" (requires explicit in-session user approval)`);
    e.blocked = true; e.tier = tier; e.actionClass = actionClass;
    throw e;
  }
  // scope-check every extracted target (fail closed)
  const bad = [];
  for (const b of bssids) if (!wg.bssidInScope(b, scope).ok && !wg.stationInScope(b, scope).ok) bad.push(b);
  for (const e2 of essids) if (!wg.essidInScope(e2, scope).ok) bad.push(JSON.stringify(e2));
  for (const c of channels) if (!wg.channelInScope(c, scope).ok) bad.push('channel ' + c);
  // No live target in argv: only auto-tier actions (passive scan / offline crack) may proceed —
  // they don't touch a live AP. Confirm-tier actions with no target are meaningless-or-dangerous
  // and fail closed (unknown bins classify as confirm, so they're covered too). An interface only
  // satisfies the target requirement for actions where the NIC itself is the operand (mac/sniff);
  // for AP-touching actions (deauth/wps/capture/automated/join) `-i <iface>` alone still fails.
  const ifaceIsTarget = IFACE_TARGET_CLASSES.has(actionClass);
  const noTargets = bssids.length === 0 && essids.length === 0 && channels.length === 0 && !(ifaceIsTarget && ifaces.length);
  if (noTargets && tier !== 'auto') {
    const e = new Error('no in-scope wireless target found in args (fail closed)');
    e.blocked = true; e.reason = 'no wireless target found';
    throw e;
  }
  if (bad.length) {
    const e = new Error('out-of-scope wireless target(s): ' + bad.join(', '));
    e.blocked = true; e.bad = bad;
    throw e;
  }
  const rps = (scope && scope.max_requests_per_second) || 1;
  await pace.wait(rps);
  auditWifi({ ts: new Date().toISOString(), bin, args, bssids, essids, channels, ifaces, action: actionClass, tier, confirmed: !!confirm });
  // gateOnly: run every scope/tier/audit check but DON'T execute — used by rogue(), which must
  // gate a long-running server (hostapd/dnsmasq) and then spawn it in the background itself.
  if (opts.gateOnly) return { gated: true, actionClass, tier, bssids, essids, channels, ifaces };
  const exec = opts.runBinary || runBinary;
  const r = await exec(bin, args, { capture: true, input: opts.input, timeoutMs: opts.timeoutMs });
  auditWifi({ ts: new Date().toISOString(), bin, args, action: actionClass, exit: r.status, ok: r.status === 0, error: r.error });
  return r;
}

// ---- concrete command lists (kept pure for tests) ----

function scanCommands(iface) {
  const mon = iface + 'mon';
  return [
    { bin: 'airmon-ng', args: ['start', iface] },
    { bin: 'airodump-ng', args: [mon, '--output-format', 'csv', '-w', path.join('reports', 'wifi', 'scan')] },
  ];
}

function captureCommands(bssid, opts) {
  opts = opts || {};
  const b = wg.normalizeMac(bssid) || String(bssid);
  const mon = opts.iface ? opts.iface + 'mon' : 'wlan0mon';
  const cap = opts.write || path.join('reports', 'wifi', 'capture-' + b.replace(/:/g, ''));
  if (opts.pmkid) {
    return [{ bin: 'hcxdumptool', args: ['-i', mon, '--filterlist_ap=' + b, '--filtermode=2', '-w', cap] }];
  }
  const cmds = [{ bin: 'airodump-ng', args: ['-c', String(opts.channel), '--bssid', b, '-w', cap, mon] }];
  cmds.push({ bin: 'aireplay-ng', args: ['-0', '3', '-a', b, mon] });
  return cmds;
}

function crackCommands(cap, opts) {
  opts = opts || {};
  const w = opts.wordlist || '/usr/share/wordlists/rockyou.txt';
  return [{ bin: 'aircrack-ng', args: [cap, '-w', w] }];
}

function wpsCommands(bssid, opts) {
  opts = opts || {};
  const b = wg.normalizeMac(bssid) || String(bssid);
  const mon = opts.iface ? opts.iface + 'mon' : 'wlan0mon';
  return [{ bin: 'reaver', args: ['-i', mon, '-b', b, '-c', String(opts.channel), '-vv'] }];
}

// ---- open-network + local-NIC commands (kept pure for tests) ----

// Associate to an (expected open) network. nmcli is preferred because it also brings up DHCP and
// is present on Parrot/KDE; the SSID is positional, so the caller must also pass it as an explicit
// scope target (opts.targets.essids) — see join().
function joinCommands(essid, opts) {
  opts = opts || {};
  const args = ['device', 'wifi', 'connect', String(essid)];
  const b = wg.normalizeMac(opts.bssid);
  if (b) args.push('bssid', b);
  return [{ bin: 'nmcli', args }];
}

// Local NIC MAC control. No AP is touched, but it changes the identity the NIC presents, so the
// whole class is confirm-tier (it is how you defeat MAC-based captive-portal authorization).
function macCommands(mode, iface, opts) {
  opts = opts || {};
  const m = String(mode || '').toLowerCase();
  if (m === 'random') return [{ bin: 'macchanger', args: ['-r', String(iface)] }];
  if (m === 'reset') return [{ bin: 'macchanger', args: ['-p', String(iface)] }];
  if (m === 'clone') {
    const mac = wg.normalizeMac(opts.mac);
    if (!mac) throw new Error('mac clone requires --mac <mac>');
    return [{ bin: 'macchanger', args: ['-m', mac, String(iface)] }];
  }
  throw new Error('mac mode must be random|clone|reset');
}

// Passive capture on an open network (no transmission toward any AP).
function sniffCommands(iface, opts) {
  opts = opts || {};
  const out = opts.write || path.join('reports', 'wifi', 'sniff-' + String(iface));
  return [{ bin: 'tcpdump', args: ['-i', String(iface), '-n', '-U', '-w', out + '.pcap'] }];
}

// ---- airodump-ng CSV parser (pure; AP section only) ----
// ponytail: the airodump CSV layout is fixed but the ESSID column may contain commas, so it is
// re-joined from column 13 onward. A changed layout degrades to [] instead of wrong records.
function parseAirodumpCsv(text) {
  const aps = [];
  if (text == null || typeof text !== 'string') return aps;
  let inAp = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^BSSID,/.test(line)) { inAp = true; continue; }
    if (/^Station MAC,/.test(line)) { inAp = false; continue; } // station section follows the APs
    if (!inAp) continue;
    const cols = line.split(',').map((c) => String(c).trim());
    const bssid = wg.normalizeMac(cols[0]);
    if (!bssid) continue;
    // ESSID is column 13; the empty Key column follows, so join from 13 and drop the trailing
    // empty field. (An ESSID containing unquoted commas would still split — ponytail.)
    const essid = cols.slice(13).join(',').replace(/,\s*$/, '') || null;
    aps.push({
      bssid,
      channel: cols[3] ? Number(cols[3]) : null,
      privacy: cols[5] || null,
      cipher: cols[6] || null,
      auth: cols[7] || null,
      essid,
    });
  }
  return aps;
}

// ---- airodump-ng station parser (pure; client section) ----
// Columns: Station MAC, First time seen, Last time seen, Power, # packets, BSSID, Probed ESSIDs.
// `bssid` is the AP the station is associated with (blank while unassociated).
function parseAirodumpStations(text) {
  const stations = [];
  if (text == null || typeof text !== 'string') return stations;
  let inSt = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^Station MAC,/.test(line)) { inSt = true; continue; }
    if (/^BSSID,/.test(line)) { inSt = false; continue; }
    if (!inSt) continue;
    const cols = line.split(',').map((c) => String(c).trim());
    const station = wg.normalizeMac(cols[0]);
    if (!station) continue;
    stations.push({
      station,
      power: cols[3] ? Number(cols[3]) : null,
      packets: cols[4] ? Number(cols[4]) : null,
      bssid: wg.normalizeMac(cols[5]) || null,
      probed: cols.slice(6).join(',').replace(/,\s*$/, '') || null,
    });
  }
  return stations;
}

// An AP is open when airodump reports the OPN privacy flag (or an OPN auth with no cipher).
function isOpen(ap) {
  if (!ap) return false;
  const p = String(ap.privacy || '').toUpperCase();
  if (p === 'OPN' || p === 'OPEN') return true;
  return String(ap.auth || '').toUpperCase() === 'OPN' && !ap.cipher;
}

// Read the most recent airodump CSVs (or an injected opts.csvText) into deduped APs + stations.
function collectRecon(opts) {
  opts = opts || {};
  if (opts.csvText) {
    return { aps: parseAirodumpCsv(opts.csvText), stations: parseAirodumpStations(opts.csvText) };
  }
  const dir = path.join(__dirname, '..', 'reports', 'wifi');
  const aps = [];
  const stations = [];
  try {
    const files = fs.readdirSync(dir).filter((f) => /\.csv$/.test(f) && f.startsWith('scan')).sort();
    for (const f of files.slice(-3)) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      for (const a of parseAirodumpCsv(text)) if (!aps.some((x) => x.bssid === a.bssid)) aps.push(a);
      for (const s of parseAirodumpStations(text)) if (!stations.some((x) => x.station === s.station)) stations.push(s);
    }
  } catch {}
  return { aps, stations };
}

// ---- subcommands ----

async function scan(iface, opts) {
  opts = opts || {};
  const runWifi = opts.runWifi || defaultRunWifi;
  const results = [];
  for (const c of scanCommands(iface)) {
    const r = await runWifi(c.bin, c.args, opts);
    results.push({ cmd: c.bin, args: c.args, status: r && r.status, stdout: r && r.stdout });
  }
  const aps = collectRecon(opts).aps;
  const added = aps.length ? appendAps(aps) : 0;
  return { iface, results, aps: added };
}

// Open-network recon: passive scan, then surface APs with no encryption plus their client stations.
async function open(iface, opts) {
  opts = opts || {};
  const runWifi = opts.runWifi || defaultRunWifi;
  const results = [];
  for (const c of scanCommands(iface)) {
    const r = await runWifi(c.bin, c.args, opts);
    results.push({ cmd: c.bin, args: c.args, status: r && r.status, stdout: r && r.stdout });
  }
  const { aps, stations } = collectRecon(opts);
  const added = aps.length ? appendAps(aps) : 0;
  const openAps = aps.filter(isOpen).map((a) => Object.assign({}, a, {
    stations: stations.filter((s) => s.bssid === a.bssid).map((s) => s.station),
  }));
  return { iface, results, aps: added, open: openAps };
}

async function join(essid, opts) {
  opts = opts || {};
  const runWifi = opts.runWifi || defaultRunWifi;
  const cmd = joinCommands(essid, opts)[0];
  // The SSID is positional in nmcli's argv, so pass it as an explicit scope target.
  const o = Object.assign({}, opts, { targets: { essids: [String(essid)], bssids: opts.bssid ? [opts.bssid] : [] } });
  const r = await runWifi(cmd.bin, cmd.args, o);
  return { essid, bssid: wg.normalizeMac(opts.bssid) || null, status: r && r.status, stdout: r && r.stdout };
}

async function mac(mode, iface, opts) {
  opts = opts || {};
  const runWifi = opts.runWifi || defaultRunWifi;
  const cmd = macCommands(mode, iface, opts)[0];
  const r = await runWifi(cmd.bin, cmd.args, opts);
  return { mode: String(mode).toLowerCase(), iface, status: r && r.status, stdout: r && r.stdout };
}

async function sniff(iface, opts) {
  opts = opts || {};
  const runWifi = opts.runWifi || defaultRunWifi;
  const cmd = sniffCommands(iface, opts)[0];
  const r = await runWifi(cmd.bin, cmd.args, opts);
  return { iface, out: cmd.args[cmd.args.length - 1], status: r && r.status };
}

async function capture(bssid, opts) {
  opts = opts || {};
  const runWifi = opts.runWifi || defaultRunWifi;
  const results = [];
  for (const c of captureCommands(bssid, opts)) {
    const r = await runWifi(c.bin, c.args, opts);
    results.push({ cmd: c.bin, args: c.args, status: r && r.status, stdout: r && r.stdout });
  }
  return { bssid: wg.normalizeMac(bssid), results };
}

async function crack(cap, opts) {
  opts = opts || {};
  const runWifi = opts.runWifi || defaultRunWifi;
  const cmd = crackCommands(cap, opts)[0];
  const r = await runWifi(cmd.bin, cmd.args, opts);
  return { cap, status: r && r.status, stdout: r && r.stdout };
}

async function wps(bssid, opts) {
  opts = opts || {};
  const runWifi = opts.runWifi || defaultRunWifi;
  const cmd = wpsCommands(bssid, opts)[0];
  const r = await runWifi(cmd.bin, cmd.args, opts);
  return { bssid: wg.normalizeMac(bssid), status: r && r.status, stdout: r && r.stdout };
}

// ---- rogue AP (hostapd + dnsmasq) — config builders (pure) ----

const ROGUE_DIR = () => path.join('reports', 'wifi', 'rogue');

// R4: the ESSID is interpolated into the line-oriented hostapd.conf (ssid=<value>), so a newline
// or '=' in the value would inject directives into the config. 802.11 caps the SSID at 32 BYTES.
// Pure + fail-closed (throw) so a bad ESSID never reaches a config file.
function validateEssid(essid) {
  const e = String(essid == null ? '' : essid);
  if (!e.trim()) throw new Error('rogue requires a non-empty ESSID');
  if (/[\r\n\u0000]/.test(e)) throw new Error('ESSID must not contain newlines/NUL (hostapd.conf injection)');
  if (e.includes('=')) throw new Error('ESSID must not contain "=" (hostapd.conf injection)');
  if (Buffer.byteLength(e, 'utf8') > 32) throw new Error('ESSID must be <= 32 bytes (802.11 SSID limit)');
  return e;
}

// hostapd.conf (open AP, no encryption — it mirrors an open/hotspot SSID) + dnsmasq.conf with a
// wildcard DNS that points every name at our gateway, i.e. the captive-portal behaviour.
function rogueConfigs(essid, opts) {
  opts = opts || {};
  const iface = opts.iface || 'wlan0';
  const channel = Number(opts.channel) || 6;
  const gw = opts.gw || '10.0.0.1';
  const dhcpRange = opts.dhcpRange || '10.0.0.10,10.0.0.250,12h';
  const hostapd = [
    'interface=' + iface,
    'driver=nl80211',
    'ssid=' + validateEssid(essid),
    'hw_mode=g',
    'channel=' + channel,
    'auth_algs=1',
    'ignore_broadcast_ssid=0',
    'wpa=0',
    '# open rogue AP — authorized assessment only; mirrors the in-scope SSID posture',
  ].join('\n') + '\n';
  const dnsmasq = [
    'interface=' + iface,
    'bind-interfaces',
    'dhcp-range=' + dhcpRange,
    'dhcp-option=3,' + gw,   // default gateway = us
    'dhcp-option=6,' + gw,   // DNS = us
    'address=/#/' + gw,      // wildcard: every lookup lands on the portal
    'log-queries',
    'log-dhcp',
  ].join('\n') + '\n';
  return { iface, channel, gw, hostapd, dnsmasq, dir: opts.dir || ROGUE_DIR() };
}

// Setup plan. mode 'run' = short-lived setup step; 'background' = long-running daemon.
function rogueCommands(essid, opts) {
  opts = opts || {};
  const c = rogueConfigs(essid, opts);
  return [
    { bin: 'ip', args: ['addr', 'add', c.gw + '/24', 'dev', c.iface], mode: 'run' },
    { bin: 'sysctl', args: ['-w', 'net.ipv4.ip_forward=1'], mode: 'run' },
    { bin: 'hostapd', args: [path.join(c.dir, 'hostapd.conf')], mode: 'background' },
    { bin: 'dnsmasq', args: ['-C', path.join(c.dir, 'dnsmasq.conf'), '--no-daemon', '--log-facility=-'], mode: 'background' },
  ];
}

// Rollback of OUR setup (cleanup class = auto, iface-targeted).
function rogueStopCommands(opts) {
  opts = opts || {};
  const iface = opts.iface || 'wlan0';
  const gw = opts.gw || '10.0.0.1';
  return [
    { bin: 'sysctl', args: ['-w', 'net.ipv4.ip_forward=0'], mode: 'run' },
    { bin: 'ip', args: ['addr', 'del', gw + '/24', 'dev', iface], mode: 'run' },
  ];
}

function roguePidsFile(opts) {
  opts = opts || {};
  return opts.pidsFile || path.join(__dirname, '..', 'reports', 'wifi', 'rogue', 'pids.json');
}

function readPids(opts) {
  try { return JSON.parse(fs.readFileSync(roguePidsFile(opts), 'utf8')); } catch { return []; }
}

function writePids(list, opts) {
  const f = roguePidsFile(opts);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(list, null, 2) + '\n');
}

// Detached spawn for the daemons; returns the PID immediately (runBinary would block forever).
function defaultSpawnBg(bin, args, opts) {
  opts = opts || {};
  const logFile = opts.logFile || path.join(__dirname, '..', ROGUE_DIR(), bin + '.log');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const out = fs.openSync(logFile, 'a');
  const child = spawn(bin, args, { detached: true, stdio: ['ignore', out, out] });
  child.unref();
  return { pid: child.pid, logFile };
}

// Stand up a rogue AP. Confirm-tier (rogue_ap): the ESSID must be in wifi-scope.json and the
// channel in scope, and every step is gated by runWifi before anything is spawned.
async function rogue(essid, opts) {
  opts = opts || {};
  const runWifi = opts.runWifi || defaultRunWifi;
  const spawnBg = opts.spawnBg || defaultSpawnBg;
  const cfg = rogueConfigs(essid, opts);
  const cmds = rogueCommands(essid, opts);
  const targets = { essids: [String(essid)], channels: [cfg.channel] };

  // Gate EVERY step (scope + tier + audit, no execution) BEFORE writing configs or spawning:
  // a blocked rogue AP must leave no config files and no processes behind.
  for (const c of cmds) {
    await runWifi(c.bin, c.args, Object.assign({}, opts, { gateOnly: true, targets }));
  }

  const dirAbs = path.isAbsolute(cfg.dir) ? cfg.dir : path.join(__dirname, '..', cfg.dir);
  fs.mkdirSync(dirAbs, { recursive: true });
  fs.writeFileSync(path.join(dirAbs, 'hostapd.conf'), cfg.hostapd);
  fs.writeFileSync(path.join(dirAbs, 'dnsmasq.conf'), cfg.dnsmasq);

  const started = [];
  const ran = [];
  for (const c of cmds) {
    if (c.mode === 'background') {
      if (!opts.spawnBg && !hasBin(c.bin)) {
        const e = new Error(`required binary '${c.bin}' not found — install it (./install-tools.sh) and retry`);
        e.blocked = true;
        throw e;
      }
      const r = spawnBg(c.bin, c.args, { logFile: path.join(dirAbs, c.bin + '.log') });
      started.push({ bin: c.bin, pid: r.pid, log: r.logFile });
    } else {
      const exec = opts.runBinary || runBinary;
      const r = await exec(c.bin, c.args, { capture: true, timeoutMs: opts.timeoutMs || 60000 });
      ran.push({ bin: c.bin, status: r && r.status, error: r && r.error });
    }
  }
  writePids(started, opts);
  return {
    essid, iface: cfg.iface, channel: cfg.channel, gw: cfg.gw, configs: cfg.dir,
    started, ran,
    portal: opts.portal ? { dir: opts.portal, port: opts.portalPort || 80, collect: !!opts.collect } : null,
    next_step: 'Serve the portal (node tools/portal.js serve --confirm "<reason>"), then tear down with "node tools/wifi.js rogue-stop".',
  };
}

// Tear down the rogue AP: kill the recorded daemons, then undo the local network changes.
async function rogueStop(opts) {
  opts = opts || {};
  const runWifi = opts.runWifi || defaultRunWifi;
  const kill = opts.kill || ((pid) => { try { process.kill(pid, 'SIGTERM'); return true; } catch { return false; } });
  const killed = [];
  for (const p of readPids(opts)) {
    if (p && p.pid) killed.push({ pid: p.pid, bin: p.bin, ok: kill(p.pid) });
  }
  const results = [];
  for (const c of rogueStopCommands(opts)) {
    try {
      const r = await runWifi(c.bin, c.args, Object.assign({}, opts, { targets: { ifaces: [String(opts.iface || 'wlan0')] } }));
      results.push({ cmd: c.bin, status: r && r.status });
    } catch (e) {
      results.push({ cmd: c.bin, blocked: true, error: e.message });
    }
  }
  writePids([], opts);
  return { stopped: killed.length, killed, results };
}

function status() {
  const aps = readAps();
  return { aps: aps.length, list: aps };
}

// ---- CLI ----

function usage() {
  console.error(
    'usage: node tools/wifi.js check <target> | scan <iface> | open <iface> | capture <bssid> [--channel N] [--write <cap>] [--pmkid] [--confirm "<reason>"] | crack <cap> [--wordlist <w>] | wps <bssid> [--channel N] [--confirm "<reason>"] | join <essid> [--bssid <mac>] [--confirm "<reason>"] | mac <random|clone|reset> <iface> [--mac <m>] [--confirm "<reason>"] | sniff <iface> [--write <prefix>] | rogue <essid> --channel N [--iface wlan0] [--gw 10.0.0.1] [--portal <dir>] [--collect] [--confirm "<reason>"] | rogue-stop [--iface wlan0] [--gw 10.0.0.1] | status'
  );
  process.exit(2);
}

function parseArgs(rest) {
  const opts = {};
  const pos = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--channel') opts.channel = Number(rest[++i]);
    else if (a === '--write') opts.write = rest[++i];
    else if (a === '--wordlist') opts.wordlist = rest[++i];
    else if (a === '--iface') opts.iface = rest[++i];
    else if (a === '--pmkid') opts.pmkid = true;
    else if (a === '--bssid') opts.bssid = rest[++i];
    else if (a === '--mac') opts.mac = rest[++i];
    else if (a === '--gw') opts.gw = rest[++i];
    else if (a === '--portal') opts.portal = rest[++i];
    else if (a === '--portal-port') opts.portalPort = Number(rest[++i]);
    else if (a === '--collect') opts.collect = true;
    else if (a === '--confirm') opts.confirm = rest[++i];
    else pos.push(a);
  }
  return { opts, pos };
}

async function main() {
  const argv = process.argv.slice(2);
  const [cmd, ...rest] = argv;
  if (!cmd) usage();
  if (cmd === 'check') {
    let scope;
    try { scope = wg.loadWifiScope(); } catch (e) {
      console.log(JSON.stringify({ ok: false, reason: 'wifi-scope.json missing - nothing is authorized yet' }));
      process.exit(1);
    }
    if (wg.scopeEmpty(scope)) {
      console.log(JSON.stringify({ ok: false, reason: 'wifi-scope.json empty - nothing is authorized yet' }));
      process.exit(1);
    }
    const res = wg.inWifiScope(rest[0], scope);
    console.log(JSON.stringify(res));
    process.exit(res.ok ? 0 : 1);
  }
  if (cmd === 'status') {
    console.log(JSON.stringify(status(), null, 2));
    process.exit(0);
  }
  const { opts, pos } = parseArgs(rest);
  try {
    let out;
    switch (cmd) {
      case 'scan':
        if (!pos[0]) usage();
        out = await scan(pos[0], opts);
        break;
      case 'open':
        if (!pos[0]) usage();
        out = await open(pos[0], opts);
        break;
      case 'join':
        if (!pos[0]) usage();
        out = await join(pos[0], opts);
        break;
      case 'mac':
        if (!pos[0] || !pos[1]) usage();
        out = await mac(pos[0], pos[1], opts);
        break;
      case 'sniff':
        if (!pos[0]) usage();
        out = await sniff(pos[0], opts);
        break;
      case 'capture':
        if (!pos[0]) usage();
        out = await capture(pos[0], opts);
        break;
      case 'crack':
        if (!pos[0]) usage();
        out = await crack(pos[0], opts);
        break;
      case 'wps':
        if (!pos[0]) usage();
        out = await wps(pos[0], opts);
        break;
      case 'rogue':
        if (!pos[0]) usage();
        out = await rogue(pos[0], opts);
        break;
      case 'rogue-stop':
        out = await rogueStop(opts);
        break;
      default:
        usage();
    }
    console.log(JSON.stringify(out, null, 2));
  } catch (e) {
    console.error(JSON.stringify({ error: e.message, blocked: e.blocked || undefined, tier: e.tier, action: e.actionClass, bad: e.bad }));
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  scan, open, capture, crack, wps, join, mac, sniff, rogue, rogueStop, status,
  scanCommands, captureCommands, crackCommands, wpsCommands, joinCommands, macCommands, sniffCommands,
  rogueConfigs, rogueCommands, rogueStopCommands, readPids, writePids, defaultSpawnBg, validateEssid,
  extractTargets, classify, classifyRaw, loadTiers, isOpen, parseArgs,
  parseAirodumpCsv, parseAirodumpStations, collectRecon, readAps, appendAps,
  defaultRunWifi,
};
