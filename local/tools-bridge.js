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
      description: 'Registra un finding (dedup, hash-chain). Campi: severity,title,host,endpoint,poc,status; opz. cvss,cvss_vector,cwe,remediation,verify_level,oracle,evidence_quote. Per status confirmed servono DUE prove: (1) oracle meccanico da `node tools/oracle.js record {json} <host>` → passa {type,ref,token}; (2) evidence_quote {file,text} dove text è una sottostringa ESATTA di un file che hai scritto in reports/ con write_file (es. la risposta HTTP grezza). Senza entrambe resta un\'ipotesi: usa status inconclusive.',
      parameters: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['Info', 'Low', 'Medium', 'High', 'Critical'] },
          title: { type: 'string' }, host: { type: 'string' }, endpoint: { type: 'string' },
          poc: { type: 'string' }, status: { type: 'string', enum: ['suspected', 'confirmed', 'verified'] },
          verify_level: { type: 'string', enum: ['suspected', 'triggered', 'exploited', 'proven_impact'] },
          cvss: { type: 'number' }, cvss_vector: { type: 'string' }, cwe: { type: 'string' }, remediation: { type: 'string' },
          oracle: {
            type: 'object',
            description: 'Oracolo meccanico verificato su disco. Obbligatorio per status confirmed/verified: senza, il finding resta ipotesi (inconclusive).',
            properties: {
              type: { type: 'string', enum: ['oob', 'http-diff', 'console', 'script'] },
              ref: { type: 'string', description: 'es. reports/tmp/oracle-log.jsonl#51 oppure artifacts/oracle/<f>.json' },
              token: { type: 'string', description: 'token printable ASCII 8..256 char usato quando l\'oracolo è stato registrato' },
            },
            required: ['type', 'ref', 'token'],
          },
          evidence_quote: {
            type: 'object',
            description: 'Prova letterale: text deve essere una sottostringa byte-per-byte di file (workspace-relative). Obbligatorio per status confirmed/verified. Salva prima la risposta grezza in reports/ con write_file.',
            properties: {
              file: { type: 'string', description: 'path relativo al workspace, es. reports/demo/bola-evidence.txt' },
              text: { type: 'string', description: 'estratto esatto (max 64 KB) copiato dal file, non parafrasato' },
            },
            required: ['file', 'text'],
          },
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
  {
    type: 'function',
    function: {
      name: 'findings_query',
      description: 'Interroga il ledger dei finding (quello attivo, FINDINGS_JSONL compreso) per host, severità o stato. Read-only: usalo per domande sui finding già registrati.',
      parameters: {
        type: 'object',
        properties: {
          host: { type: 'string', description: 'substring dell\'host, opzionale' },
          severity: { type: 'string', enum: ['Info', 'Low', 'Medium', 'High', 'Critical'] },
          status: { type: 'string', description: 'substring di status/verify_level, es. confirmed o triggered' },
          limit: { type: 'number', description: 'default 10, max 50' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'sessions_list',
      description: 'Elenca le sessioni agent salvate (id, data, host, fase, modello). Read-only: usalo per domande sulle run precedenti.',
      parameters: { type: 'object', properties: { limit: { type: 'number', description: 'default 10, max 50' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'session_read',
      description: 'Legge meta e ultimi eventi di una sessione agent (tool call, risultati, fine run). Read-only.',
      parameters: { type: 'object', properties: { id: { type: 'string' }, limit: { type: 'number', description: 'eventi finali, default 20, max 200' } }, required: ['id'] },
    },
  },
];

// ---- read-only interrogation of the engagement state -----------------------------
const clampLimit = (v, def, max) => Math.max(1, Math.min(Number.isFinite(Number(v)) ? Number(v) : def, max));
const oneLine = (s, n = 140) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

function findingsPath() {
  return process.env.FINDINGS_JSONL || path.join(WS, 'reports', 'findings.jsonl');
}

function findingsQuery(args = {}) {
  const file = findingsPath();
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return `nessun ledger leggibile: ${path.relative(WS, file)}`; }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* una riga rotta non ferma la query */ }
  }
  const host = String(args.host || '').toLowerCase();
  const sev = args.severity ? String(args.severity).toLowerCase() : '';
  const status = String(args.status || '').toLowerCase();
  let hits = rows.filter((f) => {
    if (host && !String(f.host || '').toLowerCase().includes(host)) return false;
    if (sev && String(f.severity || '').toLowerCase() !== sev) return false;
    if (status) {
      const s = `${f.status || ''} ${f.verify_level || ''}`.toLowerCase();
      if (!s.includes(status)) return false;
    }
    return true;
  });
  if (!hits.length) return `0 finding in ${path.relative(WS, file)} per i filtri richiesti`;
  hits = hits.slice(-clampLimit(args.limit, 10, 50));
  const lines = hits.map((f) => [
    String(f.severity || '?').toUpperCase(),
    oneLine(f.title, 120),
    oneLine(f.endpoint || f.host, 80),
    `${f.status || '?'}/${f.verify_level || '?'}`,
    oneLine(f.host, 60),
    f.oracle ? `oracle ${oneLine(f.oracle.ref, 80)}` : 'no oracle',
  ].join(' | '));
  return `${hits.length} finding · ${path.relative(WS, file)}\n${lines.join('\n')}`;
}

function sessionsRoot() {
  return process.env.CYBOROS_AGENT_DIR || process.env.CYBOROS_SESSIONS_DIR
    || path.join(WS, 'reports', 'agent', 'sessions');
}

function sessionsList(args = {}) {
  const root = sessionsRoot();
  let ids;
  try { ids = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return `nessuna directory sessioni: ${path.relative(WS, root)}`; }
  const rows = [];
  for (const id of ids) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(root, id, 'meta.json'), 'utf8'));
      rows.push({ id, meta });
    } catch { /* una sessione senza meta non è interrogabile */ }
  }
  if (!rows.length) return 'nessuna sessione con meta.json';
  rows.sort((a, b) => String(b.meta.started_at || '').localeCompare(String(a.meta.started_at || '')));
  const out = rows.slice(0, clampLimit(args.limit, 10, 50)).map(({ id, meta }) => [
    id,
    meta.started_at || '?',
    meta.host || '?',
    meta.phase || '?',
    `${meta.profile || '?'}/${meta.model || '?'}`,
  ].join(' · '));
  return `${rows.length} sessioni · ${path.relative(WS, root)}\n${out.join('\n')}`;
}

function sessionRead(args = {}) {
  const id = String(args.id || '');
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id === '.' || id === '..') return `id sessione non valido: ${id}`;
  const dir = path.join(sessionsRoot(), id);
  const metaFile = path.join(dir, 'meta.json');
  const evFile = path.join(dir, 'events.jsonl');
  let meta;
  try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch { return `sessione non trovata: ${id}`; }
  let events = [];
  try {
    events = fs.readFileSync(evFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { /* meta-only session */ }
  const n = clampLimit(args.limit, 20, 200);
  const tail = events.slice(-n).map((e) => {
    const what = e.type === 'tool_call' ? `${e.tool}(${oneLine(JSON.stringify(e.args || {}), 80)})`
      : e.type === 'tool_result' ? oneLine(e.summary, 120)
        : e.type === 'assistant' ? oneLine(e.content, 120)
          : e.type === 'user' ? oneLine(e.content, 120)
            : e.type === 'run_end' ? `status=${e.status}` : '';
    return `${String(e.ts || '').slice(11, 19)} ${e.type}${what ? ' ' + what : ''}`.trim();
  });
  return `session ${id} · ${meta.started_at || '?'} · host ${meta.host || '?'} · ${meta.phase || '?'} · ${meta.profile || '?'}/${meta.model || '?'}\n`
    + `${events.length} eventi, ultimi ${tail.length}:\n${tail.join('\n')}`;
}

// ---- dispatch ---------------------------------------------------------------------
function safeReportPath(p) {
  const abs = path.resolve(WS, p);
  if (!abs.startsWith(path.resolve(WS, 'reports') + path.sep)) throw new Error('consentito solo sotto reports/');
  return abs;
}

function makeDispatch({ allowRunTool = true, noCache = false } = {}) {
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
        const r = nodeTool('run.js', [...(noCache ? ['--no-cache'] : []), bin, ...a], { timeout: 1800000 });
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
      case 'findings_query': return findingsQuery(args);
      case 'sessions_list': return sessionsList(args);
      case 'session_read': return sessionRead(args);
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
