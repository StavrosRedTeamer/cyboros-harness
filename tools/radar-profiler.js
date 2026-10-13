'use strict';
// tools/radar-profiler.js — Cyboros Radar: codebase capability profiler.
// Scansiona .agents/, tools/ e vendor/ per estrarre agenti, tool, MCP server e
// categorie di vulnerabilità coperte. Zero dipendenze (node:fs, node:path).
//
// Uso: node tools/radar.js profile   (oppure import della funzione)

const fs = require('node:fs');
const path = require('node:path');

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

/**
 * @param {string} rootDir radice del progetto Cyboros Harness
 * @returns {{categories: string[], agents: string[], tools: string[], mcpServers: string[], vendors: string[]}}
 */
function profileCodebase(rootDir = process.cwd()) {
  // agenti in due posti: .agents/ = root attivo (canale cloud), local/fleet/ = specialisti
  // come playbook — vedi local/README-local.md
  const agentDirs = [path.join(rootDir, '.agents'), path.join(rootDir, 'local', 'fleet')];
  const toolsDir = path.join(rootDir, 'tools');
  const vendorDir = path.join(rootDir, 'vendor');

  const agents = [];
  const mcpServers = new Set();
  for (const dir of agentDirs) {
  if (fs.existsSync(dir)) {
    const agentFiles = fs.readdirSync(dir).filter(f => f.endsWith('.ts') || f.endsWith('.js'));
    for (const f of agentFiles) {
      agents.push(path.basename(f, path.extname(f)));
      try {
        const content = fs.readFileSync(path.join(dir, f), 'utf8');
        const mcpMatch = content.match(/mcpServers\s*:\s*\[([^\]]+)\]/);
        if (mcpMatch) {
          mcpMatch[1].split(',').map(s => s.replace(/['"\s]/g, '')).filter(Boolean).forEach(s => mcpServers.add(s));
        }
      } catch { /* file non leggibile: ignora */ }
    }
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

module.exports = { profileCodebase };