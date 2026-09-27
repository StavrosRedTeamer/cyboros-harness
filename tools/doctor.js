#!/usr/bin/env node
'use strict';
// tools/doctor.js — Stavros Doctor: controllo dipendenze + installazione guidata.
//
// Cosa controlla (tutto LOCALE, nessuna richiesta verso target):
//   1. runtime      node >= 22 (engines di package.json), python3, go, pipx, git, unzip, xz
//   2. progetto     file/cardini del workspace (registry, agents, GUI, knowledge, scope.json...)
//                   + validazione schema del tool-registry (node tools/run.js --registry-check)
//   3. registry     i binari instradabili via tools/run.js (elenco in tool-registry.json), con come si installano
//   4. extra        tool-plane esteso (msf, sliver, wireless, cloud CLI)
//   5. vendor       obscura, frida-server (root ESTERNA via tools/vendor-dir.js), tool vetted,
//                   mirror MANIFEST (questi ultimi gitignored: servono per copia-cartella; un
//                   git clone deve rifare "vendor-mirror.js pull")
//   6. scope        scope.json presente? allowlist vuota? (fail-closed: vuoto = tutto bloccato)
//   7. segreti      auth.json/c2.json/scope/... leggibili solo dall'operatore (--fix-perms).
//                   L'output umano non elenca gli host per default (finisce in screenshot e
//                   report): --show-hosts li mostra. `--json` resta completo, è l'input del CC.
//   8. spazio       occupazione per directory e cosa è archiviabile in temp/ (solo informativo:
//                   non incide su exit code né installazione). Lo spostamento lo fa
//                   tools/workspace-gc.js, che verifica con sha256 e non cancella mai.
//
// Installazione: SOLO dopo conferma interattiva (o --yes). Best-effort, in gruppi:
//   runtime (apt) -> arsenal (apt/go/pipx) -> suggerimenti manuali (sliver, cloud CLI).
// Per l'arsenale esteso completo rimanda a ./install-tools.sh (una sola fonte di verità
// per i pacchetti: doctor NON duplica quella lista).
//
// Uso:
//   node tools/doctor.js            # report + domanda di installazione (se TTY)
//   node tools/doctor.js --check    # solo report, nessuna domanda/instillazione
//   node tools/doctor.js --yes      # installa tutto il mancante senza domande
//   node tools/doctor.js --json     # report machine-readable (per la GUI/console)
//
// Exit code: 0 = tutto presente; 1 = mancanti (dopo eventuale install); 2 = core rotto.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const ROOT = path.resolve(__dirname, '..');
const IS_WIN = process.platform === 'win32';

// ---- CLI ----------------------------------------------------------------------
function parseArgs(argv) {
  const o = { check: false, yes: false, json: false, help: false, showHosts: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') o.check = true;
    else if (a === '--yes' || a === '-y') o.yes = true;
    else if (a === '--json') o.json = true;
    else if (a === '--show-hosts') o.showHosts = true;
    else if (a === '--fix-perms') o.fixPerms = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else { console.error(`doctor: opzione sconosciuta "${a}" (usa --help)`); process.exit(2); }
  }
  return o;
}

// ---- output helpers ------------------------------------------------------------
const C = process.stdout.isTTY && !IS_WIN ? {
  g: '\x1b[0;32m', y: '\x1b[0;33m', r: '\x1b[0;31m', c: '\x1b[0;36m', d: '\x1b[2m', b: '\x1b[1m', n: '\x1b[0m',
} : { g: '', y: '', r: '', c: '', d: '', b: '', n: '' };

const okS = (s) => `${C.g}OK${C.n}   ${s}`;
const missS = (s) => `${C.y}MISS${C.n} ${s}`;
const badS = (s) => `${C.r}FAIL${C.n}  ${s}`;
const infoS = (s) => `${C.c}::${C.n}   ${s}`;
const dimS = (s) => `${C.d}${s}${C.n}`;

// ---- system helpers -------------------------------------------------------------
function hasBin(bin) {
  const r = IS_WIN
    ? spawnSync('where', [bin], { stdio: 'ignore' })
    : spawnSync('/usr/bin/which', [bin], { stdio: 'ignore' });
  return r.status === 0;
}
function isRoot() { try { return process.getuid && process.getuid() === 0; } catch { return false; } }
function sudoPrefix() {
  if (isRoot()) return [];
  return hasBin('sudo') ? ['sudo'] : null; // null = niente modo di diventare root
}
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

// ---- 1. runtime ------------------------------------------------------------------
const RUNTIME = [
  { bin: 'node', how: 'apt:nodejs', note: 'richiesto >= 22 (npm engines); se apt dà una vecchia, usa nodesource' },
  { bin: 'python3', how: 'apt:python3' },
  { bin: 'go', how: 'apt:golang-go', note: 'serve per i tool ProjectDiscovery (httpx, subfinder, ...)' },
  { bin: 'pipx', how: 'apt:pipx', note: 'serve per h8mail, frida-tools, objection' },
  { bin: 'git', how: 'apt:git' },
  { bin: 'unzip', how: 'apt:unzip' },
  { bin: 'xz', how: 'apt:xz-utils' },
];
function nodeOk() {
  const major = parseInt(String(process.versions.node).split('.')[0], 10);
  return { bin: 'node', installed: true, ok: major >= 22, note: `v${process.versions.node} (min 22)` };
}
function checkRuntime() {
  const rows = [nodeOk()];
  for (const r of RUNTIME.slice(1)) {
    const installed = hasBin(r.bin);
    rows.push({ bin: r.bin, installed, ok: installed, how: r.how, note: r.note });
  }
  return rows;
}

// ---- 2. progetto -------------------------------------------------------------------
const CORE_FILES = [
  'package.json',
  'knowledge.md',
  'ops/harness.md',
  'tools/tool-registry.json',
  'tools/run.js',
  'tools/scope-guard.js',
  'tools/stavros.js',
  'tools/repeater.js',
  'tools/gui-server.js',
  'tools/gui/index.html',
  'tools/run-tests.js',
  'install-tools.sh',
];
// La flotta vive in local/fleet/ (28 specialisti) dal commit che ha separato il runner locale
// da Freebuff; .agents/ tiene solo l'agente root. Contare una sola delle due cartelle fa
// gridare "core rotto" a un workspace sano.
const AGENT_DIRS = ['local/fleet', '.agents'];
function countAgents() {
  const seen = new Set();
  for (const d of AGENT_DIRS) {
    try {
      for (const f of fs.readdirSync(path.join(ROOT, d))) if (f.endsWith('.ts')) seen.add(d + '/' + f);
    } catch { /* cartella assente */ }
  }
  return seen.size;
}
// Segreti e autorizzazioni di engagement: gitignorati, ma su disco devono essere leggibili
// solo dall'operatore. 0755 su auth.json significa che qualunque processo/utente sulla stessa
// macchina li legge (e che finiscono nelle copie di backup fatte senza guardare i permessi).
const SECRET_FILES = ['scope.json', 'auth.json', 'c2.json', 'wifi-scope.json', 'mobile-scope.json', 'mcp.json'];
function checkSecrets() {
  const rows = [];
  for (const f of SECRET_FILES) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;
    let mode = 0;
    try { mode = fs.statSync(p).mode & 0o777; } catch { continue; }
    const exposed = (mode & 0o077) !== 0;
    rows.push({ file: f, mode: mode.toString(8).padStart(3, '0'), ok: !exposed, exposed, path: p });
  }
  return rows;
}

// Occupazione del workspace. Perché è qui: `temp/` è 268 MB su 19.671 file di dati di engagement
// e finora niente lo diceva — `doctor` era l'unico posto in cui un operatore guarda, e taceva
// sulla voce più grande. Solo informativo: nessun exit code dipende da questo.
function checkSpace() {
  try {
    const GC = require('./workspace-gc');
    return GC.scanWorkspace(ROOT, { days: 30 });
  } catch {
    return null;
  }
}

function checkProject() {
  const rows = [];
  for (const f of CORE_FILES) {
    const p = path.join(ROOT, f);
    rows.push({ file: f, ok: fs.existsSync(p) });
  }
  const agents = countAgents();
  rows.push({ file: `agenti definiti (${AGENT_DIRS.join(' + ')})`, ok: agents >= 20, note: `${agents} agenti` });
  // scope.json è gitignored per design: su un checkout pulito la sua assenza è ATTESA, non un
  // workspace rotto (la sezione 6 la segnala già come fail-closed). Quindi non entra in
  // `core rotto`, altrimenti ogni clone e la CI nascono "rotti".
  const scopePresent = fs.existsSync(path.join(ROOT, 'scope.json'));
  rows.push({ file: 'scope.json (autorizzazione scritta)', ok: scopePresent, optional: true,
    note: 'gitignored: compilalo prima di un engagement (fail-closed fino ad allora)' });
  // validazione schema registry riusando il validatore del progetto (fonte di verità)
  const reg = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'run.js'), '--registry-check'],
    { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  rows.push({ file: 'tools/run.js --registry-check (schema)', ok: reg.status === 0, note: reg.status === 0 ? null : dimS((reg.stdout || reg.stderr || '').trim().split('\n').slice(0, 2).join(' | ')) });
  return rows;
}

// ---- 3. registry (i 35 bin via run.js) -----------------------------------------------
// cat = categoria logica (solo per il report); pkg = pacchetto apt; go = modulo go;
// pipx = pacchetto pipx; how:'aptgo' = apt prima, go come fallback.
const REGISTRY = [
  // recon
  { bin: 'subfinder', cat: 'recon', go: 'github.com/projectdiscovery/subfinder/v2/cmd/subfinder@latest' },
  { bin: 'amass', cat: 'recon', pkg: 'amass' },
  { bin: 'dnsx', cat: 'recon', go: 'github.com/projectdiscovery/dnsx/cmd/dnsx@latest' },
  { bin: 'gau', cat: 'recon', go: 'github.com/lc/gau/v2/cmd/gau@latest' },
  { bin: 'waybackurls', cat: 'recon', go: 'github.com/tomnomnom/waybackurls@latest' },
  { bin: 'katana', cat: 'recon', go: 'github.com/projectdiscovery/katana/cmd/katana@latest' },
  // scan
  { bin: 'nmap', cat: 'scan', pkg: 'nmap' },
  { bin: 'masscan', cat: 'scan', pkg: 'masscan' },
  { bin: 'nuclei', cat: 'scan', pkg: 'nuclei', go: 'github.com/projectdiscovery/nuclei/v3/cmd/nuclei@latest', how: 'aptgo' },
  { bin: 'httpx', cat: 'scan', go: 'github.com/projectdiscovery/httpx/cmd/httpx@latest' },
  { bin: 'ffuf', cat: 'scan', pkg: 'ffuf', go: 'github.com/ffuf/ffuf/v2@latest', how: 'aptgo' },
  { bin: 'gobuster', cat: 'scan', pkg: 'gobuster' },
  { bin: 'dirsearch', cat: 'scan', pkg: 'dirsearch' },
  // web
  { bin: 'sqlmap', cat: 'web', pkg: 'sqlmap' },
  { bin: 'dalfox', cat: 'web', go: 'github.com/hahwul/dalfox/v2@latest' },
  { bin: 'nikto', cat: 'web', pkg: 'nikto' },
  { bin: 'whatweb', cat: 'web', pkg: 'whatweb' },
  // creds
  { bin: 'hydra', cat: 'creds', pkg: 'hydra' },
  { bin: 'john', cat: 'creds', pkg: 'john' },
  { bin: 'hashcat', cat: 'creds', pkg: 'hashcat' },
  { bin: 'h8mail', cat: 'creds', pipx: 'h8mail' },
  { bin: 'netexec', cat: 'creds', pkg: 'netexec', pipx: 'netexec', how: 'aptpipx' },
  { bin: 'impacket-secretsdump', cat: 'creds', pkg: 'impacket-scripts' },
  // ad
  { bin: 'enum4linux', cat: 'ad', pkg: 'enum4linux', note: 'se assente copre enum4linux-ng (alternative nel registry)' },
  { bin: 'enum4linux-ng', cat: 'ad', pkg: 'enum4linux-ng' },
  { bin: 'ldapsearch', cat: 'ad', pkg: 'ldap-utils' },
  { bin: 'bloodhound-python', cat: 'ad', pkg: 'bloodhound.py', note: 'il collector è bloodhound-python; su Parrot il comando `bloodhound` è il SERVER GUI (bhapi/neo4j), NON il collector' },
  { bin: 'impacket-findDelegation', cat: 'ad', pkg: 'impacket-scripts', note: 'enum deleghe Kerberos (fallback findDelegation.py da pipx impacket)' },
  { bin: 'coercer', cat: 'ad', pipx: 'coercer', note: 'coercione autenticazioni MS-DFSNM/EFSR per ad.js coerce (confirm-tier); impacket NON include dfscoerce — coercer è il sostituto upstream-verificato' },
  // mobile
  { bin: 'curl', cat: 'core', pkg: 'curl' },
  { bin: 'adb', cat: 'mobile', pkg: 'adb' },
  { bin: 'apktool', cat: 'mobile', pkg: 'apktool' },
  { bin: 'jadx', cat: 'mobile', pkg: 'jadx', note: 'su Parrot è in apt (pkg jadx); su Debian puro ./install-tools.sh lo scarica dalle release GitHub' },
  { bin: 'frida', cat: 'mobile', pipx: 'frida-tools' },
  { bin: 'objection', cat: 'mobile', pipx: 'objection' },
  { bin: 'mitmproxy', cat: 'mobile', pkg: 'mitmproxy' },
  { bin: 'mitmdump', cat: 'mobile', pkg: 'mitmproxy', note: 'stesso pacchetto di mitmproxy' },
];

// ---- 4. extra tool-plane (rilevati ma fuori registry) ---------------------------------
const EXTRAS = [
  { bin: 'msfconsole', pkg: 'metasploit-framework' },
  { bin: 'msfvenom', pkg: 'metasploit-framework', note: 'stesso pacchetto di msfconsole' },
  { bin: 'sliver', manual: 'curl https://sliver.sh/install | sudo bash  (eseguilo SOLO tu — vedi install-tools.sh Fase 5)' },
  { bin: 'aircrack-ng', pkg: 'aircrack-ng', note: 'fornisce aircrack-ng/airmon-ng/airodump-ng' },
  { bin: 'airmon-ng', pkg: 'aircrack-ng', note: 'stesso pacchetto di aircrack-ng' },
  { bin: 'airodump-ng', pkg: 'aircrack-ng', note: 'stesso pacchetto di aircrack-ng' },
  { bin: 'aireplay-ng', pkg: 'aircrack-ng', note: 'deauth/injection (confirm-tier) — stesso pacchetto' },
  { bin: 'reaver', pkg: 'reaver' },
  // wireless — reti aperte / captive portal / rogue AP (Fase 4; solo Linux/Parrot).
  { bin: 'hcxdumptool', pkg: 'hcxdumptool', note: 'PMKID capture (confirm-tier capture)' },
  { bin: 'hcxpcapngtool', pkg: 'hcxtools', note: 'pcap -> hashcat 22000 (pacchetto hcxtools)' },
  { bin: 'hcxpsktool', pkg: 'hcxtools', note: 'stesso pacchetto di hcxpcapngtool' },
  { bin: 'wifite', pkg: 'wifite', note: 'automazione wifi (confirm-tier automated)' },
  { bin: 'hostapd', pkg: 'hostapd', note: 'rogue AP (confirm-tier rogue_ap)' },
  { bin: 'dnsmasq', pkg: 'dnsmasq', note: 'DHCP/DNS wildcard del rogue AP / captive portal' },
  { bin: 'iw', pkg: 'iw', note: 'monitor mode / configurazione interfaccia wireless' },
  { bin: 'macchanger', pkg: 'macchanger', note: 'spoof MAC (confirm-tier mac_spoof)' },
  { bin: 'tcpdump', pkg: 'tcpdump', note: 'sniff passivo (auto)' },
  { bin: 'tshark', pkg: 'tshark', note: 'analisi passiva delle catture (auto)' },
  { bin: 'aws', manual: 'pipx install awscli (o pacchetto distro)' },
  { bin: 'az', manual: 'pipx install azure-cli' },
  { bin: 'gcloud', manual: 'vedi https://cloud.google.com/sdk/docs/install' },
  { bin: 'chromium', pkg: 'chromium', note: 'browser per dom-check.js (CDP) e chrome-devtools MCP' },
];

function checkBins(list) {
  return list.map((r) => ({ ...r, installed: hasBin(r.bin) }));
}

// ---- 5. vendor -----------------------------------------------------------------------
// I binari grossi (obscura, frida-server) vivono nella root ESTERNA (tools/vendor-dir.js:
// $STAVROS_VENDOR_DIR → ~/.local/share/stavros/vendor → legacy workspace vendor/); script
// vetted e mirror restano in workspace (gitignored).
const { vendorRoot } = require('./vendor-dir');
const VENDOR = [
  { rel: 'tools/obscura/obscura', what: 'obscura (browser headless antidetect, backend CDP per dom-check.js)', fix: './install-tools.sh (Fase 4b) — installa fuori dalla workspace' },
  { rel: 'tools/frida/frida-server', what: 'frida-server android-x86_64 (lab ReDroid)', fix: './install-tools.sh (Fase 4c) — installa fuori dalla workspace' },
  { rel: 'tools/noauth_finder/noauth_finder.py', what: 'noauth_finder (tool vetted)', fix: 'node tools/vendor-mirror.js pull', legacy: true },
  { rel: 'mirror/MANIFEST.jsonl', what: 'mirror hash-pinnato (integrità zips)', fix: 'node tools/vendor-mirror.js pull', legacy: true },
  { rel: 'poc-archive/index.json', what: 'archivio PoC indicizzato', fix: 'node tools/vendor-mirror.js pull', legacy: true },
];
function checkVendor() {
  return VENDOR.map((v) => {
    const ext = path.join(vendorRoot(), v.rel);
    const legacy = path.join(ROOT, 'vendor', v.rel);
    const found = fs.existsSync(ext) ? ext : fs.existsSync(legacy) ? legacy : null;
    return { ...v, p: found || ext, ok: !!found };
  });
}

// ---- 6. scope -------------------------------------------------------------------------
function checkScope(opts) {
  const p = path.join(ROOT, 'scope.json');
  if (!fs.existsSync(p)) return { exists: false, empty: true, critical: true, note: 'scope.json ASSENTE: il guard fail-closed blocca OGNI azione su target (by design). Compilalo prima di un engagement.' };
  const s = readJson(p);
  if (!s) return { exists: true, empty: true, critical: true, note: 'scope.json non parsabile: il guard lo tratta come vuoto (fail-closed).' };
  const hosts = Array.isArray(s.allowed_hosts) ? s.allowed_hosts : [];
  const ips = Array.isArray(s.allowed_ips) ? s.allowed_ips : [];
  const empty = hosts.length === 0 && ips.length === 0;
  // L'output umano del doctor finisce in screenshot, log e report di engagement: i nomi dei
  // clienti restano fuori da lì per default (--show-hosts li mostra). Il --json invece
  // resta completo perché è l'input del Command Center, che gli host li deve mostrare.
  const listed = (opts && opts.showHosts)
    ? `${hosts.concat(ips).slice(0, 6).join(', ')}${hosts.length + ips.length > 6 ? ' …' : ''}`
    : `${hosts.length} host + ${ips.length} CIDR (redatto: --show-hosts per elencarli)`;
  return { exists: true, empty, critical: false, note: empty
    ? 'allowlist vuota: nessun target autorizzato (fail-closed). Compila scope.json per operare.'
    : `allowlist: ${listed}` };
}

// ---- installazione (best-effort, solo dopo consenso) ------------------------------------
function aptInstall(pkgs, log) {
  if (!pkgs.length) return true;
  const su = sudoPrefix();
  if (su === null) { log(`${C.r}serve root per apt e sudo non disponibile${C.n}`); return false; }
  log(infoS(`apt-get update && apt-get install -y ${pkgs.join(' ')}`));
  const upd = spawnSync([...su, 'apt-get', 'update', '-y'], { stdio: 'inherit', timeout: 300000 });
  if (upd.status !== 0) log(`${C.y}!! apt-get update ha restituito ${upd.status}: proseguo comunque${C.n}`);
  const ins = spawnSync([...su, 'apt-get', 'install', '-y', ...pkgs], { stdio: 'inherit', timeout: 900000 });
  if (ins.status !== 0) log(`${C.y}!! apt install parziale: alcuni pacchetti potrebbero non esistere su questa release${C.n}`);
  return true;
}

function goInstall(specs, log) {
  if (!specs.length || !hasBin('go')) {
    if (specs.length) log(`${C.y}!! go assente: salto ${specs.length} tool go${C.n}`);
    return;
  }
  const gopath = spawnSync('go', ['env', 'GOPATH'], { encoding: 'utf8' }).stdout?.trim() || '~/go';
  const gobin = path.join(gopath, 'bin');
  log(infoS(`go install in ${gobin} (verifica che sia nel PATH)`));
  for (const [bin, spec] of specs) {
    if (hasBin(bin)) continue;
    log(dimS(`go install ${spec}`));
    const r = spawnSync('go', ['install', spec], { stdio: 'inherit', timeout: 900000 });
    if (r.status !== 0) log(`${C.y}!! go install ${bin} fallito (riprova; serve internet)${C.n}`);
  }
  if (!process.env.PATH.includes(gobin)) {
    log(`${C.y}!! aggiungi al PATH: export PATH="$PATH:${gobin}"  (in ~/.bashrc)${C.n}`);
  }
}

function pipxInstall(pkgs, log) {
  if (!pkgs.length) return;
  const binsFor = { 'h8mail': 'h8mail', 'frida-tools': 'frida', 'objection': 'objection', 'netexec': 'netexec' };
  if (hasBin('pipx')) {
    for (const pkg of pkgs) {
      if (hasBin(binsFor[pkg] || pkg)) continue;
      log(dimS(`pipx install ${pkg}`));
      const r = spawnSync('pipx', ['install', pkg], { stdio: 'inherit', timeout: 600000 });
      if (r.status !== 0 && hasBin('pip3')) {
        log(dimS(`pipx fallito, provo pip3 install --user ${pkg}`));
        spawnSync('pip3', ['install', '--user', pkg], { stdio: 'inherit', timeout: 600000 });
      }
    }
    const localBin = path.join(process.env.HOME || '', '.local', 'bin');
    if (!process.env.PATH.includes(localBin)) log(`${C.y}!! aggiungi al PATH: export PATH="$PATH:${localBin}"${C.n}`);
  } else if (hasBin('pip3')) {
    log(infoS(`pipx assente, pip3 install --user ${pkgs.join(' ')}`));
    spawnSync('pip3', ['install', '--user', ...pkgs], { stdio: 'inherit', timeout: 900000 });
  } else {
    log(`${C.y}!! né pipx né pip3: salto ${pkgs.join(', ')}${C.n}`);
  }
}

// ---- prompt ----------------------------------------------------------------------------
function makeAsker(interactive) {
  if (!interactive) return async () => true; // con --yes tutto true; in --check non si arriva qui
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return async (q) => {
    const a = await new Promise((res) => rl.question(`${q} ${C.d}[S/n]${C.n} `, res));
    const t = String(a).trim().toLowerCase();
    return t === '' || t === 's' || t === 'sì' || t === 'si' || t === 'y' || t === 'yes';
  };
}

// ---- report -----------------------------------------------------------------------------
function section(title) {
  console.log(`\n${C.b}${C.c}== ${title} ${'='.repeat(Math.max(1, 58 - title.length))}${C.n}`);
}

function printRow(installed, label, note) {
  const pad = ' '.repeat(Math.max(1, 26 - label.length));
  console.log(`  ${installed ? okS(label) : missS(label)}${pad}${note ? dimS(note) : ''}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(require('node:fs').readFileSync(__filename, 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
    return 0;
  }

  const runtime = checkRuntime();
  const project = checkProject();
  const registry = checkBins(REGISTRY);
  const extras = checkBins(EXTRAS);
  const vendor = checkVendor();
  const scope = checkScope(opts);
  const space = checkSpace();
  let secrets = checkSecrets();
  if (opts.fixPerms) {
    for (const r of secrets.filter((s) => s.exposed)) {
      try { fs.chmodSync(r.path, 0o600); r.mode = '600'; r.ok = true; r.exposed = false; } catch { /* segnalato sotto */ }
    }
    secrets = checkSecrets();
  }

  if (opts.json) {
    // install hints are part of the JSON on purpose: the Command Center builds the
    // "install what is missing" plan from THIS document, so doctor stays the single
    // source of truth for what to install and how (never re-derived by the UI).
    const how = (r) => r.how || (r.pkg ? 'apt' : r.go ? 'go' : r.pipx ? 'pipx' : 'manual');
    const j = {
      ts: new Date().toISOString(),
      runtime, project,
      registry: registry.map(({ bin, cat, installed, pkg, go, pipx, note }) => ({ bin, cat, installed, pkg: pkg || null, go: go || null, pipx: pipx || null, note: note || null })),
      extras: extras.map(({ bin, installed, pkg, manual, note }) => ({ bin, installed, pkg: pkg || null, manual: manual || null, note: note || null })),
      vendor: vendor.map(({ p, ok, what, fix }) => ({ path: p, ok, what: what || null, fix: fix || null })),
      scope,
      // Additivo: l'occupazione per directory e i candidati all'archiviazione. La Console lo
      // mostra; nessun campo esistente cambia forma.
      space: space ? {
        archive_root: space.archive_root,
        archivable_roots: space.archivable_roots,
        total_bytes: space.total_bytes,
        dirs: space.dirs,
        top_candidates: space.candidates.slice(0, 10),
      } : null,
      summary: {
        registry_total: registry.length,
        registry_present: registry.filter((r) => r.installed).length,
        extras_present: extras.filter((r) => r.installed).length,
        core_broken: project.some((r) => !r.ok),
        // additive: what the installer would act on, per group
        runtime_missing: runtime.slice(1).filter((r) => !r.installed).map((r) => ({ bin: r.bin, how: r.how || null, note: r.note || null })),
        registry_missing: registry.filter((r) => !r.installed).map((r) => ({ bin: r.bin, cat: r.cat, how: how(r), pkg: r.pkg || null, go: r.go || null, pipx: r.pipx || null, note: r.note || null })),
        extras_missing: extras.filter((r) => !r.installed).map((r) => ({ bin: r.bin, how: how(r), pkg: r.pkg || null, manual: r.manual || null, note: r.note || null })),
        vendor_missing: vendor.filter((v) => !v.ok).map((v) => ({ what: v.what, fix: v.fix })),
      },
    };
    console.log(JSON.stringify(j, null, 2));
    return j.summary.core_broken ? 2 : (j.summary.registry_present < j.summary.registry_total ? 1 : 0);
  }

  console.log(`\n${C.b}Stavros Doctor — controllo dipendenze (${new Date().toISOString().split('T')[0]})${C.n}`);
  console.log(dimS(`root: ${ROOT}`));

  // 1. runtime
  section('1. Runtime');
  const nodeRow = runtime[0];
  printRow(nodeRow.ok, 'node', nodeRow.note || (nodeRow.ok ? '' : 'richiesto >= 22'));
  for (const r of runtime.slice(1)) printRow(r.installed, r.bin, r.installed ? '' : `installa con ${r.how}`);

  // 2. progetto
  section('2. File di progetto (cardini)');
  for (const r of project) printRow(r.ok, r.file, r.ok ? '' : (r.note || 'MANCANTE — il workspace è incompleto'));

  // 3. registry
  section(`3. Binari registry run.js (${registry.filter((r) => r.installed).length}/${registry.length} presenti)`);
  let lastCat = null;
  for (const r of registry) {
    if (r.cat !== lastCat) { console.log(dimS(`  — ${r.cat} —`)); lastCat = r.cat; }
    const how = r.pkg ? `apt:${r.pkg}` : r.go ? 'go' : r.pipx ? `pipx:${r.pipx}` : '';
    printRow(r.installed, r.bin, r.installed ? '' : [how, r.note].filter(Boolean).join(' · '));
  }

  // 4. extra
  section('4. Extra tool-plane (opzionali)');
  for (const r of extras) printRow(r.installed, r.bin, r.installed ? '' : (r.manual || `apt:${r.pkg}`));

  // 5. vendor
  section('5. Vendor (gitignored — viaggiano solo con copia-cartella)');
  for (const v of vendor) printRow(v.ok, path.basename(v.p), v.ok ? dimS(v.what) : `${v.what} → ${v.fix}`);

  // 6. scope
  section('6. Scope (fail-closed)');
  if (scope.critical) console.log(`  ${badS('scope.json')} ${scope.note}`);
  else if (scope.empty) console.log(`  ${missS('scope.json vuota')} ${scope.note}`);
  else console.log(`  ${okS('scope.json')} ${dimS(scope.note)}`);

  // 7. segreti di engagement
  if (secrets.length) {
    section('7. Segreti di engagement (permessi)');
    for (const s of secrets) {
      printRow(s.ok, s.file, s.ok ? `0${s.mode}` : `0${s.mode} — leggibile da altri utenti (node tools/doctor.js --fix-perms)`);
    }
  }

  // 8. spazio
  if (space) {
    const GC = require('./workspace-gc');
    section('8. Spazio (occupazione)');
    // Nessun OK/MISS: è una misura, non un verdetto — `printRow` direbbe "OK" a una riga che non
    // ha passato niente. Stessa spaziatura, senza il giudizio.
    for (const d of space.dirs) {
      const label = `${d.name}/`;
      console.log(`  ${label}${' '.repeat(Math.max(1, 26 - label.length))}${dimS(`${GC.human(d.disk_bytes)} · ${d.files} file`)}`);
    }
    const top = space.candidates.slice(0, 5);
    if (top.length) {
      console.log(`\n  ${dimS('archiviabile in ' + space.archivable_roots.map((r) => r + '/').join(', ') + ':')}`);
      for (const c of top) {
        const stale = c.stale && c.age_days !== null ? ` — inattivo da ${c.age_days}g` : '';
        console.log(`    ${(c.root + '/' + c.name).padEnd(30)} ${GC.human(c.disk_bytes).padStart(9)}${stale}`);
      }
      console.log(`  ${dimS(`sposta con: node tools/workspace-gc.js archive <nome> — archivio ${space.archive_root}, verifica sha256, nessuna cancellazione`)}`);
    }
  }

  // browser/mcp nota
  const browserOk = hasBin('chromium') || hasBin('google-chrome') || hasBin('google-chrome-stable');
  console.log(`\n  ${browserOk ? okS('browser CDP') : missS('browser CDP')} ${dimS(browserOk ? 'chrome-devtools MCP pronto (headless)' : 'chrome-devtools MCP richiede Chrome/Chromium; il pacchetto npx si scarica da solo al primo uso (serve internet)')}`);

  // summary + exit decision
  const missingRegistry = registry.filter((r) => !r.installed);
  const missingRuntime = runtime.slice(1).filter((r) => !r.installed);
  const coreBroken = project.some((r) => !r.ok && !r.optional);
  const exposedSecrets = secrets.filter((s) => s.exposed);
  console.log(`\n${C.b}Riepilogo:${C.n} runtime mancanti=${missingRuntime.length}, registry mancanti=${missingRegistry.length}, ` +
    `vendor mancanti=${vendor.filter((v) => !v.ok).length}, core rotto=${coreBroken ? 'SÌ' : 'no'}` +
    (secrets.length ? `, segreti esposti=${exposedSecrets.length}` : ''));

  if (IS_WIN) {
    console.log(`\n${C.y}Windows: l'installazione nativa non è coperta; usa install-tools.ps1 o WSL + questo script.${C.n}`);
    return coreBroken ? 2 : (missingRegistry.length ? 1 : 0);
  }
  if (coreBroken) {
    console.log(`${C.r}Il workspace è incompleto: ripristina i file mancanti prima di installare tool.${C.n}`);
    return 2;
  }
  if (opts.check) {
    if (exposedSecrets.length) {
      console.log(`${C.r}Segreti di engagement leggibili da altri utenti: ${exposedSecrets.map((s) => s.file).join(', ')}` +
        `\nCorreggi con: node tools/doctor.js --fix-perms${C.n}`);
      return 1;
    }
    if (missingRegistry.length || missingRuntime.length) {
      console.log(dimS('\n(--check: solo report. Lancia senza --check per installare.)'));
      return 1;
    }
    console.log(`${C.g}Tutto il necessario per Stavros è presente.${C.n}`);
    return 0;
  }
  if (!missingRuntime.length && !missingRegistry.length) {
    console.log(`${C.g}Tutto il necessario per Stavros è presente. Nulla da installare.${C.n}`);
    console.log(dimS('Suggerimento: npm test (gate offline), ./install-tools.sh per l\'arsenale esteso.'));
    return 0;
  }

  // ---- installazione guidata ----
  const interactive = Boolean(process.stdin.isTTY) && !opts.yes;
  if (!interactive && !opts.yes) {
    console.log(`${C.y}Non interattivo: rilancia con --yes per installare tutto il mancante senza domande.${C.n}`);
    return 1;
  }
  const ask = makeAsker(opts.yes);
  if (opts.yes) console.log(`\n${infoS('--yes: installo tutto il mancante senza altre domande')}`);

  // gruppo runtime (apt)
  const rtPkgs = missingRuntime.map((r) => String(r.how || '').replace(/^apt:/, '')).filter((p) => p && !p.startsWith('apt:nodejs'));
  if (rtPkgs.length && (opts.yes || await ask(`\nInstallare il runtime mancante via apt (${rtPkgs.join(', ')})?`))) {
    if (rtPkgs.includes('nodejs')) console.log(dimS('node: se apt dà una versione < 22 usa nodesource (https://deb.nodesource.com)'));
    aptInstall(rtPkgs, console.log.bind(console));
  }

  // gruppo arsenal: apt / aptgo / go / pipx
  const aptPkgs = [];
  const aptgoPairs = [];
  const goSpecs = [];
  const pipxPkgs = [];
  const manualNotes = [];
  for (const r of missingRegistry) {
    if (r.how === 'aptgo') { aptPkgs.push(r.pkg); aptgoPairs.push([r.bin, r.go]); }
    else if (r.pkg) aptPkgs.push(r.pkg);
    else if (r.go) goSpecs.push([r.bin, r.go]);
    if (r.pipx) pipxPkgs.push(r.pipx);
    if (!r.pkg && !r.go && !r.pipx) manualNotes.push(`${r.bin}: ${r.note || 'installazione manuale'}`);
  }
  const doApt = aptPkgs.length && (opts.yes || await ask(`Installare i pacchetti apt mancanti (${aptPkgs.join(', ')})?`));
  if (doApt) aptInstall([...new Set(aptPkgs)], console.log.bind(console));
  const doGo = goSpecs.length && (opts.yes || await ask(`Compilare/installare i tool Go (${goSpecs.map((s) => s[0]).join(', ')})?`));
  if (doGo) goInstall(goSpecs, console.log.bind(console));
  const doPipx = pipxPkgs.length && (opts.yes || await ask(`Installare i tool Python via pipx (${pipxPkgs.join(', ')})?`));
  if (doPipx) pipxInstall([...new Set(pipxPkgs)], console.log.bind(console));

  // fallback go per aptgo falliti + verifica finale
  if (doApt && aptgoPairs.length) goInstall(aptgoPairs.filter(([bin]) => !hasBin(bin)), console.log.bind(console));

  // extras mancanti: apt diretti (best-effort) + manuali
  const missingExtras = extras.filter((r) => !r.installed);
  const extraApt = [...new Set(missingExtras.filter((r) => r.pkg).map((r) => r.pkg))];
  if (extraApt.length && (opts.yes || await ask(`Installare anche gli extra opzionali via apt (${extraApt.join(', ')})?`))) {
    aptInstall(extraApt, console.log.bind(console));
  }
  for (const r of missingExtras.filter((x) => x.manual)) console.log(`${C.y}manuale:${C.n} ${r.bin} → ${r.manual}`);

  // vendor mancanti
  for (const v of vendor.filter((x) => !x.ok)) console.log(`${C.y}vendor:${C.n} ${v.what} → ${v.fix}`);

  // riepilogo finale
  const registryAfter = checkBins(REGISTRY).filter((r) => !r.installed);
  console.log(`\n${C.b}Post-install:${C.n} registry mancanti=${registryAfter.length}${registryAfter.length ? ` (${registryAfter.map((r) => r.bin).join(', ')})` : ''}`);
  if (registryAfter.length === 0) {
    console.log(`${C.g}Registry completo: tutti i 35 binari di run.js sono disponibili.${C.n}`);
    console.log(dimS('Per l\'arsenale esteso (seclists, wpscan, certipy, wordlist, ReDroid…) lancia: ./install-tools.sh'));
    console.log(dimS('Verifica finale della suite: npm test'));
    return 0;
  }
  console.log(dimS('I mancanti hanno alternative nel registry (campo "alternative") o workaround curl/repeater.js;'));
  console.log(dimS('riprova ./install-tools.sh per un tentativo più aggressivo, o installali a mano.'));
  return 1;
}

main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(2); });
