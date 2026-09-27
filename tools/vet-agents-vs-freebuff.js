#!/usr/bin/env node
// Pre-flight: verifica che ogni .agents/*.ts sia compatibile con il BINARIO
// Freebuff attualmente installato (che si auto-aggiorna da npm ad ogni avvio).
// Estrae dal binario l'insieme dei toolNames e degli slug-modello CONOSCIUTI e
// segnala ogni agente che referenzia un tool o un modello non piu' presente.
// Exit 0 = tutti gli agenti compatibili; exit 1 = almeno un problema.
//
// Uso: node tools/vet-agents-vs-freebuff.js
'use strict'
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const AGENTS_DIR = path.join(__dirname, '..', '.agents')
const BIN = path.join(
  process.env.HOME || require('os').homedir(),
  '.config/manicode/freebuff',
)

function binStrings() {
  try {
    return execSync(`strings -n 4 ${JSON.stringify(BIN)}`, {
      maxBuffer: 512 * 1024 * 1024,
    }).toString()
  } catch (e) {
    console.error(`[vet] impossibile leggere il binario Freebuff: ${BIN}\n      ${e.message}`)
    process.exit(2)
  }
}

const s = binStrings()

// Tool ufficiali del formato Codebuff/Freebuff (whitelist chiusa: se un tool
// non e' tra questi E non compare nel binario, e' sospetto).
const KNOWN_TOOL_UNIVERSE = [
  'read_files', 'read_file', 'read_subtree', 'write_file', 'str_replace', 'run_terminal_command',
  'spawn_agents', 'spawn_agent_inline', 'end_turn', 'add_message', 'set_output',
  'create_plan', 'browser_logs', 'code_search', 'find_files',
  'run_file_change_hooks', 'think_deeply', 'read_docs', 'web_search',
  // tool presenti nei template base2/base3 del binario ma assenti dalla whitelist:
  // senza questi il preflight segnalava falsi positivi (es. read_url su stavros-vet.ts)
  'read_url', 'ask_user', 'suggest_followups', 'list_directory', 'glob', 'write_todos',
  'skill', 'gravity_index', 'render_ui', 'propose_str_replace', 'propose_write_file',
  'lookup_agent_info', 'apply_patch', 'add_subgoal', 'set_messages', 'task_completed',
  'cloud_plan_ready', 'report_project_profile',
]
const validTools = new Set(
  KNOWN_TOOL_UNIVERSE.filter((t) => new RegExp(`\\b${t}\\b`).test(s)),
)
const knownModelSlugs = new Set(
  (s.match(/(?:deepseek|z-ai|anthropic|openai|google|moonshotai|qwen|x-ai|meta-llama)\/[a-z0-9.-]+/g) || []),
)

// Id dei template BUNDLED nel binario. Un .agents/*.ts che ne riusa uno viene
// validato dal server contro il template del registry, non contro il file locale:
// succede che il file passi i controlli ma l'invio venga bloccato con un errore
// che descrive un agente diverso. Diventa quindi un problema a se'.
const bundledIds = new Set((s.match(/\bid:"([a-z0-9][a-z0-9._-]*)"/g) || [])
  .map((m) => m.slice(4, -1)))

const files = fs.readdirSync(AGENTS_DIR).filter((n) => n.endsWith('.ts'))
const parsed = files.map((f) => {
  const src = fs.readFileSync(path.join(AGENTS_DIR, f), 'utf8')
  const spawnBlock = src.match(/spawnableAgents:\s*\[([^\]]*)\]/)
  return {
    f,
    src,
    id: (src.match(/\bid:\s*'([^']+)'/) || [])[1],
    toolNames: [...new Set(
      [...((src.match(/toolNames:\s*\[([^\]]*)\]/) || [, ''])[1]
        .matchAll(/'([a-z_]+)'/g))].map((m) => m[1]),
    )],
    spawnableAgents: spawnBlock
      ? [...spawnBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
      : [],
  }
})
const localIds = new Set(parsed.map((p) => p.id).filter(Boolean))

let problems = 0
for (const { f, src, id, toolNames, spawnableAgents } of parsed) {
  const modelMatch = src.match(/const model\s*=\s*'([^']+)'/) ||
                     src.match(/model:\s*'([^']+)'/)
  if (modelMatch && !knownModelSlugs.has(modelMatch[1])) {
    console.error(`[MODELLO] ${f}: '${modelMatch[1]}' non e' nel roster del binario Freebuff installato`)
    problems++
  }

  for (const t of toolNames) {
    if (!validTools.has(t)) {
      console.error(`[TOOL]    ${f}: '${t}' non e' un tool valido in questa versione di Freebuff`)
      problems++
    }
  }

  // Schema agente: la CLI pretende i tre prompt come stringhe, non opzionali.
  for (const key of ['systemPrompt', 'instructionsPrompt', 'stepPrompt']) {
    if (!new RegExp(`\\b${key}:\\s*(\`|'|\")`).test(src)) {
      console.error(`[SCHEMA]  ${f}: manca '${key}' (richiesto dallo schema agente della CLI)`)
      problems++
    }
  }

  // Schema agente: spawnableAgents non vuoto => serve 'spawn_agents' nei toolNames
  // (o spawn programmatico via handleSteps). Se no, l'invio del messaggio viene
  // scartato dal validatore: "Non-empty spawnableAgents array requires the
  // 'spawn_agents' tool" e in TUI resta muto.
  if (spawnableAgents.length > 0 &&
      !toolNames.includes('spawn_agents') &&
      !toolNames.includes('spawn_agent_inline') &&
      !/\bhandleSteps\b/.test(src)) {
    console.error(`[SCHEMA]  ${f}: spawnableAgents non vuoto (${spawnableAgents.length}) ma 'spawn_agents' non e' nei toolNames`)
    problems++
  }

  // Schema agente: ogni id referenziato deve esistere fra gli agenti locali,
  // altrimenti "Invalid agent ID: <id>. Not found."
  for (const ref of spawnableAgents) {
    if (!localIds.has(ref)) {
      console.error(`[SCHEMA]  ${f}: spawnableAgents referenzia '${ref}', che non e' definito in ${AGENTS_DIR}`)
      problems++
    }
  }

  if (id && bundledIds.has(id)) {
    console.error(`[SCHEMA]  ${f}: id '${id}' e' anche un template bundled: il validatore lo risolve contro il registry, non contro questo file. Rinominalo.`)
    problems++
  }
}

// settings.json:freebuffModel e' uno slug di MODELLO, non un agent id: l'agente principale
// ne deriva (HuA/OaH). Un valore che non e' uno slug noto viene scartato in silenzio e si
// ripiega sul default, che puo cambiare a ogni auto-aggiornamento del core.
const SETTINGS = path.join(
  process.env.HOME || require('os').homedir(),
  '.config/manicode/settings.json',
)
try {
  const pick = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')).freebuffModel
  if (typeof pick === 'string' && pick &&
      !/^[a-z0-9][a-z0-9-]*\/[a-z0-9._-]+$/.test(pick) && !knownModelSlugs.has(pick)) {
    console.error(`[MODELLO] settings.json: freebuffModel='${pick}' non e' uno slug di modello (atteso 'publisher/model'): verra' scartato in silenzio.`)
    problems++
  }
} catch (e) {
  if (e.code !== 'ENOENT') {
    console.error(`[MODELLO] ${SETTINGS} non leggibile: ${e.message}`)
    problems++
  }
}

if (problems === 0) {
  console.log(`[vet] OK — tutti gli agenti sono compatibili con il binario Freebuff installato.`)
  console.log(`[vet] tool validi rilevati: ${[...validTools].sort().join(', ')}`)
  process.exit(0)
}
console.error(`\n[vet] ${problems} problema/i: correggi gli agenti sopra prima di avviare Freebuff.`)
process.exit(1)
