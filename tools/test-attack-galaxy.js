// Self-check: attack-galaxy.js builds a deterministic graph from findings + chains, embeds
// the payload so that a finding title can never break out of the <script> block, and emits a
// fully offline HTML (no CDN / no remote asset / no http(s) reference in the markup).
// Run: node tools/test-attack-galaxy.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const G = require('./attack-galaxy');

// test-tags: offline

const FINDINGS = [
  { severity: 'Critical', title: 'RCE via upload', host: 'a.example', class: 'other', cvss: 9.8,
    status: 'verified', ts: '2026-09-01T10:00:00.000Z', chain: { seq: 1 }, poc: 'p', impact: 'i', remediation: 'r' },
  { severity: 'Medium', title: 'IDOR on orders', host: 'a.example', class: 'idor', cvss: 5.3,
    status: 'confirmed', ts: '2026-09-02T10:00:00.000Z', chain: { seq: 2 } },
  { severity: 'Low', title: 'Missing header', host: 'b.example', class: 'config', cvss: 2.1,
    status: 'inconclusive', ts: '2026-09-02T11:00:00.000Z', chain: { seq: 3 } },
];

const CHAINS = [
  { host: 'a.example', chain_count: 1, chains: [{ name: 'Foothold to takeover', reasoning: 'r',
    findings: ['RCE via upload [Critical]', 'IDOR on orders [Medium]'] }] },
];

// ── determinism: same input -> byte-identical graph (no Math.random in the data path)
const a = G.buildGalaxy(FINDINGS, CHAINS);
const b = G.buildGalaxy(FINDINGS, CHAINS);
assert.deepStrictEqual(a.nodes.map((n) => [n.id, n.seed_x, n.seed_y]), b.nodes.map((n) => [n.id, n.seed_x, n.seed_y]));
assert.strictEqual(a.seed, b.seed);
assert.notStrictEqual(a.seed, G.buildGalaxy(FINDINGS.slice(0, 2), CHAINS).seed, 'a different corpus must move the seed');

// The source must stay plain text: raw NUL bytes in a .js file make grep/file treat it as
// binary, which silently breaks every text-oriented tool that touches this repo.
const src = fs.readFileSync(path.join(__dirname, 'attack-galaxy.js'));
assert.ok(!src.includes(0), 'no raw NUL byte in the source (write the separator as an escape)');
assert.ok(src.toString('utf8').includes('\\u0000'), 'the NUL separator is written as an escape');

// ── structure: one host node per host, one finding node per finding, host links complete
assert.strictEqual(a.nodes.filter((n) => n.kind === 'host').length, 2);
assert.strictEqual(a.nodes.filter((n) => n.kind === 'finding').length, 3);
assert.strictEqual(a.links.filter((l) => l.kind === 'host').length, 3, 'every finding hangs off its host');
const chainLinks = a.links.filter((l) => l.kind === 'chain');
assert.strictEqual(chainLinks.length, 1, 'a 2-finding chain yields one chain edge');
const hostA = a.nodes.find((n) => n.id === 'h:a.example');
assert.strictEqual(hostA.count, 2);
assert.strictEqual(hostA.severity, 'Critical', 'host severity_top rolls up to the worst finding');
assert.strictEqual(hostA.verified, 2);
assert.ok(a.nodes.find((n) => n.label === 'RCE via upload').in_chain, 'chain membership is marked on the node');
assert.strictEqual(hostA.chain_hits, 1, 'host counts its chain links');
assert.ok(a.nodes.filter((n) => n.kind === 'host').every((n) => Number.isFinite(n.chain_hits)),
  'every host node carries a finite chain_hits counter (no undefined++ → NaN)');
assert.strictEqual(a.chain_edges[0].name, 'Foothold to takeover');

// ── key separator: with a space these two (host, title) pairs produce the SAME key, so a
// chain edge meant for one host would attach to a finding on the other. Guard it explicitly.
// Both fixtures carry TWO findings per chain, because a single-member chain yields no edge
// by design (an edge needs two endpoints) — otherwise these assertions would pass vacuously.
const collide = G.buildGalaxy([
  { severity: 'High', title: 'c', host: 'a b', ts: '2026-09-01T00:00:00.000Z' },
  { severity: 'High', title: 'd', host: 'a b', ts: '2026-09-01T00:00:00.000Z' },
  { severity: 'High', title: 'b c', host: 'a', ts: '2026-09-01T00:00:00.000Z' },
  { severity: 'High', title: 'b d', host: 'a', ts: '2026-09-01T00:00:00.000Z' },
], [{
  host: 'a b', chain_count: 1,
  chains: [{ name: 'c1', reasoning: 'r', findings: ['c [High]', 'd [High]'] }],
}]);
const collideChains = collide.links.filter((l) => l.kind === 'chain');
assert.strictEqual(collideChains.length, 1,
  'the unambiguous pair on host "a b" still produces its chain edge');
const collideHostA = collide.nodes.find((n) => n.id === 'h:a');
assert.strictEqual(collideHostA.chain_hits, 0,
  'the same-keyed findings on host "a" must not steal the edge (NUL separator, not space)');
assert.ok(!collideChains.some((l) => l.source === 'f:' + collideHostA.id),
  'no chain edge may originate from the colliding host');

// ── stats
assert.strictEqual(a.stats.findings, 3);
assert.strictEqual(a.stats.hosts, 2);
assert.strictEqual(a.stats.chains, 1);
assert.strictEqual(a.stats.severity.Critical, 1);
assert.strictEqual(a.stats.with_cvss, 3);
assert.deepStrictEqual(a.days.map((d) => d.day), ['2026-09-01', '2026-09-02']);
assert.strictEqual(a.days[1].total, 2);

// ── node order is stable regardless of input order (the physics loop depends on it)
const shuffled = G.buildGalaxy([FINDINGS[2], FINDINGS[0], FINDINGS[1]], CHAINS);
assert.deepStrictEqual(shuffled.nodes.map((n) => n.id), a.nodes.map((n) => n.id));

// ── empty corpus must not explode (a fresh engagement)
const empty = G.buildGalaxy([], []);
assert.strictEqual(empty.nodes.length, 0);
assert.strictEqual(empty.stats.findings, 0);
assert.ok(G.buildHtml(empty, {}).includes('<canvas'));

// ── payload embedding: a hostile title cannot close the script tag
const xss = G.buildGalaxy([{ severity: 'High', title: '</script><img src=x onerror=alert(1)>', host: 'x', ts: '2026-09-03T00:00:00.000Z' }], []);
const html = G.buildHtml(xss, { host: 'all hosts', generatedAt: '2026-09-03T00:00:00.000Z' });
assert.ok(!html.includes('</script><img'), 'raw </script> must never reach the document');
assert.ok(html.includes('\\u003c/script\\u003e'), 'angle brackets are unicode-escaped in the payload');
assert.ok(!/<\/script>\s*<img/.test(html));
// exactly one payload + one renderer script block
assert.strictEqual((html.match(/<script/g) || []).length, 2);
assert.strictEqual((html.match(/<\/script>/g) || []).length, 2);

// ── offline by construction: no remote asset of any kind in the EXECUTABLE shell.
//
// Scope matters. A real finding carries its own endpoint and PoC URLs, so the payload
// legitimately contains absolute URLs — they are DATA (evidence text), rendered as text.
// What must be clean is the shell: markup + CSS + the renderer, i.e. everything the browser
// would actually dereference. Asserting over the whole document would either fail on real
// corpora or, worse, pass on a fixture that happens to have no URLs and prove nothing.
function shellOf(doc) {
  const head = doc.split(/<script id="payload"[^>]*>/)[0];         // doctype, <head>, CSS, header chrome
  const tail = doc.split(/<\/script>/).slice(2).join('</script>'); // the renderer, after the payload
  return head + '\n' + tail;
}
const shell = shellOf(html);
assert.ok(shell.length > 500 && shell.includes('canvas'), 'shell split must keep the real markup');
for (const [label, re] of [
  ['external script', /<script[^>]+\ssrc=/i],
  ['external stylesheet', /<link[^>]+stylesheet/i],
  ['image', /<img/i],
  ['css @import', /@import/i],
  ['css url()', /url\(/i],
  ['fetch()', /\bfetch\s*\(/],
  ['XMLHttpRequest', /XMLHttpRequest/],
  ['WebSocket', /new WebSocket/],
  ['absolute URL', /https?:\/\/[a-z0-9]/i],
]) assert.ok(!re.test(shell), 'shell must contain no ' + label);

// The negative case: URLs INSIDE the payload are allowed (they are evidence text), and they
// must never escape into markup — proven by feeding a finding whose URL is a quote breakout.
const withUrls = G.buildHtml(G.buildGalaxy([
  { severity: 'High', title: 'leak', host: 'x.example', ts: '2026-09-04T00:00:00.000Z',
    poc: 'curl https://evil.example/a</script><script>alert(1)</script>' },
], []), {});
assert.ok(shellOf(withUrls).includes('"poc"') === false, 'payload text is not part of the shell');
assert.ok(!/<script>alert\(1\)/.test(withUrls), 'a URL-ish payload cannot inject a live script tag');
assert.ok(withUrls.includes('evil.example'), 'legitimate endpoint text survives verbatim as data');
assert.ok(shellOf(withUrls).length > 500, 'shell is still intact after a hostile payload');

// ── pure helpers
assert.strictEqual(G.fnv1a(''), 0x811c9dc5);
assert.strictEqual(G.dayKey('2026-09-05T01:02:03Z'), '2026-09-05');
assert.strictEqual(G.dayKey('nope'), 'unknown');
const r = G.rng(42), r2 = G.rng(42);
assert.deepStrictEqual([r(), r(), r()], [r2(), r2(), r2()]);
for (const v of [G.rng(7)(), G.rng(7)()]) assert.ok(v >= 0 && v < 1, 'rng stays in [0,1)');

console.log('attack-galaxy: all tests passed');
