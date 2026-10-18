// test-tags: loopback
// test-kill-port — il PID che il kernel dichiara come LISTENER è quello che viene ucciso.
// Un server figlio (sibling del CLI kill-port) ascolta su 127.0.0.1:porta effimera; il tool deve
// trovarlo, ucciderlo con SIGTERM e riportare la porta libera. Tutto su loopback, nessun target.
// Run: node tools/test-kill-port.js
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { ok, okAsync, summary } = require('./testkit');

const CLI = path.join(__dirname, 'kill-port.js');
const { parseArgs } = require('./kill-port');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const c = net.connect(port, '127.0.0.1');
      c.once('connect', () => { c.destroy(); resolve(true); });
      c.once('error', () => {
        c.destroy();
        if (Date.now() > deadline) return resolve(false);
        setTimeout(attempt, 50);
      });
    };
    attempt();
  });
}

function run(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// ── parsing ────────────────────────────────────────────────────────────────────────────────────
ok('port parsed', () => assert.strictEqual(parseArgs(['8099']).port, 8099));
ok('--dry-run parsed', () => assert.strictEqual(parseArgs(['8099', '--dry-run']).dryRun, true));
ok('--signal KILL parsed', () => assert.strictEqual(parseArgs(['8099', '--signal', 'KILL']).signal, 'KILL'));
ok('--signal=INT parsed', () => assert.strictEqual(parseArgs(['8099', '--signal=INT']).signal, 'INT'));
ok('--udp switches protocol', () => assert.strictEqual(parseArgs(['53', '--udp']).proto, 'udp'));
ok('non-numeric port is rejected', () => {
  const a = parseArgs(['abc']);
  assert.strictEqual(a.port, null);
  assert.match(a.bad, /unknown argument/);
});

(async () => {
  const port = await freePort();
  const child = spawn(process.execPath, ['-e',
    `require('net').createServer(() => {}).listen(${port}, '127.0.0.1')`], { stdio: 'ignore' });
  // Un processo morto PER SEGNALE ha exitCode null e signalCode valorizzato.
  const dead = () => child.exitCode !== null || child.signalCode !== null;

  try {
    await okAsync('fixture listener is up on loopback', async () => {
      assert.ok(await waitForPort(port, 5000), `port ${port} never accepted a connection`);
    });

    // --dry-run: trova il PID giusto ma non uccide nulla.
    const dry = run([String(port), '--dry-run', '--json']);
    let dryJson = null;
    try { dryJson = JSON.parse(dry.stdout); } catch { /* asserted below */ }
    ok('--dry-run exits 0', () => assert.strictEqual(dry.status, 0, dry.stderr));
    ok('--dry-run reports the real listener pid', () => assert.ok(
      dryJson && dryJson.listeners.some((l) => l.pid === child.pid), JSON.stringify(dryJson && dryJson.listeners)));
    ok('--dry-run leaves the listener alive', () => assert.ok(!dead()));

    // Il caso che rompeva i workflow: il PID del wrapper non è quello del listener. Qui il CLI
    // deve uccidere il processo che il kernel dichiara, e la porta deve risultare libera.
    const real = run([String(port), '--json']);
    let json = null;
    try { json = JSON.parse(real.stdout); } catch { /* asserted below */ }
    ok('kill exits 0', () => assert.strictEqual(real.status, 0, real.stderr + real.stdout));
    ok('kill reports the port free', () => assert.strictEqual(json && json.port_free, true));
    ok('kill killed exactly the listener pid', () => assert.ok(
      json && json.killed.includes(child.pid), JSON.stringify(json && json.killed)));

    await okAsync('fixture listener process exited', async () => {
      if (!dead()) {
        await new Promise((resolve) => {
          child.once('exit', resolve);
          setTimeout(resolve, 3000);
        });
      }
      assert.ok(dead(), `exit=${child.exitCode} signal=${child.signalCode}`);
    });

    // La porta è davvero libera: un nuovo bind riesce.
    await okAsync('port can be bound again (no EADDRINUSE)', async () => {
      const rebound = await new Promise((resolve) => {
        const s = net.createServer();
        s.once('error', () => resolve(false));
        s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
      });
      assert.ok(rebound);
    });

    // Nessun listener → nessun PID da uccidere, exit 0 (idempotente).
    const nothing = run([String(port), '--json']);
    let none = null;
    try { none = JSON.parse(nothing.stdout); } catch { /* asserted below */ }
    ok('no listener: exit 0 and killed []', () => {
      assert.strictEqual(nothing.status, 0);
      assert.deepStrictEqual(none.killed, []);
    });

    // Porta privilegiata senza --yes: rifiuta prima di toccare qualsiasi cosa.
    const priv = run(['80']);
    ok('privileged port without --yes is refused (exit 2)', () => {
      assert.strictEqual(priv.status, 2);
      assert.match(priv.stderr, /--yes/);
    });
  } finally {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }

  summary('kill-port');
})();
