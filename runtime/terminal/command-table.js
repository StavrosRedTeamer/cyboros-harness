// runtime/terminal/command-table.js — the slash commands as data.
//
// The menu, the completer and /help all read this table, so a command cannot exist
// in the dispatch and be missing from the menu. Dispatch is commands.js; keeping the
// table separate lets the input module read it without importing the handlers.
'use strict';

// ── commands ───────────────────────────────────────────────────────────────
const CMDS = [
  ['/help', 'this guide'],
  ['/demo [sqli|idor]', 'run a scripted turn'],
  ['/scope [host]', 'show or check the authorization'],
  ['/target <host>', 'set the target (fail-closed)'],
  ['/phase <p>', 'recon-map | web-test | host | wireless | report'],
  ['/class <c>', 'sqli | xss | authz | authn | ssrf | ...'],
  ['/model [profile]', 'openrouter | llama'],
  ['/live [profile|off]', 'real provider loop · guarded tools'],
  ['/plan | /auto | /ask', 'execution mode'],
  ['/budget', 'requests, time, tokens, cost'],
  ['/findings', 'current findings and proof levels'],
  ['/gate', 'coverage and report gate'],
  ['/trace', 'last events'],
  ['/todos', 'coverage plan as a checklist'],
  ['/status', 'session card'],
  ['/permissions', 'approval policy'],
  ['/details [on|off]', 'tool call details'],
  ['/thinking [on|off]', 'show or hide the model reasoning'],
  ['/compact', 'compact the context, keeping the contract and the state digest'],
  ['/sessions', 'recent sessions'],
  ['/resume [id]', 'list, attach, or continue a session'],
  ['/clear', 'clear the screen'],
  ['/quit', 'exit'],
];

module.exports = { CMDS };
