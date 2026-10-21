#!/usr/bin/env node
// tools/project-map.js — la mappa del progetto, GENERATA dal repository reale.
//
// Perché esiste: il motore è cresciuto a ondate e oggi sono 160 moduli più centotredici test in una
// cartella piatta, senza niente che dica quale file è un cancello, quale è una libreria e
// quale un entry point. Una mappa scritta a mano invecchia al primo modulo aggiunto (è
// successo: `docs/project-graph.html` era ferma al 4 ottobre, non la citava nessun file e
// nessun codice la rigenerava). Questa si rigenera dai file veri, come `docs/INDEX.md`.
//
// Cosa legge, non cosa gli si dice:
//   · l'elenco dei moduli lo decide `git ls-files` (un clone vede gli stessi: il worktree
//     non conta, l'indice sì — è la lezione di `tools/test-lint.js`);
//   · lo scopo in una riga è il primo blocco di commento dell'header di ogni modulo;
//   · l'invocazione è la riga `node tools/<file>.js …` dell'header, o lo shebang;
//   · i test che nominano un modulo vengono dai `require`/riferimenti reali dei test;
//   · i conteggi (moduli, test, pipeline, agenti, documenti) sono contati adesso.
//
// La tabella AREAS è l'unica cosa dichiarata a mano, ed è deliberata: è la risposta a
// «dove metto un file nuovo?» e parla la lingua dell'operatore — attacchi web, attacchi host,
// recon, opsec — non quella del codice. Un modulo non assegnato, assegnato due volte, un
// binario esterno o un file citato che non esiste fanno uscire con exit 1: fail-closed, come
// il resto della harness.
//
// Uso:
//   node tools/project-map.js            # (ri)scrive docs/project-map.html
//   node tools/project-map.js --check    # non scrive: exit 1 se la mappa è indietro
//
// L'HTML è self-contained: zero dipendenze, zero CDN, zero font remoti (il repo è offline
// e `docs/egress-opsec.md` vieta l'egress). Si apre da `file://` senza rete.

'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const WS = path.resolve(__dirname, '..');
const TOOLS = path.join(WS, 'tools');
const OUT = path.join(WS, 'docs', 'project-map.html');

// ── indice di git ─────────────────────────────────────────────────────────────
// Come in docs-index.js: la mappa descrive ciò che è versionato. Un file solo su questo
// disco non esiste per chi clona, e la mappa committata non sarebbe riproducibile.
const TRACKED = (() => {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: WS, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return new Set(out.split('\0').filter(Boolean));
  } catch { return null; }   // export/tarball senza git: si legge il disco
})();

const read = (p) => fs.readFileSync(p, 'utf8');
const rel = (p) => path.relative(WS, p).split(path.sep).join('/');
const isTracked = (p) => !TRACKED || TRACKED.has(rel(p));

// ── le aree: l'unica tabella dichiarata ──────────────────────────────────────
// Le aree sono il vocabolario dell'operatore, non quello del codice: attacchi web, attacchi
// host, recon e OSINT, opsec. È la stessa domanda a cui risponde l'indice — «dove metto un
// file nuovo?» — e ogni modulo, ogni binario del registro e ogni file chiave devono stare in
// una e una sola area: la generazione si ferma se qualcuno resta fuori (fail-closed).
// `accent` è una chiave funzionale: colore = area, e non si usa per decorare.
const AREAS = [
  {
    id: 'gate', name: 'Cancello e scope', accent: '#ffb020',
    blurb: 'Chi decide se puoi. Gira sotto il modello e dice no: fail-closed, e non esiste un flag che lo spenga.',
    modules: [
      'scope-guard', 'ssrf-guard', 'c2-guard', 'wifi-guard', 'mobile-guard',
      'enforce', 'permission-matrix', 'request-approval', 'mcp-guard-proxy',
    ],
    files: ['knowledge.md', 'docs/THREAT-MODEL.md', 'scope.example.json'],
  },
  {
    id: 'recon', name: 'Recon e OSINT', accent: '#d9c07a',
    blurb: 'Prima di attaccare: chi è il bersaglio, cosa espone, cosa se ne sa già. Include il radar e la ricerca di exploit.',
    modules: [
      'searchsploit', 'threatintel', 'cloud-enum', 'radar', 'radar-scout', 'radar-analyst',
      'radar-profiler', 'listen-audit', 'map', 'vendor-mirror', 'vendor-dir', 'parsers',
    ],
    tools: [
      'subfinder', 'amass', 'dnsx', 'gau', 'waybackurls', 'katana', 'httpx', 'httpx-toolkit',
      'whatweb', 'wafw00f', 'dnsrecon', 'dnsenum', 'fierce', 'shuffledns', 'mapcidr',
      'theharvester', 'uncover', 'cewl', 'eyewitness', 'trufflehog', 'titus', 'h8mail',
    ],
    files: ['workflows/recon-baseline.yaml', 'docs/toolbox.md'],
  },
  {
    id: 'web', name: 'Attacchi web', accent: '#a97cff',
    blurb: 'Tutto ciò che parla HTTP: richieste ripetibili, token, header, desync, GraphQL, la superficie client-side, i credential attack.',
    modules: [
      'repeater', 'jwt', 'cors', 'csp', 'desync', 'graphql', 'ws', 'saml',
      'api-authz', 'cachepoison', 'header-check', 'dom-check', 'analyze-bundle',
      'authn-oracle', 'obscura', 'reflector', 'oob', 'spray', 'crack', 'login', 'wp-check', 'takeover',
    ],
    tools: [
      'curl', 'nuclei', 'ffuf', 'feroxbuster', 'gobuster', 'dirsearch', 'dirb', 'wfuzz', 'arjun',
      'nikto', 'dalfox', 'xsser', 'sqlmap', 'commix', 'wpscan', 'schemathesis', 'h2csmuggler',
      'zaproxy', 'interactsh-client',
    ],
    files: ['workflows/attack-http-surface.yaml', 'workflows/attack-jwt.yaml',
      'workflows/attack-nextjs.yaml', 'workflows/attack-dataapi.yaml', 'docs/methodology-classes.md'],
  },
  {
    id: 'host', name: 'Attacchi host, AD e rete', accent: '#7d9cff',
    blurb: 'Dal web al sistema: dominio, servizi di rete, privesc, C2, e i credential attack contro i servizi.',
    modules: ['ad', 'net', 'privesc', 'msf', 'sliver', 'sshx'],
    tools: [
      'nmap', 'masscan', 'naabu', 'rustscan', 'netexec', 'nxc', 'enum4linux', 'enum4linux-ng',
      'ldapsearch', 'bloodhound-python', 'certipy', 'smbclient', 'rpcclient', 'smbmap',
      'snmpwalk', 'onesixtyone', 'tnscmd10g', 'oscanner', 'evil-winrm', 'chisel', 'responder',
      'coercer', 'impacket-secretsdump', 'impacket-ntlmrelayx', 'impacket-dfscoerce',
      'impacket-findDelegation', 'findDelegation.py', 'impacket-psexec', 'impacket-wmiexec',
      'impacket-getTGT', 'impacket-getST', 'impacket-GetUserSPNs', 'impacket-lookupsid',
      'impacket-rpcdump', 'impacket-smbclient', 'hydra', 'medusa', 'kerbrute', 'brutus',
      'john', 'hashcat',
    ],
    files: ['docs/host-exploitation.md', 'workflows/enum-smb.yaml', 'workflows/attack-creds.yaml'],
  },
  {
    id: 'wireless', name: 'Attacchi wireless', accent: '#2ee6c5',
    blurb: 'Spettro radio: l\'unica superficie con un\'autorizzazione propria (wifi-scope.json) e un tier model suo.',
    modules: ['wifi'],
    tools: [
      'airmon-ng', 'airodump-ng', 'aireplay-ng', 'aircrack-ng', 'hcxdumptool', 'hcxpcapngtool',
      'reaver', 'nmcli', 'hostapd', 'dnsmasq', 'tcpdump', 'tshark',
    ],
    files: ['docs/wireless.md', 'wifi-scope.example.json'],
  },
  {
    id: 'mobile', name: 'Attacchi mobile', accent: '#46d1a8',
    blurb: 'Device Android: la seconda superficie con autorizzazione propria (mobile-scope.json), dal unpacking al hook runtime.',
    modules: [
      'mobile', 'frida/anti-anti', 'frida/component-fuzz', 'frida/crypto-dump',
      'frida/disable-flutter-tls', 'frida/key-hunt', 'frida/storage-triage', 'frida/unpin',
    ],
    tools: ['adb', 'apktool', 'jadx', 'frida', 'objection', 'mitmproxy', 'mitmdump'],
    files: ['docs/mobile.md'],
  },
  {
    id: 'opsec', name: 'Opsec ed egress', accent: '#8fa3c8',
    blurb: 'Niente esce dalla macchina dell\'engagement: egress forzato su allowlist, pacing, placeholder, e identità verificata.',
    modules: ['egress-proxy', 'proxy-route', 'socks5', 'privacy', 'pace', 'check-identity'],
    files: ['docs/egress-opsec.md'],
  },
  {
    id: 'plan', name: 'Pipeline e piano', accent: '#ff8a3d',
    blurb: 'Cosa fare adesso e cosa manca: la pipeline deterministica, il piano guidato dai finding, i gap di copertura.',
    modules: [
      'cyboros', 'workflow', 'planner', 'planner-demo', 'next-actions',
      'autopilot', 'autopilot-checkpoint', 'loop-watch',
      'coverage', 'coverage-loop', 'attack-coverage', 'target-model', 'attack-galaxy',
    ],
    files: ['workflows/', 'knowledge.md'],
  },
  {
    id: 'runtime', name: 'Runtime e stato', accent: '#3fd6ff',
    blurb: 'Il motore che esegue una volta passato il cancello: processo, budget, audit, e la catena delle ricevute su disco.',
    modules: [
      'run', 'state', 'opstate', 'proc-registry', 'tool-plane', 'tool-path',
      'budget', 'accounting', 'audit-trail', 'artifact-ledger', 'chain', 'chain-log', 'rechain',
      'continuation', 'circuit-breaker', 'recover', 'sessions', 'workspace-gc', 'kill-port',
      'daily-maintenance', 'ensure-test-scope', 'mcp-bridge',
    ],
    files: ['docs/ARCHITECTURE.md', 'tools/tool-registry.json'],
  },
  {
    id: 'proof', name: 'Prova e referto', accent: '#46d17f',
    blurb: 'La severità non supera l\'evidenza: registrazione, verifica indipendente, riproduzione, report e gate di chiusura.',
    modules: [
      'record-finding', 'verify-finding', 'verification-log', 'verify-tag', 'oracle',
      'gen-poc', 'poc-replay', 'evidence-quote', 'effective-findings', 'gate',
      'report-html', 'report-sarif', 'distiller', 'cvss', 'epss', 'entity-taxonomy',
    ],
    files: ['docs/METHODOLOGY.md', 'docs/GLOSSARY.md', 'docs/entity-taxonomy.yaml'],
  },
  {
    id: 'memory', name: 'Memoria e conoscenza', accent: '#b8d17a',
    blurb: 'Ciò che resta tra un engagement e l\'altro — sanificato — e il recupero a budget fisso che lo riporta in contesto.',
    modules: ['memory', 'memory-store', 'memory-recall', 'memory-rag', 'embeddings', 'kb-search', 'retrieval-budget'],
    files: ['memory/', 'skills/pentest-playbook/SKILL.md'],
  },
  {
    id: 'console', name: 'Command Center', accent: '#ff4d9d',
    blurb: 'La superficie umana: il programma desktop, il suo backend Node, e le viste che leggono stato e ricevute.',
    modules: [
      'cc-approvals', 'cc-arsenal', 'cc-campaign', 'cc-coverage', 'cc-graph', 'cc-instance',
      'cc-ledger', 'cc-mission', 'cc-panic', 'cc-router', 'cc-util', 'cc-warroom',
      // The backend as a composition: entry point, request pipeline, then one module
      // per responsibility (transport, gate, route families, jobs, terminals, models).
      'gui-server',
      'console/app', 'console/http', 'console/gate', 'console/files',
      'console/routes/index', 'console/routes/public', 'console/routes/accounts',
      'console/routes/state', 'console/routes/streams', 'console/routes/chat',
      'console/jobs', 'console/terminals', 'console/chat',
      'console/scope', 'console/findings', 'console/pipeline', 'console/engagement',
      'gui/app', 'gui/views-control', 'gui/views-engagement', 'gui/views-warroom',
      'gui/login', 'gui/views-admin', 'gui/views-chat', 'gui/guide',
      'identity', 'users', 'config', 'init',
      'portal', 'backfill-findings-tab',
    ],
    files: ['docs/command-center-desktop.md', 'cyboros-cc', 'docs/IDENTITY.md'],
  },
  {
    id: 'forum', name: 'Forum agentico', accent: '#c77dff',
    blurb: 'Il canale fra agenti: messaggi firmati, identità assegnate dal server, e il ruolo admin dall\'altro lato.',
    modules: ['forum', 'forum-server', 'forum-keystore', 'forum-admin', 'forum-admin-agent', 'forum-sim'],
    files: ['docs/forum-admin.md', 'skills/agent-forum/SKILL.md'],
  },
  {
    id: 'fleet', name: 'Flotta e agenti', accent: '#9aa8ff',
    blurb: 'Gli agenti e il loro prompt: chi fa cosa, con quale modello, e la disciplina che li tiene allineati.',
    modules: ['fleet', 'model-routing', 'llm-inject', 'vet-agents-vs-freebuff'],
    files: ['local/fleet/', 'ops/harness.md', '.agents/'],
  },
  {
    id: 'lab', name: 'Laboratorio e benchmark', accent: '#8892a6',
    blurb: 'Il modello locale senza cloud e la misura: il benchmark contaminazione-proof e la sua provenienza.',
    modules: ['gen-bench', 'eval-juice-shop', 'bench-provenance'],
    files: ['BENCHMARK.md', 'local/README-local.md', 'docs/RECORDING.md'],
  },
  {
    id: 'hygiene', name: 'Igiene del repository', accent: '#a8b0c0',
    blurb: 'I controlli che tengono onesto il repo: salute dell\'installazione, capability, indice e mappa rigenerati, la suite.',
    modules: ['env', 'doctor', 'install-all', 'capcheck', 'cap-plan', 'docs-index', 'project-map', 'run-tests'],
    files: ['CONTRIBUTING.md', 'SECURITY.md', 'docs/INDEX.md', 'docs/project-map.html'],
  },
];

// La catena dei cancelli, nell'ordine in cui `tools/run.js` li attraversa davvero (i require
// del file, non una descrizione): scope → enforce → privacy → tool-plane. Il generatore
// verifica che ogni nome esista e che `run.js` lo richieda, così la striscia non può mentire.
const GATES = [
  { file: 'scope-guard', label: 'scope', what: 'l\'host è nella tua autorizzazione scritta?' },
  { file: 'enforce', label: 'enforce', what: 'il comando è distruttivo o fuori rate?' },
  { file: 'privacy', label: 'privacy', what: 'il comando porta un placeholder o un dato personale?' },
  { file: 'tool-plane', label: 'tool-plane', what: 'il binario esiste su questa macchina?' },
];

// Le altre parti del repo: ruolo dichiarato + conteggio reale dei file tracciati.
const PARTS = [
  { dir: 'tools', role: 'il motore: cancelli, esecuzione, prova, console. È la cartella di questa mappa.', modules: true },
  { dir: 'local', role: 'il runner offline contro un modello locale: nessuna chiave, nessun byte che esce.' },
  { dir: 'local/fleet', role: 'le definizioni degli agenti: orchestratore e specialisti, con i loro prompt.' },
  { dir: 'workflows', role: 'le pipeline riusabili: enum-* per enumerare una superficie, attack-* per attaccarla.' },
  { dir: 'skills', role: 'le procedure caricabili su richiesta, con il dettaglio in references/.' },
  { dir: 'docs', role: 'il riferimento per classe e per tool; si cerca con tools/kb-search.js.' },
  { dir: 'ops', role: 'le regole condivise della harness e le unità di sistema (radar, timer).' },
  { dir: 'memory', role: 'le lezioni tra engagement, sanificate: nessun host in-scope, nessuna credenziale.' },
  { dir: '.agents', role: 'gli agenti del client: id, modello, spawnableAgents — validati da test-repo-invariants.' },
  { dir: 'evo-x2-lab', role: 'il laboratorio AI locale come sottoprogetto, con la sua build.' },
  { dir: 'scripts', role: 'gli script una-tantum dell\'operatore (i probe con host reali sono gitignorati).' },
  { dir: 'templates', role: 'i modelli da cui nascono le autorizzazioni e i suoi file.' },
  { dir: 'legal', role: 'il testo legale dell\'engagement.' },
];

// I gate della suite: due di questi vivono sotto `test-` e quindi non sono "moduli" — è
// esattamente il punto, e va detto invece di lasciare il buco.
const SUITE = [
  { file: 'tools/run-tests.js', what: 'l\'unico gate: scopre i test, li classifica (offline/loopback/e2e) e li esegue in parallelo.' },
  { file: 'tools/test-lint.js', what: 'ogni `require` relativo risolve e il file risolto è tracciato da git. Il gate che mancava quando master è stato rosso per chi clonava.' },
  { file: 'tools/test-repo-invariants.js', what: 'il repository dice la verità su se stesso: numeri del README, indice aggiornato, flotta, nessun leak di host in-scope.' },
  { file: 'tools/testkit.js', what: 'lo stato condiviso dei test (rate limiter, audit, findings head-anchor) in fixture: due run non si influenzano.' },
  { file: 'tools/tool-registry.json', what: 'il registro dichiarativo dei binari esterni: risk_tier, rate_class, read_only. Alimenta run.js e il pacing.' },
];

// «Dove si tocca cosa»: la rubrica, non un consiglio. Ogni riga corrisponde a un gate che
// esiste davvero nel repo.
const HOWTO = [
  { want: 'Aggiungere un modulo al motore', where: 'tools/<nome>.js', then: 'assegnalo a un\'area in tools/project-map.js, aggiungi una riga in docs/toolbox.md, rigenera la mappa' },
  { want: 'Aggiungere un test', where: 'tools/test-<nome>.js', then: 'usa testkit.hermetic(), e aggiorna «N tests» in README.md (tutte le occorrenze)' },
  { want: 'Aggiungere una pipeline', where: 'workflows/<classe>.yaml', then: 'aggiorna «N reusable pipelines» in README.md' },
  { want: 'Aggiungere un agente', where: 'local/fleet/<id>.ts', then: 'id unico, model a forma di slug, spawnableAgents risolvibili — o test-repo-invariants fallisce' },
  { want: 'Aggiungere un documento', where: 'docs/<nome>.md', then: 'rigenera docs/INDEX.md: l\'indice è generato e fallisce se è indietro' },
  { want: 'Aggiungere un binario esterno', where: 'tools/tool-registry.json + install-tools.sh', then: 'risk_tier e rate_class: run.js e il pacing leggono quelli' },
  { want: 'Aggiornare questa mappa', where: 'node tools/project-map.js', then: 'l\'HTML è generato: non si modifica a mano, si rigenera' },
];

// ── lettura dei moduli ────────────────────────────────────────────────────────
function toolsModules() {
  const skip = /[\\/](payloads|examples|app)[\\/]/;
  const list = TRACKED
    ? [...TRACKED].filter((p) => p.startsWith('tools/') && p.endsWith('.js'))
    : walk(TOOLS).map(rel);
  return list
    .filter((p) => !skip.test(p) && !/[\\/]gui[\\/]vendor[\\/]/.test(p))
    .filter((p) => !path.basename(p).startsWith('test-') && path.basename(p) !== 'testkit.js')
    .map((p) => p.replace(/^tools\//, '').replace(/\.js$/, ''))
    .sort();
}

function walk(dir, acc) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc); else acc.push(p);
  }
  return acc;
}

// Lo scopo: il primo blocco di commento dell'header, e SOLO quello. Due forme convivono nel
// repo (`//` in linea e `/* … */` a blocco) e il blocco si interrompe alla prima riga di
// codice: senza quello stop, un modulo con header a blocco riceveva come scopo la prima riga
// di commento trovata *dentro il codice* (misurato: `gui/views-warroom.js` usciva come
// "Called by app.js renderTab…").
function headerBlock(src) {
  const lines = src.split('\n').slice(0, 60);
  const out = [];
  let mode = null;
  for (const raw of lines) {
    const l = raw.replace(/^\s+/, '');
    if (mode === null) {
      if (!l || l.startsWith('#!') || l === "'use strict';" || l === '"use strict";') continue;
      if (l.startsWith('/*')) {
        // Il blocco può aprirsi e chiudersi sulla stessa riga (`/* … */`): in quel caso la
        // riga successiva è già codice, e senza questo controllo finiva nello scopo.
        const rest = l.replace(/^\/\*+\s?/, '');
        if (rest.includes('*/')) { out.push(rest.replace(/\*\/.*$/, '')); break; }
        mode = 'block'; out.push(rest); continue;
      }
      if (l.startsWith('//')) { mode = 'line'; out.push(l.replace(/^\/\/\s?/, '')); continue; }
      break;                              // la prima riga è codice: non c'è header
    }
    if (mode === 'block') {
      if (l.includes('*/')) { out.push(l.replace(/\*\/.*$/, '').replace(/^\*\s?/, '')); break; }
      out.push(l.replace(/^\*\s?/, ''));
      if (out.length >= 8) break;
    } else {
      if (!l.startsWith('//')) break;     // fine del blocco: qui comincia il codice
      out.push(l.replace(/^\/\/\s?/, ''));
      if (out.length >= 8) break;
    }
  }
  // Il primo paragrafo: si ferma dove comincia l'uso o un elenco, che è il "come", non il "cosa".
  const para = [];
  for (const l of out) {
    const t = l.trimEnd();
    if (!t) { if (para.length) break; else continue; }
    if (para.length && /^(usage|uso|examples?|esempi?|perch[eé] esiste|why|upgrade path)\b/i.test(t)) break;
    if (para.length && /^node\s+tools\//.test(t)) break;
    if (para.length && /^[-*·]\s|^\d+\.\s/.test(t)) break;
    para.push(t);
    if (para.length >= 4) break;
  }
  return para;
}

// Toglie il banner col nome del file (`tools/x.js — …`, `x.js — …`, `x.js: …`) e il codice di
// lavoro con cui il file è nato (`B9 (Ondata 3) —`, `WP6 —`, `Tier 1-A —`, `E8 (rimandati) —`):
// sono il nome e la provenienza, non lo scopo, e in una riga di mappa rubano l'inizio.
function stripBanner(text, name) {
  const base = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text
    .replace(new RegExp('^(?:tools/)?' + base + '\\.js\\s*(?:[—–:·-]\\s*)?', 'i'), '')
    .replace(new RegExp('^(?:tools/)?[A-Za-z0-9_/.-]+\\.js\\s*[—–:]\\s*', 'i'), '')
    // I codici arrivano anche composti (`F8 + C4w (Ondata 4) —`, `WP7+ —`, `E7/C1w —`):
    // si consumano in sequenza finché sono codici, poi si richiede il separatore.
    .replace(/^(?:Ondata \d+|Tier \d+-[A-Z]|[A-Z]{1,5}\d+[a-z+]*(?:\s*\([^)]*\))?(?:\s*[+/,&]\s*)?)+\s*[—–:]\s*/, '')
    // …e la variante con una qualifica in mezzo al codice (`A4 mitigazione-S (Ondata 3) —`).
    .replace(/^[A-Z]{1,5}\d+[a-z+]*\s+(?:[A-Za-z][A-Za-z-]*\s+){0,3}(?:\([^)]*\)\s*)?[—–:]\s*/, '')
    .trim();
}

// Una riga sola, tagliata a fine frase o a un trattino lungo quando c'è spazio: la mappa è
// per orientarsi, il dettaglio sta nel file.
function oneLine(text, max) {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t.replace(/[.\s]+$/, '');
  const cut = t.slice(0, max);
  for (const m of cut.matchAll(/\.\s|—\s|–\s/g)) {
    if (m.index >= 40) return t.slice(0, m.index).replace(/[.,;:\s]+$/, '');
  }
  const sp = cut.lastIndexOf(' ');
  return (sp > 40 ? cut.slice(0, sp) : cut).replace(/[.,;:\s]+$/, '') + '…';
}

function purposeOf(src, name) {
  const para = headerBlock(src);
  if (!para.length) return '';
  return oneLine(stripBanner(para.join(' '), name), 150);
}

function cliOf(src, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('node\\s+tools/' + esc + '\\.js\\s*(.*)');
  const pool = headerBlock(src).join('\n') + '\n' + src.split('\n').slice(0, 60).join('\n');
  const m = pool.match(re);
  if (m) return ('node tools/' + name + '.js ' + m[1]).trim();
  return /^#!/.test(src) ? 'node tools/' + name + '.js' : null;
}

// `entry` è lo shebang; `runnable` è la capacità di stare su una riga di comando, che nel
// repo esiste anche senza shebang (tutti invocano `node tools/x.js`). Misurato: inferire
// l'una dall'altro sbagliava — `scope-guard.js` è una CLI documentata nell'header e finiva
// descritta come «libreria: non si esegue da sola».
function moduleInfo(name) {
  const file = path.join(TOOLS, name + '.js');
  const src = read(file);
  const cli = cliOf(src, name);
  return {
    name,
    path: 'tools/' + name + '.js',
    lines: src.split('\n').length,
    purpose: purposeOf(src, name),
    cli,
    entry: /^#!/.test(src),
    runnable: !!cli,
  };
}

// I test sono collegati per riferimento reale nel sorgente, non per convenzione di nome:
// `test-tier1c.js` copre `coverage-loop.js`, e questo è il punto della mappa.
function testsByModule(modules) {
  const files = TRACKED
    ? [...TRACKED].filter((p) => /^tools\/test-[\w.-]+\.js$/.test(p))
    : fs.readdirSync(TOOLS).filter((f) => /^test-[\w.-]+\.js$/.test(f)).map((f) => 'tools/' + f);
  const map = new Map(modules.map((m) => [m, []]));
  const meta = new Map();
  for (const p of files.sort()) {
    const src = read(path.join(WS, p));
    const short = p.replace(/^tools\//, '').replace(/\.js$/, '');
    const tag = (src.slice(0, 4096).match(/^\s*\/\/\s*test-tags:\s*([^\n#]+)/m) || [])[1];
    const tags = tag ? tag.split(/[,\s]+/).filter(Boolean) : [];
    meta.set(short, tags.includes('e2e') ? 'e2e' : tags.includes('loopback') ? 'loopback' : 'offline');
    for (const m of modules) {
      if (new RegExp("require\\('\\./" + m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "'\\)").test(src) ||
          src.includes(m + '.js')) {
        map.get(m).push(short);
      }
    }
  }
  return { map, meta };
}

function countIn(dirs, filter) {
  if (!TRACKED) return 0;
  return [...TRACKED].filter((p) => dirs.some((d) => p.startsWith(d)) && filter(p)).length;
}

// ── il registro dei binari esterni ────────────────────────────────────────────
// `tools/tool-registry.json` è già il registro dichiarativo dei binari (risk_tier, rate_class,
// read_only) che alimenta run.js: la mappa lo legge invece di ripetere l'elenco a mano.
function readRegistry() {
  const raw = JSON.parse(read(path.join(TOOLS, 'tool-registry.json')));
  return Object.keys(raw).filter((k) => !k.startsWith('_'));
}

// ── dati ──────────────────────────────────────────────────────────────────────
function build() {
  const modules = toolsModules();
  const known = new Set(modules);
  const registry = readRegistry();
  const declared = new Map();
  const toolArea = new Map();
  const problems = [];
  for (const a of AREAS) {
    for (const m of a.modules) {
      if (declared.has(m)) problems.push(`${m}: in due aree (${declared.get(m)}, ${a.id})`);
      declared.set(m, a.id);
      if (!known.has(m)) problems.push(`${m} (area ${a.id}): dichiarato ma non esiste in tools/`);
    }
    for (const t of a.tools || []) {
      if (toolArea.has(t)) problems.push(`${t}: in due aree (${toolArea.get(t)}, ${a.id})`);
      toolArea.set(t, a.id);
      if (!registry.includes(t)) problems.push(`${t} (area ${a.id}): non è in tools/tool-registry.json`);
    }
    for (const f of a.files || []) {
      const dir = f.endsWith('/');
      const hit = !TRACKED || [...TRACKED].some((p) => (dir ? p.startsWith(f) : p === f));
      if (!hit) problems.push(`${f} (area ${a.id}): non esiste o non è tracciato da git`);
    }
  }
  for (const m of modules) {
    if (!declared.has(m)) problems.push(`${m}: non assegnato a nessuna area in tools/project-map.js`);
  }
  for (const t of registry) {
    if (!toolArea.has(t)) problems.push(`${t}: binario del registro senza area`);
  }
  if (problems.length) {
    console.error('project-map: la tabella AREAS non copre il progetto —\n  ' + problems.join('\n  ') +
      '\n\nOgni modulo, ogni binario del registro e ogni file citato va assegnato a una sola area\n' +
      '(o si toglie una voce morta), altrimenti la mappa racconta un progetto che non esiste.');
    process.exit(1);
  }

  // La striscia dei cancelli deve corrispondere al codice: esistono e run.js li attraversa.
  const runSrc = read(path.join(TOOLS, 'run.js'));
  for (const g of GATES) {
    if (!known.has(g.file)) problems.push(`cancello ${g.file}: non esiste`);
    if (!new RegExp("require\\('\\./" + g.file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "'\\)").test(runSrc)) {
      problems.push(`cancello ${g.file}: tools/run.js non lo richiede (la striscia mentirebbe)`);
    }
  }
  if (problems.length) {
    console.error('project-map: la catena dei cancelli non torna —\n  ' + problems.join('\n  '));
    process.exit(1);
  }

  const { map: tests, meta: testKind } = testsByModule(modules);
  const info = new Map(modules.map((m) => [m, moduleInfo(m)]));

  // Le aree, con i loro binari e i loro file: la mappa concettuale disegna queste.
  const areas = AREAS.map((a) => ({
    id: a.id, name: a.name, accent: a.accent, blurb: a.blurb,
    modules: a.modules, tools: a.tools || [], files: a.files || [],
  }));

  const parts = PARTS.map((p) => {
    const files = TRACKED ? [...TRACKED].filter((f) => f === p.dir || f.startsWith(p.dir + '/')).length : 0;
    return { ...p, files };
  });

  const counts = {
    modules: modules.length,
    tests: testKind.size,
    testsOffline: [...testKind.values()].filter((k) => k === 'offline').length,
    pipelines: countIn(['workflows/'], (p) => /\.ya?ml$/.test(p)),
    agents: countIn(['local/fleet/'], (p) => p.endsWith('.ts')),
    docs: countIn(['docs/'], (p) => p.endsWith('.md')),
    skills: countIn(['skills/'], (p) => p.endsWith('.md')),
    tracked: TRACKED ? TRACKED.size : 0,
  };

  // Nessuno short-SHA di HEAD qui dentro, di proposito: inchiodato nel file, dopo OGNI commit
  // la mappa risulterebbe indietro (l'HTML committato porta il SHA del commit precedente, e
  // --check ne rigenera uno nuovo) — un gate condannato a essere rosso. L'impronta qui sotto
  // si calcola sui DATI, quindi cambia quando cambia il motore, che è l'unica cosa che conta.
  counts.tools = registry.length;

  return { modules, info, tests, testKind, parts, counts, areas, gates: GATES, suite: SUITE, howto: HOWTO };
}

// ── rendering ─────────────────────────────────────────────────────────────────
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// ── la mappa concettuale ──────────────────────────────────────────────────────
// Un albero: la radice a sinistra, una dorsale verticale, e una riga per ogni area con dentro
// i suoi componenti. Geometria calcolata TUTTA qui: nessuna simulazione, niente layout nel
// browser, la figura è deterministica e c'è anche senza JS (che aggiunge solo i salti).
//
// Perché un albero e non un grafo delle dipendenze: i 242 `require` fanno un gomitolo in cui
// non si legge niente, mentre la domanda vera è «in quante parti si divide questo progetto e
// cosa c'è in ciascuna». Questa è quella risposta, disegnata.
function conceptView(d) {
  const BOX_X = 268, BOX_W = 838, PAD = 14;
  const LINE = 16, CHIP_H = 17, CHIP_GAP = 5, ROW_GAP = 7;
  const CHIP_CH = 6.2;      // larghezza di un carattere mono a 10,5 unità
  const BLURB_CH = 6.6;     // larghezza di un carattere sans a 12 unità
  const chipW = (s) => 12 + Math.round(s.length * CHIP_CH);

  function wrap(text, width, ch) {
    const out = [];
    let cur = '';
    for (const w of String(text).split(/\s+/)) {
      if (cur && (cur + ' ' + w).length * ch > width) { out.push(cur); cur = w; }
      else cur = cur ? cur + ' ' + w : w;
    }
    if (cur) out.push(cur);
    return out;
  }

  // Impagino dentro ogni riquadro: il blurb va a capo, i chip dei moduli pure. L'altezza della
  // riga è conseguenza del contenuto, quindi nessun rettangolo taglia il testo.
  const rows = d.areas.map((a) => {
    const blurb = wrap(a.blurb, BOX_W - PAD * 2, BLURB_CH);
    const lines = [[]];
    let x = BOX_X + PAD;
    const maxX = BOX_X + BOX_W - PAD;
    for (const m of a.modules) {
      const w = chipW(m);
      if (x + w > maxX && lines[lines.length - 1].length) { lines.push([]); x = BOX_X + PAD; }
      lines[lines.length - 1].push({ m, x, w });
      x += w + CHIP_GAP;
    }
    const h = 34 + blurb.length * LINE + 12 + lines.length * (CHIP_H + CHIP_GAP) + (a.files.length ? 24 : 6);
    return { a, blurb, lines, h };
  });

  let y = 176;
  for (const r of rows) { r.y = y; y += r.h + ROW_GAP; }
  const H = y + 14;
  const spineX = 246;
  const rootCy = 86;

  // La dorsale resta accesa col grafo; ogni braccio porta il data-area della sua area, così il
  // filtro può spegnere la linea insieme alla casella che raggiunge.
  const out = [];
  out.push(`<line class="stem trunk" x1="224" y1="${rootCy}" x2="${spineX}" y2="${rootCy}"/>`);
  out.push(`<line class="stem trunk" x1="${spineX}" y1="${rootCy}" x2="${spineX}" y2="${rows[rows.length - 1].y + 22}"/>`);

  for (const r of rows) {
    const a = r.a;
    const stubY = r.y + 22;
    out.push(`<line class="stem stub" data-area="${esc(a.id)}" x1="${spineX}" y1="${stubY}" x2="${BOX_X}" y2="${stubY}"/>`);
    out.push(`<g class="area" data-fam="${esc(a.id)}" style="--acc:${a.accent}">`);
    out.push(`<rect class="box" x="${BOX_X}" y="${r.y}" width="${BOX_W}" height="${r.h}" rx="3"/>`);
    out.push(`<rect class="bar" x="${BOX_X}" y="${r.y}" width="4" height="${r.h}"/>`);
    out.push(`<text class="aname" x="${BOX_X + PAD}" y="${r.y + 26}">${esc(a.name)}</text>`);
    const nM = a.modules.length, nT = a.tools.length;
    out.push(`<text class="acount" x="${BOX_X + BOX_W - PAD}" y="${r.y + 26}" text-anchor="end">` +
      `${nM} ${nM === 1 ? 'modulo' : 'moduli'}` +
      `${nT ? ` · ${nT} ${nT === 1 ? 'binario esterno' : 'binari esterni'}` : ''}</text>`);
    r.blurb.forEach((l, k) => out.push(
      `<text class="ablurb" x="${BOX_X + PAD}" y="${r.y + 30 + LINE * (k + 1)}">${esc(l)}</text>`));
    const chipY = r.y + 30 + LINE * r.blurb.length + 14;
    r.lines.forEach((line, k) => {
      for (const c of line) {
        const cy = chipY + k * (CHIP_H + CHIP_GAP);
        const info = d.info.get(c.m);
        const nTest = (d.tests.get(c.m) || []).length;
        const hay = [c.m, info ? info.purpose : '', a.name].join(' ').toLowerCase();
        out.push(`<g class="chip" data-id="${esc(c.m)}" data-hay="${esc(hay)}" ` +
          `style="--acc:${a.accent}" tabindex="0" role="button" ` +
          `aria-label="${esc(c.m)}: ${esc(info ? info.purpose : 'senza descrizione')}">` +
          `<rect x="${c.x}" y="${cy}" width="${c.w}" height="${CHIP_H}" rx="2"/>` +
          `<text x="${c.x + 6}" y="${cy + 12}">${esc(c.m)}</text>` +
          `<title>${esc(c.m)} — ${esc(info ? info.purpose : '')}${nTest ? ` · ${nTest} test lo nominano` : ''}</title></g>`);
      }
    });
    if (a.files.length) {
      const fy = chipY + r.lines.length * (CHIP_H + CHIP_GAP) + 12;
      out.push(`<text class="afiles" x="${BOX_X + PAD}" y="${fy}">` +
        a.files.map((f) => `<a href="${esc('../' + f)}">${esc(f)}</a>`).join('   ') + `</text>`);
    }
    out.push(`</g>`);
  }

  const root = `<g class="root">` +
    `<rect x="14" y="20" width="210" height="132"/>` +
    `<text class="rtitle" x="28" y="50">Cyboros Harness</text>` +
    `<text class="rsub" x="28" y="74">Un harness di pentest</text>` +
    `<text class="rsub" x="28" y="90">autorizzato in cui la policy</text>` +
    `<text class="rsub" x="28" y="106">sta nel runtime, non nel prompt</text>` +
    `<text class="rcount" x="28" y="132">${d.counts.modules} moduli · ${d.areas.length} aree</text>` +
    `<text class="rcount" x="28" y="146">${d.counts.tests} test · ${d.counts.tools} binari</text></g>`;

  return `<section id="mappa">
  <h2>In quante parti si divide</h2>
  <p class="lede">${d.areas.length} aree, ognuna con dentro i suoi moduli e i suoi file: l'altezza di una
  casella è quella che serve al suo contenuto, niente di più. <strong>Clicca un componente</strong> per aprirlo
  nell'indice con la sua scheda, o un nome di file per leggerlo.</p>
  <div class="cmapwrap">
    <svg id="cmap" viewBox="0 0 1120 ${H}" role="img" aria-label="Mappa concettuale: Cyboros Harness diviso in ${d.areas.length} aree">
      ${root}
      ${out.join('\n      ')}
    </svg>
  </div>
</section>`;
}

function render(d) {
  const hash = require('crypto').createHash('sha256').update(JSON.stringify(d)).digest('hex').slice(0, 8);
  const fam = d.areas.map((f) => {
    const rows = f.modules.map((m) => {
      const i = d.info.get(m);
      const tests = d.tests.get(m) || [];
      const hay = [m, i.purpose, f.name, tests.join(' ')].join(' ').toLowerCase();
      return `<details class="mod" data-id="${esc(m)}" data-hay="${esc(hay)}" data-fam="${f.id}">` +
        `<summary>` +
        `<code class="nm">${esc(m)}</code>` +
        `<span class="why">${esc(i.purpose)}</span>` +
        `<span class="marks">${i.runnable ? '<i class="m-entry" title="si invoca da riga di comando">cli</i>' : ''}` +
        `${tests.length ? `<i class="m-test" title="test che lo nominano">${tests.length} test</i>` : '<i class="m-notest">senza test</i>'}</span>` +
        `</summary>` +
        `<div class="body">` +
        `<dl><dt>file</dt><dd><code>${esc(i.path)}</code> · ${i.lines} righe</dd>` +
        (i.cli ? `<dt>comando</dt><dd><code>${esc(i.cli)}</code></dd>` : '') +
        `<dt>test</dt><dd>${tests.length ? tests.map((t) => `<code class="t ${d.testKind.get(t)}">${esc(t)}</code>`).join(' ') : 'nessuno lo nomina'}</dd>` +
        `<dt>cos'è</dt><dd>${i.entry ? 'entry point: ha lo shebang, si esegue da riga di comando'
          : i.runnable ? 'CLI documentata nell\'header: senza shebang si invoca con <code>node …</code>'
          : 'libreria: la usano altri moduli, non si esegue da sola'}</dd>` +
        `</dl></div></details>`;
    }).join('');
    return `<section class="fam" data-fam="${f.id}" style="--acc:${f.accent}">` +
      `<div class="fhead"><h3>${esc(f.name)}</h3><span class="n">${f.modules.length} moduli</span></div>` +
      `<p class="fblurb">${esc(f.blurb)}</p>` +
      `<div class="list">${rows}</div></section>`;
  }).join('');

  const partsRows = d.parts.map((p) =>
    `<tr><td><code>${esc(p.dir)}/</code></td><td>${esc(p.role)}</td><td class="num">${p.files}</td></tr>`
  ).join('');

  const suiteRows = d.suite.map((s) =>
    `<tr><td><code>${esc(s.file)}</code></td><td>${esc(s.what)}</td></tr>`
  ).join('');

  const howtoRows = d.howto.map((h) =>
    `<tr><td>${esc(h.want)}</td><td><code>${esc(h.where)}</code></td><td>${esc(h.then)}</td></tr>`
  ).join('');

  const gateStrip = d.gates.map((g, k) =>
    `<li><span class="n">${k + 1}</span><code>${esc(g.file)}.js</code><span class="what">${esc(g.what)}</span></li>`
  ).join('');

  const counts = [
    ['moduli del motore', d.counts.modules],
    ['test', d.counts.tests],
    ['pipeline', d.counts.pipelines],
    ['agenti', d.counts.agents],
    ['documenti .md', d.counts.docs],   // solo `.md` in docs/: la tabella delle parti conta ogni file
    ['file tracciati', d.counts.tracked],
  ].map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');

  return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mappa del progetto — Cyboros Harness</title>
<meta name="description" content="Dove sta cosa in Cyboros Harness: ${d.counts.modules} moduli in ${d.areas.length} aree, i cancelli, i test. Pagina generata dal repository.">
<style>
:root{
  --ink:#0a0a11; --ink-2:#0e0e17; --panel:#12121c; --rule:#242433; --rule-soft:#1a1a26;
  --text:#e9e9f3; --muted:#9a9aae; --faint:#6b6b80;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
  --sans:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;
  --w:74rem;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--ink);color:var(--text);font:15px/1.55 var(--sans);
  background-image:linear-gradient(var(--rule-soft) 1px,transparent 1px),linear-gradient(90deg,var(--rule-soft) 1px,transparent 1px);
  background-size:44px 44px;background-position:-1px -1px}
a{color:inherit}
code{font-family:var(--mono);font-size:.86em}
.wrap{max-width:var(--w);margin:0 auto;padding:0 20px}

/* testata: una spina, non un hero */
header{border-bottom:1px solid var(--rule);background:linear-gradient(180deg,rgba(10,10,17,.94),rgba(10,10,17,.86));backdrop-filter:blur(2px)}
header .wrap{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;flex-wrap:wrap;padding-top:20px;padding-bottom:14px}
h1{margin:0;font:600 21px/1.15 var(--mono);letter-spacing:-.01em}
h1 .sub{display:block;font:400 12px/1.5 var(--mono);color:var(--muted);letter-spacing:.02em;margin-top:4px}
.counts{display:flex;gap:22px;margin:0;flex-wrap:wrap}
.counts div{text-align:right}
.counts dt{font:400 10px/1.4 var(--mono);color:var(--faint);text-transform:lowercase}
.counts dd{margin:0;font:600 17px/1.2 var(--mono);font-variant-numeric:tabular-nums}

main{padding:34px 0 8px}
h2{font:600 13px/1 var(--mono);color:var(--muted);margin:0 0 14px;letter-spacing:.04em}
section+section{margin-top:40px}
.lede{max-width:62ch;color:var(--muted);margin:0 0 18px;font-size:14.5px}
.lede strong{color:var(--text);font-weight:600}

/* la striscia dei cancelli: l'unico elemento che si concede di essere memorabile */
.strip{border:1px solid var(--rule);border-radius:2px;overflow:hidden;background:var(--ink-2)}
.strip .above,.strip .below{padding:7px 14px;font:11px/1.4 var(--mono);color:var(--faint)}
.strip .above{color:var(--muted)}
.strip ol{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr))}
.strip li{padding:13px 14px;border-left:1px solid var(--rule);position:relative}
.strip li:first-child{border-left:0}
.strip li .n{position:absolute;top:7px;right:10px;font:10px var(--mono);color:var(--faint)}
.strip li code{display:block;color:#ffb020;font-size:12.5px}
.strip li .what{display:block;color:var(--muted);font-size:12px;margin-top:5px;line-height:1.4}

/* filtro: lo strumento, non un ornamento */
.tools{display:flex;align-items:center;gap:12px;margin:0 0 6px;flex-wrap:wrap}
input[type=search]{flex:1 1 260px;background:var(--panel);border:1px solid var(--rule);color:var(--text);
  font:13px var(--mono);padding:9px 11px;border-radius:2px}
input[type=search]:focus{outline:2px solid #3fd6ff;outline-offset:-1px;border-color:#3fd6ff}
input[type=search]::placeholder{color:var(--faint)}
.hit{font:12px var(--mono);color:var(--faint)}
.hit b{color:var(--text);font-weight:600}

/* le aree */
.fam{border-top:1px solid var(--rule);padding-top:16px}
.fhead{display:flex;align-items:baseline;gap:12px}
.fhead h3{margin:0;font:600 16px/1.3 var(--sans)}
.fhead h3::before{content:"";display:inline-block;width:9px;height:9px;background:var(--acc);margin-right:9px;
  vertical-align:1px;border-radius:1px}
.fhead .n{font:11px var(--mono);color:var(--faint);margin-left:auto}
.fblurb{margin:8px 0 14px;color:var(--muted);font-size:13.5px;max-width:78ch}
.list{display:flex;flex-direction:column}
details.mod{border-top:1px solid var(--rule-soft)}
details.mod:first-child{border-top:1px solid var(--rule)}
details.mod>summary{list-style:none;cursor:pointer;display:grid;grid-template-columns:minmax(9rem,15rem) 1fr auto;
  gap:14px;align-items:baseline;padding:8px 4px 8px 12px;border-left:2px solid transparent}
details.mod>summary::-webkit-details-marker{display:none}
details.mod>summary:hover,details.mod>summary:focus-visible{border-left-color:var(--acc);background:#13131e;outline:none}
details.mod>summary:focus-visible{box-shadow:inset 0 0 0 1px #3fd6ff}
details.mod[open]>summary{border-left-color:var(--acc);background:#13131e}
.nm{font-family:var(--mono);font-size:13px;color:var(--text);word-break:break-word}
.why{color:var(--muted);font-size:13px;line-height:1.5}
.marks{display:flex;gap:7px;align-items:baseline;white-space:nowrap;font-style:normal}
.marks i{font-style:normal;font:10px var(--mono);color:var(--faint);border:1px solid var(--rule);padding:1px 5px;border-radius:2px}
.marks i.m-entry{color:#3fd6ff;border-color:#1d4553}
.marks i.m-test{color:#46d17f;border-color:#1e4433}
.marks i.m-notest{color:#ff8a3d;border-color:#4a3a20}
.body{padding:2px 4px 16px 14px;border-left:2px solid var(--acc)}
.body dl{display:grid;grid-template-columns:max-content 1fr;gap:5px 14px;margin:10px 0 0}
.body dt{font:10px var(--mono);color:var(--faint);padding-top:3px}
.body dd{margin:0;font-size:13px;color:var(--text)}
.body dd code{color:var(--text)}
.t{border:1px solid var(--rule);padding:1px 5px;border-radius:2px;font-size:11px;color:var(--muted);display:inline-block}
.t.loopback{color:#7d9cff;border-color:#2a3357}
.t.e2e{color:#ff8a3d;border-color:#4a3a20}

/* tabelle */
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--rule-soft);vertical-align:top}
th{font:10px var(--mono);color:var(--faint);text-transform:lowercase;border-bottom-color:var(--rule)}
td code{color:var(--text)}
td.num{text-align:right;font-family:var(--mono);font-variant-numeric:tabular-nums;color:var(--muted)}
tbody tr:hover{background:#13131e}

/* switch fra le due viste */
.switch{display:flex;gap:6px;margin:22px 0 26px;border-bottom:1px solid var(--rule);padding-bottom:0}
.switch button{background:transparent;color:var(--muted);border:1px solid var(--rule);border-bottom:0;
  border-radius:2px 2px 0 0;padding:8px 14px;font:12px var(--mono);cursor:pointer;margin-bottom:-1px}
.switch button[aria-selected=true]{color:var(--text);border-color:var(--rule);background:var(--ink)}
.switch button:hover{color:var(--text)}
.switch button:focus-visible{outline:2px solid #3fd6ff;outline-offset:2px}

/* mappa concettuale: albero con dorsale, tutto pre-renderizzato in Node */
.cmapwrap{overflow-x:auto}
#cmap{width:100%;height:auto;display:block;min-width:820px}
#cmap .stem{stroke:var(--rule);stroke-width:1}
#cmap .stem.dim{opacity:.25}
#cmap .box{fill:var(--ink-2);stroke:var(--rule)}
#cmap .bar{fill:var(--acc)}
#cmap .root rect{fill:var(--panel);stroke:var(--rule)}
#cmap .rtitle{font:600 16px var(--mono);fill:var(--text)}
#cmap .rsub{font:12px var(--sans);fill:var(--muted)}
#cmap .rcount{font:10.5px var(--mono);fill:var(--faint)}
#cmap .aname{font:600 15px var(--sans);fill:var(--text)}
#cmap .acount{font:10.5px var(--mono);fill:var(--faint)}
#cmap .ablurb{font:12px var(--sans);fill:var(--muted)}
#cmap .afiles{font:10.5px var(--mono);fill:var(--faint)}
#cmap .afiles a{fill:var(--muted);text-decoration:none}
#cmap .afiles a:hover,#cmap .afiles a:focus-visible{fill:var(--text);text-decoration:underline}
#cmap .chip{cursor:pointer}
#cmap .chip rect{fill:transparent;stroke:var(--rule)}
#cmap .chip text{font:10.5px var(--mono);fill:var(--muted);pointer-events:none}
#cmap .chip:hover rect,#cmap .chip:focus-visible rect{stroke:var(--acc);fill:#161622}
#cmap .chip:hover text,#cmap .chip:focus-visible text{fill:var(--text)}
#cmap .chip:focus-visible{outline:none}
#cmap .chip.dim{opacity:.2}
#cmap g.area.dim .box,#cmap g.area.dim .bar{opacity:.35}
#cmap g.area.dim .aname,#cmap g.area.dim .acount,#cmap g.area.dim .ablurb,#cmap g.area.dim .afiles{opacity:.3}
@media (max-width:940px){#cmap{min-width:1000px}}

footer{border-top:1px solid var(--rule);margin-top:44px;padding:18px 0 42px;color:var(--faint);font-size:12.5px}
footer code{color:var(--muted)}
footer p{margin:6px 0}
.hidden{display:none !important}
@media (max-width:720px){
  details.mod>summary{grid-template-columns:1fr;gap:3px}
  .marks{justify-content:flex-start}
  details.mod>summary{padding-left:10px}
}
@media (prefers-reduced-motion:no-preference){
  .strip li{animation:in .5s ease-out backwards}
  .strip li:nth-child(1){animation-delay:.02s}.strip li:nth-child(2){animation-delay:.09s}
  .strip li:nth-child(3){animation-delay:.16s}.strip li:nth-child(4){animation-delay:.23s}
  @keyframes in{from{opacity:0;transform:translateY(6px)}}
}
@media print{body{background:#fff;color:#000}details.mod>summary,.strip li{break-inside:avoid}}
</style>
</head>
<body>
<header>
  <div class="wrap">
    <h1>Mappa del progetto<span class="sub">Cyboros Harness — generata dal repository, non scritta a mano</span></h1>
    <dl class="counts">${counts}</dl>
  </div>
</header>

<main class="wrap">

<section id="catena">
  <h2>La catena</h2>
  <p class="lede">L'idea che tiene insieme tutto il resto: <strong>l'agente decide cosa provare, il
  runtime decide cosa è permesso</strong>. Questi quattro programmi girano uno dopo l'altro dentro
  <code>run.js</code>, prima che un binario venga eseguito, e nessuno di loro chiede il permesso al
  modello. Se uno dice no, l'azione non parte.</p>
  <div class="strip">
    <div class="above">l'agente propone un comando</div>
    <ol>${gateStrip}</ol>
    <div class="below">il binario esegue solo se tutti e quattro hanno risposto sì — ogni passaggio è appeso a <code>reports/tmp/run-audit.jsonl</code></div>
  </div>
</section>

<div class="tools">
  <label for="q" class="hidden">Filtra i moduli</label>
  <input id="q" type="search" placeholder="filtra per nome, scopo, area o test  ( / )" autocomplete="off" spellcheck="false">
  <span class="hit" id="hit"></span>
</div>

<div class="switch" role="tablist" aria-label="Vista della mappa">
  <button type="button" id="t-index" role="tab" aria-selected="true" aria-controls="view-index">Indice</button>
  <button type="button" id="t-map" role="tab" aria-selected="false" aria-controls="view-map">Mappa concettuale</button>
</div>

<div id="view-index" role="tabpanel" aria-labelledby="t-index">

<section id="motore">
  <h2>Il motore — ${d.counts.modules} moduli, ${d.areas.length} aree</h2>
  <p class="lede">Clicca un modulo per sapere dove vive, come si invoca e quale test lo nomina.
  L'area risponde alla domanda vera: <strong>dove metto un file nuovo?</strong> — la tabella in
  <code>tools/project-map.js</code> è fail-closed, un modulo senza area fa fallire la generazione.</p>
  <div id="fams">${fam}</div>
</section>

<section id="parti">
  <h2>Le altre parti</h2>
  <p class="lede">Il motore è una parte. Il resto del repository ha ruoli distinti, e i numeri qui
  sotto sono contati dai file tracciati adesso.</p>
  <table>
    <thead><tr><th>cartella</th><th>a cosa serve</th><th class="num">file</th></tr></thead>
    <tbody>${partsRows}</tbody>
  </table>
</section>

<section id="suite">
  <h2>I gate della suite</h2>
  <p class="lede">${d.counts.tests} test (${d.counts.testsOffline} offline, il resto loopback o e2e) più i controlli che non
  sono test. Questi non verificano il target: verificano <strong>questo repository</strong>.</p>
  <table>
    <thead><tr><th>file</th><th>cosa impedisce</th></tr></thead>
    <tbody>${suiteRows}</tbody>
  </table>
</section>

<section id="dove">
  <h2>Dove si tocca cosa</h2>
  <p class="lede">Ogni riga corrisponde a un gate che esiste davvero: se salti il secondo passo,
  la suite te lo dice.</p>
  <table>
    <thead><tr><th>se devi…</th><th>il file</th><th>e poi</th></tr></thead>
    <tbody>${howtoRows}</tbody>
  </table>
</section>

</div><!-- /view-index -->

<div id="view-map" role="tabpanel" aria-labelledby="t-map" class="hidden">
${conceptView(d)}
</div>

</main>

<footer class="wrap">
  <p>Generata da <code>node tools/project-map.js</code> — <code>--check</code> esce 1 se è indietro,
  e <code>tools/test-repo-invariants.js</code> la usa come gate: questa pagina non può invecchiare in silenzio.</p>
  <p>Nessuna risorsa esterna: si apre da <code>file://</code>, offline, senza rete. Impronta dei dati
  <code>${hash}</code> — cambia quando cambiano i moduli, ed è la stessa per chi rigenera sulla stessa
  istantanea del repository.</p>
</footer>

<script>
(function(){
  var q = document.getElementById('q');
  var hit = document.getElementById('hit');
  var mods = [].slice.call(document.querySelectorAll('details.mod'));
  var fams = [].slice.call(document.querySelectorAll('section.fam'));
  var total = mods.length;
  function apply(){
    var s = q.value.trim().toLowerCase();
    var n = 0;
    for (var i=0;i<mods.length;i++){
      var m = mods[i];
      var ok = !s || m.dataset.hay.indexOf(s) !== -1;
      m.classList.toggle('hidden', !ok);
      if (ok) n++;
    }
    for (var j=0;j<fams.length;j++){
      var f = fams[j];
      var vis = f.querySelectorAll('details.mod:not(.hidden)').length;
      f.classList.toggle('hidden', s && vis === 0);
    }
    // lo stesso filtro agisce sulla mappa: un componente fuori filtro si spegne anche lì
    var sullaMappa = 0;
    for (var c = 0; c < chips.length; c++){
      var okc = !s || chips[c].dataset.hay.indexOf(s) !== -1;
      chips[c].classList.toggle('dim', !okc);
      if (okc) sullaMappa++;
    }
    for (var r2 = 0; r2 < cmapAreas.length; r2++){
      var rimasti = cmapAreas[r2].querySelectorAll('.chip:not(.dim)').length;
      var spenta = !!s && rimasti === 0;
      cmapAreas[r2].classList.toggle('dim', spenta);
      var braccio = cmapStubs[r2];
      if (braccio) braccio.classList.toggle('dim', spenta);
    }
    for (var t = 0; t < cmapTrunk.length; t++) cmapTrunk[t].classList.toggle('dim', !!s && sullaMappa === 0);
    hit.innerHTML = s
      ? '<b>' + n + '</b> moduli in indice · <b>' + sullaMappa + '</b> sulla mappa'
      : total + ' moduli in ' + fams.length + ' aree';
  }

  // ── la mappa: un componente si apre nell'indice, il filtro spegne tutte e due le viste ──
  var chips = [].slice.call(document.querySelectorAll('#cmap .chip'));
  var cmapAreas = [].slice.call(document.querySelectorAll('#cmap g.area'));
  var cmapStubs = cmapAreas.map(function(a){
    return document.querySelector('#cmap line.stub[data-area="' + a.dataset.fam + '"]');
  });
  var cmapTrunk = [].slice.call(document.querySelectorAll('#cmap line.trunk'));

  function jump(id){
    show('index');
    var row = document.querySelector('details.mod[data-id="' + id + '"]');
    if (!row) return;
    var sec = row.closest('section.fam');
    if (sec) sec.classList.remove('hidden');
    row.open = true;
    row.scrollIntoView({ block: 'center' });
  }
  chips.forEach(function(c){
    c.addEventListener('click', function(){ jump(c.dataset.id); });
    c.addEventListener('keydown', function(e){
      if (e.key === 'Enter' || e.key === ' '){ e.preventDefault(); jump(c.dataset.id); }
    });
  });

  // ── le due viste ──
  var tabs = { index: document.getElementById('t-index'), map: document.getElementById('t-map') };
  var views = { index: document.getElementById('view-index'), map: document.getElementById('view-map') };
  function show(v){
    for (var k in views){
      views[k].classList.toggle('hidden', k !== v);
      tabs[k].setAttribute('aria-selected', String(k === v));
    }
  }
  tabs.index.addEventListener('click', function(){ show('index'); });
  tabs.map.addEventListener('click', function(){ show('map'); });

  q.addEventListener('input', apply);
  document.addEventListener('keydown', function(e){
    if (e.key === '/' && document.activeElement !== q){ e.preventDefault(); q.focus(); }
    if (e.key === 'Escape' && document.activeElement === q){ q.value=''; apply(); q.blur(); }
  });
  apply();
})();
</script>
</body>
</html>
`;
}

// ── main ──────────────────────────────────────────────────────────────────────
// Il JS della pagina nasce dentro un template literal: un apostrofo non escapato lo rompe in
// modo silenzioso — l'HTML resta valido, `--check` resta verde, e la pagina muore nel browser
// con un SyntaxError che nessun gate vede (misurato: "Con <kbd>Esc</kbd> si toglie l'evidenza").
// Qui la sintassi si controlla dove nasce, e un errore ferma la generazione.
function assertScriptSyntax(page) {
  const m = page.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) {
    console.error('project-map: la pagina non contiene <script>: la mappa perderebbe filtro e grafo');
    process.exit(1);
  }
  try { new Function(m[1]); }
  catch (e) {
    console.error('project-map: il JS generato non è sintatticamente valido — ' + e.message +
      '\n  (quasi sempre un apostrofo non escapato in una stringa del client)');
    process.exit(1);
  }
}

const data = build();
const html = render(data);
assertScriptSyntax(html);
const kb = (n) => (n / 1024).toFixed(1).replace('.', ',') + ' KB';

if (process.argv.includes('--check')) {
  const current = fs.existsSync(OUT) ? read(OUT) : null;
  if (current === html) { console.log('project-map: docs/project-map.html è aggiornato'); process.exit(0); }
  console.error('project-map: docs/project-map.html non è aggiornato — rigeneralo con `node tools/project-map.js`');
  process.exit(1);
}
fs.writeFileSync(OUT, html);
console.log(`project-map: scritto ${rel(OUT)} — ${data.counts.modules} moduli in ${data.areas.length} aree, ` +
  `${data.counts.tests} test, ${html.split('\n').length} righe, ${kb(Buffer.byteLength(html))}`);
