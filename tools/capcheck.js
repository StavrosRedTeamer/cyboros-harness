#!/usr/bin/env node
// capcheck.js — stato REALE dei privilegi per cui i binari di attacco girano senza prompt
// di password. Zero dipendenze, nessuna scrittura fuori da reports/tmp.
//
// Perche' esiste come tool e non come nota in un .md: la harness gia' ha questa disciplina
// per l'installazione (`tool-plane.js` esiste perche' "non inventare l'output di uno strumento
// non installato" deve essere verificabile, non ricordato). Lo stesso vale qui. Un xattr
// `security.capability` sparisce a ogni `apt upgrade` del pacchetto che riscrive il binario:
// se la fonte di verita' fosse un paragrafo in AGENTS.md, l'agente continuerebbe a lanciare
// masscan convinto che funzioni, e fallirebbe a meta' engagement con un "permission denied"
// che nessuno ha previsto. Qui lo stato si chiede, e si ottiene una risposta exit!=0.
//
//   node tools/capcheck.js                 # tabella leggibile (default) + scrive reports/tmp
//   node tools/capcheck.js --json          # solo JSON su stdout
//   node tools/capcheck.js --mode network  # solo le capability di una modalita' (network|wireless|host)
//   node tools/capcheck.js --require network  # preflight: exit!=0 se la modalita' non e' operativa
//   node tools/capcheck.js --quiet         # solo il riepilogo, una riga
// Env: CYBOROS_CAP_MANIFEST (default tools/cap-manifest.json), CAPCHECK_OUT (default reports/tmp/cap-state.json)
//
// Contratto di uscita: 0 = tutto dichiarato e' concesso; 1 = qualcosa manca; 2 = manifest
// illeggibile o rotto. "Non installato" NON e' un fallimento: e' un tool-plane, e la
// domanda giusta e' "manca il privilegio a uno strumento che ho?", non "ho tutto installato?".
// require('./capcheck') -> { check, capsOn, parseGetcapLine, isScript, sameSet, sysctlValue,
// resolveBin, MODES }
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { loadManifest, plan } = require('./cap-plan');
const { augmentPath } = require('./tool-path');

const WS = path.join(__dirname, '..');
const OUT = process.env.CAPCHECK_OUT || path.join(WS, 'reports', 'tmp', 'cap-state.json');
const MODES = ['network', 'wireless', 'host'];

// Risoluzione binario lungo il PATH di tool-path.js (le dir dell'operatore, non PATH di root).
// Camminiamo il PATH invece di sh -c 'command -v': nessuna shell, nessun quoting, e la stessa
// risoluzione che fa run.js, cosi' capcheck e il runner non possono divergere su un binario.
function resolveBin(name) {
  if (name.includes('/')) return fs.existsSync(name) ? name : null;
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const cand = path.join(dir, name);
    try { fs.accessSync(cand, fs.constants.X_OK); if (fs.statSync(cand).isFile()) return cand; }
    catch { /* not here */ }
  }
  return null;
}

// Parsing puro di una riga di output di getcap: `/percorso cap_a,cap_b=ep` -> ['cap_a','cap_b'].
// Nessun flag, nessun path. Funzione pura e separata perche' e' stata esattamente qui che una
// regex falliva: `/usr/bin/nmap cap_net_admin,cap_net_raw=ep` contiene un `=` che un pattern
// di soli caratteri di capability non copre, e il risultato era "nessuna capability" su tutto
// il sistema senza un solo errore. Parsing su campi, e test diretto su questo caso.
function parseGetcapLine(line) {
  const t = String(line == null ? '' : line).trim();
  if (!t) return null;
  const field = t.split(/\s+/)[1];
  if (!field || !field.startsWith('cap_')) return null;
  // Filtriamo sui nomi di capability validi: un campo come `cap_=ep` (flag senza nome)
  // passerebbe altrimenti come «una capability concessa» e falserebbe il confronto.
  const caps = field.replace(/[=+].*$/, '').split(',').filter((c) => /^cap_[a-z0-9_]+$/.test(c));
  return caps.length ? caps.sort() : null;
}

// getcap stampato da util-linux: prendiamo il secondo campo e via i flag (`+ep`): sono COSI'
// che applichiamo, e confrontarli aggiungerebbe rumore senza informazione — nessun tool
// dichiarato ha bisogno dei flag.
function capsOn(binPath) {
  let out;
  try { out = execFileSync('getcap', [binPath], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return null; }
  const line = String(out).trim().split('\n')[0].trim();
  if (!line) return null;
  return parseGetcapLine(line);
}

// Due insiemi di capability sono uguali se contengono gli stessi elementi, indipendentemente
// dall'ordine (getcap non garantisce un ordine). Un insieme VUOTO non e' mai soddisfatto:
// «non ho letto nessuna capability» e «l'attesa era nessuna capability» sono fatti diversi,
// e confonderli direbbe che un binario senza xattr e' stato concesso.
function sameSet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (!a.length || !b.length) return false;
  if (a.length !== b.length) return false;
  const sa = a.slice().sort();
  const sb = b.slice().sort();
  return sa.every((v, i) => v === sb[i]);
}

// Uno script non puo' avere capability: l'xattr andrebbe sull'interprete, e su python3 o
// /bin/sh sarebbe root per ogni cosa. E' un caso legittimo e distinto da "manca il privilegio".
function isScript(binPath) {
  try { return fs.readFileSync(binPath).subarray(0, 2).toString('latin1') === '#!'; }
  catch { return false; }
}

function sysctlValue(key) {
  try { return fs.readFileSync(`/proc/sys/${key.replace(/\./g, '/')}`, 'utf8').trim(); }
  catch { return null; }
}

function check(opts) {
  const loaded = loadManifest((opts && opts.manifest) || undefined);
  const rows = plan(loaded.manifest);
  augmentPath(process.env);

  const entries = [];
  for (const r of rows) {
    if (r.kind === 'SYSCTL') {
      const cur = sysctlValue(r.key);
      entries.push({
        kind: 'SYSCTL', key: r.key, want: r.want, current: cur,
        state: cur === null ? 'unknown' : (cur === String(r.want) ? 'granted' : 'missing'),
        why: r.why,
      });
      continue;
    }
    const want = r.caps.slice().sort();
    const base = { kind: 'BIN', key: r.key, mode: r.mode, want, why: r.why, caveat: r.caveat || null };
    const p = resolveBin(r.key);
    if (!p) { entries.push(Object.assign({}, base, { state: 'absent', current: null, path: null })); continue; }
    if (isScript(p)) {
      entries.push(Object.assign({}, base, { state: 'not_applicable', current: null, path: p,
        note: 'script: setcap non applicabile (l\'xattr andrebbe sull\'interprete)' }));
      continue;
    }
    const cur = capsOn(p);
    entries.push(Object.assign({}, base, {
      path: p, current: cur,
      state: sameSet(cur, want) ? 'granted' : 'missing',
    }));
  }

  const byMode = {};
  for (const m of MODES) {
    const inMode = entries.filter((e) => e.kind === 'BIN' && e.mode === m);
    byMode[m] = {
      declared: inMode.length,
      granted: inMode.filter((e) => e.state === 'granted').length,
      missing: inMode.filter((e) => e.state === 'missing').map((e) => e.key),
      absent: inMode.filter((e) => e.state === 'absent').map((e) => e.key),
    };
    byMode[m].operational = byMode[m].missing.length === 0;
  }
  // Le SYSCTL sono condivise: senza la soglia porte a 0, tutti i tool che fanno bind sotto
  // 1024 (responder, ntlmrelayx, chisel, hostapd, dnsmasq) restano bloccati anche se hanno
  // le capability giuste. Sono parte del requisito, non un dettaglio.
  const portsOk = entries.find((e) => e.kind === 'SYSCTL' && e.key === 'net.ipv4.ip_unprivileged_port_start');
  const portsGranted = !portsOk || portsOk.state === 'granted';

  const missing = entries.filter((e) => e.state === 'missing').map((e) => e.key);
  return {
    manifest: loaded.path,
    uid: process.getuid(),
    ports: portsGranted,
    entries,
    byMode,
    missing,
    // Un tool con capability e un caveat dichiarato (nmap) non e' "rotto": e' concesso ma
    // non basta perche' il programma ha un proprio controllo. Lo separiamo per non dirti
    // "tutto verde" quando in realta un sottoinsieme richiede sudo.
    caveats: entries.filter((e) => e.caveat).map((e) => ({ key: e.key, caveat: e.caveat })),
    ok: missing.length === 0 && portsGranted,
  };
}

function table(res) {
  const lines = [];
  lines.push('binario / chiave'.padEnd(42) + 'stato'.padEnd(18) + 'capability effettive');
  lines.push('-'.repeat(96));
  for (const e of res.entries) {
    const label = e.kind === 'SYSCTL' ? `${e.key} = ${e.want}` : e.key;
    const st = e.state === 'granted' ? 'OK' : e.state === 'absent' ? 'non installato'
      : e.state === 'not_applicable' ? 'n/a (script)' : e.state === 'unknown' ? 'sconosciuto' : 'MANCA';
    const cur = e.kind === 'SYSCTL' ? (e.current == null ? '?' : `ora=${e.current}`) : (e.current || 'nessuna');
    lines.push(label.padEnd(42) + st.padEnd(18) + cur);
  }
  lines.push('');
  for (const m of MODES) {
    const s = res.byMode[m];
    if (!s.declared) continue;
    lines.push(`${m.padEnd(9)} ${s.granted}/${s.declared} concesse` +
      (s.missing.length ? `  MANCA: ${s.missing.join(', ')}` : '') +
      (s.absent.length ? `  (assenti: ${s.absent.join(', ')})` : ''));
  }
  lines.push(`porte <1024 da utente: ${res.ports ? 'si' : 'NO'}`);
  if (res.caveats.length) {
    lines.push('');
    for (const c of res.caveats) lines.push(`!! ${c.key}: ${c.caveat}`);
  }
  return lines.join('\n');
}

function main() {
  const argv = process.argv.slice(2);
  const opts = { json: argv.includes('--json'), quiet: argv.includes('--quiet') };
  const mi = argv.indexOf('--mode');
  const mode = mi >= 0 ? argv[mi + 1] : null;
  const ri = argv.indexOf('--require');
  const requireMode = ri >= 0 ? argv[ri + 1] : null;
  if (requireMode && !MODES.includes(requireMode)) {
    console.error(`capcheck: --require accetta ${MODES.join('|')}`); process.exit(2);
  }
  if (mode && !MODES.includes(mode)) {
    console.error(`capcheck: --mode accetta ${MODES.join('|')}`); process.exit(2);
  }

  let res;
  try { res = check({}); }
  catch (e) { console.error(`capcheck: ${e.message}`); process.exit(2); }

  if (requireMode) {
    const s = res.byMode[requireMode];
    if (!s || !s.operational || !res.ports) {
      console.error(`capcheck: modalita' ${requireMode} non operativa` +
        (s && s.missing.length ? ` — manca il privilegio a: ${s.missing.join(', ')}` : '') +
        (res.ports ? '' : ' — e manca net.ipv4.ip_unprivileged_port_start=0 per i bind sotto 1024'));
      process.exit(1);
    }
    process.stdout.write(opts.json ? JSON.stringify(res.byMode[requireMode], null, 2) + '\n'
      : `capcheck: modalita' ${requireMode} operativa (${s.granted}/${s.declared} capability concesse)\n`);
    return;
  }

  if (mode) res.entries = res.entries.filter((e) => e.kind === 'SYSCTL' || e.mode === mode);

  try {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(res, null, 2) + '\n');
  } catch { /* reports/tmp non scrivibile: la verifica resta valida, solo senza cache */ }

  if (opts.json) process.stdout.write(JSON.stringify(res, null, 2) + '\n');
  else if (opts.quiet) {
    process.stdout.write(`capcheck: ${res.ok ? 'operativo' : 'incompleto'}` +
      `${res.missing.length ? `, manca: ${res.missing.join(', ')}` : ''}\n`);
  } else {
    process.stdout.write(table(res) + '\n');
  }
  process.exit(res.ok ? 0 : 1);
}

module.exports = { check, capsOn, parseGetcapLine, isScript, sameSet, sysctlValue, resolveBin, MODES };

if (require.main === module) main();
