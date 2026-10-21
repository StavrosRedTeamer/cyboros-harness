// Console — background jobs (resume / report generation) and their SSE feed.
//
// Why it is its own module: a job outlives the request that started it, buffers its
// own output and has its own viewers. That state belongs to the runner, not to the
// route that triggers it — a new job kind is a new entry in the caller's table, and
// swapping the executor (say, a queue) changes only this file.
'use strict';
const { spawn } = require('child_process');

function createJobs(opts) {
  const root = opts.root;
  const jobs = new Map();
  let seq = 1;

  function run(name, cmdArgs, extra) {
    const id = 'job' + seq++;
    const job = {
      id, name, lines: [], state: 'running', exitCode: null,
      out: extra && extra.out || null,
      startedAt: new Date().toISOString(), finishedAt: null,
      listeners: new Set(),
    };
    jobs.set(id, job);
    const push = (chunk) => {
      const text = chunk.toString();
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        job.lines.push(line);
        if (job.lines.length > 4000) job.lines.splice(0, job.lines.length - 4000);
        for (const cb of job.listeners) cb({ type: 'line', line });
      }
    };
    const child = spawn(process.execPath, cmdArgs, {
      cwd: root,
      env: Object.assign({}, process.env, { GUI_NO_LOG: '1' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    child.on('error', (e) => {
      job.state = 'error';
      job.exitCode = -1;
      job.finishedAt = new Date().toISOString();
      for (const cb of job.listeners) cb({ type: 'done', exitCode: -1, error: String(e.message || e), out: job.out });
      job.listeners.clear();
    });
    child.on('close', (code) => {
      job.state = code === 0 ? 'done' : 'error';
      job.exitCode = code;
      job.finishedAt = new Date().toISOString();
      for (const cb of job.listeners) cb({ type: 'done', exitCode: code, out: job.out });
      job.listeners.clear();
    });
    return id;
  }

  // Snapshot per /api/jobs e per il War Room (stessa forma, un solo posto).
  function snapshot() {
    return [...jobs.values()].map((j) => ({
      id: j.id, name: j.name, state: j.state, exitCode: j.exitCode,
      startedAt: j.startedAt, finishedAt: j.finishedAt, out: j.out, lines: j.lines.length,
    })).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  }

  // Replay then live frames; ends the response when the job ends. Returns false when
  // the id is unknown (caller answers 404 with its own shape).
  function stream(req, res, sendJson, jobId) {
    const job = jobs.get(jobId);
    if (!job) return false;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    for (const line of job.lines) res.write('data: ' + JSON.stringify({ type: 'line', line }) + '\n\n');
    if (job.state !== 'running') {
      res.write('data: ' + JSON.stringify({ type: 'done', exitCode: job.exitCode, out: job.out }) + '\n\n');
      res.end();
      return true;
    }
    const cb = (ev) => {
      res.write('data: ' + JSON.stringify(ev) + '\n\n');
      if (ev.type === 'done') { job.listeners.delete(cb); res.end(); }
    };
    job.listeners.add(cb);
    req.on('close', () => job.listeners.delete(cb));
    return true;
  }

  return { run, snapshot, stream };
}

module.exports = { createJobs };
