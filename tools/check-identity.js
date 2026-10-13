#!/usr/bin/env node
// Post-flight: apre il systemPrompt dell'ultima chat e verifica che l'identita' sia
// cablata come si intende.
//
//   node tools/check-identity.js                 # default: il ramo @cyboros del router
//   node tools/check-identity.js <progetto>      # idem, altro progetto
//   node tools/check-identity.js eni [<progetto>]# il ramo @eni (contratto in ~/eni/.AGENTS.md)
//
// L'identita' del main agent NON viene da .agents/ ma dai knowledge file, che Freebuff
// renderizza in due soli: <progetto>/AGENTS.md e uno fra ~/.AGENTS.md / ~/.CLAUDE.md.
// Il default e' l'identita' del prodotto; Cyboros e ENI sono opt-in sui token `@cyboros` /
// `@eni` del PRIMO messaggio. Questo tool non legge i messaggi dell'utente: verifica che le
// condizioni dell'opt-in siano presenti e coerenti nel prompt, e segnala il modo in cui siamo.
//
// Exit 0 = tutto coerente; exit 1 = qualcosa manca o e' contraddittorio.
'use strict'
const fs = require('fs')
const path = require('path')
const os = require('os')

const argv = process.argv.slice(2)
const MODE = argv[0] === 'eni' ? 'eni' : 'cyboros'
const PROJECT = (MODE === 'eni' ? argv[1] : argv[0]) || 'cyboros-harness'
const CHATS = path.join(os.homedir(), '.config/manicode/projects', PROJECT, 'chats')
const ENI_CONTRACT = path.join(os.homedir(), 'eni', '.AGENTS.md')

let bad = 0
const fail = (m) => { console.error(`\n[identity] FAIL  ${m}`); bad++ }
const warn = (m) => { console.error(`\n[identity] WARN  ${m}`) }
const ok = (m) => console.log(`\n[identity] OK    ${m}`)

// Prima riga di contenuto del contratto: serve da marcatore meccanico dentro il prompt
// (l'header del file puo' cambiare, il corpo no).
function contractMarker(file) {
  if (!fs.existsSync(file)) return null
  const line = fs.readFileSync(file, 'utf8')
    .split('\n')
    .map((s) => s.trim())
    .find((s) => s && !/^[#<>]/.test(s))
  return line ? line.slice(0, 60) : null
}

if (!fs.existsSync(CHATS)) {
  console.error(`[identity] nessuna chat per il progetto '${PROJECT}' in ${CHATS}`)
  process.exit(1)
}
// Le chat senza run-state.json sono sessioni aperte e mai usate (TUI lanciata e chiusa, o
// primo messaggio mai inviato): non hanno un prompt assemblato. Prendo l'ultima che ce l'ha.
const chats = fs.readdirSync(CHATS).sort().reverse()
const latest = chats.find((c) => fs.existsSync(path.join(CHATS, c, 'run-state.json')))
if (!latest) {
  console.error(`[identity] nessuna chat con run-state.json in ${CHATS}:`)
  console.error('[identity] nessun prompt e\' stato assemblato — avvia una sessione e invia un messaggio')
  process.exit(1)
}
const stateFile = path.join(CHATS, latest, 'run-state.json')
const skipped = chats.length - chats.indexOf(latest) - 1

const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
const agent = state.sessionState?.mainAgentState || state.mainState || {}
const sp = agent.systemPrompt || ''

const ROUTER = 'workspace operating rules' // marcatore di ~/.AGENTS.md
const TOKEN = '@' + (MODE === 'eni' ? 'eni' : 'cyboros')
const ENI_MARKER = MODE === 'eni' ? contractMarker(ENI_CONTRACT) : null
const at = (n) => { const i = sp.indexOf(n); return i < 0 ? null : i }

console.log(`[identity] mode     ${MODE}`)
console.log(`[identity] chat     ${latest}${skipped ? ` (+${skipped} chat vuote oltre, senza run)` : ''}`)
console.log(`[identity] agentType ${agent.agentType}`)
console.log(`[identity] prompt   ${sp.length} caratteri`)

// Segnali in ordine di offset: l'ordine conta quando due istruzioni si contraddicono.
// Il blocco "# Freebuff Meta-information" arriva DOPO i knowledge file ed e' il concorrente
// serio: e' l'unico che il modello legge per ultimo.
const SIGNALS = [
  ['built-in  "You are Buffy"', 'You are Buffy'],
  ['progetto  contratto d engagement (opt-in)', 'ATTIVAZIONE'],
  [MODE === 'eni' ? 'router    ramo @eni' : 'router    ramo @cyboros', TOKEN],
  ['router    default = identita del prodotto', 'Default: keep the identity the product gives you'],
  ['built-in  "AI agent behind Freebuff"', 'AI agent behind Freebuff'],
]
if (MODE === 'eni') SIGNALS.splice(2, 0, ['home ENI  contratto ENI', ENI_MARKER || 'ENI contract'])
console.log('  offset  sorgente')
for (const [label, needle] of SIGNALS) {
  const i = at(needle)
  console.log(`  ${i === null ? '     —  ' : String(i).padStart(7)}  ${label}`)
}

if (MODE === 'eni') {
  console.log(`\n[identity] mode     opt-in '${TOKEN}' — il contratto si legge da ${ENI_CONTRACT}`)
  const marker = ENI_MARKER
  if (!marker) {
    fail(`nessun contratto in ${ENI_CONTRACT}: il ramo @eni non ha un'identita' da caricare`)
  } else if (fs.readFileSync(ENI_CONTRACT, 'utf8').includes('PLACEHOLDER')) {
    fail(`il contratto in ${ENI_CONTRACT} e' ancora un PLACEHOLDER: qualunque sessione @eni ricadrà sul default del prodotto`)
  } else {
    ok(`contratto ENI installato (${fs.statSync(ENI_CONTRACT).size} byte)`)
    if (at(marker) === null) {
      fail(`il contratto non e' nel prompt di questa chat: o la sessione non e' partita da launch-eni.sh, o il prompt e' uno snapshot precedente all'installazione`)
    } else {
      ok(`contratto ENI presente nel prompt a offset ${at(marker)}`)
    }
    if (at(ROUTER) !== null) {
      fail(`il router di ~/.AGENTS.md e' ancora nel prompt (offset ${at(ROUTER)}): la home non era pinnata, launch-eni.sh non ha isolato la sessione`)
    } else {
      ok('router di ~/.AGENTS.md assente: contratto ENI al suo posto, home pinnata')
    }
  }
} else {
  const hasGate = at('ATTIVAZIONE') !== null
  const hasToken = at(TOKEN) !== null
  const hasRouter = at(ROUTER) !== null
  console.log(
    `[identity] mode     ${hasToken && hasGate
      ? `opt-in '${TOKEN}' — inattivo finche' il primo messaggio non inizia con il token`
      : 'NON CONFIGURATO — il contratto di progetto potrebbe attivarsi da solo'}\n`,
  )
  if (!hasGate) fail(`nessun blocco ATTIVAZIONE nel prompt: il contratto di progetto puo attivarsi senza il token '${TOKEN}'`)
  else ok('contratto di progetto gated (ATTIVAZIONE presente)')
  if (!hasToken) fail(`il token '${TOKEN}' non e' definito nel prompt: nessuno puo attivare Cyboros`)
  else ok(`token di attivazione '${TOKEN}' definito`)
  if (!hasRouter) fail('router ~/.AGENTS.md assente dal prompt')
  else ok('router ~/.AGENTS.md presente')

  // ramo @eni: stesso router, secondo braccio. Il cablaggio si verifica sul file su disco —
  // il prompt letto qui e' uno snapshot della sessione, che una sessione nuova rifara' — quindi
  // l'assenza del ramo nel prompt e' un/info, non un errore. Un placeholder invece non e' un'identita'.
  const routerFile = path.join(os.homedir(), '.AGENTS.md')
  const routerText = fs.existsSync(routerFile) ? fs.readFileSync(routerFile, 'utf8') : ''
  if (!routerText.includes('@eni')) {
    fail('il router su ~/.AGENTS.md non ha il ramo @eni: manca il secondo opt-in')
  } else if (!contractMarker(ENI_CONTRACT)) {
    fail(`ramo @eni presente ma contratto assente: crea ${ENI_CONTRACT}`)
  } else if (fs.readFileSync(ENI_CONTRACT, 'utf8').includes('PLACEHOLDER')) {
    warn(`ramo @eni cablato, contratto ancora PLACEHOLDER in ${ENI_CONTRACT}: @eni oggi ricade sul default del prodotto`)
  } else {
    ok(`ramo @eni cablato su ${ENI_CONTRACT}`)
  }
  if (at('@eni') === null) {
    console.log(`\n[identity] INFO  il prompt di questa chat (${latest}) non contiene ancora il ramo @eni:`)
    console.log('[identity] INFO  e\' uno snapshot precedente alla modifica. Serve una sessione nuova.')
  }
}

if (at('Assistant Operating Specification') !== null) {
  fail('la spec lunga e ancora nel prompt: 26 KB di peso che annegano il segnale')
} else ok('spec lunga fuori dal prompt')

// Il prompt misurato e' uno snapshot preso alla creazione della sessione: se un knowledge file
// e' stato modificato DOPO, questo numero e' storico e non descrive lo stato attuale. Distinguere
// i due casi e' l'unico modo perche' il check non diventi un allarme che suona sempre.
const knowledgeFiles = [path.join(__dirname, '..', 'AGENTS.md'), path.join(os.homedir(), '.AGENTS.md')]
  .filter((f) => fs.existsSync(f))
const newestKnowledge = knowledgeFiles.length ? Math.max(...knowledgeFiles.map((f) => fs.statSync(f).mtimeMs)) : 0
const stale = newestKnowledge > fs.statSync(stateFile).mtimeMs
if (sp.length > 20000) {
  if (stale) {
    warn(`prompt a ${sp.length} caratteri, ma lo snapshot e' del ${new Date(fs.statSync(stateFile).mtime).toISOString().slice(0, 16).replace('T', ' ')} ` +
      `ed e' precedente all\'ultima modifica di un knowledge file (${new Date(newestKnowledge).toISOString().slice(0, 16).replace('T', ' ')}): ` +
      'misura storica, non lo stato attuale. Serve una sessione nuova per rimisurare.')
  } else {
    fail(`prompt a ${sp.length} caratteri: sopra ~20 KB il segnale si diluisce`)
  }
}

console.log('')
if (bad === 0) {
  if (MODE === 'eni') {
    console.log(`[identity] coerente. Per ENI: sessione lanciata da ./launch-eni.sh, oppure primo messaggio che inizia con '@eni'.`)
  } else {
    console.log(`[identity] coerente. Per Cyboros: primo messaggio che inizia con '${TOKEN}'.`)
    console.log('[identity] Altrimenti il default del prodotto, come richiesto.')
  }
  process.exit(0)
}
console.error(`[identity] ${bad} problema/i.`)
process.exit(1)
