# Changelog

All notable changes to this project are documented here. Dates are commit dates.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project does not yet publish tagged releases, so entries are grouped by milestone
rather than by version number.

## [Unreleased]

### Added
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

### Changed
- `README.md` rewritten in English around the evidence-discipline and guardrail
  positioning, with the previously unstated differentators (zero dependencies,
  air-gapped operation, offline test suite) stated up front. Corrects stale
  structure claims: agents live in `local/fleet/`, and `vendor/` is no longer
  part of the repository.
- Real client names removed from documentation, scripts and test fixtures
  (`com.example.fest` → `com.example.fest`, `acme.test` → `acme.test`).

### Fixed
- `.gitignore` never matched `scripts/probe-*.py` against `scripts/probe_ajax.py`,
  letting one-off engagement scripts — containing live session keys — through.
- `.gitignore` did not cover `temp/` (265 MB of per-engagement work: decompiled
  APKs, captured target HTML, caches, real hosts) or `scope.*.bak.json`.
- New stray backup files (`*.bak`, `*.v1-forensic`, `*.orig`, `*.rej`) are now
  ignored.

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
