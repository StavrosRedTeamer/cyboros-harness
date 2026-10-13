# Stavros Radar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create an autonomous intelligence and capability-scouting tool for StavrosRedTeamer that analyzes the local codebase, discovers relevant open-source projects on GitHub/web, evaluates the architectural delta via OmniRoute LLM, and produces actionable periodic integration reports.

**Architecture:** A modular 4-component Node.js pipeline: `radar-profiler.js` extracts current capabilities, `radar-scout.js` queries and deduplicates GitHub candidates, `radar-analyst.js` prompts local OmniRoute (`http://localhost:20128/v1`) for gap analysis and integration recipes, and `radar.js` coordinates execution, generates Markdown/JSON reports, and maintains the cache.

**Tech Stack:** Node.js (v20+ native standard library: `node:https`, `node:fs`, `node:path`, `node:crypto`), OmniRoute OpenAI-compatible API (`/v1/chat/completions`), GitHub REST API v3. Zero external npm dependencies.

**Spec:** `docs/superpowers/specs/2026-09-08-stavros-radar-design.md`

## Global Constraints

- Zero external dependencies: rely strictly on Node.js built-ins (`node:fs`, `node:path`, `node:https`, `node:crypto`).
- Non-blocking error handling: network timeouts (max 15s), OmniRoute unreachable fallback to heuristic metadata, GitHub 403/429 rate limit graceful handling.
- Deterministic deduplication: all discovered and evaluated repositories stored in `reports/radar/cache.json`.
- Offline testability: all unit and integration tests must run offline without live network dependencies.
- Follow repository conventions: scripts reside in `tools/`, tests in `tools/test-radar.js`, and system units in `ops/`.

---

### Task 1: Codebase Capability Profiler (`tools/radar-profiler.js`)

**Files:**
- Create: `tools/radar-profiler.js`
- Test: `tools/test-radar.js`

**Interfaces:**
- Consumes: Local filesystem (`.agents/*.ts`, `tools/*.js`, `refs/**/*.md`, `knowledge.md`)
- Produces: `export function profileCodebase(baseDir): { categories: string[], agents: string[], tools: string[], mcpServers: string[], vendors: string[] }`

- [ ] **Step 1: Write test for capability profiling**

Add to `tools/test-radar.js`:
```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { profileCodebase } from './radar-profiler.js';
import path from 'node:path';

test('profileCodebase extracts agents, tools and categories from project directory', () => {
  const projectRoot = path.resolve(import.meta.dirname, '..');
  const profile = profileCodebase(projectRoot);
  
  assert.ok(Array.isArray(profile.agents), 'agents should be an array');
  assert.ok(profile.agents.length > 0, 'should find at least one agent in .agents');
  assert.ok(Array.isArray(profile.tools), 'tools should be an array');
  assert.ok(profile.tools.includes('scope-guard.js'), 'should detect scope-guard.js');
  assert.ok(Array.isArray(profile.categories), 'categories should be an array');
  assert.ok(profile.categories.includes('recon') || profile.categories.includes('web'), 'should extract core categories');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/test-radar.js`  
Expected: FAIL with `Cannot find module './radar-profiler.js'`

- [ ] **Step 3: Implement `tools/radar-profiler.js`**

```javascript
import fs from 'node:fs';
import path from 'node:path';

const CATEGORY_KEYWORDS = {
  'web-recon': ['recon', 'subdomain', 'crawler', 'spider', 'endpoint', 'asset'],
  'active-scanning': ['scanner', 'nuclei', 'fuzz', 'ffuf', 'injection', 'vuln'],
  'auth-bypass': ['auth', 'jwt', 'session', 'login', 'oauth', 'token'],
  'ssrf-injection': ['ssrf', 'sqli', 'xss', 'rce', 'command-injection'],
  'wireless-audit': ['wifi', 'wpa', 'bssid', 'handshake', 'aircrack'],
  'c2-postex': ['c2', 'listener', 'beacon', 'reverse-shell', 'payload'],
  'cdp-browser': ['chrome', 'devtools', 'cdp', 'puppeteer', 'playwright', 'dom'],
  'mobile-audit': ['frida', 'apk', 'android', 'ios'],
  'reporting': ['report', 'sarif', 'jsonl', 'summary']
};

export function profileCodebase(rootDir = process.cwd()) {
  const agentsDir = path.join(rootDir, '.agents');
  const toolsDir = path.join(rootDir, 'tools');
  const vendorDir = path.join(rootDir, 'vendor');

  const agents = [];
  const mcpServers = new Set();
  if (fs.existsSync(agentsDir)) {
    const agentFiles = fs.readdirSync(agentsDir).filter(f => f.endsWith('.ts') || f.endsWith('.js'));
    for (const f of agentFiles) {
      agents.push(path.basename(f, path.extname(f)));
      try {
        const content = fs.readFileSync(path.join(agentsDir, f), 'utf8');
        const mcpMatch = content.match(/mcpServers\s*:\s*\[([^\]]+)\]/);
        if (mcpMatch) {
          mcpMatch[1].split(',').map(s => s.replace(/['"\s]/g, '')).filter(Boolean).forEach(s => mcpServers.add(s));
        }
      } catch {}
    }
  }

  const tools = [];
  if (fs.existsSync(toolsDir)) {
    tools.push(...fs.readdirSync(toolsDir).filter(f => f.endsWith('.js') || f.endsWith('.sh')));
  }

  const vendors = [];
  if (fs.existsSync(vendorDir)) {
    vendors.push(...fs.readdirSync(vendorDir));
  }

  const detectedCategories = new Set();
  const allNames = [...agents, ...tools, ...vendors].join(' ').toLowerCase();
  for (const [cat, kws] of Object.entries(CATEGORY_KEYWORDS)) {
    if (kws.some(kw => allNames.includes(kw))) {
      detectedCategories.add(cat);
    }
  }
  if (detectedCategories.size === 0) {
    detectedCategories.add('web-recon');
    detectedCategories.add('active-scanning');
  }

  return {
    categories: Array.from(detectedCategories),
    agents: agents.sort(),
    tools: tools.sort(),
    mcpServers: Array.from(mcpServers),
    vendors: vendors.sort(),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/test-radar.js`  
Expected: PASS

- [ ] **Step 5: Commit changes**

```bash
git add tools/radar-profiler.js tools/test-radar.js
git commit -m "feat(radar): add codebase capability profiler"
```

---

### Task 2: GitHub & Web Discovery Engine (`tools/radar-scout.js`)

**Files:**
- Create: `tools/radar-scout.js`
- Modify: `tools/test-radar.js`

**Interfaces:**
- Consumes: `queries: string[]`, `cache: { seen: Record<string, string> }`, `options: { githubToken?: string, minStars?: number, limit?: number }`
- Produces: `export async function scoutRepositories(options): Promise<CandidateRepo[]>`

- [ ] **Step 1: Write test for scout filtering and deduplication**

Add to `tools/test-radar.js`:
```javascript
import { filterAndDeduplicateRepos } from './radar-scout.js';

test('filterAndDeduplicateRepos filters out seen repos, low stars and old repos', () => {
  const cache = { seen: { 'author/old-repo': '2026-01-01' } };
  const rawItems = [
    { full_name: 'author/old-repo', stargazers_count: 500, updated_at: '2026-08-01T00:00:00Z', archived: false },
    { full_name: 'author/low-stars', stargazers_count: 5, updated_at: '2026-08-01T00:00:00Z', archived: false },
    { full_name: 'author/archived-tool', stargazers_count: 300, updated_at: '2026-08-01T00:00:00Z', archived: true },
    { full_name: 'good/new-tool', name: 'new-tool', html_url: 'https://github.com/good/new-tool', description: 'Great tool', stargazers_count: 350, updated_at: '2026-08-10T00:00:00Z', archived: false, topics: ['pentest'] }
  ];

  const filtered = filterAndDeduplicateRepos(rawItems, cache, { minStars: 50 });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].id, 'good/new-tool');
  assert.equal(filtered[0].stars, 350);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/test-radar.js`  
Expected: FAIL with `filterAndDeduplicateRepos is not defined`

- [ ] **Step 3: Implement `tools/radar-scout.js`**

```javascript
import https from 'node:https';

export function filterAndDeduplicateRepos(items, cache = { seen: {} }, opts = {}) {
  const minStars = opts.minStars ?? 30;
  const maxDays = opts.maxDays ?? 365;
  const now = Date.now();
  const maxAgeMs = maxDays * 24 * 60 * 60 * 1000;

  return items
    .filter(item => {
      if (!item || item.archived) return false;
      if (cache.seen && cache.seen[item.full_name]) return false;
      if ((item.stargazers_count || 0) < minStars) return false;
      if (item.updated_at && (now - new Date(item.updated_at).getTime()) > maxAgeMs) return false;
      return true;
    })
    .map(item => ({
      id: item.full_name,
      name: item.name,
      htmlUrl: item.html_url,
      description: item.description || '',
      stars: item.stargazers_count,
      topics: item.topics || [],
      updatedAt: item.updated_at,
      license: item.license ? item.license.spdx_id || item.license.name : 'Unknown'
    }));
}

export function fetchGithubQuery(query, token = process.env.GITHUB_TOKEN) {
  return new Promise((resolve, reject) => {
    const encoded = encodeURIComponent(query);
    const url = `https://api.github.com/search/repositories?q=${encoded}&sort=updated&order=desc&per_page=15`;
    const headers = {
      'User-Agent': 'StavrosRedTeamer-Radar/1.0',
      'Accept': 'application/vnd.github.v3+json'
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const req = https.get(url, { headers, timeout: 15000 }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 403 || res.statusCode === 429) {
          return resolve({ rateLimited: true, items: [] });
        }
        if (res.statusCode >= 400) {
          return reject(new Error(`GitHub API HTTP ${res.statusCode}: ${data}`));
        }
        try {
          const json = JSON.parse(data);
          resolve({ rateLimited: false, items: json.items || [] });
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('GitHub API request timed out'));
    });
    req.on('error', reject);
  });
}

export async function scoutRepositories(cache = { seen: {} }, opts = {}) {
  const topics = opts.queries || [
    'topic:redteam',
    'topic:pentest',
    'topic:bugbounty',
    'topic:mcp-server',
    'topic:c2-framework'
  ];
  const allCandidates = new Map();

  for (const q of topics) {
    try {
      const res = await (opts.fetcher ? opts.fetcher(q) : fetchGithubQuery(q, opts.githubToken));
      if (res.rateLimited) {
        console.warn(`[Radar Scout] GitHub rate limit reached for query "${q}". Continuing with collected items.`);
        break;
      }
      const filtered = filterAndDeduplicateRepos(res.items, cache, opts);
      for (const item of filtered) {
        if (!allCandidates.has(item.id)) {
          allCandidates.set(item.id, item);
        }
      }
    } catch (err) {
      console.warn(`[Radar Scout] Query "${q}" failed: ${err.message}`);
    }
  }

  const limit = opts.limit ?? 8;
  return Array.from(allCandidates.values())
    .sort((a, b) => b.stars - a.stars)
    .slice(0, limit);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/test-radar.js`  
Expected: PASS

- [ ] **Step 5: Commit changes**

```bash
git add tools/radar-scout.js tools/test-radar.js
git commit -m "feat(radar): add github discovery and deduplication engine"
```

---

### Task 3: OmniRoute AI Gap & Integration Analyst (`tools/radar-analyst.js`)

**Files:**
- Create: `tools/radar-analyst.js`
- Modify: `tools/test-radar.js`

**Interfaces:**
- Consumes: `profile: CapabilityProfile`, `candidates: CandidateRepo[]`, `options: { omnirouteUrl?: string, model?: string }`
- Produces: `export async function analyzeCandidates(profile, candidates, options): Promise<AnalyzedProposal[]>`

- [ ] **Step 1: Write test for heuristic fallback and prompt formatting**

Add to `tools/test-radar.js`:
```javascript
import { buildAnalysisPrompt, heuristicFallbackAnalysis } from './radar-analyst.js';

test('buildAnalysisPrompt formats prompt with profile categories and candidates', () => {
  const profile = { categories: ['web-recon'], tools: ['scope-guard.js'], agents: ['recon'] };
  const candidates = [{ id: 'test/tool', name: 'tool', description: 'fast recon tool', stars: 200, topics: ['recon'] }];
  const prompt = buildAnalysisPrompt(profile, candidates);
  
  assert.ok(prompt.includes('scope-guard.js'));
  assert.ok(prompt.includes('test/tool'));
  assert.ok(prompt.includes('JSON'));
});

test('heuristicFallbackAnalysis returns structured proposals without LLM', () => {
  const candidates = [{ id: 'test/tool', name: 'tool', htmlUrl: 'https://github.com/test/tool', description: 'Fast port scanner', stars: 500, license: 'MIT' }];
  const proposals = heuristicFallbackAnalysis(candidates);
  
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].repoId, 'test/tool');
  assert.ok(proposals[0].integrationStrategy);
  assert.equal(proposals[0].source, 'heuristic');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/test-radar.js`  
Expected: FAIL with `Cannot find module './radar-analyst.js'`

- [ ] **Step 3: Implement `tools/radar-analyst.js`**

```javascript
import http from 'node:http';

export function buildAnalysisPrompt(profile, candidates) {
  return `You are an expert security engineer and system architect for StavrosRedTeamer, a multi-agent penetration testing harness.

Current Stavros Capabilities:
- Categories covered: ${profile.categories.join(', ')}
- Registered Tools: ${profile.tools.slice(0, 20).join(', ')}
- Registered Agents: ${profile.agents.slice(0, 20).join(', ')}
- MCP Servers: ${profile.mcpServers.join(', ') || 'none'}

Evaluate each of the following new GitHub projects for integration into Stavros:
${candidates.map(c => `- ID: ${c.id}\n  URL: ${c.htmlUrl}\n  Description: ${c.description}\n  Stars: ${c.stars}\n  Topics: ${c.topics.join(', ')}`).join('\n\n')}

For each project, reply ONLY with a valid JSON array of objects with the following keys:
[
  {
    "repoId": "full_name",
    "relevant": true/false,
    "category": "Evasion / Recon / Exploit / MCP / Performance",
    "gapFilled": "Concise explanation of what this adds that Stavros currently lacks",
    "integrationStrategy": "TOOL_WRAPPER / MCP_SERVER / VENDOR_BINARY / AGENT_PLAYBOOK",
    "integrationRecipe": "Short actionable technical recipe: which file to edit or create",
    "riskEffort": "LOW / MEDIUM / HIGH"
  }
]`;
}

export function heuristicFallbackAnalysis(candidates) {
  return candidates.map(c => {
    const isMcp = c.topics.some(t => t.includes('mcp')) || c.name.includes('mcp');
    return {
      repoId: c.id,
      name: c.name,
      htmlUrl: c.htmlUrl,
      stars: c.stars,
      license: c.license,
      description: c.description,
      relevant: true,
      category: isMcp ? 'MCP Tooling' : 'Security Tooling',
      gapFilled: `Provides specialized capabilities in ${c.topics.slice(0, 3).join(', ') || 'offensive security'}`,
      integrationStrategy: isMcp ? 'MCP_SERVER' : 'TOOL_WRAPPER',
      integrationRecipe: isMcp 
        ? `Register as MCP server in mcp.example.json`
        : `Add CLI wrapper in tools/${c.name}.js or vendor into vendor/`,
      riskEffort: 'MEDIUM',
      source: 'heuristic'
    };
  });
}

export function queryOmniRoute(prompt, options = {}) {
  return new Promise((resolve, reject) => {
    const port = options.port || 20128;
    const body = JSON.stringify({
      model: options.model || 'claude-3-5-sonnet',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2
    });

    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 30000
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          return reject(new Error(`OmniRoute error HTTP ${res.statusCode}: ${data}`));
        }
        try {
          const json = JSON.parse(data);
          const content = json.choices?.[0]?.message?.content || '';
          resolve(content);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('OmniRoute request timed out'));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

export async function analyzeCandidates(profile, candidates, options = {}) {
  if (!candidates || candidates.length === 0) return [];
  
  try {
    const prompt = buildAnalysisPrompt(profile, candidates);
    const rawAnswer = await (options.queryLlm ? options.queryLlm(prompt) : queryOmniRoute(prompt, options));
    const jsonMatch = rawAnswer.match(/\[\s*\{[\s\S]*\}\s*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const repoMap = new Map(candidates.map(c => [c.id, c]));
      return parsed.map(item => {
        const repo = repoMap.get(item.repoId) || {};
        return {
          ...item,
          name: repo.name || item.repoId,
          htmlUrl: repo.htmlUrl || `https://github.com/${item.repoId}`,
          stars: repo.stars || 0,
          license: repo.license || 'Unknown',
          source: 'omniroute-llm'
        };
      });
    }
  } catch (err) {
    console.warn(`[Radar Analyst] OmniRoute analysis unavailable (${err.message}). Falling back to heuristic analysis.`);
  }

  return heuristicFallbackAnalysis(candidates);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/test-radar.js`  
Expected: PASS

- [ ] **Step 5: Commit changes**

```bash
git add tools/radar-analyst.js tools/test-radar.js
git commit -m "feat(radar): add omniroute llm gap analyst and heuristic fallback"
```

---

### Task 4: CLI Orchestrator & Report Generator (`tools/radar.js`)

**Files:**
- Create: `tools/radar.js`
- Modify: `tools/test-radar.js`
- Modify: `package.json` (add `npm run radar` and include `test-radar.js` in `npm test`)

**Interfaces:**
- Consumes: `tools/radar-profiler.js`, `tools/radar-scout.js`, `tools/radar-analyst.js`
- Produces: CLI commands (`run`, `profile`, `status`) and report artifacts in `reports/radar/`

- [ ] **Step 1: Write test for report markdown generator**

Add to `tools/test-radar.js`:
```javascript
import { generateMarkdownReport } from './radar.js';

test('generateMarkdownReport formats clean markdown with badges and recipes', () => {
  const profile = { categories: ['web-recon'], tools: ['scope-guard.js'], agents: ['recon'] };
  const proposals = [{
    repoId: 'project/super-scanner',
    name: 'super-scanner',
    htmlUrl: 'https://github.com/project/super-scanner',
    stars: 1200,
    category: 'Evasion',
    gapFilled: 'Bypasses modern Cloudflare rate limiting',
    integrationStrategy: 'TOOL_WRAPPER',
    integrationRecipe: 'Create tools/super-scanner.js',
    riskEffort: 'LOW',
    source: 'omniroute-llm'
  }];

  const md = generateMarkdownReport(profile, proposals, '2026-09-08');
  assert.ok(md.includes('# Stavros Radar Intelligence Report'));
  assert.ok(md.includes('super-scanner'));
  assert.ok(md.includes('Cloudflare rate limiting'));
  assert.ok(md.includes('TOOL_WRAPPER'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/test-radar.js`  
Expected: FAIL with `Cannot find module './radar.js'`

- [ ] **Step 3: Implement `tools/radar.js`**

```javascript
#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { profileCodebase } from './radar-profiler.js';
import { scoutRepositories } from './radar-scout.js';
import { analyzeCandidates } from './radar-analyst.js';

const ROOT_DIR = path.resolve(import.meta.dirname, '..');
const RADAR_DIR = path.join(ROOT_DIR, 'reports', 'radar');
const CACHE_FILE = path.join(RADAR_DIR, 'cache.json');

export function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    }
  } catch {}
  return { seen: {}, lastScan: null };
}

export function saveCache(cache) {
  fs.mkdirSync(RADAR_DIR, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
}

export function generateMarkdownReport(profile, proposals, dateStr = new Date().toISOString().split('T')[0]) {
  let md = `# Stavros Radar Intelligence Report — ${dateStr}\n\n`;
  md += `> **Ecosystem Scanner & Capability Scout**\n`;
  md += `> Baseline: ${profile.agents.length} agenti, ${profile.tools.length} tool, ${profile.categories.length} categorie coperte.\n\n`;
  
  if (proposals.length === 0) {
    md += `*Nessuna nuova proposta rilevante identificata in questa sessione. La cache è aggiornata.*\n`;
    return md;
  }

  md += `## Proposte di Potenziamento Selezionate (${proposals.length})\n\n`;

  for (const p of proposals) {
    md += `### [${p.name}](${p.htmlUrl}) ⭐ ${p.stars || 'N/A'}\n`;
    md += `- **Ambito/Categoria**: \`${p.category || 'General'}\`\n`;
    md += `- **Strategia**: \`${p.integrationStrategy}\` | **Sforzo**: \`${p.riskEffort}\` | **Fonte**: \`${p.source}\`\n`;
    md += `- **Gap Colmato**: ${p.gapFilled}\n`;
    md += `- **Ricetta di Integrazione**: ${p.integrationRecipe}\n\n`;
  }

  md += `---\n*Generato automaticamente da Stavros Radar via OmniRoute.*\n`;
  return md;
}

export async function runRadar(opts = {}) {
  const rootDir = opts.rootDir || ROOT_DIR;
  const cache = loadCache();

  console.log('[Radar] Profilazione della codebase StavrosRedTeamer...');
  const profile = profileCodebase(rootDir);
  console.log(`[Radar] Profilati ${profile.agents.length} agenti e ${profile.tools.length} tool in ${profile.categories.length} categorie.`);

  console.log('[Radar] Scansione nuovi repository su GitHub...');
  const candidates = await scoutRepositories(cache, opts);
  console.log(`[Radar] Trovati ${candidates.length} candidati qualificati non ancora analizzati.`);

  if (candidates.length === 0) {
    console.log('[Radar] Nessun nuovo candidato da valutare.');
    return { profile, proposals: [] };
  }

  console.log('[Radar] Analisi gap e strategie di integrazione via OmniRoute...');
  const proposals = await analyzeCandidates(profile, candidates, opts);

  const dateStr = new Date().toISOString().split('T')[0];
  const reportMd = generateMarkdownReport(profile, proposals, dateStr);

  fs.mkdirSync(RADAR_DIR, { recursive: true });
  const mdPath = path.join(RADAR_DIR, `radar-${dateStr}.md`);
  const jsonPath = path.join(RADAR_DIR, `radar-${dateStr}.json`);

  fs.writeFileSync(mdPath, reportMd, 'utf8');
  fs.writeFileSync(jsonPath, JSON.stringify({ date: dateStr, profile, proposals }, null, 2), 'utf8');

  // Aggiorna cache
  cache.lastScan = new Date().toISOString();
  for (const c of candidates) {
    cache.seen[c.id] = dateStr;
  }
  saveCache(cache);

  console.log(`\n✔ Report generato con successo:`);
  console.log(`  📄 Markdown: ${mdPath}`);
  console.log(`  📊 JSON:     ${jsonPath}`);

  return { profile, proposals, mdPath, jsonPath };
}

// CLI handler
if (process.argv[1] && import.meta.filename && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const cmd = process.argv[2] || 'run';
  if (cmd === 'profile') {
    const prof = profileCodebase(ROOT_DIR);
    console.log(JSON.stringify(prof, null, 2));
  } else if (cmd === 'status') {
    const cache = loadCache();
    const seenCount = Object.keys(cache.seen || {}).length;
    console.log(`Stavros Radar Status:`);
    console.log(`- Progetti archiviati in cache: ${seenCount}`);
    console.log(`- Ultima scansione: ${cache.lastScan || 'Mai eseguita'}`);
  } else {
    runRadar().catch(err => {
      console.error('[Radar Error]', err);
      process.exit(1);
    });
  }
}
```

- [ ] **Step 4: Update `package.json` scripts**

Add `"radar": "node tools/radar.js run"` to `package.json` scripts and verify test runner includes `tools/test-radar.js`.

- [ ] **Step 5: Run tests and verify full suite passes**

Run: `node --test tools/test-radar.js`  
Expected: PASS all tests

- [ ] **Step 6: Commit changes**

```bash
git add tools/radar.js tools/test-radar.js package.json
git commit -m "feat(radar): add main radar cli orchestrator and report generator"
```

---

### Task 5: Systemd Timer & Service Scheduling (`ops/radar.*`)

**Files:**
- Create: `ops/radar.service`
- Create: `ops/radar.timer`
- Create: `ops/install-radar-timer.sh`

**Interfaces:**
- Produces: Systemd user timer running weekly (or configurable interval) invoking `node tools/radar.js run`

- [ ] **Step 1: Write `ops/radar.service`**

```ini
[Unit]
Description=Stavros Radar Ecosystem Intelligence Scout
After=network.target

[Service]
Type=oneshot
WorkingDirectory=%h/Scrivania/stavrosredteamer
ExecStart=/usr/bin/node tools/radar.js run
StandardOutput=journal
StandardError=journal
```

- [ ] **Step 2: Write `ops/radar.timer`**

```ini
[Unit]
Description=Run Stavros Radar weekly
Persistent=true

[Timer]
OnCalendar=weekly
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
```

- [ ] **Step 3: Write `ops/install-radar-timer.sh`**

```bash
#!/usr/bin/env bash
set -e

SYSTEMD_DIR="$HOME/.config/systemd/user"
mkdir -p "$SYSTEMD_DIR"

cp ops/radar.service "$SYSTEMD_DIR/radar.service"
cp ops/radar.timer "$SYSTEMD_DIR/radar.timer"

systemctl --user daemon-reload
systemctl --user enable --now radar.timer

echo "✔ Stavros Radar systemd user timer abilitato con successo!"
echo "Verifica con: systemctl --user list-timers radar.timer"
```
Make executable: `chmod +x ops/install-radar-timer.sh`

- [ ] **Step 4: Verify syntax and dry-run execution**

Run: `node tools/radar.js status`  
Expected: Outputs status cleanly.

- [ ] **Step 5: Commit changes**

```bash
git add ops/radar.service ops/radar.timer ops/install-radar-timer.sh
git commit -m "feat(radar): add systemd user timer and service units for periodic scheduling"
```

---

## Plan Self-Review Checklist

1. **Spec coverage**: Covers capability profiler, scout deduplication, OmniRoute analyst, CLI orchestrator, report generation, and systemd scheduling.
2. **Placeholder scan**: 0 TODOs, 0 placeholders, explicit complete code blocks provided.
3. **Type and interface consistency**: `profileCodebase`, `scoutRepositories`, `analyzeCandidates`, `generateMarkdownReport` all have consistent signatures across tasks.
