# Stavros Radar — Design Specification

**Status:** Approved  
**Date:** 2026-09-08  
**Scope:** `stavrosredteamer` Project Scouting & Ecosystem Intelligence Subsystem  

---

## 1. Executive Summary

Stavros Radar is an autonomous intelligence and capability-scouting subsystem for **StavrosRedTeamer**. It inspects the local codebase to map existing agents, tools, and vulnerability playbooks, discovers emerging open-source repositories and security tooling on GitHub/web, evaluates the technical delta using a local LLM via **OmniRoute** (`http://localhost:20128/v1`), and synthesizes prioritized, actionable integration recipes into periodic reports.

---

## 2. Global Constraints & Principles

1. **Zero External Dependencies**: Must run on standard Node.js (v20+) using native modules (`node:https`, `node:fs`, `node:path`, `node:crypto`). No third-party npm libraries required.
2. **Local AI Inference**: Integrates directly with the active OmniRoute gateway at `http://localhost:20128/v1` for reasoning, semantic analysis, and recipe drafting.
3. **Resilient Fallback**: If OmniRoute is temporarily offline or unconfigured, the pipeline falls back gracefully to deterministic heuristic ranking (stars, freshness, keywords) without failing.
4. **Rate Limit Resilience**: Works with unauthenticated GitHub Search API, respects HTTP 403/429 limits with exponential backoff, and automatically leverages `GITHUB_TOKEN` from the environment if present.
5. **Fail-Closed Deduplication**: Stores processed repositories in `reports/radar/cache.json` to prevent re-evaluating or re-recommending the same project across runs.
6. **Strict Test Coverage**: Fully covered by offline integration tests runnable via `npm test` without making live network calls during normal testing.

---

## 3. Architecture & Components

```
stavrosredteamer/
├── tools/
│   ├── radar-profiler.js     # Extracts local capabilities from .agents, tools, refs, knowledge.md
│   ├── radar-scout.js        # Discovers relevant repositories from GitHub Search API & topics
│   ├── radar-analyst.js      # Interacts with OmniRoute to evaluate delta & integration recipes
│   ├── radar.js              # Main CLI entrypoint and report aggregator
│   └── test-radar.js         # Unit and offline integration tests
├── reports/radar/
│   ├── cache.json            # Persistent deduplication index (seen repositories & verdict history)
│   └── radar-YYYY-MM-DD.md   # Generated Markdown reports
└── ops/
    ├── radar.service         # Systemd user service unit definition
    └── radar.timer           # Systemd user timer unit definition (e.g. weekly execution)
```

### Component Details

#### 3.1 `tools/radar-profiler.js` (Codebase Capability Profiler)
- **Inputs**: Filesystem paths (`.agents/*.ts`, `tools/*.js`, `refs/**/*.md`, `knowledge.md`, `package.json`).
- **Functionality**:
  - Scans `.agents/*.ts` to extract agent names, system prompts, role definitions, and registered MCP servers (`chrome-devtools`, etc.).
  - Scans `tools/*.js` to extract available scripts, utility names, and descriptions (e.g., `scope-guard`, `repeater`, `run`, `login`, `c2-pipeline`).
  - Scans `knowledge.md` and `refs/` to extract target vulnerability categories and attack methodologies.
- **Output**: `CapabilityProfile` object:
  ```json
  {
    "categories": ["web-recon", "active-scanning", "auth-bypass", "ssrf", "sqli", "wifi", "c2", "cdp-browser", "reporting"],
    "registeredAgents": ["recon", "mapper", "tester", "reporter", "wifi-hunter", ...],
    "registeredTools": ["scope-guard.js", "repeater.js", "run.js", "c2-server.js", ...],
    "mcpServers": ["chrome-devtools"],
    "installedVendors": ["obscura", "frida-server", "poc-archive"]
  }
  ```

#### 3.2 `tools/radar-scout.js` (GitHub & Web Discovery Engine)
- **Inputs**: Target topic queries (`topic:redteam`, `topic:pentest`, `topic:mcp-server`, `topic:bugbounty`, `topic:security-tools`), minimum star threshold (default: >= 50), max age of last commit (< 365 days).
- **Functionality**:
  - Queries `https://api.github.com/search/repositories?q=...&sort=updated&order=desc`.
  - Filters out repositories already present in `reports/radar/cache.json` or matching existing vendor names.
  - Limits selection to top 5-10 highest quality candidates per execution.
  - Supports `GITHUB_TOKEN` environment variable for 5,000 req/hour limit, with graceful error handling and rate-limit detection.
- **Output**: Array of `CandidateRepo` objects:
  ```json
  [
    {
      "id": "full_name",
      "name": "repo-name",
      "htmlUrl": "https://github.com/...",
      "description": "...",
      "stars": 420,
      "updatedAt": "2026-08-15T...",
      "topics": ["pentest", "mcp", "recon"],
      "license": "MIT"
    }
  ]
  ```

#### 3.3 `tools/radar-analyst.js` (OmniRoute AI Gap & Integration Analyst)
- **Inputs**: `CapabilityProfile` from profiler + `CandidateRepo[]` from scout.
- **Functionality**:
  - Connects to OmniRoute OpenAI-compatible endpoint: `http://localhost:20128/v1/chat/completions`.
  - Prompts the LLM with a concise JSON schema request asking for each candidate:
    - **Category & Relevance**: Does this tool belong in StavrosRedTeamer?
    - **Gap Analysis**: What specific capability, efficiency gain, or evasion technique does it offer over existing Stavros tools?
    - **Integration Strategy**:
      - `TOOL_WRAPPER`: Add zero-dependency Node.js script in `tools/`.
      - `MCP_SERVER`: Register as a new MCP server in `mcp.example.json` / agent config.
      - `VENDOR_BINARY`: Add precompiled binary to `vendor/` or `install-tools.sh`.
      - `AGENT_PLAYBOOK`: Integrate prompt/methodology into `.agents/` or `knowledge.md`.
    - **Risk & Complexity**: Low, Medium, High.
  - Parses JSON response with schema validation and fallback handling.
- **Output**: Array of `AnalyzedProposal` objects.

#### 3.4 `tools/radar.js` (Main CLI & Report Generator)
- **Commands**:
  - `node tools/radar.js run`: Executes full pipeline (profile -> scout -> analyze -> report -> cache update).
  - `node tools/radar.js profile`: Prints current project capability inventory to terminal.
  - `node tools/radar.js status`: Shows cache stats (number of evaluated repos, last scan timestamp).
- **Report Writing**:
  - `reports/radar/radar-YYYY-MM-DD.md`: Human-readable markdown report with badges, links, and integration snippets.
  - `reports/radar/radar-YYYY-MM-DD.json`: Machine-readable artifact.
  - Updates `reports/radar/cache.json` with processed repository identifiers.

---

## 4. Error Handling & Edge Cases

| Failure Scenario | Fallback Behavior |
|------------------|-------------------|
| OmniRoute server unreachable on port 20128 | Log warning, skip AI enrichment, generate heuristic report based on stars/tags. |
| GitHub API rate limit hit (HTTP 403/429) | Log clear warning suggesting `GITHUB_TOKEN`, save partial results, exit with code 0. |
| Malformed JSON from LLM response | Attempt regex extraction; if unparseable, fall back to heuristic metadata without crashing. |
| Missing directories (`reports/radar`) | Automatically create directories recursively (`mkdirSync({ recursive: true })`). |

---

## 5. Testing & Verification

- `tools/test-radar.js`:
  - **Profiler Test**: Verifies accurate extraction of categories and tool names from local repo files.
  - **Scout Mock Test**: Simulates GitHub API response, confirms filtering and deduplication logic against a mock cache.
  - **Analyst Mock Test**: Simulates OmniRoute API response, verifies parsing of proposals into structured report data.
  - **Runner Test**: Dry-run of `radar.js` to ensure clean exit code and valid report generation.
- Integrated into `npm test` via `package.json` test runner.
