// local/agents-local/index.js — agenti di FASE consolidati per l'edizione locale.
// I 28 agenti cloud sono collassati in 5 fasi, con prompt corti adatti a un modello ~3B attivi.
// Ogni agente: { id, tools:[nomi], system, task(ctx) }.

const { systemFor } = require('./_shared');

const AGENTS = {
  'recon-map': {
    id: 'recon-map',
    tools: ['scope_check', 'pipeline', 'run_tool', 'read_file', 'write_file', 'kb_search'],
    system: systemFor(
      'RUOLO: Recon + Mapping. Scopri la superficie d\'attacco di un host e produci una mappa di endpoint/parametri per classe di vulnerabilità. NON testare vulnerabilità qui.'),
    task: (ctx) => [
      `Host in scope: ${ctx.host}`,
      '1) scope_check sull\'host.',
      '2) Chiama il tool "pipeline" con args ESATTI {"phase":"recon","host":"' + ctx.host + '"}.',
      '   Poi, se serve, {"phase":"enumerate","host":"' + ctx.host + '"}.',
      '   Usa SOLO il tool "pipeline" per la pipeline. Se usi run_tool, passa bin e args SEPARATI',
      '   (es. {"bin":"httpx","args":["-u","https://host"]}); una stringa di shell viene rifiutata.',
      '3) Leggi l\'output della pipeline (reports/state.db è già popolato) e i bundle JS con run_tool.',
      `4) Scrivi con write_file una mappa compatta in reports/${ctx.host}-map.json: elenco endpoint, parametri, form, ruoli, e per ogni endpoint le classi candidate (sqli/xss/authz/authn/csrf/ssrf/injection/cloud/llm).`,
      'FINAL: 5-10 righe con sottodomini vivi, stack/tech, e gli endpoint ad alto valore da testare.',
    ].join('\n'),
  },

  'web-test': {
    id: 'web-test',
    tools: ['scope_check', 'run_tool', 'read_file', 'write_file', 'record_finding', 'memory_recall', 'kb_search'],
    system: systemFor(
      'RUOLO: Web testing per classe. Verifica UNA classe di vulnerabilità per volta sugli endpoint candidati, con prova a impatto minimo (marker benigni). Registra solo finding verificati.'),
    task: (ctx) => [
      `Host: ${ctx.host}. Classe da testare: ${ctx.klass || 'auto (scegli dalla mappa)'}.`,
      `1) read_file reports/${ctx.host}-map.json per gli endpoint+parametri candidati.`,
      '2) memory_recall "<stack> <classe>" per tecniche già note.',
      '3) scope_check, poi verifica la classe con run_tool (es. sqlmap/httpx/nuclei/curl) usando un MARKER benigno e un confronto baseline (dovere di falso-positivo).',
      '4) Per ogni conferma: record_finding con verify_level onesto (suspected/triggered/exploited/proven_impact), poc = pacchetto richiesta/risposta minimale, cwe e remediation.',
      'FINAL: elenco dei finding registrati con classe e livello di verifica.',
    ].join('\n'),
  },

  host: {
    id: 'host',
    tools: ['scope_check', 'run_tool', 'read_file', 'write_file', 'record_finding', 'kb_search'],
    system: systemFor(
      'RUOLO: Host/network exploitation. Solo se l\'ingaggio lo include. breach -> post-exploitation in lettura. Lateral movement / persistence / azioni distruttive richiedono conferma esplicita in-sessione dell\'operatore (non procedere senza).'),
    task: (ctx) => [
      `Target host: ${ctx.host}. Obiettivo: ${ctx.objective || 'accesso iniziale + enumerazione post-exploit in lettura'}.`,
      '1) scope_check. 2) pipeline scan <host> se non già fatto (porte/servizi).',
      '3) Sfrutta solo servizi in scope, con prova a impatto minimo (whoami/pwd/id, mai comandi in scrittura o distruttivi).',
      '4) record_finding per ogni accesso/vuln provata, con poc riproducibile.',
      'Se un passo è lateral/persist/distruttivo: FERMATI e chiedi conferma esplicita nel FINAL, non eseguirlo.',
      'FINAL: cosa è stato provato, con quale livello di verifica, e quali azioni intrusive attendono conferma.',
    ].join('\n'),
  },

  wireless: {
    id: 'wireless',
    tools: ['scope_check', 'run_tool', 'read_file', 'write_file', 'record_finding', 'kb_search'],
    system: systemFor(
      'RUOLO: superficie wireless/hardware/mobile. Scope wireless è separato (wifi-scope.json). Azioni tier "confirm" (deauth/capture/rogue_ap/...) richiedono --confirm + approvazione in-sessione: non eseguirle da solo.'),
    task: (ctx) => [
      `Target: ${ctx.host || ctx.bssid || '(vedi wifi-scope.json / mobile-scope.json)'}.`,
      '1) scope_check (o wifi-guard per BSSID). 2) Ricognizione passiva prima di tutto.',
      '3) Solo azioni auto-tier (scan/sniff) senza conferma; per il resto chiedi conferma nel FINAL.',
      '4) record_finding con host=BSSID/package, endpoint=ESSID/activity, poc riproducibile.',
      'FINAL: superficie osservata e azioni che richiedono approvazione.',
    ].join('\n'),
  },

  report: {
    id: 'report',
    tools: ['read_file', 'write_file', 'record_finding', 'kb_search'],
    system: systemFor(
      'RUOLO: verifica finale + report. Prima consolida e ri-verifica i finding a singola richiesta; poi scrivi un report leggibile. Non gonfiare le severity oltre il livello di verifica.'),
    task: (ctx) => [
      `Host: ${ctx.host}.`,
      '1) read_file reports/findings.jsonl e reports/coverage-matrix.md.',
      '2) Rimuovi falsi positivi e coerenzia severity <= livello di verifica.',
      `3) write_file un report Markdown in reports/${ctx.host}-report-local.md: sommario esecutivo, findings (severity, cvss, cwe, poc redatto, remediation), e le catene rilevanti.`,
      'FINAL: percorso del report e conteggio findings per severity.',
    ].join('\n'),
  },
};

function getAgent(id) {
  return AGENTS[id] || null;
}

module.exports = { AGENTS, getAgent };
