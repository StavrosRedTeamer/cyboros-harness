'use strict';
// tools/radar-scout.js — Stavros Radar: GitHub & web discovery engine.
// Query GitHub Search API per topic (redteam, pentest, mcp, ...), filtra
// candidati già visti/archiviati/vecchi/pochi-stelle e deduplica per full_name.
// Zero dipendenze (node:https). Supporta GITHUB_TOKEN e gestisce 403/429.
//
// Uso: node tools/radar.js run   (oppure import delle funzioni)

const https = require('node:https');

/**
 * Filtra e normalizza item grezzi della GitHub Search API.
 * @param {object[]} items item grezzi da api.github.com/search/repositories
 * @param {{seen?: Record<string,string>}} cache
 * @param {{minStars?: number, maxDays?: number}} opts
 * @returns {object[]} CandidateRepo[]
 */
function filterAndDeduplicateRepos(items, cache = { seen: {} }, opts = {}) {
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

/**
 * Query singola alla GitHub Search API. Resolve sempre: rate limit (403/429)
 * => { rateLimited: true, items: [] }; errori di rete/timeout => reject.
 * @param {string} query
 * @param {string} [token]
 * @returns {Promise<{rateLimited: boolean, items: object[]}>}
 */
function fetchGithubQuery(query, token = process.env.GITHUB_TOKEN) {
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

/**
 * Scouting completo: esegue le topic queries, filtra/deduplica e ritorna i
 * migliori candidati (per stelle) fino al limite richiesto.
 * @param {{seen?: Record<string,string>}} cache
 * @param {{queries?: string[], githubToken?: string, minStars?: number, limit?: number, fetcher?: Function}} opts
 * @returns {Promise<object[]>} CandidateRepo[]
 */
async function scoutRepositories(cache = { seen: {} }, opts = {}) {
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

module.exports = { filterAndDeduplicateRepos, fetchGithubQuery, scoutRepositories };