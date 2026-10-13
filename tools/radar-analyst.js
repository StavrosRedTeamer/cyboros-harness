'use strict';
// tools/radar-analyst.js — Cyboros Radar: OmniRoute AI gap & integration analyst.
// Costruisce il prompt di gap analysis, interroga OmniRoute
// (http://127.0.0.1:20128/v1/chat/completions) e, se irraggiungibile o con
// risposta non parsabile, ripiega su analisi euristica deterministica.
// Zero dipendenze (node:http).
//
// Uso: node tools/radar.js run   (oppure import delle funzioni)

const http = require('node:http');

// Modello di default: agy/gemini-pro-agent (nome ufficiale su OmniRoute, verificato
// HTTP 200 con chiave API). Override: env OMNIROUTE_MODEL, opzione { model }.
// Effort alto per i modelli Gemini: env OMNIROUTE_REASONING_EFFORT o opzione
// { reasoningEffort }. Chiave API: env OMNIROUTE_API_KEY o opzione { apiKey }.
const DEFAULT_MODEL = 'agy/gemini-pro-agent';

/**
 * Costruisce il body della richiesta chat/completions per OmniRoute.
 * @param {string} prompt
 * @param {{model?: string, reasoningEffort?: string, port?: number}} options
 * @returns {object}
 */
function buildOmniRouteBody(prompt, options = {}) {
  const model = options.model || process.env.OMNIROUTE_MODEL || DEFAULT_MODEL;
  const effort = options.reasoningEffort || process.env.OMNIROUTE_REASONING_EFFORT || undefined;
  const body = {
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.2
  };
  if (effort) body.reasoning_effort = effort;
  return body;
}

/**
 * Header della richiesta verso OmniRoute; aggiunge Authorization Bearer
 * quando è disponibile una chiave API (opzione { apiKey } o env OMNIROUTE_API_KEY).
 * @param {string} payload body già serializzato
 * @param {{apiKey?: string}} options
 * @returns {object}
 */
function omniRouteHeaders(payload, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  };
  const apiKey = options.apiKey || process.env.OMNIROUTE_API_KEY;
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  return headers;
}

/**
 * POST verso l'endpoint OmniRoute; risolve sempre con { statusCode, data }.
 * @param {object} body
 * @param {number} port
 * @param {{apiKey?: string, timeoutMs?: number}} options
 * @returns {Promise<{statusCode: number, data: string}>}
 */
function postOmniRoute(body, port, options = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    // timeout generoso: gemini-pro-agent fa reasoning e la gap analysis di 5-8 repo
    // richiede decine di secondi. Override: env OMNIROUTE_TIMEOUT o opzione { timeoutMs }.
    const timeoutMs = options.timeoutMs || Number(process.env.OMNIROUTE_TIMEOUT) || 120000;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: omniRouteHeaders(payload, options),
      timeout: timeoutMs
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, data }));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('OmniRoute request timed out'));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * Costruisce il prompt JSON-schema per OmniRoute.
 * @param {{categories: string[], tools: string[], agents: string[], mcpServers: string[]}} profile
 * @param {object[]} candidates CandidateRepo[]
 * @returns {string}
 */
function buildAnalysisPrompt(profile, candidates) {
  return `You are an expert security engineer and system architect for Cyboros Harness, a multi-agent penetration testing harness.

Current Cyboros Capabilities:
- Categories covered: ${(profile.categories || []).join(', ')}
- Registered Tools: ${(profile.tools || []).slice(0, 20).join(', ')}
- Registered Agents: ${(profile.agents || []).slice(0, 20).join(', ')}
- MCP Servers: ${(profile.mcpServers || []).join(', ') || 'none'}

Evaluate EACH of the following new GitHub projects for integration into Cyboros.
Return EXACTLY one JSON object per project (even for projects you would reject):
${candidates.map(c => `- ID: ${c.id}\n  URL: ${c.htmlUrl}\n  Description: ${c.description}\n  Stars: ${c.stars}\n  Topics: ${c.topics.join(', ')}`).join('\n\n')}

Gap analysis rules:
1. Compare each project against the Current Cyboros Capabilities listed above (tools, agents, categories). If the project duplicates an existing capability (e.g. an existing tool already covers the same attack class), set "relevant": false and explain the redundancy in "gapFilled".
2. For relevant projects, be specific about the concrete gap: name the Cyboros file/agent that would host the integration.
3. "integrationStrategy" values: TOOL_WRAPPER (add a zero-dependency Node.js script in tools/), MCP_SERVER (register in mcp.example.json / agent config), VENDOR_BINARY (precompiled binary into vendor/ or install-tools.sh), AGENT_PLAYBOOK (methodology into .agents/ or knowledge.md).
4. "priority" is a 1-5 integer (1 = integrate immediately, 5 = nice-to-have), balancing gap size, stars, maturity and effort.

Reply ONLY with a valid JSON array of objects with the following keys:
[
  {
    "repoId": "full_name",
    "relevant": true/false,
    "category": "Evasion / Recon / Exploit / MCP / Performance",
    "gapFilled": "Concise explanation of what this adds that Cyboros currently lacks (or why it is redundant if relevant=false)",
    "integrationStrategy": "TOOL_WRAPPER / MCP_SERVER / VENDOR_BINARY / AGENT_PLAYBOOK",
    "integrationRecipe": "Short actionable technical recipe: which file to edit or create",
    "riskEffort": "LOW / MEDIUM / HIGH",
    "priority": 1-5
  }
]`;
}

/**
 * Fallback deterministico senza LLM: classifica per topic/name (MCP vs tooling).
 * @param {object[]} candidates CandidateRepo[]
 * @returns {object[]} AnalyzedProposal[] (source: 'heuristic')
 */
function heuristicFallbackAnalysis(candidates) {
  return candidates.map(c => {
    const topics = c.topics || [];
    const isMcp = topics.some(t => t.includes('mcp')) || (c.name || '').includes('mcp');
    return {
      repoId: c.id,
      name: c.name,
      htmlUrl: c.htmlUrl,
      stars: c.stars,
      license: c.license,
      description: c.description,
      relevant: true,
      category: isMcp ? 'MCP Tooling' : 'Security Tooling',
      gapFilled: `Provides specialized capabilities in ${topics.slice(0, 3).join(', ') || 'offensive security'}`,
      integrationStrategy: isMcp ? 'MCP_SERVER' : 'TOOL_WRAPPER',
      integrationRecipe: isMcp
        ? `Register as MCP server in mcp.example.json`
        : `Add CLI wrapper in tools/${c.name}.js or vendor into vendor/`,
      riskEffort: 'MEDIUM',
      priority: c.stars >= 1000 ? 1 : c.stars >= 300 ? 2 : 3,
      source: 'heuristic'
    };
  });
}

/**
 * Query OpenAI-compatible endpoint OmniRoute su 127.0.0.1:<port>.
 * Se il gateway rifiuta reasoning_effort (400), riprova una volta senza quel parametro.
 * @param {string} prompt
 * @param {{port?: number, model?: string, reasoningEffort?: string}} options
 * @returns {Promise<string>} contenuto della risposta LLM
 */
async function queryOmniRoute(prompt, options = {}) {
  const port = options.port || 20128;
  const body = buildOmniRouteBody(prompt, options);

  let res = await postOmniRoute(body, port, options);
  // Gemini thinking effort: se il gateway non supporta reasoning_effort, degrada senza.
  if (res.statusCode === 400 && body.reasoning_effort) {
    const { reasoning_effort, ...withoutEffort } = body;
    res = await postOmniRoute(withoutEffort, port, options);
  }

  if (res.statusCode >= 400) {
    throw new Error(`OmniRoute error HTTP ${res.statusCode}: ${res.data}`);
  }
  const json = JSON.parse(res.data);
  return json.choices?.[0]?.message?.content || '';
}

/**
 * Gap analysis completa: OmniRoute con fallback euristico.
 * @param {object} profile CapabilityProfile
 * @param {object[]} candidates CandidateRepo[]
 * @param {{port?: number, model?: string, queryLlm?: Function}} options
 * @returns {Promise<object[]>} AnalyzedProposal[]
 */
async function analyzeCandidates(profile, candidates, options = {}) {
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

module.exports = { buildAnalysisPrompt, heuristicFallbackAnalysis, buildOmniRouteBody, omniRouteHeaders, queryOmniRoute, analyzeCandidates };