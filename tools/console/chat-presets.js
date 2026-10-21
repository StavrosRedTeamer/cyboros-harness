// Console — chat presets: what a conversation is ALLOWED to do, in one table.
//
// Why it exists: "pentest chat" and "conversation about the reports" are the same
// transport (POST /api/chat, SSE) with a different contract. If that contract lived in
// the UI or in the prompt, a stale tab, a handcrafted request or a prompt injection
// would widen it. So the allowlist is data, the dispatch refuses anything outside it,
// and the tool schema sent to the model is filtered by the same list — two layers,
// one source. The prompt only states what the code already enforces.
//
// Presets are built in, not user files: an operator who can edit the allowlist from
// the browser can turn analysis mode into a remote shell, which is exactly the
// decision this module exists to keep out of reach. Adding a preset is a code change
// reviewed like any other.
'use strict';

const { SCHEMA } = require('../../local/tools-bridge');

const ALL_TOOLS = SCHEMA.map((t) => t.function.name);

// Read-only interrogation of the engagement: the same tools the TUI offers in plan
// mode. `write_file` and `record_finding` are deliberately absent — analysis observes,
// it does not author evidence.
const ANALYSIS_TOOLS = [
  'scope_check', 'read_file', 'kb_search', 'memory_recall',
  'findings_query', 'sessions_list', 'session_read',
];

const PRESETS = [
  {
    id: 'pentest',
    label: 'Pentest',
    description: 'Full engagement surface: recon, probes, findings. Intrusive tools ask the operator first.',
    mode: 'operate',
    tools: ALL_TOOLS,
    max_iters: 16,
    addendum: [
      'PRESET: pentest — the guarded tools are available and the operator expects work, not a plan.',
      'Call scope_check before a target, prefer the deterministic pipeline over hand-run binaries,',
      'and register findings with the evidence they need. Intrusive tools are approved per action',
      'by the operator from this same conversation; a refusal is a decision, not an obstacle to route around.',
    ].join('\n'),
  },
  {
    id: 'analysis',
    label: 'Analysis',
    description: 'Read previous reports, findings and sessions. No recon, no probes, no writes.',
    mode: 'read-only',
    tools: ANALYSIS_TOOLS,
    max_iters: 8,
    addendum: [
      'PRESET: analysis — read-only. findings_query, sessions_list, session_read, read_file,',
      'kb_search and memory_recall are the whole surface. Do not propose a command you cannot run;',
      'if the operator asks for one, name the pentest preset and stop.',
    ].join('\n'),
  },
  {
    id: 'chat',
    label: 'Conversation',
    description: 'No tools at all: methodology, definitions, thinking out loud.',
    mode: 'chat',
    tools: [],
    max_iters: 1,
    addendum: 'PRESET: conversation — no tools. Answer from what you know and say so when you do not know.',
  },
];

// A typo in a tool name above must fail at load, not silently grant nothing (or, worse,
// silently grant everything if the lookup is inverted).
for (const p of PRESETS) {
  for (const name of p.tools) {
    if (!ALL_TOOLS.includes(name)) throw new Error(`chat preset "${p.id}" names an unknown tool: ${name}`);
  }
}

const BY_ID = new Map(PRESETS.map((p) => [p.id, p]));
const DEFAULT_ID = 'pentest';

function get(id) {
  return BY_ID.get(String(id || '')) || null;
}

function list() {
  return PRESETS.map((p) => ({
    id: p.id,
    label: p.label,
    description: p.description,
    mode: p.mode,
    readonly: p.mode !== 'operate',
    tools: p.tools.slice(),
  }));
}

// The schema the model may even see: a tool outside the preset is not offered, and if
// a model invents the call anyway the dispatch refuses it (see chat-tools.js).
function schemaFor(preset) {
  return SCHEMA.filter((t) => preset.tools.includes(t.function.name));
}

function allows(preset, name) {
  return !!preset && preset.tools.includes(String(name || ''));
}

function systemAddendum(preset) {
  return String((preset && preset.addendum) || '');
}

module.exports = { PRESETS, DEFAULT_ID, get, list, schemaFor, allows, systemAddendum };
