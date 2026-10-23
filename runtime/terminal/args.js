// runtime/terminal/args.js — what this process was asked to do.
//
// argv is read once, here, and the rest of the terminal surface reads OPTS and
// nothing else: a flag that is not in this object does not exist. `--scope` is
// exported to the child tools (they read SCOPE_JSON themselves) in the same place
// it is parsed.
'use strict';

// Single source of truth: the banner, `/version` and `--version` must agree with the
// release, and package.json is what a tag is cut from.
const VERSION = require('../../package.json').version;
const argv = process.argv.slice(2);

function argValue(flag) {
  const i = argv.indexOf(flag);
  if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('-')) return argv[i + 1];
  const pref = flag + '=';
  const hit = argv.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length) : null;
}

function firstPositional() {
  for (let i = 0; i < argv.length; i += 1) {
    // Every flag that TAKES a value: otherwise its value becomes the positional host and
    // `--resume <id>` would be read as an out-of-scope target.
    if (['--scope', '--task', '--profile', '--config', '--phase', '--class', '--resume'].includes(argv[i])) { i += 1; continue; }
    if (!argv[i].startsWith('-')) return argv[i];
  }
  return null;
}

const OPTS = {
  demo: argv.includes('--demo'),
  demoApprove: argv.includes('--demo-approve'),
  live: argv.includes('--live'),
  task: argValue('--task'),
  profile: argValue('--profile'),
  config: argValue('--config'),
  phase: argValue('--phase'),
  klass: argValue('--class'),
  allowCloud: argv.includes('--allow-cloud'),
  resume: argValue('--resume'),
  allowStale: argv.includes('--allow-stale'),
  fast: argv.includes('--fast') || !process.stdout.isTTY,
  script: argv.includes('--script'),
  scope: argValue('--scope'),
  target: firstPositional(),
  ascii: argv.includes('--ascii'),
  help: argv.includes('--help') || argv.includes('-h'),
  version: argv.includes('--version') || argv.includes('-v'),
  noColor: argv.includes('--no-color') || process.env.NO_COLOR != null || process.env.TERM === 'dumb',
};
if (OPTS.task) OPTS.live = true;
// Continuing a session means sending its history somewhere: the same reasoning that makes
// --task a live run applies to --resume.
if (OPTS.resume) OPTS.live = true;
// Authorizing cloud egress is meaningless without a provider call: treat the flag as
// an explicit "connect at launch" too, so `cyboros --allow-cloud` is not a shell.
if (OPTS.allowCloud && !OPTS.demo) OPTS.live = true;
// The child tools (run.js, record-finding.js, …) read SCOPE_JSON themselves:
// the --scope flag must reach them, not just this process.
if (OPTS.scope) process.env.SCOPE_JSON = OPTS.scope;

module.exports = { OPTS, VERSION };
