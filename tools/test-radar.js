// test-tags: offline
// Stavros Radar — unit e integration test offline (nessuna chiamata di rete live).
// Copre: capability profiler, scout filtering/deduplication, analyst prompt+fallback,
// e generatore di report markdown. Eseguito da `node tools/run-tests.js` (npm test).
//
// Run: node tools/test-radar.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { profileCodebase } = require('./radar-profiler.js');
const { filterAndDeduplicateRepos } = require('./radar-scout.js');
const { buildAnalysisPrompt, heuristicFallbackAnalysis, buildOmniRouteBody, omniRouteHeaders } = require('./radar-analyst.js');
const { generateMarkdownReport } = require('./radar.js');

test('profileCodebase extracts agents, tools and categories from project directory', () => {
  const projectRoot = path.resolve(__dirname, '..');
  const profile = profileCodebase(projectRoot);

  assert.ok(Array.isArray(profile.agents), 'agents should be an array');
  assert.ok(profile.agents.length > 0, 'should find at least one agent in .agents');
  assert.ok(Array.isArray(profile.tools), 'tools should be an array');
  assert.ok(profile.tools.includes('scope-guard.js'), 'should detect scope-guard.js');
  assert.ok(Array.isArray(profile.categories), 'categories should be an array');
  assert.ok(profile.categories.some(c => c.includes('recon') || c.includes('web')), 'should extract core categories');
});

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

test('buildAnalysisPrompt formats prompt with profile categories and candidates', () => {
  const profile = { categories: ['web-recon'], tools: ['scope-guard.js'], agents: ['recon'] };
  const candidates = [{ id: 'test/tool', name: 'tool', description: 'fast recon tool', stars: 200, topics: ['recon'] }];
  const prompt = buildAnalysisPrompt(profile, candidates);

  assert.ok(prompt.includes('scope-guard.js'));
  assert.ok(prompt.includes('test/tool'));
  assert.ok(prompt.includes('JSON'));
});

test('buildOmniRouteBody defaults to Gemini flash-high and honors reasoning effort', () => {
  const savedModel = process.env.OMNIROUTE_MODEL;
  const savedEffort = process.env.OMNIROUTE_REASONING_EFFORT;
  delete process.env.OMNIROUTE_MODEL;
  delete process.env.OMNIROUTE_REASONING_EFFORT;
  try {
    // default: gemini pro agent (nome ufficiale su OmniRoute), senza reasoning_effort se non richiesto
    const def = buildOmniRouteBody('prompt');
    assert.ok(def.model.includes('gemini'), 'default model should be gemini, got: ' + def.model);
    assert.ok(!('reasoning_effort' in def), 'reasoning_effort should be omitted when unset');
    assert.equal(def.temperature, 0.2);

    // effort via opzione
    const withEffort = buildOmniRouteBody('prompt', { reasoningEffort: 'high' });
    assert.equal(withEffort.reasoning_effort, 'high');

    // override modello via env
    process.env.OMNIROUTE_MODEL = 'google/gemini-3.8-flash';
    assert.equal(buildOmniRouteBody('p').model, 'google/gemini-3.8-flash');
  } finally {
    if (savedModel === undefined) delete process.env.OMNIROUTE_MODEL; else process.env.OMNIROUTE_MODEL = savedModel;
    if (savedEffort === undefined) delete process.env.OMNIROUTE_REASONING_EFFORT; else process.env.OMNIROUTE_REASONING_EFFORT = savedEffort;
  }
});

test('omniRouteHeaders adds Authorization Bearer only when an api key is set', () => {
  const savedKey = process.env.OMNIROUTE_API_KEY;
  delete process.env.OMNIROUTE_API_KEY;
  try {
    const noKey = omniRouteHeaders('{"a":1}');
    assert.ok(!('Authorization' in noKey), 'no Authorization header without key');

    const withKey = omniRouteHeaders('{"a":1}', { apiKey: 'sk-test' });
    assert.equal(withKey.Authorization, 'Bearer sk-test');

    process.env.OMNIROUTE_API_KEY = 'sk-env';
    assert.equal(omniRouteHeaders('{}').Authorization, 'Bearer sk-env');
  } finally {
    if (savedKey === undefined) delete process.env.OMNIROUTE_API_KEY; else process.env.OMNIROUTE_API_KEY = savedKey;
  }
});

test('heuristicFallbackAnalysis returns structured proposals without LLM', () => {
  const candidates = [{ id: 'test/tool', name: 'tool', htmlUrl: 'https://github.com/test/tool', description: 'Fast port scanner', stars: 500, license: 'MIT' }];
  const proposals = heuristicFallbackAnalysis(candidates);

  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].repoId, 'test/tool');
  assert.ok(proposals[0].integrationStrategy);
  assert.equal(proposals[0].source, 'heuristic');
});

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
    priority: 1,
    source: 'omniroute-llm'
  }];

  const md = generateMarkdownReport(profile, proposals, '2026-09-08');
  assert.ok(md.includes('# Stavros Radar Intelligence Report'));
  assert.ok(md.includes('super-scanner'));
  assert.ok(md.includes('Cloudflare rate limiting'));
  assert.ok(md.includes('TOOL_WRAPPER'));
  assert.ok(md.includes('Priorità'));
});

test('generateMarkdownReport separates rejected proposals and prioritizes by effort/stars', () => {
  const profile = { categories: ['recon', 'evasion'], tools: [], agents: [] };
  const proposals = [
    { repoId: 'a/redundant', name: 'redundant', htmlUrl: 'https://github.com/a/redundant', stars: 900, relevant: false, gapFilled: 'Duplicates existing scope-guard.js', source: 'omniroute-llm' },
    { repoId: 'a/high-effort', name: 'high-effort', htmlUrl: 'https://github.com/a/high-effort', stars: 5000, category: 'Recon', gapFilled: 'Fills recon gap', integrationStrategy: 'TOOL_WRAPPER', integrationRecipe: 'Create tools/high-effort.js', riskEffort: 'HIGH', priority: 4, source: 'omniroute-llm' },
    { repoId: 'a/top-pick', name: 'top-pick', htmlUrl: 'https://github.com/a/top-pick', stars: 300, category: 'Recon', gapFilled: 'Fills recon gap', integrationStrategy: 'MCP_SERVER', integrationRecipe: 'Register in mcp.example.json', riskEffort: 'LOW', priority: 1, source: 'omniroute-llm' },
  ];

  const md = generateMarkdownReport(profile, proposals, '2026-09-08');
  assert.ok(md.includes('## Proposte di Potenziamento Selezionate (2)'));
  assert.ok(md.includes('## Valutati ma non raccomandati (1)'));
  assert.ok(md.includes('Duplicates existing scope-guard.js'));
  assert.ok(md.includes('raccomandazione principale: `top-pick`'), 'LOW effort should rank before HIGH effort');
  assert.ok(md.includes('Gap coperti'), 'should include per-category gap summary');
  // il rigetto non deve comparire tra le proposte
  assert.ok(!md.includes('### [redundant]'), 'rejected repo must not appear among proposals');
});