<div align="center">

# StavrosRedTeamer

**A penetration-testing harness where a finding is only a finding if code can prove it —
and where the agent cannot violate scope, because the enforcement is beneath it.**

[Apache-2.0](LICENSE) · zero dependencies · offline-capable · 93 tests in ~1 min

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

## Why it might interest you

- **Zero dependencies.** No lockfile, no transitive supply chain, nothing to audit but
  the 53k lines in this repository. CI fails the build if that ever stops being true.
  On a client network, `npm install` does nothing.
- **Runs air-gapped.** `local/` drives the same deterministic engine against a local
  model. No API key, no data leaving the engagement laptop.
- **93 tests, ~1 minute, no network.** Offline and loopback tests, classified by the
  runner; `npm test` is the gate, `npm run test:all` includes the live e2e set.
- **Evidence memory that compounds.** `memory/` keeps sanitized technique→outcome
  lessons across engagements, with a sanitizer that refuses to store in-scope hosts,
  emails, tokens or credentials.

## Quick start

Requires **Node ≥ 22** (the Command Center backend uses `node:sqlite`).

```bash
git clone https://github.com/CSI-entitymorton/stavrosredteamer.git
cd stavrosredteamer
npm test                 # 93 tests, no install, no network
```

Then write your authorization. `scope.json` **is** the written authorization, and the
harness is fail-closed until you fill it in:

```json
{
  "allowed_hosts": ["target.example"],
  "allowed_ips": ["10.0.0.0/8"],
  "max_requests_per_second": 2
}
```

```bash
node tools/scope-guard.js check https://target.example   # exit 0 = authorized
node tools/stavros.js recon target.example
node tools/stavros.js scan target.example
node tools/stavros.js status
```

Install the external tool binaries with `./install-tools.sh` (Parrot/Debian) or
`install-tools.ps1` (Windows), then verify with `node tools/doctor.js`.

The full operator surface — gateway launchers, the desktop Command Center, the local
runner — is documented in [`docs/command-center-desktop.md`](docs/command-center-desktop.md)
and the harness contract in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## The surface

The Command Center is a desktop app over the same engine (`stavros-cc`, PyQt6, falling
back to Chromium in app-mode). It is a **surface, not a gate**: it bypasses no guard, and
every write it performs is a wrapper over an existing tool.

Campaign → mission → approval → execution → verification → report → evidence bundle. The
approval inbox is where the consent tokens live: a confirm-tier action cannot start
without a granted, single-use, host-bound grant from the operator. `cc-panic.js` stops
only the processes the harness owns.


*Screenshot: synthetic dataset (RFC 2606 `.example` hosts), captured against an isolated
`CC_ROOT` so no engagement data is involved.*

## What is in here

| | |
|---|---|
| `tools/` | the engine: 139 modules, scope guards, repeater, oracle, pipeline, C2, wifi, GUI, tests |
| `local/fleet/` | 28 agent definitions (orchestrator + specialists) |
| `local/` | standalone runner against a local model — no cloud, no Freebuff |
| `workflows/` | 14 reusable `enum-*` / `attack-*` pipelines |
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

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — guard → model → tool, and why
- [`docs/METHODOLOGY.md`](docs/METHODOLOGY.md) — how this is measured: three metrics, contamination, the severity ceiling (written to apply to any harness)
- [`BENCHMARK.md`](BENCHMARK.md) — the contamination-proof benchmark, and why recall alone is not a claim
- [`docs/TOOL-LANDSCAPE.md`](docs/TOOL-LANDSCAPE.md) — where the published AI-pentest benchmarks stop, argued against the strongest existing work
- [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) — our own attack surface, written down before someone else finds it
- [`docs/GLOSSARY.md`](docs/GLOSSARY.md) — canonical terminology for levels, status and guards
- [`knowledge.md`](knowledge.md) — engagement rules and toolbox (the contract)
- [`docs/toolbox.md`](docs/toolbox.md) — full flags per tool
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

Apache-2.0. See [LICENSE](LICENSE).

## Citing this project

If you use the harness, the guard architecture, or `gen-bench.js` in published work,
cite the commit you used rather than `master`:

```
StavrosRedTeamer — severity-enforced findings and a contamination-proof
precision benchmark for AI security agents.
https://github.com/CSI-entitymorton/stavrosredteamer @ <commit-sha>
```

Scores produced by this harness are only meaningful alongside the seed, the agent
under test, and the model version. `gen-bench.js eval` writes all three to
`reports/bench-history.jsonl` — publish that line, not just the percentage.
