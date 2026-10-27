#!/usr/bin/env node
// test-sage-redact.js — la redazione è l'unica cosa che separa "ricerca" da "leak".
//
// Il contratto: gli host in scope non escono MAI, i loro sottodomini nemmeno, gli host che
// gli somigliano restano intatti (una redazione che mangia `notexample.com` renderebbe la
// ricerca inutile), e il registro dei colpi non contiene il valore rimosso — un audit log
// che ripete il segreto è un secondo leak.
'use strict';
const assert = require('assert');
const { ok, summary } = require('./testkit');
const { collectHints, normalizeHost, scrubText, hostPattern, HOST_MARK, IP_MARK, ENGAGEMENT_MARK } = require('./sage/redact');

ok('normalizeHost: schema, path, wildcard e maiuscole', () => {
  assert.strictEqual(normalizeHost('https://app.example.com/login?x=1'), 'app.example.com');
  assert.strictEqual(normalizeHost('*.example.com'), 'example.com');
  assert.strictEqual(normalizeHost('Example.COM.'), 'example.com');
  assert.strictEqual(normalizeHost('10.0.0.5'), '10.0.0.5');
  assert.strictEqual(normalizeHost(''), '');
});

ok('collectHints: host da hosts/prefissi/targets, IP anche come base di un CIDR', () => {
  const h = collectHints({
    allowed_hosts: ['a.example.com', 'https://b.example.com/x'],
    allowed_url_prefixes: ['https://c.example.com/api'],
    allowed_ips: ['10.0.0.0/24', '127.0.0.1'],
  });
  assert.deepStrictEqual([...h.hosts].sort(), ['a.example.com', 'b.example.com', 'c.example.com']);
  assert.ok(h.ips.includes('10.0.0.0/24'));
  assert.ok(h.ips.includes('10.0.0.0'));
  assert.ok(h.ips.includes('127.0.0.1'));
});

ok('collectHints: accetta extra (campagne) e stringhe nude', () => {
  const h = collectHints({ allowed_hosts: ['a.example.com'] }, { targets: ['b.example.net'] }, 'c.example.org');
  assert.deepStrictEqual([...h.hosts].sort(), ['a.example.com', 'b.example.net', 'c.example.org']);
});

ok("collectHints: nome e cliente dell'engagement diventano termini da raschiare", () => {
  const h = collectHints({}, { name: 'ACME Q4 Assessment', client: 'ACME S.p.A.' });
  assert.ok(h.terms.includes('ACME Q4 Assessment'), JSON.stringify(h.terms));
  assert.ok(h.terms.includes('ACME'), 'un brief scrive ACME, non il nome intero');
  assert.ok(!h.terms.includes('Q4'), 'i token troppo corti non sono identità utili');
  assert.ok(!h.terms.includes('Assessment'), 'le parole generiche non vanno raschiate');
});

ok('collectHints: SSID, BSSID e seriali sono termini da raschiare', () => {
  const h = collectHints({}, { essids: ['CasaDiMario'], bssids: ['AA:BB:CC:DD:EE:FF'], allowed_serials: ['R58M12345AB'] });
  assert.ok(h.terms.includes('CasaDiMario'), JSON.stringify(h.terms));
  assert.ok(h.terms.includes('AA:BB:CC:DD:EE:FF'), JSON.stringify(h.terms));
  assert.ok(h.terms.includes('R58M12345AB'), JSON.stringify(h.terms));
});

ok('scrubText: il nome del cliente non esce, le parole simili restano', () => {
  const r = scrubText('tecniche per ACME e per NOAH, non per ACMEBANK', {
    hosts: [], ips: [], terms: ['ACME'],
  });
  // Resta UNA sola occorrenza di ACME: quella dentro ACMEBANK, che non è il cliente.
  assert.strictEqual((r.text.match(/ACME/g) || []).length, 1, r.text);
  assert.ok(r.text.includes(ENGAGEMENT_MARK), r.text);
  assert.ok(r.text.includes('NOAH'), 'un nome che somiglia non deve essere toccato');
  assert.ok(r.text.includes('ACMEBANK'), r.text);
  assert.ok(r.hits.some((h) => h.kind === 'engagement-name'));
});

ok('hostPattern: copre i sottodomini, non i nomi che somigliano', () => {
  // Un pattern nuovo per ogni assert: con /g, `test` consuma lastIndex e il secondo
  // controllo partirebbe a metà stringa (bug del test, non del pattern).
  assert.ok(hostPattern('example.com').test('example.com'));
  assert.ok(hostPattern('example.com').test('sub.example.com'));
  assert.ok(!hostPattern('example.com').test('notexample.com'));
});

ok('scrubText: host, sottodomini e IP spariscono; il simile resta', () => {
  const r = scrubText('novità su example.com e su sub.example.com, non su notexample.com; ip 10.0.0.7.', {
    hosts: ['example.com'], ips: ['10.0.0.7'],
  });
  // `notexample.com` CONTIENE example.com: l'unica occorrenza ammessa è quella, dentro
  // il nome che somiglia (che non deve essere redatto).
  assert.strictEqual((r.text.match(/example\.com/g) || []).length, 1, r.text);
  assert.ok(!r.text.includes('10.0.0.7'), r.text);
  assert.ok(r.text.includes('notexample.com'), 'un host che somiglia non deve essere toccato');
  assert.strictEqual(r.text.split(HOST_MARK).length - 1, 2);
  assert.ok(r.text.includes(IP_MARK));
  assert.ok(r.redacted);
});

ok('scrubText: IP a fine frase viene comunque redatto', () => {
  const r = scrubText("l'IP 10.0.0.7.", { hosts: [], ips: ['10.0.0.7'] });
  assert.ok(!r.text.includes('10.0.0.7'), r.text);
});

ok('scrubText: segreti via, e i hit non contengono il valore', () => {
  const aws = 'AKIAIOSFODNN7EXAMPLE';
  const r = scrubText(
    `contatta mario.rossi@cliente.it con ${aws} e Bearer abcdef123456789012345`,
    { hosts: [], ips: [] },
  );
  assert.ok(!r.text.includes('mario.rossi'), r.text);
  assert.ok(!r.text.includes(aws), r.text);
  assert.ok(!r.text.includes('abcdef1234567890'), r.text);
  const serialized = JSON.stringify(r.hits);
  assert.ok(!serialized.includes(aws), 'il log dei hit non deve contenere il segreto');
  assert.ok(!serialized.includes('mario.rossi'));
  assert.ok(r.hits.some((h) => h.kind === 'aws-key'));
  assert.ok(r.hits.some((h) => h.kind === 'email'));
});

ok('scrubText: una query pulita non viene toccata', () => {
  const q = 'stateful API fuzzing con Schemathesis: tecniche e limiti';
  const r = scrubText(q, { hosts: ['example.com'], ips: ['10.0.0.1'] });
  assert.strictEqual(r.text, q);
  assert.strictEqual(r.redacted, false);
  assert.deepStrictEqual(r.hits, []);
});

summary('sage-redact');
