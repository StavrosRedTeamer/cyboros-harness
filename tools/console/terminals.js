// Console — embedded TUI terminals: direct PTY bridges, one per named session.
//
// Why it is its own module: a terminal owns a child process, a replay buffer, a set
// of SSE viewers and an auto-restart circuit breaker — none of which the HTTP route
// or the data model should know about. Each tab (`freebuff`) owns ONE fbpty.py
// process living in the SERVER: a real PTY sized like the browser terminal,
// surviving reloads. SSE clients are VIEWERS: on connect they get a byte-exact
// replay of the session output (capped), then live frames. If the TUI dies on its
// own the server auto-restarts it with a circuit breaker.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const TERM_COLS = 120;
const TERM_ROWS = 32;
const FB_REPLAY_MAX = 2 * 1024 * 1024; // screen-history bytes kept for replay

function createTerminals(opts) {
  const root = opts.root;
  const toolsDir = opts.toolsDir;
  const FBPTY = path.join(toolsDir, 'fbpty.py');

  const TERM_DEFS = {
    freebuff: { label: 'Freebuff', cwd: root, cmd: 'freebuff --cwd ' + root },
  };

  function mkSession(def) {
    return {
      def,
      proc: null,            // the fbpty.py child (null = not running)
      cmdLine: null,         // command it is running
      cols: TERM_COLS,
      rows: TERM_ROWS,
      replay: [],            // output chunks since start (Buffer[])
      replayBytes: 0,
      stopping: false,       // set by stop → suppress auto-restart
      restarts: [],          // auto-restart circuit breaker timestamps
      clients: new Map(),    // sse id -> res
    };
  }
  const termSessions = new Map();
  for (const k of Object.keys(TERM_DEFS)) termSessions.set(k, mkSession(TERM_DEFS[k]));
  const termDefault = 'freebuff';
  let fbSeq = 0;               // global SSE viewer id counter

  function fbClamp(v, lo, hi, dflt) {
    const n = parseInt(v, 10);
    return Math.max(lo, Math.min(hi, Number.isFinite(n) && n > 0 ? n : dflt));
  }

  function fbKeepReplay(S, buf) {
    S.replay.push(buf);
    S.replayBytes += buf.length;
    while (S.replayBytes > FB_REPLAY_MAX && S.replay.length > 1) {
      S.replayBytes -= S.replay[0].length;
      S.replay.shift();
    }
  }

  function fbBroadcast(S, buf) {
    fbKeepReplay(S, buf);
    const frame = 'data: ' + buf.toString('base64') + '\n\n';
    for (const [id, res] of S.clients) {
      try { res.write(frame); } catch { S.clients.delete(id); }
    }
  }

  function fbEndAll(S) {
    for (const [, res] of S.clients) {
      try { res.write('event: end\ndata: 1\n\n'); res.end(); } catch { /* ignore */ }
    }
    S.clients.clear();
  }

  function fbNote(S, text) {
    fbBroadcast(S, Buffer.from('\r\n\x1b[33m[cyboros-console] ' + text + '\x1b[0m\r\n'));
  }

  function fbStartProc(S, cmd, cols, rows) {
    S.cols = fbClamp(cols, 20, 400, TERM_COLS);
    S.rows = fbClamp(rows, 6, 200, TERM_ROWS);
    const proc = spawn('python3', [FBPTY, String(S.cols), String(S.rows), '--', 'bash', '-lc', cmd], {
      cwd: S.def.cwd,
      env: Object.assign({}, process.env, { TERM: 'xterm-256color', COLORTERM: 'truecolor' }),
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });
    S.proc = proc;
    S.cmdLine = cmd;
    S.replay = [];
    S.replayBytes = 0;
    proc.stdout.on('data', (buf) => fbBroadcast(S, buf));
    proc.stderr.on('data', (buf) => fbBroadcast(S, buf)); // render stderr inline too
    proc.on('exit', (code) => {
      S.proc = null;
      fbEndAll(S);
      if (S.stopping) { S.stopping = false; return; }
      // The TUI exited on its own (crash or `exit` typed). Auto-restart with a
      // circuit breaker so a crash loop cannot spin forever.
      const now = Date.now();
      while (S.restarts.length && now - S.restarts[0] > 60000) S.restarts.shift();
      if (S.restarts.length >= 5) {
        fbNote(S, 'processo terminato (exit ' + code + ') — auto-restart sospeso (troppi restart in 60s)');
        return;
      }
      S.restarts.push(now);
      fbNote(S, 'processo terminato (exit ' + code + ') — riavvio automatico…');
      setTimeout(() => {
        if (!S.proc && !S.stopping && S.cmdLine) fbStartProc(S, S.cmdLine, S.cols, S.rows);
      }, 800);
    });
  }

  async function status(name) {
    const S = termSessions.get(name || termDefault);
    if (!S) return { available: false, reason: 'sessione sconosciuta: ' + name };
    const okFs = fs.existsSync(FBPTY);
    return {
      available: okFs,
      reason: okFs ? null : 'fbpty.py non trovato',
      name: name || termDefault,
      label: S.def.label,
      running: !!S.proc,
      session: 'direct-pty',
      cmd: S.cmdLine,
      cwd: S.def.cwd,
      cols: S.cols,
      rows: S.rows,
      viewers: S.clients.size,
    };
  }

  async function start(name, body) {
    const S = termSessions.get(name || termDefault);
    if (!S) return { ok: false, error: 'sessione sconosciuta: ' + name };
    if (S.proc) return { ok: false, error: 'terminal already running' };
    const cols = fbClamp(body && body.cols, 20, 400, TERM_COLS);
    const rows = fbClamp(body && body.rows, 6, 200, TERM_ROWS);
    // Default command: the session's harness TUI, launched from its own root so
    // it picks up scope.json / agent definitions from the right directory.
    let cmd = String((body && body.cmd) || '').trim() || S.def.cmd;
    cmd = cmd.replace(/\s+$/, '');
    S.stopping = false;
    fbStartProc(S, cmd, cols, rows);
    return { ok: true, session: 'direct-pty', name: name || termDefault, cols: S.cols, rows: S.rows, cmd };
  }

  async function stop(name) {
    const S = termSessions.get(name || termDefault);
    if (!S) return { ok: false, error: 'sessione sconosciuta: ' + name };
    if (!S.proc) return { ok: true, message: 'not running' };
    S.stopping = true;
    try { S.proc.kill('SIGTERM'); } catch { /* ignore */ }
    return { ok: true, message: 'stopped' };
  }

  // Connect is ALWAYS allowed: if the TUI is not running the client sees an idle
  // notice on screen; otherwise it first receives the full replay, then live frames.
  // Input/resize act on the session PTY (the stream id is informational).
  function stream(res, name) {
    const S = termSessions.get(name || termDefault);
    const id = 'fb' + (++fbSeq);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    res.write('event: id\ndata: ' + id + '\n\n');
    if (!S) {
      res.write('event: end\ndata: 1\n\n');
      res.end();
      return id;
    }
    S.clients.set(id, res);
    if (S.proc) {
      for (const buf of S.replay) {
        try { res.write('data: ' + buf.toString('base64') + '\n\n'); } catch { break; }
      }
    } else {
      try {
        res.write('data: ' + Buffer.from(
          '\x1b[2J\x1b[H\x1b[33m[cyboros-console] sessione ' + S.def.label + ' non attiva — premi ▶ Start\x1b[0m\r\n'
        ).toString('base64') + '\n\n');
      } catch { /* ignore */ }
    }
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 25000);
    res.on('close', () => { clearInterval(ping); S.clients.delete(id); });
    return id;
  }

  function input(name, dataB64) {
    const S = termSessions.get(name || termDefault);
    if (!S) return { ok: false, error: 'sessione sconosciuta: ' + name };
    if (!S.proc) return { ok: false, error: 'not running' };
    try { S.proc.stdin.write(Buffer.from(String(dataB64 || ''), 'base64')); return { ok: true }; }
    catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
  }

  function resize(name, cols, rows) {
    const S = termSessions.get(name || termDefault);
    if (!S) return { ok: false, error: 'sessione sconosciuta: ' + name };
    const c = fbClamp(cols, 20, 400, TERM_COLS);
    const r = fbClamp(rows, 6, 200, TERM_ROWS);
    S.cols = c; S.rows = r;
    if (!S.proc) return { ok: false, error: 'not running', cols: c, rows: r };
    try { S.proc.stdio[3].write('R ' + c + ' ' + r + '\n'); return { ok: true, cols: c, rows: r }; }
    catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
  }

  return { status, start, stop, stream, input, resize };
}

module.exports = { createTerminals };
