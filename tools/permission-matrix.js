#!/usr/bin/env node
// permission-matrix — campagna di autorizzazione multi-identità (BOLA/BFLA), artefatto Gate P1.
//
// Ogni endpoint viene ripetuto come ogni identità di `auth.json`: la matrice mostra chi vede cosa,
// e i candidati (stessa risorsa servita a un'identità diversa che non dovrebbe vederla) escono come
// `verify_level: 'suspected'`. NON registra finding: la registrazione è di `record-finding.js`,
// perché solo lì esiste il ceiling di severità e la disciplina dell'oracolo.
//
// Regole della casa, applicate qui:
//   - solo metodi sicuri (GET/HEAD/OPTIONS) di default; un metodo state-changing richiede
//     `--methods` esplicito **e** `--confirm "<motivo>"` (knowledge.md rule 2);
//   - ogni richiesta passa da `repeater.sendChain` (scope-guard + DNS-pin + identità), mai http nudo;
//   - un'identità che risolve a zero header NON diventa una richiesta anonima: è un errore
//     fail-closed (se vuoi il baseline anonimo, l'identità si chiama `anon` ed è esplicita);
//   - rate limit globale via `pace.waitAsync` sulla `max_requests_per_second` di scope.json.
//
// CLI:
//   node tools/permission-matrix.js --urls <file> | --map reports/<host>-map.json \
//        --identities user_a,user_b [--baseline user_a] [--methods GET,POST] [--confirm "<motivo>"] \
//        [--rps 2] [--out reports/permission-matrix.md]
'use strict';
const fs = require('fs');
const path = require('path');

const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];
const ALL_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

// Endpoint da un file (una riga per endpoint: `METHOD url` oppure `url` = GET) o dal target model.
function loadEndpoints({ urlsFile, mapFile }) {
  const out = [];
  if (urlsFile) {
    const text = fs.readFileSync(urlsFile, 'utf8');
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const m = line.match(/^([A-Za-z]+)\s+(\S+)$/);
      if (m) out.push({ method: m[1].toUpperCase(), url: m[2] });
      else out.push({ method: 'GET', url: line });
    }
  }
  if (mapFile) {
    const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
    for (const e of map.endpoints || []) {
      const url = e.url || e.path;
      if (!url) continue;
      out.push({ method: String(e.method || 'GET').toUpperCase(), url });
    }
  }
  const seen = new Set();
  return out.filter((e) => {
    const k = `${e.method} ${e.url}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function similarity(a, b) {
  return require('./repeater').similarity(a, b);
}

// `exec` è iniettabile: è ciò che rende questa campagna testabile offline, senza mai toccare un
// target. Contratto: exec({ method, url, headers }) → { status, body, blocked?, error? }.
async function buildMatrix({ endpoints, identities, baseline, exec, rps, pace }) {
  if (!Array.isArray(endpoints) || !endpoints.length) throw new Error('no endpoints to test');
  if (!Array.isArray(identities) || !identities.length) throw new Error('no identities to test');
  const base = baseline || identities[0];
  if (!identities.includes(base)) throw new Error(`--baseline "${base}" is not among the identities`);
  const rows = [];
  const candidates = [];
  const errors = [];
  const cache = new Map();
  const cellOf = async (ep, ident) => {
    const k = `${ep.method} ${ep.url}|${ident}`;
    if (!cache.has(k)) {
      if (rps && pace && typeof pace.waitAsync === 'function') await pace.waitAsync(rps);
      try {
        cache.set(k, await exec({ method: ep.method, url: ep.url, headers: ident }));
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        cache.set(k, { status: 0, body: '', error: msg });
        errors.push({ cell: k, error: msg });
      }
    }
    return cache.get(k);
  };
  for (const ep of endpoints) {
    const b = await cellOf(ep, base);
    const row = { method: ep.method, url: ep.url, cells: {} };
    for (const ident of identities) {
      const r = await cellOf(ep, ident);
      const sim = ident === base ? 1 : similarity(b.body || '', r.body || '');
      const cell = { status: r.status, bytes: (r.body || '').length, similarity: sim };
      if (r.blocked) cell.blocked = true;
      if (r.error) cell.error = r.error;
      if (ident !== base && r.status === 200 && b.status === 200 && sim >= 0.9) {
        cell.flag = 'same-content';
      }
      row.cells[ident] = cell;
      if (ident === base || r.blocked || r.status !== 200) continue;
      if (r.status === 200 && b.status === 200 && sim >= 0.9)
        candidates.push({ type: 'bola', method: ep.method, url: ep.url, baseline: base, identity: ident, similarity: sim, verify_level: 'suspected' });
      if (/(admin|manage|internal)/i.test(ep.url))
        candidates.push({ type: 'bfla', method: ep.method, url: ep.url, baseline: base, identity: ident, similarity: sim, verify_level: 'suspected' });
    }
    rows.push(row);
  }
  return { rows, candidates, errors, baseline: base, identities, generated_at: new Date().toISOString() };
}

function renderMarkdown(m) {
  const head = `| endpoint | ${m.identities.join(' | ')} |`;
  const sep = `|---|${m.identities.map(() => '---').join('|')}|`;
  const lines = m.rows.map((r) => {
    const cells = m.identities.map((i) => {
      const c = r.cells[i];
      if (!c) return 'n/a';
      if (c.blocked) return 'BLOCKED';
      return `${c.status} (${c.bytes}B)${c.flag ? ' !' : ''}`;
    });
    return `| ${r.method} ${r.url} | ${cells.join(' | ')} |`;
  });
  const cand = m.candidates.length
    ? m.candidates.map((c) => `- **${c.type.toUpperCase()}** ${c.method} ${c.url} — \`${c.identity}\` vs baseline \`${c.baseline}\` (similarity ${c.similarity.toFixed(2)}) — suspected, da verificare e registrare con record-finding.js`).join('\n')
    : '- nessun candidato';
  const errs = m.errors.length ? `\n## Errori per cella\n${m.errors.map((e) => `- ${e.cell}: ${e.error}`).join('\n')}\n` : '';
  return `# permission-matrix\n\nBaseline: \`${m.baseline}\` · identità: ${m.identities.map((i) => `\`${i}\``).join(', ')} · ${m.generated_at}\n\n`
    + `Legenda: \`status (bytes)\`, \`!\` = stesso contenuto di un'identità che non dovrebbe vederlo, BLOCKED = rifiutato dallo scope-guard.\n\n`
    + `${head}\n${sep}\n${lines.join('\n')}\n\n## Candidati (suspected)\n${cand}\n${errs}`;
}

// ── CLI ──

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--urls') o.urls = argv[++i];
    else if (a === '--map') o.map = argv[++i];
    else if (a === '--identities') o.identities = argv[++i];
    else if (a === '--baseline') o.baseline = argv[++i];
    else if (a === '--methods') o.methods = argv[++i];
    else if (a === '--confirm') o.confirm = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--rps') o.rps = argv[++i];
    else o._.push(a);
  }
  return o;
}

// Exec reale: repeater (scope + DNS-pin) con gli header dell'identità risolti una volta sola.
// `anon` è l'unica identità senza header, ed è esplicita.
function makeExec(scope) {
  const cache = new Map();
  return async ({ method, url, headers: ident }) => {
    const rep = require('./repeater');
    if (!cache.has(ident)) {
      if (ident === 'anon') cache.set(ident, []);
      else {
        const h = await rep.resolveIdentity(ident);
        if (!h || !h.length) throw new Error(`identity '${ident}' resolved to no headers — refusing to send an anonymous request (use the explicit 'anon' identity if that is what you mean)`);
        cache.set(ident, h);
      }
    }
    const headerMap = {};
    for (const h of ['User-Agent: ' + rep.DEFAULT_UA, ...cache.get(ident), 'Accept-Encoding: identity']) {
      const i = h.indexOf(':');
      if (i > 0) headerMap[h.slice(0, i).trim()] = h.slice(i + 1).trim();
    }
    const res = await rep.sendChain(url, method, () => Object.assign({}, headerMap), null,
      { timeout: 10000, showBody: true, follow: false }, scope);
    if (res.blocked) return { blocked: true, status: 0, body: '', reason: res.reason };
    return res;
  };
}

async function main(argv) {
  const cli = parseArgs(argv);
  if ((!cli.urls && !cli.map) || !cli.identities) {
    console.error('usage: node tools/permission-matrix.js --urls <file> | --map <map.json> --identities <a,b> [--baseline a] [--methods GET,POST] [--confirm "<motivo>"] [--rps N] [--out reports/permission-matrix.md]');
    return 2;
  }
  const methods = (cli.methods ? String(cli.methods).split(',') : ['GET']).map((m) => m.trim().toUpperCase()).filter(Boolean);
  const bad = methods.filter((m) => !ALL_METHODS.includes(m));
  if (bad.length) { console.error(`unknown method(s): ${bad.join(',')}`); return 2; }
  const stateChanging = methods.filter((m) => !SAFE_METHODS.includes(m));
  if (stateChanging.length && !cli.confirm) {
    console.error(`refusing ${stateChanging.join(',')} without --confirm "<reason>": state-changing requests are confirm-tier (knowledge.md rule 2)`);
    return 2;
  }
  const endpoints = loadEndpoints({ urlsFile: cli.urls, mapFile: cli.map }).filter((e) => methods.includes(e.method));
  if (!endpoints.length) { console.error(`no endpoints matching methods ${methods.join(',')}`); return 2; }
  const identities = String(cli.identities).split(',').map((s) => s.trim()).filter(Boolean);
  const scope = require('./scope-guard').loadScope();
  const rps = cli.rps ? Number(cli.rps) : (scope && scope.max_requests_per_second);
  const matrix = await buildMatrix({
    endpoints, identities, baseline: cli.baseline, rps,
    pace: require('./pace'), exec: makeExec(scope),
  });
  const md = renderMarkdown(matrix);
  const out = cli.out || path.join(__dirname, '..', 'reports', 'permission-matrix.md');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, md);
  fs.writeFileSync(out.replace(/\.md$/, '.json'), JSON.stringify(matrix, null, 2));
  console.log(JSON.stringify({
    ok: true, out, endpoints: matrix.rows.length, identities: matrix.identities,
    candidates: matrix.candidates.length, bola: matrix.candidates.filter((c) => c.type === 'bola').length,
    bfla: matrix.candidates.filter((c) => c.type === 'bfla').length, errors: matrix.errors.length,
  }));
  return 0;
}

module.exports = { loadEndpoints, buildMatrix, renderMarkdown, parseArgs, makeExec, SAFE_METHODS, ALL_METHODS };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code || 0))
    .catch((e) => { console.error(e && e.message ? e.message : String(e)); process.exit(1); });
}
