#!/usr/bin/env node
// test-cap-privs.js — offline: nessuna rete, nessun root, nessun engagement toccato.
// Copre il modello dei privilegi in tre pezzi: il manifest (cosa concediamo e perche'),
// il piano (come lo legge lo shell) e la verifica (cosa l'agente ne deduce a runtime).
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { ok, summary, fixture, runCli } = require('./testkit');

const { loadManifest, plan, toTsv, validateManifest } = require('./cap-plan');
const { parseGetcapLine, sameSet, isScript, resolveBin, check, MODES } = require('./capcheck');

const dir = fixture('capprivs');
const CAP = path.join(__dirname, 'cap-manifest.json');

// Un manifest valido minimo, da usare come base dei casi negativi. `writeManifest` lo
// mette su disco: loadManifest accetta un PATH, e passargli l'oggetto e' stato un errore
// di questo test, non del modulo.
function manifest(over) {
  return Object.assign({
    version: 1,
    sysctl: { 'net.ipv4.ip_unprivileged_port_start': { want: 0, persist_file: '/etc/sysctl.d/x.conf', why: 'bind <1024' } },
    bins: { masscan: { caps: ['cap_net_raw', 'cap_net_admin'], mode: 'network', why: 'raw socket' } },
  }, over || {});
}
// Scrive il manifest e ne restituisce il path: tutto quello che passa da loadManifest
// comincia da qui.
function onDisk(over) { return writeManifest(manifest(over)); }
function writeManifest(obj) {
  const f = path.join(dir, `m-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify(obj));
  return f;
}

// --- il manifest reale: e' un artefatto versionato, quindi le sue ipotesi sono testate ------
ok('manifest reale: carica e ogni riga sysctl ha un valore numerico', () => {
  const { path: p, manifest: m } = loadManifest(CAP);
  assert.equal(p, CAP);
  assert.ok(m.sysctl['net.ipv4.ip_unprivileged_port_start']);
  assert.equal(typeof m.sysctl['net.ipv4.ip_unprivileged_port_start'].want, 'number');
});

ok('manifest reale: ogni capability concessa e motivata, in un modo noto', () => {
  const { manifest: m } = loadManifest(CAP);
  for (const [bin, spec] of Object.entries(m.bins)) {
    assert.ok(spec.caps.length, `${bin} senza capability`);
    assert.ok(spec.why && spec.why.length > 20, `${bin}: la ragione deve essere specifica, non un segnaposto`);
    assert.ok(MODES.includes(spec.mode), `${bin}: mode ${spec.mode} sconosciuta`);
  }
});

ok('manifest reale: i binari coperti altrove sono detti, non lasciati nel vuoto', () => {
  // Lo stato "perche' questo tool non ha bisogno di niente" e' informazione: senza, un
  // binario assente dal manifest sembra un dimenticato invece di una scelta.
  const { manifest: m } = loadManifest(CAP);
  for (const b of ['tcpdump', 'tshark', 'responder', 'impacket-ntlmrelayx', 'airmon-ng']) {
    assert.ok(m.covered_elsewhere && m.covered_elsewhere[b], `${b} non e' né nel manifest né in covered_elsewhere`);
  }
});

// --- validazione: fallire qui, non a meta' applicazione ------------------------------------
ok('schema: rifiuta una capability che non e\' tale (typo che fallirebbe a runtime)', () => {
  const errs = validateManifest(manifest({ bins: { x: { caps: ['capnet_raw'], why: 'perche' } } }), 'm');
  assert.ok(errs.some((e) => /non-capability/.test(e)), errs.join('|'));
});

ok('schema: rifiuta un binario senza why — ogni capability va motivata', () => {
  const errs = validateManifest(manifest({ bins: { x: { caps: ['cap_net_raw'], mode: 'network' } } }), 'm');
  assert.ok(errs.some((e) => /why mancante/.test(e)), errs.join('|'));
});

ok('schema: rifiuta una versione sconosciuta invece di applicarla per meta\'', () => {
  const errs = validateManifest(manifest({ version: 99 }), 'm');
  assert.ok(errs.some((e) => /version/.test(e)), errs.join('|'));
});

ok('schema: rifiuta un nome con spazi/TAB (romperebbe il piano TSV)', () => {
  const errs = validateManifest(manifest({ bins: { 'bad name': { caps: ['cap_net_raw'], why: 'perche' } } }), 'm');
  assert.ok(errs.some((e) => /rompe il piano TSV/.test(e)), errs.join('|'));
});

ok('schema: rifiuta una chiave sysctl che non e\' un path net.*', () => {
  const errs = validateManifest(manifest({ sysctl: { kernel: { want: 0, why: 'x' } } }), 'm');
  assert.ok(errs.some((e) => /sysctl/.test(e)), errs.join('|'));
});

ok('loadManifest: JSON rotto -> E_JSON, non un crash', () => {
  const f = path.join(dir, 'broken.json');
  fs.writeFileSync(f, '{ nope');
  assert.throws(() => loadManifest(f), (e) => e.code === 'E_JSON');
});

ok('CLI cap-plan: manifest rotto esce 3, non 0 (il fallimento non e\' silenzioso)', () => {
  const f = writeManifest({ version: 1, bins: { x: { caps: ['bogus'], why: '' } } });
  const r = runCli([path.join(__dirname, 'cap-plan.js'), f]);
  assert.equal(r.status, 3, r.stdout + r.stderr);
});

// --- il piano che lo shell consuma ---------------------------------------------------------
ok('piano TSV: una riga per sysctl e per binario, con i campi nell\'ordine giusto', () => {
  const rows = toTsv(plan(loadManifest(onDisk()).manifest));
  const lines = rows.split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[0], 'SYSCTL\tnet.ipv4.ip_unprivileged_port_start\t0\t/etc/sysctl.d/x.conf');
  assert.equal(lines[1], 'BIN\tmasscan\tcap_net_raw,cap_net_admin');
});

ok('piano TSV: nessun campo contiene TAB, perche\' lo shell lo splitta su quello', () => {
  const rows = toTsv(plan(loadManifest(CAP).manifest)).split('\n');
  for (const l of rows) assert.equal(l.split('\t').length, (l.startsWith('SYSCTL') ? 4 : 3), l);
});

ok('piano: l\'ordine segue il manifest, quindi l\'output e\' diffabile', () => {
  const rows = plan(loadManifest(onDisk()).manifest);
  assert.deepEqual(rows.map((r) => r.kind), ['SYSCTL', 'BIN']);
});

ok('piano: il caveat sopravvive al passaggio dal manifest al piano', () => {
  // Se il caveat si perdesse qui, la verifica direbbe «tutto verde» su nmap: le capability
  // ci sono, ma il programma rifiuta lo stesso i tipi di scan raw. Il manifesto green
  // sarebbe falso proprio nel caso che conta.
  const rows = plan(loadManifest(onDisk({
    bins: { nmap: { caps: ['cap_net_raw'], mode: 'network', why: 'x', caveat: 'rifiuta -sS' } },
  })).manifest);
  assert.equal(rows.find((r) => r.kind === 'BIN').caveat, 'rifiuta -sS');
});

// --- la verifica: parsing di getcap, il punto che aveva il difetto -------------------------
ok('parseGetcapLine: /usr/bin/nmap cap_net_admin,cap_net_raw=ep -> le due capability', () => {
  // Caso reale, non inventato: e' la riga che il regex precedente non sapeva leggere,
  // restituendo "nessuna capability" su tutti i 19 binari senza emettere un errore.
  assert.deepEqual(parseGetcapLine('/usr/bin/nmap cap_net_admin,cap_net_raw=ep'), ['cap_net_admin', 'cap_net_raw']);
});

ok('parseGetcapLine: ignora i flag ma non le capability, e ordina', () => {
  assert.deepEqual(parseGetcapLine('/sbin/iw cap_net_admin=ep'), ['cap_net_admin']);
  assert.deepEqual(parseGetcapLine('/x cap_net_raw,cap_net_admin+eip'), ['cap_net_admin', 'cap_net_raw']);
});

ok('parseGetcapLine: output vuoto o percorso senza capability -> null, non lista vuota', () => {
  assert.equal(parseGetcapLine(''), null);
  assert.equal(parseGetcapLine('   '), null);
  assert.equal(parseGetcapLine('/bin/sh'), null);
  assert.equal(parseGetcapLine(null), null);
  assert.equal(parseGetcapLine('/x cap_=ep'), null);
});

ok('sameSet: confronto come insieme, non come stringa (l\'ordine di getcap non e\' significativo)', () => {
  assert.equal(sameSet(['cap_net_raw', 'cap_net_admin'], ['cap_net_admin', 'cap_net_raw']), true);
  assert.equal(sameSet(['cap_net_raw'], ['cap_net_raw', 'cap_net_admin']), false);
  assert.equal(sameSet(null, ['cap_net_raw']), false);
  assert.equal(sameSet([], []), false, 'nessuna capability concessa non e\' "stessa" di un insieme vuoto atteso');
});

// --- binari: script, ELF, risoluzione ------------------------------------------------------
ok('isScript: distingue shebang da ELF — su uno script setcap non ha effetto', () => {
  const s = path.join(dir, 'fake.sh');
  const e = path.join(dir, 'fake.elf');
  fs.writeFileSync(s, '#!/bin/sh\necho hi\n');
  fs.writeFileSync(e, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]));
  assert.equal(isScript(s), true);
  assert.equal(isScript(e), false);
  assert.equal(isScript(path.join(dir, 'non-esiste')), false);
});

ok('resolveBin: trova un eseguibile lungo il PATH, e null se non esiste', () => {
  const bin = path.join(dir, 'tool-x');
  fs.writeFileSync(bin, '#!/bin/sh\n');
  fs.chmodSync(bin, 0o755);
  const old = process.env.PATH;
  process.env.PATH = dir;
  try {
    assert.equal(resolveBin('tool-x'), bin);
    assert.equal(resolveBin('tool-che-non-esiste'), null);
  } finally { process.env.PATH = old; }
});

// --- classificazione dello stato -----------------------------------------------------------
ok('check: uno strumento assente non e\' un fallimento, ma un tool-plane', () => {
  // `sysctl: {}` isola la proprietà dai requisiti della MACCHINA: senza, su un host dove
  // `net.ipv4.ip_unprivileged_port_start` non è 0 (il runner CI) `res.ok` è false per la
  // soglia porte e il test fallisce pur essendo corretto il comportamento sui binari.
  const res = check({ manifest: writeManifest(manifest({
    sysctl: {},
    bins: { 'tool-che-non-esiste': { caps: ['cap_net_raw'], mode: 'network', why: 'x' } },
  })) });
  const e = res.entries.find((x) => x.key === 'tool-che-non-esiste');
  assert.equal(e.state, 'absent');
  assert.equal(res.ok, true, 'un tool non installato non rende lo stato non-operativo');
});

ok('check: un binario senza capability dichiarate e\' MANCA, e lo stato non e\' ok', () => {
  const res = check({ manifest: writeManifest(manifest({
    bins: { sh: { caps: ['cap_net_raw', 'cap_net_admin'], mode: 'network', why: 'x' } },
  })) });
  const e = res.entries.find((x) => x.key === 'sh');
  assert.equal(e.state, 'missing', `stato=${e.state} percorso=${e.path}`);
  assert.equal(res.ok, false);
  assert.ok(res.missing.includes('sh'));
});

ok('check: la soglia porte e\' parte del requisito, non un dettaglio', () => {
  // sysctl assente dal manifest => ports true (niente dichiarato, niente richiesto).
  assert.equal(check({ manifest: onDisk({ sysctl: {} }) }).ports, true);
  // Con la chiave presente, lo stato la traccia come entry SYSCTL e la sintesi la segue.
  const res2 = check({ manifest: onDisk() });
  const sys = res2.entries.find((x) => x.kind === 'SYSCTL');
  assert.equal(sys.key, 'net.ipv4.ip_unprivileged_port_start');
  assert.equal(res2.ports, sys.state === 'granted');
});

ok('check: byMode distingue assente da mancante, e solo il secondo blocca', () => {
  // Un binario che non c\'e\' non toglie il privilegio a nessuno: e\' un tool-plane, e
  // dichiarare "modalita\' non operativa" perche' manca un programma che l\'operatore non ha
  // installato sarebbe un falso allarme. Qui invece c\'e\' un file VERO, eseguibile, senza
  // capability: e\' il caso "manca il privilegio" vero, e dipende solo da noi.
  const bin = path.join(dir, 'tool-senza-cap');
  // Magia ELF, non uno shebang: su uno script setcap non e' applicabile e lo stato sarebbe
  // `not_applicable`, che e\' un terzo caso e non quello che questo test sta provando.
  fs.writeFileSync(bin, Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]), Buffer.alloc(64)]));
  fs.chmodSync(bin, 0o755);
  const old = process.env.PATH;
  process.env.PATH = dir;
  try {
    const res = check({ manifest: onDisk({
      bins: {
        'tool-che-non-esiste': { caps: ['cap_net_raw'], mode: 'network', why: 'x' },
        'tool-senza-cap': { caps: ['cap_net_admin'], mode: 'wireless', why: 'x' },
      },
    }) });
    assert.equal(res.byMode.network.operational, true, 'assente non blocca');
    assert.deepEqual(res.byMode.network.absent, ['tool-che-non-esiste']);
    assert.equal(res.byMode.wireless.operational, false, 'installato ma senza capability blocca');
    assert.deepEqual(res.byMode.wireless.missing, ['tool-senza-cap']);
  } finally { process.env.PATH = old; }
});

ok('check: un caveat dichiarato viene riportato, cosi\' "tutto verde" non mente', () => {
  // nmap e' il caso reale: capability concesse, ma il programma rifiuta lo stesso i tipi
  // di scan raw con un proprio controllo geteuid(). Se il caveat sparisse, l'agente
  // leggerebbe "operativo" e lancerebbe -sS scoprendolo solo dal "permission denied".
  const res = check({ manifest: CAP });
  const nmap = res.caveats.find((c) => c.key === 'nmap');
  assert.ok(nmap, 'il caveat di nmap deve arrivare fino alla verifica');
  assert.ok(/geteuid/.test(nmap.caveat), nmap.caveat);
});

// --- contratto di uscita della CLI ---------------------------------------------------------
ok('CLI capcheck: --require con una modalita\' inesistente esce 2 (uso sbagliato)', () => {
  const r = runCli([path.join(__dirname, 'capcheck.js'), '--require', 'volante'], {
    env: Object.assign({}, process.env, { CYBOROS_CAP_MANIFEST: CAP }),
  });
  assert.equal(r.status, 2, r.stdout + r.stderr);
});

ok('CLI capcheck: --json produce JSON valido con le voci attese', () => {
  const out = path.join(dir, 'state.json');
  const r = runCli([path.join(__dirname, 'capcheck.js'), '--json'], {
    env: Object.assign({}, process.env, { CYBOROS_CAP_MANIFEST: CAP, CAPCHECK_OUT: out }),
  });
  const parsed = JSON.parse(r.stdout);
  assert.ok(Array.isArray(parsed.entries));
  assert.ok(typeof parsed.ok === 'boolean');
  assert.ok(parsed.manifest);
  // exit 0 e 1 sono entrambi validi (dipende dallo stato reale della macchina): quel che
  // conta e' che il contratto dichiarato sia quello osservato.
  assert.ok(r.status === 0 || r.status === 1, `exit ${r.status}: ${r.stderr}`);
});

ok('CLI capcheck: manifest rotto esce 2 e non stampa uno stato falso', () => {
  const bad = writeManifest({ version: 1, bins: { x: { caps: ['non-esiste'], why: '' } } });
  const r = runCli([path.join(__dirname, 'capcheck.js'), '--json'], {
    env: Object.assign({}, process.env, { CYBOROS_CAP_MANIFEST: bad }),
  });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.equal(r.stdout.trim(), '', 'nessuno stato parziale su un manifest rotto');
});

summary('test-cap-privs');
