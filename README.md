<div align="center">

# Cyboros Harness

**A penetration-testing harness where a finding is only a finding if code can prove it —
and where the lesson of one engagement changes the next.**

[![CI](https://github.com/stavrosredteamer/cyboros-harness/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/stavrosredteamer/cyboros-harness/actions/workflows/ci.yml)
[![License: Apache-2.0 + commercial-use restriction](docs/assets/license-apache-2.0.svg)](LICENSE)

[Apache-2.0, with a commercial-use restriction](LICENSE) · zero dependencies · offline-capable · 132 tests, hermetic and parallel

[Cyboros](docs/OUROBOROS.md): cyber + ouroboros. The loop is not marketing — every claim on
that page names the file that proves it. The agent still cannot violate scope, because the
enforcement is beneath it.

<img src="docs/assets/demo.gif" alt="A shell session: an empty scope blocks the target, a Critical finding on a suspected rating is rejected, a 'verified' claim with no oracle is refused, then the guard tests pass" width="820">

<sub>Three refusals and a green gate — real output of `DEMO_FAST=1 DEMO_PACE=3 ./tools/demo.sh`, not an edit.</sub>

![Command Center overview](docs/assets/command-center-overview.png)

</div>

---

Most AI pentest agents are built to *find* things. This one is built to *refuse to
report things it cannot prove*. That is a different engineering problem, and it is the
one that keeps the whole field honest. The published lab-to-real gap is stark: handed
the advisory text, GPT-4 exploited **87%** of one-day vulnerabilities while *every other
model tested scored 0%* ([Fan et al. 2024](https://arxiv.org/abs/2404.08144)); pointed
at real web targets with no description to lean on, the strongest agent framework
resolved **up to 13%** ([Zhu et al., CVE-Bench, ICML 2025](https://arxiv.org/abs/2503.17332)).
On hard HackTheBox boxes our own runs sit near zero — that last figure is *our* unreleased
observation, not a published result, and we label it that way wherever we repeat it. The
bottleneck is not generation. It is **proof**.

So this harness moves the policy out of the prompt and into the runtime.

> **Evaluating Cyboros for a security team or an organization?** Start with
> [`docs/ADOPTION.md`](docs/ADOPTION.md) — a due-diligence page on authorization,
> client-data governance, auditability and the tool's own security posture, each
> answer naming the file that proves it.

## Two ideas

**1. The agent is not the policy. The runtime is.**

Every other agent in this space handles authorization with a sentence in its README
and then gives the model a shell. Here, the guards are separate programs that run
*below* the model, and they are fail-closed:

- `scope-guard.js` — nothing runs against a host absent from `scope.json`. Empty
  `scope.json` means everything is blocked. There is no flag to disable it.
- A **DNS-rebinding guard**: an in-scope hostname that resolves to a private,
  loopback or link-local address is refused unless that subnet is in `allowed_ips`.
- **Tiered confirmation** for destructive or high-impact actions, and **consent
  tokens** so a confirm-tier action cannot start without an explicit operator grant.
- Rate limits and pacing enforced in-process, not suggested to the model.

The agent can decide to attack. It cannot decide *whether it is allowed to*. The
design principle is simple enough to state in a code review: **a refusal by the
model is a bug, because the guard already made that decision.** Policy belongs in
something the model cannot talk its way past.

**2. Severity can never exceed evidence.**

`record-finding.js` enforces a verification ladder, and rejects incoherent records
rather than warning about them:

| `verify_level` | means | severity ceiling |
|---|---|---|
| `suspected` | plausible, not reproduced | Low |
| `triggered` | condition triggered, not exploited | Medium |
| `exploited` | full exploit chain demonstrated | High |
| `proven_impact` | real impact proven (data read, ATO, RCE) | Critical |

Declare `proven_impact` without a valid oracle and the finding is refused. A finding
that claims reality — `status: verified`, or `exploited`/`proven_impact` — must carry
an **oracle**: a machine-re-executed proof the harness runs itself, N/N times, live.

```json
"verify": {
  "method": "GET", "url": "https://HOST/api/x", "as": "user_a",
  "expect": { "status": 200, "body_contains": "unique-marker" }
}
```

Beyond `status` and `body_contains`, `body_similarity_to` catches the same-length
IDOR that a substring check misses. Every finding also gets an independent
re-verification pass by a separate verifier agent, and `gen-poc.js` writes a
parameterized Python reproducer (`exit 0` = reproduced) so a human can re-run it
without trusting the harness.

Stage gates close the loop: coverage matrix complete, no pending findings, at least
one verified, or **no report is produced at all**.

Findings also leave as **SARIF 2.1.0** (`tools/report-sarif.js`), which GitHub code scanning
and DefectDojo consume unmodified. The evidence ceiling travels with each result in
`properties.cyboros` — `verify_level`, its severity ceiling, the oracle reference — because a
generic consumer cannot infer it. A record whose severity exceeds its verification level is
**refused** and the exporter exits non-zero, so a run that dropped findings cannot pass as a
clean scan.

## Why it might interest you

- **Zero dependencies.** No lockfile, no transitive supply chain, nothing to audit but
  the 53k lines in this repository. CI fails the build if that ever stops being true.
  On a client network, `npm install` does nothing.
- **Runs air-gapped.** `local/` drives the same deterministic engine against a local
  model. No API key, no data leaving the engagement laptop.
- **132 tests, hermetic and parallel by default, no network.** Offline and loopback tests,
  classified by the runner; `npm test` is the gate, `npm run test:all` includes the live e2e
  set. Tests keep the engine's shared state — the global rate limiter, the run audit, the
  findings head-anchor, the egress-proxy state — in a fixture (`hermetic()` in
  `tools/testkit.js`) instead of the workspace, so two runs cannot influence each other;
  measured on a 12-core box at `--jobs 2` (default): 22,7 s vs 42,2 s sequential, `--jobs 4`
  13,6 s, counts identical. On a loaded shared machine the same suite still takes minutes.
- **Evidence memory that compounds.** `memory/` keeps sanitized technique→outcome
  lessons across engagements, with a sanitizer that refuses to store in-scope hosts,
  emails, tokens or credentials.

## Quick start

### Prerequisites

- **Node ≥ 22** — `.nvmrc` pins the major, and `package.json` declares it in `engines`; the
  Command Center backend uses `node:sqlite`, which is why the floor is that high. Nothing
  else: zero dependencies means no lockfile, no `node_modules`, no registry hit.
- **git**, to clone.
- Linux and macOS run the harness natively. On Windows the core harness is plain Node, so it
  runs there too; the extended offensive arsenal (step 5 below) installs via
  `install-tools.ps1` instead of `install-tools.sh`.

### 1. Clone and run the test suite

```bash
git clone https://github.com/stavrosredteamer/cyboros-harness.git
cd cyboros-harness
npm test                 # 132 tests, no install, no network, 2 workers (--jobs 1 to serialize)
```

This is also how you verify the clone: a green suite means the guards, the oracle discipline
and the reporting pipeline all behave as documented on your machine, before you point
anything at a real target. A `pretest` hook (`tools/ensure-test-scope.js`) writes a
loopback-only `scope.json` the first time, purely so the fail-closed guard below has
something to authorize for the offline/loopback tests — it only ever creates that file, never
touches one you already wrote.

If the run fails before a single test starts, check `node --version` against the
Prerequisites above. If it fails partway through, `node tools/doctor.js` says exactly what's
missing (see Troubleshooting).

### 2. Write your authorization

`scope.json` **is** the written authorization, and the harness is fail-closed until you fill
it in — empty or absent, every target is blocked, with no flag to override it. Replace the
loopback-only file step 1 created with your real scope:

```json
{
  "allowed_hosts": ["target.example"],
  "allowed_ips": ["10.0.0.0/8"],
  "max_requests_per_second": 2
}
```

### 3. Run it against something in scope

```bash
node tools/scope-guard.js check https://target.example   # exit 0 = authorized
node tools/cyboros.js recon target.example
node tools/cyboros.js scan target.example
node tools/cyboros.js status
npm run tui              # terminal surface: scope.json is real, no model call until --live
```

### 4. Get `cyboros` as a command (optional)

Bare `cyboros` opens the TUI, the subcommands keep the pipeline — run the launcher once and
forget the path:

```bash
./scripts/install-cyboros-launcher.sh   # symlink into ~/.local/bin (idempotent, --uninstall to remove)
cyboros                         # TUI
cyboros scan target.example     # same pipeline as node tools/cyboros.js
```

### 5. Install the extended tool arsenal (optional)

The core harness — guards, pipeline, reporting, TUI — needs nothing beyond Node. Offensive
binaries (nmap, sqlmap, the recon/wireless/mobile tool-plane) are a separate, optional layer:

```bash
./install-tools.sh       # Parrot/Debian
# or
install-tools.ps1        # Windows
node tools/doctor.js     # confirms what landed, and what's still missing
```

A workstation without the extended arsenal still runs the core harness in full; `doctor.js`
just reports the gap instead of hiding it.

### Troubleshooting

- **`scope-guard.js check` exits non-zero** for a host you just added — this is correct until
  the JSON in `scope.json` parses and the host/IP matches exactly (`allowed_hosts` wants bare
  hostnames, `allowed_ips` wants CIDR). An empty or missing file blocks everything by design.
- **`doctor.js` lists binaries as `MISS`** under the tool-plane sections — expected on a bare
  clone before step 5; none of them are required for `npm test`, the scope guard, or the TUI.
- **`node:sqlite` errors** from the Command Center backend mean Node is older than 22 — see
  Prerequisites. On Node 22/23 a harmless `ExperimentalWarning: SQLite is an experimental
  feature` appears the first time a command opens the state database; it disappears once the
  module graduates and needs no action.

### Live agent with your own provider

The terminal agent can drive a real model. Copy the provider template — the key lives
in the environment, never in the file, and an inline `api_key` is refused:

```bash
cp runtime/providers.example.json runtime/providers.json   # gitignored
export OPENROUTER_API_KEY=...                              # or any OpenAI-compatible key
# or, instead of exporting, keep it in ~/.config/cyboros/openrouter.env (chmod 600)
cyboros --live target.example          # asks once, at the first message, before any egress
cyboros --allow-cloud target.example   # the flag also connects at launch
```

The key is read from the environment, or from `~/.config/cyboros/<profile>.env` when it is
mode 600; an inline `api_key` in `providers.json` is still refused.

#### What a profile declares

A provider is not "OpenAI-compatible" and a pile of exceptions: it is a `type` plus a
`capabilities` block, and the request builder (`local/adapters.js`) sends **only** what that
block declares. An unknown key is refused when the file is loaded — a typo that silently
does nothing is the bug this replaces.

| Capability | Controls | Undeclared |
|---|---|---|
| `tool_calls` | `native` (send `tools`) or `text` (parse `ACTION:` only) | `native` |
| `tool_choice` | whether `tool_choice: "auto"` is sent | not sent |
| `parallel_tool_calls` | `true`/`false` field, or `null` to leave it out | not sent |
| `reasoning: {param, on, off}` | the **shape** of the thinking switch: `chat_template_kwargs` (llama.cpp), `thinking` (DeepSeek), `reasoning_effort`, or `none` | no thinking field is ever sent |
| `reasoning_field` | where streamed/returned reasoning lives: `reasoning_content`, `reasoning`, or `null` | reads either name; writes nothing |
| `reasoning_echo_with_tools` | send prior reasoning back so a tool turn can continue | not echoed |
| `strict_unknown_fields` | the body is asserted against the declared capabilities before it leaves | no assertion |
| `grammar` | accepts llama.cpp's GBNF `grammar`; it also withholds the tool schema, since the grammar *is* the contract | not sent — and asking for one anyway is an error, not a silent downgrade |
| `timings` · `stream_options` · `sampling_extras` | `timings_per_token`, `stream_options.include_usage`, `top_k`/`*_penalty` | not sent (except `stream_options`, which `openai-compatible` declares: it is the standard usage chunk) |
| `context_window_tokens` · `reserved_output_tokens` · `context_safety_tokens` | the context budget: window − output − safety | falls back to the legacy `context_char_budget`, and the TUI says so |
| `max_output_tokens` | ceiling applied to `max_tokens` | the profile's `max_tokens` |
| `pricing {input_per_1m, output_per_1m, cached_input_per_1m}` | cost when the provider does not report one | cost shown as unknown, never invented |

Three types ship, and each default matches what its name claims: `openai-compatible` is the
bare chat-completions shape (the standard `stream_options` usage chunk, every vendor
extension off unless declared), `llama-cpp` adds the llama.cpp extensions this project uses
(`grammar`, `timings`, `sampling_extras`), and `deepseek` assumes a strict cloud endpoint
with its thinking shape and reasoning echo. `runtime/providers.example.json` contains a worked example of each —
every number in it is an overridable default, not a claim: change the key and the next
request follows.

The adapter also arbitrates what a caller cannot: a GBNF grammar and a native tool schema
are mutually exclusive, so a declared grammar withholds the schema, and a grammar requested
on a profile that never declared one **fails the request** instead of quietly sending
neither. There is no path where a run loses tool-calling without an error.

#### From declared to measured

A declaration is a default until something asks the endpoint. `tools/provider-probe.js`
does, with a bounded number of requests and no guessing:

```bash
node tools/provider-probe.js plan                       # zero requests: count, tokens, cost
node tools/provider-probe.js run --max-requests 24 --yes
```

It measures what a run can trip over — whether fields it does not know are refused, whether
`tool_choice` and a GBNF `grammar` are accepted, which field carries the reasoning and
whether it must be echoed back when tools are present, whether a streamed request reports
usage, and the usable context window found by probing rather than read out of the profile.
Each result is `measured` with the evidence that produced it, or `unknown` with the reason;
an unreachable endpoint or a missing key produces an `unmeasured` record holding **no
numbers**, so a default can never come back dressed as a measurement. `run` refuses without
`--yes`, without an explicit cap, and when the plan needs more requests than the cap allows;
the client is the one a turn uses, so the cloud-egress and key gates apply unchanged.
Results land in `reports/provider-measurements.json`, keyed by profile and by a hash of
`base_url|model`: `local/adapters.js` applies them only where the endpoint still matches,
and only in the safe direction — it will stop sending a field the endpoint refuses, but
never enlarge what is sent because an unknown field happened to be accepted once.
`node tools/doctor.js --check` reports which of the two states a profile is in.

#### Continuing a session

A turn is persisted as it completes, not when the process exits. `state.json` next to
`events.jsonl` holds the history the next turn would send, the facts extracted from it
(targets, artifacts, findings, actions — from the compactor's own extractor) and the run's
identity. A kill, a crash or a closed terminal no longer means rediscovering the host:

```bash
node runtime/tui.js --resume 20261022T091500-a1b2c3
# or, inside the REPL: /resume <id> — the next /live turn continues it
```

Resume validates before it trusts. The payload is hashed on write and re-hashed on read, so
a truncated or hand-edited file is refused with the reason; a history that fails the send
boundary is repaired and the repair is named; one that cannot be made valid is refused
rather than half-sent; a session older than seven days needs `--allow-stale`, because
resuming a week-old engagement unnoticed is how a stale map gets treated as current.
`/resume` reports what actually came back — messages, targets, findings, artifacts,
actions — and what was trimmed or repaired. `/sessions` marks which sessions have state and
which cannot be continued.

It is one assistant, not two: the same session runs the engagement and answers questions
about it. Ask `what did we find on this host?` and it reads `findings_query`,
`sessions_list` or `session_read` instead of scanning; ask it to verify an object and it
calls `scope_check` then the guarded tools.

The surface is Claude Code's shape: a rounded input box with `>` that redraws as you type,
a slash-command menu above it (filter as you type, `↑`/`↓` to choose, `Enter` to run, `Tab` to
insert), `?` for the shortcut panel, `shift+tab` to cycle ask → plan → auto, your message on a
grey band, `⏺` for the assistant and each tool, one `⎿` with the result tail, `✻` dim for the
reasoning — in a neutral grey/white palette with one warm accent, not neon. Answers
are rendered Markdown — bold, inline code, lists, tables whose cells wrap instead of
overflowing — while they stream. `/thinking off` hides the reasoning, and every turn ends
with duration, tokens and the engagement's running cost, labelled with where the price came
from (`provider-reported`, `declared prices`) — or `cost unknown` when no price exists, rather
than a zero that looks measured. `/cost` breaks the same rollup down per source, calls and
tokens, and it continues across `--resume` instead of restarting the bill.

Every tool call goes through the guarded surface (`scope_check`, `tools/run.js`,
`record-finding.js`), and an intrusive binary stops for an in-session approval. Without
`--allow-cloud`, a cloud profile is refused; `llama` points at a local `127.0.0.1:8080`
for air-gapped runs. `demo/README.md` has an authorized loopback target (IDOR, BOLA,
reflected XSS) and the exact commands to rehearse the whole loop offline from the model's
perspective — the target is local, the model may be cloud.

Install the external tool binaries with `./install-tools.sh` (Parrot/Debian) or
`install-tools.ps1` (Windows), then verify with `node tools/doctor.js`.

### Deploying it for a team

The code and the engagement data are separate directories: one
`cyboros.config.json`, validated at startup (every problem in one message, exit 2,
no silent fallback), and a data directory holding accounts, scope, reports and the
audit trail. First run writes only into that directory:

```bash
node tools/init.js --dir /srv/cyboros --admin alice   # prints the admin password once
CYBOROS_CONFIG=/srv/cyboros/cyboros.config.json node tools/gui-server.js
node tools/config.js --print                          # effective config, token redacted
```

A container definition is in the tree (`Dockerfile`, `docker-compose.yml`) with the
image holding code only and config plus data bind-mounted. See
[`docs/DEPLOY.md`](docs/DEPLOY.md) for the settings table, the environment overrides
and the reverse-proxy notes, and [`docs/UPGRADING.md`](docs/UPGRADING.md) for the
upgrade procedure covering identity data and the append-only audit trail.

The full operator surface — gateway launchers, the desktop Command Center, the local
runner — is documented in [`docs/command-center-desktop.md`](docs/command-center-desktop.md)
and the harness contract in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## The surface

The Command Center is a desktop app over the same engine (`cyboros-cc`, PyQt6, falling
back to Chromium in app-mode). It is a **surface, not a gate**: it bypasses no guard, and
every write it performs is a wrapper over an existing tool.

It has **accounts**: every request is authenticated, and every action is authorized by
role — `viewer` reads, `operator` runs the engagement, `admin` manages accounts. The
audit trail records the signed-in identity as `actor`, never a name a request body
claims. Accounts are one validated `users.json` (mode 0600); the first admin is a CLI
step, and the terminal is not a read-only view. See
[`docs/IDENTITY.md`](docs/IDENTITY.md) — including the one-function seam where an OIDC
backend plugs in without touching a route handler.

Campaign → mission → approval → execution → verification → report → evidence bundle. The
approval inbox is where the consent tokens live: a confirm-tier action cannot start
without a granted, single-use, host-bound grant from the operator. `cc-panic.js` stops
only the processes the harness owns.


*Screenshot: synthetic dataset (RFC 2606 `.example` hosts), captured against an isolated
`CC_ROOT` so no engagement data is involved.*

## What is in here

| | |
|---|---|
| `tools/` | the engine: 203 modules, scope guards, repeater, oracle, pipeline, C2, wifi, GUI, tests |
| `local/fleet/` | 28 agent definitions (orchestrator + specialists) |
| `local/` | standalone runner against a local model — no cloud, no Freebuff |
| `workflows/` | 20 reusable `enum-*` / `attack-*` pipelines |
| `knowledge.md` | the engagement contract: rules, toolbox, verification discipline |
| `docs/` | per-tool and per-class methodology, retrieved with `node tools/kb-search.js` |
| `memory/` | sanitized cross-engagement lessons |

## Scope of use

Authorized testing only: your own systems, a signed engagement scope, in-scope bug
bounty targets, or a lab. `scope.json` names which hosts may be tested; it does not
pre-authorize destructive actions, which still need explicit in-session confirmation.

One honest caveat, stated in [`SECURITY.md`](SECURITY.md) too: the guards run
in-process and are not a sandbox. Tools reached through **MCP** bypass them — unless you
mount the server *through* the proxy:

```bash
node tools/mcp-guard-proxy.js -- npx -y chrome-devtools-mcp@latest --headless --isolated
```

`mcp-guard-proxy.js` puts `scope-guard` and `ssrf-guard` in series with the server: it
judges every `tools/call`, refuses out-of-scope or rebinding targets *before* the request
leaves the machine (the agent gets an explicit error, not a silent failure), and appends
every decision — `allow-scoped`, `allow-unscoped`, `block` — to `reports/tmp/mcp-guard.jsonl`.
Mount a third-party server raw and you are outside the guard and responsible for it
yourself; going through the proxy is the supported path.

## Documentation

- [`docs/INDEX.md`](docs/INDEX.md) — every document in the repo, generated from the files
  themselves (title, first paragraph, size), so it cannot drift from what's actually here. Start
  there to browse everything; the list below is the hand-picked subset worth reading first.
- [`docs/ADOPTION.md`](docs/ADOPTION.md) — **for security teams and organizations**: a due-diligence page on authorization, client-data governance, auditability and the tool's own security posture — every answer naming the file that proves it
- [`docs/IDENTITY.md`](docs/IDENTITY.md) — roles, accounts, sessions, the audit actor, and how to plug an OIDC/SSO backend in
- [`docs/DEPLOY.md`](docs/DEPLOY.md) — config surface and precedence, first run, container, reverse proxy, honest limits
- [`docs/UPGRADING.md`](docs/UPGRADING.md) — the upgrade procedure: what each data format guarantees, backups, rollback
- [`docs/OUROBOROS.md`](docs/OUROBOROS.md) — the loop, and the artifact behind every claim
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — guard → model → tool, and why
- [`docs/METHODOLOGY.md`](docs/METHODOLOGY.md) — how this is measured: three metrics, contamination, the severity ceiling (written to apply to any harness)
- [`BENCHMARK.md`](BENCHMARK.md) — the contamination-proof benchmark, and why recall alone is not a claim
- [`docs/TOOL-LANDSCAPE.md`](docs/TOOL-LANDSCAPE.md) — where the published AI-pentest benchmarks stop, argued against the strongest existing work
- [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) — our own attack surface, written down before someone else finds it
- [`docs/GLOSSARY.md`](docs/GLOSSARY.md) — canonical terminology for levels, status and guards
- [`knowledge.md`](knowledge.md) — engagement rules and toolbox (the contract)
- [`docs/project-map.html`](docs/project-map.html) — where everything lives: the 203 modules
  grouped into the 16 areas the harness is thought in (guard, recon, web, host, wireless, mobile,
  opsec, proof, memory, console), the guard chain, the suite gates. Generated by
  `node tools/project-map.js`, so it cannot drift; it also answers the question a flat `tools/`
  does not — where a new module goes
- [`docs/toolbox.md`](docs/toolbox.md) — full flags per tool
- [`docs/TOOL-ALTERNATIVES-AUDIT.md`](docs/TOOL-ALTERNATIVES-AUDIT.md) — cosa è stato valutato e respinto, e perché
- [`docs/methodology-classes.md`](docs/methodology-classes.md) — testing by vulnerability class
- [`docs/host-exploitation.md`](docs/host-exploitation.md) — post-ex, privesc, C2
- [`docs/wireless.md`](docs/wireless.md) — wireless assessment, tier model
- [`docs/RECORDING.md`](docs/RECORDING.md) — how the demo is produced: deterministic, isolated, one command from a GIF
- [`docs/REFS-PROVENANCE.md`](docs/REFS-PROVENANCE.md) — what the reference corpus is, and its licensing status
- [`docs/LAUNCH-PLAN.md`](docs/LAUNCH-PLAN.md) — the campaign: thesis, sequence, channels, what to judge it by
- [`CHANGELOG.md`](CHANGELOG.md) — release history
- [`SECURITY.md`](SECURITY.md) — disclosure policy, safe harbor, in-scope bugs

## Contributing

Issues and pull requests are welcome. Before contributing, please read
[`SECURITY.md`](SECURITY.md) — contributions that weaken the guardrails are treated as
security bugs, not feature requests. Run `npm test` before opening a PR; it is the
same gate CI uses.

## License

Apache License 2.0, with one addition: an individual may use it freely — including a
freelance or independent professional on an authorized engagement, paid or not. A company
or organization needs a separate written commercial license when it uses the harness to
generate revenue: paid client work, a product or service offered for a fee, or any use
intended to produce revenue — work delivered through a company, including your own, is
organizational use. Internal use that generates no revenue, plus personal,
educational, academic and research use, is not affected. See [LICENSE](LICENSE) for the
exact terms.

## Citing this project

If you use the harness, the guard architecture, or `gen-bench.js` in published work,
cite the commit you used rather than `master`:

```
Cyboros Harness — severity-enforced findings and a contamination-proof
precision benchmark for AI security agents.
https://github.com/stavrosredteamer/cyboros-harness @ <commit-sha>
```

Scores produced by this harness are only meaningful alongside the seed, the agent
under test, and the model version. `gen-bench.js eval` writes all three to
`reports/bench-history.jsonl` — publish that line, not just the percentage.
