// local/tools-bridge.js — ponte tra il modello locale e il motore deterministico (tools/*.js).
// Espone un set RIDOTTO e sicuro di tool (function-calling OpenAI) per un modello debole:
// pochi tool, nomi chiari, ognuno instrada verso un entrypoint GIA' guardato (scope-guard è
// hard-enforced dentro run.js / repeater.js — qui non lo bypassiamo mai).
// Zero dipendenze esterne.

'use strict';
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const WS = path.join(__dirname, '..');

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: WS, encoding: 'utf8', timeout: opts.timeout ?? 600000, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, ...(opts.env || {}) },
  });
  const out = [r.stdout, r.stderr].filter(Boolean).join('\n').trim();
  const code = r.status == null ? 1 : r.status;
  return { code, out: out || (r.error ? String(r.error.message) : '') };
}
const nodeTool = (rel, args, opts) => sh(process.execPath, [path.join('tools', rel), ...args], opts);

// ---- schema tool esposti al modello (OpenAI function-calling) --------------------
const SCHEMA = [
  {
    type: 'function',
    function: {
      name: 'scope_check',
      description: 'Verifica se un URL/host è autorizzato in scope.json. USALO PRIMA di toccare qualunque target. Ritorna "IN SCOPE" o "OUT OF SCOPE".',
      parameters: { type: 'object', properties: { target: { type: 'string', description: 'url o host' } }, required: ['target'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Legge un file del workspace (es. reports/<host>-map.json, reports/findings.jsonl). Percorso relativo alla root del progetto.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Scrive un file intermedio sotto reports/ (mai fuori da reports/). Usa per salvare mappe/note e tenere il contesto piccolo.',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'deve iniziare con reports/' }, content: { type: 'string' } }, required: ['path', 'content'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pipeline',
      description: 'Esegue la pipeline deterministica Kali su un host in scope: recon | scan | enumerate. Preferiscila ai tool a mano.',
      parameters: { type: 'object', properties: { phase: { type: 'string', enum: ['recon', 'scan', 'enumerate'] }, host: { type: 'string' } }, required: ['phase', 'host'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_tool',
      description: 'Esegue un binario di terze parti SOLO tramite il wrapper guardato (scope+rate enforced): httpx, nuclei, ffuf, sqlmap, curl, nmap, ecc. Passa bin e args separati.',
      parameters: { type: 'object', properties: { bin: { type: 'string' }, args: { type: 'array', items: { type: 'string' } } }, required: ['bin'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'record_finding',
      description: 'Registra un finding verificato (dedup, hash-chain). Campi: severity,title,host,endpoint,poc,status; opz. cvss,cvss_vector,cwe,remediation,verify_level.',
      parameters: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['Info', 'Low', 'Medium', 'High', 'Critical'] },
          title: { type: 'string' }, host: { type: 'string' }, endpoint: { type: 'string' },
          poc: { type: 'string' }, status: { type: 'string', enum: ['suspected', 'confirmed', 'verified'] },
          verify_level: { type: 'string', enum: ['suspected', 'triggered', 'exploited', 'proven_impact'] },
          cvss: { type: 'number' }, cvss_vector: { type: 'string' }, cwe: { type: 'string' }, remediation: { type: 'string' },
        },
        required: ['severity', 'title', 'host', 'poc', 'status'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'kb_search',
      description: 'Cerca nella metodologia/knowledge base locale (docs/, refs/) una parola chiave. Usa invece di leggere file interi.',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_recall',
      description: 'Richiama lezioni cross-engagement dalla memoria RAG locale per "<stack> <classe>". Chiamalo prima di testare una superficie.',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
  },
];

// ---- dispatch ---------------------------------------------------------------------
function safeReportPath(p) {
  const abs = path.resolve(WS, p);
  if (!abs.startsWith(path.resolve(WS, 'reports') + path.sep)) throw new Error('consentito solo sotto reports/');
  return abs;
}

function makeDispatch({ allowRunTool = true } = {}) {
  return async function dispatch(name, args = {}) {
    switch (name) {
      case 'scope_check': {
        const r = nodeTool('scope-guard.js', ['check', String(args.target || '')]);
        return r.code === 0 ? `IN SCOPE: ${args.target}` : `OUT OF SCOPE / BLOCCATO: ${args.target}\n${r.out}`;
      }
      case 'read_file': {
        const abs = path.resolve(WS, String(args.path || ''));
        if (!abs.startsWith(path.resolve(WS) + path.sep)) return 'ERRORE: percorso fuori dal workspace';
        if (!fs.existsSync(abs)) return `ERRORE: file non trovato: ${args.path}`;
        return fs.readFileSync(abs, 'utf8');
      }
      case 'write_file': {
        const abs = safeReportPath(String(args.path || ''));
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, String(args.content ?? ''));
        return `scritto: ${args.path} (${String(args.content ?? '').length} char)`;
      }
      case 'pipeline': {
        const phase = String(args.phase || '');
        if (!['recon', 'scan', 'enumerate'].includes(phase)) return 'ERRORE: phase deve essere recon|scan|enumerate';
        const r = nodeTool('cyboros.js', [phase, String(args.host || '')], { timeout: 1800000 });
        return `[pipeline ${phase} exit ${r.code}]\n${r.out}`;
      }
      case 'run_tool': {
        if (!allowRunTool) return 'ERRORE: run_tool disabilitato in questa fase';
        const bin = String(args.bin || '');
        const a = Array.isArray(args.args) ? args.args.map(String) : [];
        // Modello debole: se passa una stringa di shell al posto di {bin,args} NON eseguiamo
        // nulla (niente shell: il wrapper guardato vuole argv separati) ma restituiamo un
        // errore CORRETTIVO con la forma giusta, così il giro dopo chiama bene.
        if (!bin) {
          const wrong = args.command || args.cmd || args.shell || args.raw;
          if (wrong) {
            return 'ERRORE: manca "bin". Uso corretto: '
              + '{"bin":"nmap","args":["-sV","-p","80","<host>"]} — bin e args SEPARATI, '
              + 'niente stringhe di shell.'
              + `\nPer la pipeline usa invece il tool "pipeline": {"phase":"recon","host":"<host>"}.`;
          }
          return 'ERRORE: bin mancante. Forma attesa: {"bin":"<tool>","args":["<arg1>","<arg2>"]}.';
        }
        const r = nodeTool('run.js', [bin, ...a], { timeout: 1800000 });
        return `[run ${bin} exit ${r.code}]\n${r.out}`;
      }
      case 'record_finding': {
        const r = nodeTool('record-finding.js', [JSON.stringify(args)]);
        return `[record-finding exit ${r.code}]\n${r.out}`;
      }
      case 'kb_search': {
        const r = nodeTool('kb-search.js', [String(args.query || '')]);
        return r.out || '(nessun risultato)';
      }
      case 'memory_recall': {
        const r = nodeTool('memory-recall.js', [String(args.query || '')]);
        return r.out || '(memoria vuota)';
      }
      default:
        return `ERRORE: tool sconosciuto "${name}". Ammessi: ${SCHEMA.map((t) => t.function.name).join(', ')}.`;
    }
  };
}

// Sottoinsieme dello schema per nome (fasi diverse espongono tool diversi).
function schemaFor(names) {
  return SCHEMA.filter((t) => names.includes(t.function.name));
}

module.exports = { SCHEMA, schemaFor, makeDispatch, nodeTool, sh };
