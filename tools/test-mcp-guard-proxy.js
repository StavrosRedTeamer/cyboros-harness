#!/usr/bin/env node
// test-mcp-guard-proxy.js — test OFFLINE del proxy MCP che mette le guardie in serie.
//
// Il server MCP di prova è uno script locale scritto in mkdtemp: risponde a ogni `tools/call`
// rispecchiando gli argomenti, quindi il test può distinguere "la chiamata è arrivata al server"
// da "il proxy ha risposto al posto suo". Nessuna rete: i target sono IP letterali (nessuna DNS)
// e le chiamate bloccate non escono dal proxy.
//
// Copre: passthrough dei metodi non-tools/call, blocco fuori scope, blocco hard-tier
// (metadata/loopback) anche quando lo scope li autorizza, allow su target in scope, audit JSONL
// con i tre verdetti, ordine delle richieste preservato, e la funzione di giudizio esportata
// (con resolver iniettato) per il caso DNS-pin.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const assert = require('assert');
const { spawn } = require('child_process');

const WS = path.resolve(__dirname, '..');
const PROXY = path.join(WS, 'tools', 'mcp-guard-proxy.js');

let pass = 0; let fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log(`  PASS ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}: ${e.message}`); }
}
async function okAsync(name, fn) {
  try { await fn(); pass++; console.log(`  PASS ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}: ${e.message}`); }
}

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-guard-'));
// Hermetic: niente pace file condiviso né scope ambientale.
process.env.PACE_FILE = path.join(T, 'pace.json');

// Scope del test: un IP pubblico autorizzato e, in un secondo momento, anche il metadata IP
// (il caso peggiore: il layer 1 lascia passare, il layer 2 deve negare comunque).
function writeScope(obj) {
  const f = path.join(T, 'scope.json');
  fs.writeFileSync(f, JSON.stringify(obj));
  return f;
}

// Server MCP di prova: echo degli argomenti.
const FAKE = path.join(T, 'fake-mcp-server.js');
fs.writeFileSync(FAKE, `#!/usr/bin/env node
'use strict';
const readline = require('readline');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const t = line.trim();
  if (!t) return;
  let msg; try { msg = JSON.parse(t); } catch { return; }
  if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'fake_tool' }] } }) + '\\n');
    return;
  }
  if (msg.method === 'tools/call') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
      content: [{ type: 'text', text: 'SERVER_REACHED:' + msg.params.name + ':' + JSON.stringify(msg.params.arguments) }], isError: false } }) + '\\n');
    return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ok: true } }) + '\\n');
});
`);

// Avvia il proxy con il server finto e restituisce un client che mantiene le risposte per id.
function startProxy(scopeFile, auditFile) {
  const child = spawn(process.execPath, [PROXY, '--audit', auditFile, '--', process.execPath, FAKE], {
    env: { ...process.env, SCOPE_JSON: scopeFile },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  const seen = [];
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    seen.push(msg);
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  child.stderr.on('data', () => { /* il proxy logga i blocchi su stderr: non serve qui */ });
  let nextId = 1;
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`timeout su ${method}`)), 15000);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return { child, call, seen, stop: () => { try { child.stdin.end(); } catch { /* già chiuso */ } child.kill('SIGKILL'); } };
}

const textOf = (msg) => (msg.result && msg.result.content && msg.result.content[0] && msg.result.content[0].text) || '';

async function main() {
  // --------------------------------------------------------------- guardie in serie
  await okAsync('tools/call su un IP fuori scope: bloccato, e il server NON viene raggiunto', async () => {
    const scope = writeScope({ allowed_hosts: ['target.example'], allowed_ips: ['192.0.2.10'], max_requests_per_second: 50 });
    const audit = path.join(T, 'audit-block.jsonl');
    const p = startProxy(scope, audit);
    try {
      const r = await p.call('tools/call', { name: 'navigate_page', arguments: { url: 'http://198.51.100.7/admin' } });
      assert.strictEqual(r.result.isError, true, 'atteso isError');
      assert.ok(/scope-guard: blocked/.test(textOf(r)), textOf(r).slice(0, 200));
      assert.ok(!/SERVER_REACHED/.test(textOf(r)), 'il server non deve aver risposto');
      const rows = fs.readFileSync(audit, 'utf8').trim().split('\n').map(JSON.parse);
      assert.strictEqual(rows[0].verdict, 'block');
      assert.strictEqual(rows[0].tool, 'navigate_page');
    } finally { p.stop(); }
  });

  await okAsync('tools/call su un target in scope: passa al server (allow-scoped)', async () => {
    const scope = writeScope({ allowed_hosts: ['target.example'], allowed_ips: ['192.0.2.10'], max_requests_per_second: 50 });
    const audit = path.join(T, 'audit-allow.jsonl');
    const p = startProxy(scope, audit);
    try {
      const r = await p.call('tools/call', { name: 'fetch_host', arguments: { url: 'http://192.0.2.10/status' } });
      assert.ok(/SERVER_REACHED/.test(textOf(r)), textOf(r).slice(0, 200));
      const rows = fs.readFileSync(audit, 'utf8').trim().split('\n').map(JSON.parse);
      assert.strictEqual(rows[0].verdict, 'allow-scoped');
      assert.strictEqual(rows[0].targets[0].target, 'http://192.0.2.10/status');
    } finally { p.stop(); }
  });

  await okAsync('hard tier: metadata IP autorizzato in scope.json -> bloccato comunque dal layer 2', async () => {
    // Caso peggiore per il layer 1: l'operatore ha messo il metadata IP fra i target.
    const scope = writeScope({ allowed_hosts: ['169.254.169.254'], allowed_ips: ['169.254.169.254/32'], max_requests_per_second: 50 });
    const audit = path.join(T, 'audit-metadata.jsonl');
    const p = startProxy(scope, audit);
    try {
      const r = await p.call('tools/call', { name: 'navigate_page', arguments: { url: 'http://169.254.169.254/latest/meta-data/' } });
      assert.strictEqual(r.result.isError, true, textOf(r).slice(0, 200));
      assert.ok(/ssrf-guard: blocked/.test(textOf(r)), textOf(r));
      assert.ok(!/SERVER_REACHED/.test(textOf(r)));
    } finally { p.stop(); }
  });

  await okAsync('chiamata senza target riconoscibile: passa (allow-unscoped) e resta agli atti', async () => {
    const scope = writeScope({ allowed_hosts: ['target.example'], allowed_ips: ['192.0.2.10'], max_requests_per_second: 50 });
    const audit = path.join(T, 'audit-unscoped.jsonl');
    const p = startProxy(scope, audit);
    try {
      const r = await p.call('tools/call', { name: 'take_snapshot', arguments: { verbose: true } });
      assert.ok(/SERVER_REACHED/.test(textOf(r)), textOf(r).slice(0, 200));
      const rows = fs.readFileSync(audit, 'utf8').trim().split('\n').map(JSON.parse);
      assert.strictEqual(rows[0].verdict, 'allow-unscoped');
    } finally { p.stop(); }
  });

  await okAsync('metodi diversi da tools/call: passthrough identico (initialize, tools/list)', async () => {
    const scope = writeScope({ allowed_hosts: ['target.example'], max_requests_per_second: 50 });
    const audit = path.join(T, 'audit-passthrough.jsonl');
    const p = startProxy(scope, audit);
    try {
      const init = await p.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
      assert.strictEqual(init.result.ok, true, JSON.stringify(init).slice(0, 200));
      const list = await p.call('tools/list', {});
      assert.strictEqual(list.result.tools[0].name, 'fake_tool');
      assert.ok(!fs.existsSync(audit), 'nessuna riga di audit per i metodi non-tools/call');
    } finally { p.stop(); }
  });

  await okAsync('ordine delle risposte preservato anche con giudizi misti', async () => {
    const scope = writeScope({ allowed_hosts: ['target.example'], allowed_ips: ['192.0.2.10'], max_requests_per_second: 50 });
    const audit = path.join(T, 'audit-order.jsonl');
    const p = startProxy(scope, audit);
    try {
      const [a, b, c] = await Promise.all([
        p.call('tools/call', { name: 'fetch_host', arguments: { url: 'http://192.0.2.10/1' } }),
        p.call('tools/call', { name: 'navigate_page', arguments: { url: 'http://198.51.100.9/2' } }),
        p.call('tools/call', { name: 'fetch_host', arguments: { url: 'http://192.0.2.10/3' } }),
      ]);
      assert.ok(/SERVER_REACHED/.test(textOf(a)), 'prima chiamata: dovrebbe passare');
      assert.strictEqual(b.result.isError, true, 'seconda chiamata: dovrebbe essere bloccata');
      assert.ok(/SERVER_REACHED/.test(textOf(c)), 'terza chiamata: dovrebbe passare');
      const rows = fs.readFileSync(audit, 'utf8').trim().split('\n').map(JSON.parse).map((r) => r.verdict);
      assert.deepStrictEqual(rows, ['allow-scoped', 'block', 'allow-scoped']);
    } finally { p.stop(); }
  });

  // --------------------------------------------------------------- unità del giudizio
  // `localhost` risolve SEMPRE a 127.0.0.1 (via /etc/hosts, nessuna DNS esterna): è il caso
  // DNS-rebinding più economico da testare senza rete.
  const withScope = async (scopeObj, fn, env) => {
    const prev = process.env.SCOPE_JSON;
    const prevEnv = process.env.ALLOW_METADATA_TARGET;
    process.env.SCOPE_JSON = writeScope(scopeObj);
    if (env) process.env.ALLOW_METADATA_TARGET = env;
    try { await fn(); }
    finally {
      if (prev === undefined) delete process.env.SCOPE_JSON; else process.env.SCOPE_JSON = prev;
      if (prevEnv === undefined) delete process.env.ALLOW_METADATA_TARGET; else process.env.ALLOW_METADATA_TARGET = prevEnv;
    }
  };

  await okAsync('judgeTargets: hostname in scope che risolve a un indirizzo non in allowed_ips -> negato (rebinding)', async () => {
    const { judgeTargets } = require(PROXY);
    await withScope({ allowed_hosts: ['localhost'], max_requests_per_second: 50 }, async () => {
      const verdicts = await judgeTargets(['http://localhost/']);
      assert.strictEqual(verdicts[0].ok, false, JSON.stringify(verdicts[0]));
      assert.ok(/resolve-pin/.test(verdicts[0].why), verdicts[0].why);
      assert.ok(/DNS-rebinding|not in allowed_ips/.test(verdicts[0].why), verdicts[0].why);
    });
  });

  await okAsync('judgeTargets: hostname in scope che risolve a una subnet autorizzata -> ammesso con opt-in', async () => {
    const { judgeTargets } = require(PROXY);
    await withScope({ allowed_hosts: ['localhost'], allowed_ips: ['127.0.0.0/8'], max_requests_per_second: 50 }, async () => {
      const verdicts = await judgeTargets(['http://localhost/app']);
      assert.strictEqual(verdicts[0].ok, true, JSON.stringify(verdicts[0]));
      assert.strictEqual(verdicts[0].address, '127.0.0.1');
    }, '1');
  });

  await okAsync('judgeTargets: risoluzione impossibile -> fail-closed (come repeater)', async () => {
    const { judgeTargets } = require(PROXY);
    await withScope({ allowed_hosts: ['nonexistent.invalid'], max_requests_per_second: 50 }, async () => {
      const verdicts = await judgeTargets(['http://nonexistent.invalid/']);
      assert.strictEqual(verdicts[0].ok, false, JSON.stringify(verdicts[0]));
      assert.ok(/resolve-pin: DNS resolution failed/.test(verdicts[0].why), verdicts[0].why);
    });
  });

  await okAsync('estrazione target: URL annidati, host nudi e IP dentro oggetti/array', async () => {
    const { targetsFrom } = require(PROXY);
    const targets = targetsFrom({
      url: 'https://a.example/path?x=1',
      nested: { endpoint: 'b.example' },
      list: ['http://198.51.100.3/', 'not a target at all'],
      count: 3,
      flag: true,
    });
    assert.ok(targets.includes('https://a.example/path?x=1'), JSON.stringify(targets));
    assert.ok(targets.includes('b.example'), JSON.stringify(targets));
    assert.ok(targets.includes('http://198.51.100.3/'), JSON.stringify(targets));
    assert.ok(!targets.includes('not a target at all'), JSON.stringify(targets));
  });

  console.log(`\nmcp-guard-proxy: ${pass} pass, ${fail} fail`);
  fs.rmSync(T, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('test crashed: ' + e.stack); try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* niente */ } process.exit(2); });
