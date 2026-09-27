# Offensive Batch 2 — Implementation Plan (6 workstream)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sei capacità offensive indipendenti per l'harness: matrice permessi multi-identità (Gate P1), ingest OpenAPI/Swagger, wordlist adattive dal target, fingerprint WAF cablato nel recon, pacchetto di consegna firmato, workflow AD roast→crack.

**Architecture:** Ogni workstream è un tool standalone zero-dep (o un wiring minimo) che segue la disciplina della casa: scope-guard fail-closed per ciò che tocca target, runner iniettabili per i test offline, output deterministico su `reports/`. Gli workstream sono **indipendenti e ordinabili liberamente** (unico vincolo: WS2 alimenta WS1; WS4 è standalone). Ogni workstream produce software testabile da solo.

**Tech Stack:** Node.js ≥ 22 stdlib (`node:fs`, `node:path`, `node:crypto`, `node:child_process`) — zero npm deps, come tutto il repo. Moduli esistenti riusati: `tools/repeater.js`, `tools/scope-guard.js`, `tools/pace.js`, `tools/privacy.js`, `tools/target-model.js`, `tools/parsers.js`, `tools/stavros.js`, `tools/ad.js` (tutte API verificate sotto).

**Spec:** nessun documento separato — questo piano è la fonte (l'operatore ha richiesto "solo il piano per tutti e 6" il 2026-09-26; l'implementazione partirà su sua esplicita richiesta).

## Global Constraints

- Zero dipendenze npm; solo stdlib Node (regola del repo: `tools/` zero-dep).
- Ogni richiesta verso un target passa da `repeater.sendChain` (scope + DNS-pin + identità) o da `tools/run.js`/wrapper con guard: mai `http.request` nudo.
- Test offline e deterministici in `tools/test-*.js` (auto-scoperti da `tools/run-tests.js`); nessun test tocca la rete.
- Rate: rispettare `max_requests_per_second` di `scope.json` tramite `pace.waitAsync`.
- Secrets: mai in argv/stdout/log — solo loot vault e header risolti via `repeater.resolveIdentity`.
- Nomi canonici degli artefatti del playbook non negoziabili: `permission-matrix.md`, `assets.md`, `coverage-matrix.md`.
- **Nessun commit autonomo**: a fine task lasciare le modificate non committate e riepilogare (regola workspace §3).
- A fine ogni workstream: `node tools/run-tests.js` verde tranne il noto `test-cc-routes` (porta 8787, ambientale).

## Review Focus

1. **Identità `login` (token dinamico)** — una matrice deve risolvere header freschi per ogni run; un mock con identità `login` deve fallire "chiuso" se il login fallisce, non mandare richieste anonime. → test WS1.
2. **Endpoint con tutte le risposte uguali (404/403 su ogni identità)** — deve rendere `N-A`, mai un candidato BOLA. → test WS1.
3. **OpenAPI con `$ref`/parametri condivisi/swagger 2.0** — il parser non crasha e non inventa endpoint: input degradato → lista vuota (fail-soft come tutti i `parse*`). → test WS2.
4. **Wordgen su bundle minificato/binario** — il tokenizer non emette token spazzatura (len > 64, non-printable) e l'output è deterministico. → test WS3.
5. **`wafw00f` assente dalla macchina** — il recon degrada a `WAF-UNKNOWN` senza fallire la pipeline (stessa disciplina "Mancano? Salta"). → test WS4.
6. **`report-pack verify` dopo modifica di un file impacchettato** — exit ≠ 0 e nome del file manomesso. → test WS5.

---

### Task 1 (WS1): `permission-matrix.js` — campagna authz multi-identità

**Files:**
- Create: `tools/permission-matrix.js`
- Test: `tools/test-permission-matrix.js`
- Modify: `docs/methodology-classes.md` (bullet BOLA/BFLA: puntare al tool)

**Interfaces:**
- Consumes: `repeater.resolveIdentity(name: string): Promise<string[]>` (header list), `repeater.sendChain(target, method, headersFn, body, opts, scope, proxy): Promise<{status, body, headers, blocked?}>`, `repeater.similarity(a: string, b: string): number`, `scope-guard.loadScope()`, `pace.waitAsync(rps)`.
- Produces:
  - `loadEndpoints({ urlsFile?, mapFile? }): Array<{ method: string, url: string }>` — da file riga-per-riga (`METHOD url` o `url` = GET) oppure da `reports/<host>-map.json` (chiave `endpoints`).
  - `async function buildMatrix({ endpoints, identities, baseline, exec }): Promise<{ rows, candidates, errors }>` — `exec` è iniettabile: `exec({ url, method, headers }) => Promise<{ status, body }>`; default = `sendChain` con scope caricato.
  - `renderMarkdown(matrix): string` — tabella endpoint × identità + sezione candidati.
  - CLI: `node tools/permission-matrix.js --urls <f> | --map <map.json> --identities user_a,user_b [--baseline user_a] [--out reports/permission-matrix.md] [--confirm "<reason>"]`

**Comportamento chiave:**
- Solo `GET` di default; metodi state-changing richiedono `--confirm` + elenco esplicito in `--methods` (knowledge.md rule 2).
- Cell = `status (bytes)`; se status 200 su identità ≠ baseline e `similarity(body, baseline) >= 0.9` → cell marcata `⚠ same-content` e riga entra in `candidates` come BOLA (`verify_level: 'suspected'`, non registrata: l'agente registra).
- BFLA hint: path che matcha `/(admin|manage|internal)/` risposto 200 da identità low-priv → candidato `bfla`.
- Rate-limit: `pace.waitAsync` prima di ogni `exec` usando `scope.max_requests_per_second` (fallback 2).

- [ ] **Step 1: test fallito — matrice base su exec finto**

```js
// tools/test-permission-matrix.js
'use strict';
const assert = require('assert');
const pm = require('./permission-matrix');

(async () => {
  const endpoints = [{ method: 'GET', url: 'https://t.test/api/user/1' }, { method: 'GET', url: 'https://t.test/api/admin/list' }];
  const exec = async ({ url, headers }) => headers.includes('X-User: a')
    ? { status: 200, body: 'PERSONAL-DATA-A' }
    : { status: url.includes('admin') ? 200 : 403, body: url.includes('admin') ? 'PERSONAL-DATA-A' : 'no' };
  const m = await pm.buildMatrix({
    endpoints,
    identities: ['X-User: a', 'X-User: b'],
    baseline: 'X-User: a',
    exec,
  });
  assert.strictEqual(m.rows.length, 2);
  assert.ok(m.candidates.some((c) => c.type === 'bola' && c.url.includes('admin')), 'admin: stesso body per due utenti = BOLA');
  assert.ok(!m.candidates.some((c) => c.url.includes('user/1')), '403 su identità b non è candidato');
  console.log('test matrice base: PASS');
})();
```

- [ ] **Step 2: eseguire e verificare il fallimento** — `node tools/test-permission-matrix.js` → FAIL (module not found).

- [ ] **Step 3: implementazione minima**

```js
#!/usr/bin/env node
// Stavros permission-matrix — campagna BOLA/BFLA multi-identità (Gate P1 artifact).
// Ogni endpoint viene ripetuto come ogni identità (auth.json) via repeater engine
// (scope + DNS-pin); produce reports/permission-matrix.md + .json. SOLO candidati
// suspected: il finding si registra con record-finding.js, mai da qui.
'use strict';
const fs = require('fs');
const path = require('path');
const pace = require('./pace');

function loadEndpoints({ urlsFile, mapFile }) {
  const out = [];
  if (urlsFile) {
    for (const ln of fs.readFileSync(urlsFile, 'utf8').split(/\r?\n/)) {
      const t = ln.trim();
      if (!t || t.startsWith('#')) continue;
      const m = t.match(/^(GET|POST|PUT|PATCH|DELETE)\s+(\S+)$/);
      out.push(m ? { method: m[1], url: m[2] } : { method: 'GET', url: t });
    }
  }
  if (mapFile) {
    const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
    for (const e of map.endpoints || []) out.push({ method: e.method || 'GET', url: e.url || e.path });
  }
  return out;
}

async function buildMatrix({ endpoints, identities, baseline, exec, rps }) {
  const rows = [], candidates = [], errors = [];
  const base = baseline || identities[0];
  const cache = new Map(); // url|method|identity -> response (una sola chiamata per cella)
  const cell = async (ep, ident) => {
    const k = `${ep.method} ${ep.url}|${ident}`;
    if (!cache.has(k)) {
      if (rps) await pace.waitAsync(rps);
      try { cache.set(k, await exec({ ...ep, headers: ident })); }
      catch (e) { cache.set(k, { status: 0, body: '', error: String(e.message) }); errors.push(k); }
    }
    return cache.get(k);
  };
  for (const ep of endpoints) {
    const b = await cell(ep, base);
    const row = { ...ep, cells: {} };
    for (const ident of identities) {
      const r = await cell(ep, ident);
      const sim = ident === base ? 1 : pmSimilarity(b.body || '', r.body || '');
      row.cells[ident] = { status: r.status, bytes: (r.body || '').length, similarity: sim };
      if (ident !== base && r.status === 200 && b.status === 200 && sim >= 0.9) {
        row.cells[ident].flag = 'same-content';
        candidates.push({ type: 'bola', url: ep.url, method: ep.method, baseline: base, identity: ident, similarity: sim, verify_level: 'suspected' });
      }
      if (ident !== base && r.status === 200 && /(admin|manage|internal)/i.test(ep.url)) {
        candidates.push({ type: 'bfla', url: ep.url, method: ep.method, identity: ident, verify_level: 'suspected' });
      }
    }
    rows.push(row);
  }
  return { rows, candidates, errors, baseline: base, identities };
}

function pmSimilarity(a, b) {
  if (!a && !b) return 1;
  return require('./repeater').similarity(a, b);
}

function renderMarkdown(m) {
  const head = `| endpoint | ${m.identities.join(' | ')} |`;
  const sep = `|---|${m.identities.map(() => '---').join('|')}|`;
  const lines = m.rows.map((r) => `| ${r.method} ${r.url} | ${m.identities.map((i) => {
    const c = r.cells[i];
    return `${c.status} (${c.bytes}B)${c.flag ? ' ⚠' : ''}`;
  }).join(' | ')} |`);
  const cand = m.candidates.length
    ? m.candidates.map((c) => `- **${c.type.toUpperCase()}** ${c.method} ${c.url} — ${c.identity} vs ${c.baseline || ''} (sim ${c.similarity != null ? c.similarity.toFixed(2) : 'n/a'})`).join('\n')
    : '- nessun candidato';
  return `# permission-matrix\n\nBaseline: \`${m.baseline}\`\n\n${head}\n${sep}\n${lines.join('\n')}\n\n## Candidati (suspected — registrare via record-finding.js)\n${cand}\n`;
}

module.exports = { loadEndpoints, buildMatrix, renderMarkdown };
```

(CLI in coda: `--urls/--map/--identities/--baseline/--out/--methods/--confirm`; default `exec` = `repeater.sendChain(url, method, () => resolveIdentityHeaders, null, { showBody: true }, loadScope())` con headersFn che restituisce `repeater.resolveIdentity(authName)` — mappare ogni stringa identità a un nome `auth.json` quando non è già una header-list.)

- [ ] **Step 4: test passa** — `node tools/test-permission-matrix.js` → PASS.
- [ ] **Step 5: test aggiuntivi** — identità `login` che fallisce → `errors` popolato e nessuna richiesta anonima; tutti 404 → `candidates` vuoto; `loadEndpoints` su map.json finto; endpoint fuori scope rifiutato dal default exec (`sendChain` restituisce `blocked` → cell `BLOCKED`).
- [ ] **Step 6: doc** — una riga in `docs/methodology-classes.md` (bullet BOLA/BFLA): "campagna multi-identità: `node tools/permission-matrix.js`".
- [ ] **Step 7: verifica** — `node tools/run-tests.js` (baseline 87 PASS / 1 FAIL ambientale).

---

### Task 2 (WS2): ingest OpenAPI/Swagger → state.db

**Files:**
- Modify: `tools/parsers.js` (nuova `parseOpenApi`)
- Modify: `tools/target-model.js` (`ingestOpenApi` + `case 'openapi'` nel dispatch + usage)
- Test: `tools/test-openapi.js`

**Interfaces:**
- Consumes: pattern esistenti `parseTestsslJson(raw)` (fail-soft → `[]`) e `ingestTestssl(db, raw, opts)` con `state.upsertTarget`/`state.upsertEndpoint`.
- Produces: `parseOpenApi(raw: string): Array<{ method: string, path: string, operationId: string|null, params: string[] }>` (path relativo; chi sono lo decide il chiamante); `ingestOpenApi(db, raw, opts): { endpoints: n }`; CLI `node tools/target-model.js ingest openapi <file> --target <host>` (stessa sintassi degli altri ingest).

**Comportamento chiave:**
- OpenAPI 3.x: `paths.{path}.{method}` (get/post/put/patch/delete/head/options); Swagger 2.0: `basePath` + `host` + `schemes[0]` prefissati al path.
- `params` = nomi di `parameters[].name` (in query/path/header) + proprietà top-level dei requestBody JSON semplici; `$ref` NON risolti: se `parameters` contiene solo `$ref`, `params` resta `[]` (mai inventare).
- Fail-soft totale: JSON malformato o senza `paths` → `[]`, mai throw.

- [ ] **Step 1: test fallito**

```js
// tools/test-openapi.js
'use strict';
const assert = require('assert');
const { parseOpenApi } = require('./parsers');

const spec = JSON.stringify({
  openapi: '3.0.3',
  paths: {
    '/users/{id}': { get: { operationId: 'getUser', parameters: [{ name: 'id', in: 'path' }, { name: 'verbose', in: 'query' }] } },
    '/users': { post: { operationId: 'createUser' } },
  },
});
const eps = parseOpenApi(spec);
assert.deepStrictEqual(eps.map((e) => `${e.method} ${e.path}`).sort(), ['GET /users/{id}', 'POST /users']);
assert.deepStrictEqual(eps.find((e) => e.method === 'GET').params, ['id', 'verbose']);

const sw2 = JSON.stringify({ swagger: '2.0', host: 't.test', basePath: '/api', schemes: ['https'], paths: { '/ping': { get: {} } } });
assert.strictEqual(parseOpenApi(sw2)[0].path, '/api/ping');

assert.deepStrictEqual(parseOpenApi('not json'), []);
assert.deepStrictEqual(parseOpenApi(JSON.stringify({ openapi: '3.0.0' })), []);
console.log('openapi parse: PASS');
```

- [ ] **Step 2: verificare FAIL** — `node tools/test-openapi.js` → FAIL (parseOpenApi is not a function).
- [ ] **Step 3: `parseOpenApi` in `tools/parsers.js`** (dopo `parseWhatwebJson`, stesso stile fail-soft):

```js
// OpenAPI 3.x + Swagger 2.0 → endpoint list. Fail-soft: garbage in → [] (never throws).
function parseOpenApi(raw) {
  let doc;
  try { doc = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return []; }
  if (!doc || typeof doc !== 'object' || !doc.paths || typeof doc.paths !== 'object') return [];
  const prefix = doc.basePath ? String(doc.basePath).replace(/\/$/, '') : '';
  const out = [];
  for (const [p, item] of Object.entries(doc.paths)) {
    if (!item || typeof item !== 'object') continue;
    for (const m of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']) {
      const op = item[m];
      if (!op || typeof op !== 'object') continue;
      const params = [];
      for (const pr of op.parameters || []) if (pr && typeof pr.name === 'string') params.push(pr.name);
      out.push({ method: m.toUpperCase(), path: prefix + p, operationId: op.operationId || null, params });
    }
  }
  return out;
}
```

(esportare `parseOpenApi` nel `module.exports` di `parsers.js`.)

- [ ] **Step 4: `ingestOpenApi` in `tools/target-model.js`** — clonare la forma di `ingestWhatweb`: `const tid = state.upsertTarget(db, host);` per ogni endpoint `state.upsertEndpoint(db, tid, e.method, 'https://' + host + e.path, { source: 'openapi', params: e.params.join(',') || null })`; aggiungere `case 'openapi': counts = ingestOpenApi(db, raw, opts); break;` nel dispatch e la riga usage `tool: ... | openapi`.
- [ ] **Step 5: test ingest + CLI** — in `tools/test-openapi.js`: DB SQLite temporaneo (stessa fixture usata dagli altri ingest in `tools/test-ondata6.js` — se la fixture non è importabile, creare DB via `state.openDb(tmpfile)` come negli altri test DB del repo), `ingest` due volte lo stesso spec → conteggio endpoint stabile (idempotenza).
- [ ] **Step 6: verifica** — `node tools/test-openapi.js` PASS; `node tools/run-tests.js` verde (tranne ambientale).

---

### Task 3 (WS3): `wordgen.js` — wordlist adattive dal target

**Files:**
- Create: `tools/wordgen.js`
- Test: `tools/test-wordgen.js`

**Interfaces:**
- Produces:
  - `tokenize(text: string): Map<string, number>` — token→frequenza; split su non-alfanumerici + confini camelCase/snake/kebab; token ammessi `/^[a-z0-9][a-z0-9_-]{2,63}$/` dopo lowercase (niente token binari/oltralunghi).
  - `merge(...maps): Array<{ tok: string, n: number }>` — somma frequenze, ordinamento deterministico (`n` desc, poi `tok` asc).
  - `render(list, max): string` — righe `\n`.
  - CLI: `node tools/wordgen.js --bundle <jsfile> --text <file> --map <map.json> --base <wordlist> [--min-len 3] [--max 5000] [--out reports/tmp/wordlist-<tag>.txt]`

- [ ] **Step 1: test fallito**

```js
// tools/test-wordgen.js
'use strict';
const assert = require('assert');
const { tokenize, merge, render } = require('./wordgen');

const t = tokenize('getUserById getUserById loadUsers XMLHttpRequest 1234 ___ ' + 'x'.repeat(80));
assert.strictEqual(t.get('getuserbyid'), 2);
assert.ok(t.has('loadusers') || t.has('load_users') || t.has('load'), 'camelCase split produce sotto-token');
assert.ok(!t.has('x'.repeat(80)), 'token oltralunghi scartati');
const list = merge(t, tokenize('loadUsers checkout'));
assert.strictEqual(list[0].tok.length > 0, true);
const a = render(list, 10), b = render(list, 10);
assert.strictEqual(a, b, 'output deterministico');
console.log('wordgen: PASS');
```

- [ ] **Step 2: verificare FAIL.**
- [ ] **Step 3: implementazione** — `tokenize` con regex `text.split(/[^A-Za-z0-9_]+/)` + split confini camelCase (`s.replace(/([a-z0-9])([A-Z])/g, '$1 $2')`) applicato PRIMA del lowercase; filtro regex del contratto; `merge`/`render` come da interfaccia. CLI legge ogni `--bundle/--text/--base`, merge, taglia a `--max`, scrive `--out` (default stdout).
- [ ] **Step 4: test passa + edge** — file inesistente → exit 2 con errore chiaro; `--base` merge ordinato; snapshot del tokenizer su fixture minificata (una riga da 10k di JS minificato → nessun token > 64, output deterministico tra due run).
- [ ] **Step 5: verifica** — `node tools/test-wordgen.js` PASS; suite verde.

---

### Task 4 (WS4): fingerprint WAF cablato nel recon

**Files:**
- Modify: `tools/stavros.js` (fase `recon`: probe WAF dopo httpx)
- Modify: `workflows/enum-http.yaml` (decisione E6 di esempio: rate=slow se WAF)
- Test: `tools/test-stavros.js` (aggiunte)

**Interfaces:**
- Consumes: `runBin('wafw00f', [...])` interno a `stavros.js` (binario già in `tool-registry.json`, `read_only: true`), meccanismo `decisions` documentato di `workflow.js` (`file_contains` → `set_var`).
- Produces:
  - `parseWafw00f(output: string): { waf: string|null, raw: string }` — exportato da `stavros.js` per i test.
  - File `reports/tmp/waf-<host>.json` (`{host, waf, ts}`) e `reports/tmp/waf.txt` (`"WAF <nome>"` oppure `"NO-WAF"`) — quest'ultimo è il file che le `decisions` dei workflow leggono.
  - Riga `waf` in `stavros.js status [<host>]`.

**Comportamento chiave:** probe su UN solo URL vivo (il primo di httpx), timeout 60s, `on_error` soft: `wafw00f` assente → `WAF-UNKNOWN` e la pipeline continua (disciplina "Mancano? Salta"). Il profilo alimenta `pace` solo indirettamente: il workflow che legge `waf.txt` abbassa `{rate}`; non si tocca `pace.js`.

- [ ] **Step 1: test fallito per `parseWafw00f`** — output finto con `is behind Cloudflare` → `{waf: 'Cloudflare'}`; output senza WAF → `{waf: null}`; output vuoto → `{waf: null}` senza throw.
- [ ] **Step 2: verificare FAIL.**
- [ ] **Step 3: implementare `parseWafw00f` + wiring** — dopo lo step httpx di `recon`: `runBin('wafw00f', ['-a', firstAliveUrl])` dentro try/catch; parse; scrittura dei due file; riga in `status`.
- [ ] **Step 4: test wiring con runBin iniettato** — se `stavros.js` espone il seam di injection usato da `test-stavros.js`, usarlo per restituire output finto e assertare i due file scritti; altrimenti il test copre solo `parseWafw00f` + la scrittura file tramite funzione estratta `writeWafReport(host, verdict, dir)`.
- [ ] **Step 5: decisione E6 in `enum-http.yaml`**:

```yaml
decisions:
  - id: waf-throttle
    when:
      file_contains: { path: reports/tmp/waf.txt, text: WAF }
    then:
      set_var: { name: rate, value: slow }
```

- [ ] **Step 6: verifica** — test-stavros PASS (compresi i casi aggiunti), `WORKFLOW_NO_PYYAML=1 node tools/workflow.js validate workflows/enum-http.yaml` ok, suite verde.

---

### Task 5 (WS5): `report-pack.js` — pacchetto di consegna con manifest

**Files:**
- Create: `tools/report-pack.js`
- Test: `tools/test-report-pack.js`

**Interfaces:**
- Consumes: `node:crypto` (`createHash('sha256')`), `privacy.tokenize` (redazione quando `STAVROS_PRIVACY=1`), output esistenti: `reports/report-<host>.html` (report-html.js), `reports/findings.jsonl`, `reports/exp/*.py`, `evidence-index.md`.
- Produces:
  - `collect({ host, reportsDir, findingsFile }): Array<{ path, bytes }>` — elenco file di consegna (salta ciò che non esiste, mai fallire per un file assente).
  - `manifest(files): Array<{ path, sha256, bytes }>` — hash del contenuto redatto.
  - `write({ host, outDir, redact }): { dir, manifestPath }` — scrive `reports/delivery/<host>-<ts>/` con i file + `MANIFEST.sha256` (formato `<sha256>  <relpath>`, verificabile con `sha256sum -c`) + `pack.json` (`{host, ts, files, tool: 'report-pack'}`).
  - `verify(dir): { ok, broken: string[] }` — re-hash e confronto.
  - CLI: `node tools/report-pack.js build <host> [--redact] [--out <dir>]` / `node tools/report-pack.js verify <dir>`

**Comportamento chiave:** nessun archivio compresso (niente dipendenze, niente `tar` esterno): la consegna è la directory + manifest; il wrapping è compito dell'operatore. Con `--redact` ogni file passa da `privacy.tokenize` PRIMA dell'hash (il manifest descrive ciò che è stato consegnato). Opsec: nessun dato esce dalla macchina, output solo su disco locale.

- [ ] **Step 1: test fallito** — fixture dir con 2 file finti → `manifest` ha 2 righe con sha256 esatto (calcolato nel test con `node:crypto`); `write` crea `MANIFEST.sha256` verificabile; `verify` ok; dopo modifica di un file → `verify` `{ok:false, broken:['<file>']}`; `collect` ignora file assenti senza throw.
- [ ] **Step 2: verificare FAIL.**
- [ ] **Step 3: implementazione** (funzioni come da interfaccia; hash in streaming `createHash('sha256').update(buf)` — i file sono piccoli, buffer va bene; `MANIFEST.sha256` in ordine alfabetico di relpath per determinismo).
- [ ] **Step 4: redazione** — test con `STAVROS_PRIVACY=1`: un file contenente `10.0.0.1` → nel packed file compare `IP_001` (placeholder `privacy.tokenize`) e l'hash del manifest corrisponde al redatto.
- [ ] **Step 5: verifica** — suite verde.

---

### Task 6 (WS6): `workflows/attack-ad-roast.yaml` — pipeline AD roast

**Files:**
- Create: `workflows/attack-ad-roast.yaml`
- Modify: `skills/pentest-playbook/SKILL.md` (elenco workflow offensivi: aggiungerlo)
- Test: riga di validazione nel loop seed di `tools/test-workflow.js`

**Interfaces:**
- Consumes: dialetto workflow (guard prefix `node tools/ad.js ` già in `CMD_PREFIXES`), `ad.js roast <dc> --kerberoast|--asrep --user u --pass-file f` (auto-tier, header di `ad.js`), artifact `from: stdout`.
- Produces: workflow YAML; hash Kerberos catturati in `reports/attack-{tag}-roast-krb5tgs.txt` / `-asrep.txt` (stdout capture), pronti per `node tools/crack.js run --loot`.

**Comportamento chiave:** il workflow copre la parte ON-TARGET (enum + roast); il cracking resta comando separato (`crack.js` è offline e fuori dialetto per scelta — "target-less helpers are NOT workflow steps"), documentato nell'header dello YAML. Nessuna azione intrusiva: roast = lettura di hash, `ad.js` lo classifica auto. Il passo successivo spray/PtH resta dietro conferma esplicita (rule 2) e NON entra nel workflow.

- [ ] **Step 1: scrivere lo YAML**

```yaml
# Workflow offensivo — attack-ad-roast (dialetto workflow)
# Parte ON-TARGET della catena credential AD: enum utenti + Kerberoast/AS-REP roast, gli hash
# finiscono su disco (stdout capture) pronti per il cracking OFFLINE, che resta comando separato:
#   node tools/workflow.js run workflows/attack-ad-roast.yaml -t <dc-ip> \
#     --var user=<user> --var passfile=<file> --var tag=<nome>
#   node tools/crack.js run --loot          # dopo, offline, auto-tier
# Spray/PtH successivi sono CONFIRM-tier e NON automatizzati (knowledge.md rule 2).
name: attack-ad-roast
description: AD credential surface — enum utenti + Kerberoast/AS-REP, hash pronti per crack offline
vars:
  tag: target
  outdir: reports
  user: ""
  passfile: ""
  userlist: ""
steps:
  - id: ad-enum
    cmd: node tools/ad.js enum {target} --user {user} --pass-file {passfile}
    on_error: continue
    artifacts:
      - path: "{outdir}/attack-{tag}-ad-enum.txt"
        surface: ad
        from: stdout
  - id: roast-kerberoast
    cmd: node tools/ad.js roast {target} --kerberoast --user {user} --pass-file {passfile} --userlist {userlist}
    on_error: continue
    artifacts:
      - path: "{outdir}/attack-{tag}-roast-krb5tgs.txt"
        surface: ad
        from: stdout
  - id: roast-asrep
    cmd: node tools/ad.js roast {target} --asrep --user {user} --pass-file {passfile} --userlist {userlist}
    on_error: continue
    artifacts:
      - path: "{outdir}/attack-{tag}-roast-asrep.txt"
        surface: ad
        from: stdout
```

- [ ] **Step 2: validare doppio parser** — `node tools/workflow.js validate workflows/attack-ad-roast.yaml` e con `WORKFLOW_NO_PYYAML=1` → `ok:true` entrambi (nota: `--userlist {userlist}` con default `""` produce argomento vuoto: accettabile perché `ad.js` ha `--userlist` opzionale; se `ad.js` rifiuta argomenti vuoti, mettere `userlist: "users.txt"` come default documentato).
- [ ] **Step 3: test** — aggiungere `'attack-ad-roast.yaml'` alla lista `seeds` in `tools/test-workflow.js` (il test esistente verifica `ok:true` + `steps >= 2`).
- [ ] **Step 4: doc** — aggiungere `attack-ad-roast` all'elenco workflow offensivi in `skills/pentest-playbook/SKILL.md`.
- [ ] **Step 5: verifica** — `node tools/test-workflow.js` (28→29 pass) e suite verde.

---

## Esecuzione consigliata

Ordine: **WS4** (più piccolo, valore immediato) → **WS2** → **WS1** (si alimenta di WS2) → **WS3** → **WS6** → **WS5**. Ogni workstream è comunque autonomo: si può fermare/riprendere tra uno e l'altro, e ognuno chiude con la suite verde.
