# Changelog

All notable changes to this project are documented here. Dates are commit dates.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project does not yet publish tagged releases, so entries are grouped by milestone
rather than by version number.

## [Unreleased]

### Added
- `tools/test-repo-history.js` — a gate on the git **history**, which nothing checked before:
  every ref must be free of engagement paths (`refs/`, `temp/`, `reports/`, `evidence/`,
  `*.bak.json`, `scope.json`…), every pair of refs must share an ancestor, and no blob may exceed
  1 MiB. It runs in CI as the `history` job, which checks out with `fetch-depth: 0` because a
  shallow clone cannot answer any of those questions (the tool says so loudly instead of passing).
  An index-only gate was what let the two problems below survive for months.
- Apache-2.0 license and a `SECURITY.md` with a safe-harbor policy, a private
  disclosure channel, and an explicit statement of which vulnerability classes
  count as guardrail bypasses.
- GitHub Actions CI: runs the offline suite on Node 22 and 24, asserts the
  zero-dependency invariant, and fails if engagement data (`temp/`, `scope.json`,
  `auth.json`, `c2.json`, `*.bak.json`, `reports/`, `artifacts/`) is ever tracked.
- `docs/ARCHITECTURE.md` — the guard / model / tool separation, the evidence ladder,
  and the deliberate non-goals.
- `npm run test:ci` — the suite with 2 workers, for CI where determinism of ordering
  matters less than wall time. `npm test` stays sequential by design.
- `tools/testkit.js` — the test scaffolding the suite kept copying (counter, `ok`,
  `okAsync`, `summary`, plus `fixture`/`writeScope`/`runCli`/`runCliAsync` helpers).
  `test-attack-coverage`, `test-loop-watch` and `test-reflector` already use it; the
  remaining copies are a ratchet in `test-repo-invariants`, so new tests cannot add a
  thirty-first variant of the same twelve lines.
- `tools/test-repo-invariants.js` — an offline gate on the repository's claims about
  itself: the counts declared in `README.md` must match the real test/agent/workflow/module
  counts, the prompt budget of the knowledge files cannot be exceeded, no CHANGELOG entry
  may "replace" `X` with `X`, no doc may point at a `tools/*.js` that does not exist, no
  new engine module may arrive without a line of documentation, the agent fleet must be
  coherent (unique ids, required fields, resolvable `spawnableAgents`), the test scaffold
  cannot be re-copied, and no hostname from the current `scope.json` may appear in a file
  tracked by git. Its two baselines (undocumented modules, copied scaffolding) are
  ratchets: they can only shrink.
- `tools/mcp-guard-proxy.js` — the supported way to close the one architectural hole
  this project documents about itself. Mounting a third-party MCP server behind it puts
  `scope-guard` and `ssrf-guard` in series with that server: every `tools/call` is judged
  with the same functions the in-process tools use (`inScope`, `net.resolveAndGuard` for the
  DNS-rebinding layer, `checkAddress` on the pinned address), blocked calls never reach the
  server and answer the agent with an explicit error, and every verdict (`allow-scoped`,
  `allow-unscoped`, `block`) is appended to `reports/tmp/mcp-guard.jsonl`. Limits are
  declared in the header and in `docs/ARCHITECTURE.md`: targets are extracted from the
  arguments, and an in-scope hostname that cannot be resolved is refused (fail-closed).
- `tools/test-mcp-guard-proxy.js` — offline coverage for the proxy: passthrough of
  non-`tools/call` methods, block outside scope, block of the metadata tier even when
  `scope.json` authorizes it, allow on an in-scope target, the audit trail, request-order
  preservation, and the judgement function directly for the rebinding and fail-closed cases.
- `doctor.js --show-hosts` / `--fix-perms` — the human-readable output redacts the
  engagement allowlist by default (`N host + M CIDR`), because that output lands in
  screenshots and reports (`--json` stays complete: the Command Center is its consumer),
  and a new section 7 reports engagement secrets readable by other users on the same
  machine, with `--fix-perms` to set them to 0600. `doctor --check` exits 1 while any of
  them is exposed.

### Changed
- Agent-fleet prompts de-duplicated against their single owner. The eight discipline rules and
  the RAG recall paragraph were copied verbatim into 19–29 of the 29 `.ts` files in
  `local/fleet/` + `.agents/`: 86 KB of the fleet's 185 KB, up to 29 byte-identical copies of the
  same 800-byte line. The copies could not be replaced by a bare reference, because the prompt
  assembly was measured first: `ops/harness.md` is a *pointer target*, not an injected knowledge
  file — zero of its bytes reach the assembled prompt (only `<project>/AGENTS.md` and
  `~/.AGENTS.md` are injected), so the owner never "arrives" on its own. Each prompt therefore
  keeps a **compressed in-context index** (every rule with its threshold and its command) and the
  owner keeps the extended text, now including a `## Memoria (RAG)` section it was missing. The
  authorization block stays byte-identical in all 29 files: it has no external owner, and the
  failure it prevents — refusing an in-scope task — fires *before* the first file read, so no
  pointer can prevent it. Class-specific variants (`stavros-llm`, `stavros-exploit`) were left
  intact rather than flattened. Fleet 184,810 → 154,296 bytes, duplicate blocks 86,086 → 51,986.
- `tools/test-repo-invariants.js` gained a three-part ratchet on that de-duplication: no line
  ≥100 characters may repeat in ≥3 fleet files outside the declared canonical allow-list (the
  authorization block, the harness pointer, the compressed index, the RAG pointer, the MCP
  config), the canonical blocks must still be present in every file that must carry them (so the
  first check cannot be passed by deleting them), and every rule compressed out of the prompts
  must still exist in `ops/harness.md` — "no instruction lost" as a machine check.
- `README.md` engine-module count corrected 139 → 140: `tools/workspace-gc.js` had been added
  without updating it, so `test-repo-invariants` was failing on a clean checkout of `master`.
- `README.md` rewritten in English around the evidence-discipline and guardrail
  positioning, with the previously unstated differentators (zero dependencies,
  air-gapped operation, offline test suite) stated up front. Corrects stale
  structure claims: agents live in `local/fleet/`, and `vendor/` is no longer
  part of the repository. Its declared numbers now track reality (92 tests executed
  in ~1 minute, 28 agent definitions, 139 engine modules) and a test keeps them
  there instead of a stale 89/217.
- Real client names removed from documentation, scripts and test fixtures
  (`com.example.fest`, `acme.test`). Three tracked files still carried one client
  hostname after the previous pass — `local/plan.js`, `tools/stavros.js`,
  `tools/test-local-plan.js` — and now use RFC 2606 `.example` names.
- `doctor.js` counts the agent fleet where it actually lives (`local/fleet/` plus the
  root agent in `.agents/`). It previously required 20 `.agents/*.ts` files, so a
  healthy checkout — and CI — reported `core rotto=SÌ` on every run. `scope.json` is
  gitignored by design and no longer counts as a broken cardinal file.
- `vet-agents-vs-freebuff.js` vets both agent directories (29 agents) instead of the
  single root file left in `.agents/`, fails closed when it finds nothing to vet, and
  reports the Freebuff-only prompt fields as one aggregated advisory for `local/fleet/`
  instead of 28 errors (that schema binds the CLI, not the local runner).
- `tools/test-authn-depth.js` and `tools/test-sc1.js` are hermetic: own `SCOPE_JSON`,
  own `PACE_FILE`, no operator lab host, no dependence on the ambient `scope.json`.
  The race-watch checks in `test-authn-depth` failed intermittently in a full-suite run
  because the global cross-process limiter (`tools/.pace.json`) spread the `--race`
  volley out; `test-sc1` asserted a real HTTP 200 from a LAN-only lab address, so the
  offline gate could not pass anywhere else.

### Fixed
- `run-tests.js` now fingerprints the engagement files (`scope.json`, `auth.json`, `c2.json`,
  `wifi-scope.json`, `mobile-scope.json`) before and after every test: a test that rewrites the
  operator's written authorization — directly, or through a tool that falls back to the default
  path instead of an env override — fails loudly with the file names instead of being invisible.
- `gui-server.js saveScope()` cannot silently shrink the authorization any more: removing
  hosts requires `confirm_removals:true`, the serialized result is validated before the write,
  and the previous version is copied to `scope.*.bak.json` (gitignored) first. Writes through
  the service also re-apply 0600 to the engagement files.
- `test-sc1.js` no longer contacts an operator lab host (it binds its own loopback
  server and uses the documented opt-in), and the client lab address is gone from the
  tracked tests and fixtures.
- The Freebuff harness-mechanics notes moved from `AGENTS.md` to `ops/harness.md`
  (identical text, ~7 KB): they are maintenance reference for the wiring, and having them
  in every system prompt is what pushed the assembled prompt to 24 KB against the ~20 KB
  budget the workspace sets for itself. `test-repo-invariants` now holds that budget as a
  gate, and `check-identity.js` distinguishes "prompt too big" from "measurement taken on a
  snapshot older than the knowledge files" instead of reporting a stale number as a failure.
- `.gitignore` covers editor swap files (`*.kate-swp`, `*.swp`) and a `local-only/` home for
  one-off engagement scripts: a swap file of `scope.json` holds the same engagement data as the
  file itself, and the per-name rules for one-off scripts only catch the names someone thought of.
  CI asserts the ignore rules still cover the engagement paths, instead of listing them by hand.
- `.gitignore` never matched `scripts/probe-*.py` against `scripts/probe_ajax.py`,
  letting one-off engagement scripts — containing live session keys — through.
- `.gitignore` did not cover `temp/` (265 MB of per-engagement work: decompiled
  APKs, captured target HTML, caches, real hosts) or `scope.*.bak.json`.
- New stray backup files (`*.bak`, `*.v1-forensic`, `*.orig`, `*.rej`) are now
  ignored.

### Security
- The git history was rewritten to remove two things that a published clone would have exposed,
  neither of which is visible from the working tree or the index. **`refs/`** — the corpus with
  the licensing gap documented in `docs/REFS-PROVENANCE.md` — had been taken out of the index and
  gitignored, but was still present in 131 blobs (2.3 MB) across the history of `master`;
  `git filter-repo` rewrote all 31 commits without it. **`perf/pacing-and-cache`** was a lineage
  with no common ancestor with `master` (25 commits, root 2026-08-22) that carried ~70 MB of
  uncompressed engagement material — a 37 MB `arduino-cli`, a client source map
  (`evidence/noa4-synaptic/joinnoa-main.map`), a captured page (`evidence/raw/kela_succ.html`) —
  and was pushed to `origin`. A history with no common ancestor never reaches `master` through a
  merge, so no review of this repository would have shown it. It was deleted from `origin` and
  locally, along with `command-center-redesign` (an ancestor of `master`, nothing unique). The
  repository is one lineage again: pack 49.49 MiB → 2.08 MiB, objects 5,317 → 722, `.git`
  52 MB → 2.3 MB, refs/ blobs in history 131 → 0. Every commit got a new SHA, and the pre-rewrite
  state is preserved in a `git bundle --all` kept outside the repository and never pushed.

## 2026-09-26 — Command Center (WP2–WP9)

A desktop surface over the harness: campaign → mission → approval → execution →
verification → report → evidence. It is a surface, not a gate — it adds no bypass
and every write is a wrapper over an existing tool.

- **WP2** PyQt6 desktop shell `stavros-cc` with a panic switch that stops only
  harness-owned processes.
- **WP3** campaign model, templates, additive `/api/cc/*` router.
- **WP4** approval inbox with consent tokens (additive, default-off) — a confirm-tier
  action cannot start without a granted, non-reusable, host-bound token.
- **WP5–WP6** mission control, ledger/evidence bundle with hashed manifest, attack
  graph, coverage views.
- **WP7–WP8** engagement/attack/control rail, zero-build view split.
- **WP9** two-minute end-to-end demo, plan status, F3 tunneled-client runbook.

## 2026-09-27 — Local runtime and agent fleet split

- The 28 agent definitions moved from `.agents/` to `local/fleet/` (pure rename),
  separating the Freebuff-managed set from the runner that drives `tools/` directly.
- `local/`: a standalone runner (llm, grammar, plan, chat, tools-bridge, loop-guard)
  with its own config and no cloud dependency.
- `tools/`: radar (scout/profiler/analyst), Frida scripts, mobile pairing and
  repack, attack galaxy and coverage, portal, takeover, distiller, embeddings,
  cc-arsenal, tool-path, plus the harness self-probes
  `vet-agents-vs-freebuff.js` / `check-identity.js`.
- `workflows/`: 14 reusable `enum-*` / `attack-*` pipelines (HTTP, JWT, GraphQL,
  LDAP, SMB, Mongo, MSSQL, Redis, SNMP, container).

## 2026-09-10 — Context and binary footprint

- **Fase A**: `knowledge.md` reduced to 12 KB (from 41.8 KB) and the playbook
  `SKILL.md` split into `references/`, cutting the always-in-context load for all
  28 agents.
- **Fase B**: heavy vendored binaries (obscura, frida-server) moved to an external
  root resolved through `tools/vendor-dir.js`, keeping them out of the repository.

## 2026-09-08 — GUI redesign (phases 1–6)

Design tokens, primitives, rail and palette; overview stat tiles and findings trend;
a dense findings table with detail drawer; the pipeline rendered as a phase DAG;
sessions agent table with detail drawer; and cross-cutting polish for scope, reports,
accessibility, performance and responsive layout.

## 2026-09-06 — Initial workspace

The harness as a self-contained folder: zero-dependency tool engine, agent fleet,
engagement methodology, and the scope guards that everything else sits on top of.
