# Architecture

The whole design follows from one decision: **the model decides what to try; the
runtime decides what is allowed and what counts as proof.** Those two jobs are
separated deliberately, and almost every unusual choice in this repository is a
consequence of it.

```
┌──────────────────────────────────────────────────────────────────┐
│  L4  Agent fleet (local/fleet/*.ts, 28 agents)                   │
│      Orchestrator + specialists. Plans, chooses techniques,       │
│      writes findings. This layer is advisory.                    │
├──────────────────────────────────────────────────────────────────┤
│  L3  Knowledge (knowledge.md, skills/, refs/, docs/)             │
│      The engagement contract and methodology. Retrieved,         │
│      not memorized. Never the enforcement point.                 │
├──────────────────────────────────────────────────────────────────┤
│  L2  Guard layer — in-process, fail-closed, outside model reach  │
│      scope-guard · ssrf-guard · c2-guard · wifi-guard            │
│      mobile-guard · enforce (pacing/tier) · runBin               │
├──────────────────────────────────────────────────────────────────┤
│  L1  Proof layer — what a finding is allowed to claim             │
│      record-finding (severity ceiling) · oracle (live re-exec)   │
│      evidence-quote · verify-finding · gate · coverage           │
├──────────────────────────────────────────────────────────────────┤
│  L0  State — reports/state.db, findings.jsonl, memory/           │
│      Deterministic pipeline output. Survives the session.        │
└──────────────────────────────────────────────────────────────────┘
                              ↓
                     external binaries / targets
```

## L2 — why the guards are not a prompt

A guard that lives in the agent's context is a suggestion. The model can be talked
out of it, can drift from it, or can misread it. So the enforcement here is ordinary
code that runs in a different process from the reasoning:

- **No third-party binary ever runs directly.** `run.js` and `runBin` are the only
  supported path to an external tool: they scope-check, audit, and pace it. Calling
  `nmap` directly is unsupported precisely because it would skip all three.
- **Fail-closed by default.** An empty or missing `scope.json` blocks everything.
  There is no permissive fallback and no flag that turns the guard into a warning.
- **DNS rebinding.** Resolving the hostname is not enough — the resolved address is
  checked too, so an in-scope name pointing at `169.254.169.254` or a LAN subnet is
  refused unless that subnet is explicitly authorized.
- **Tiered confirmation.** Destructive or high-impact actions need a confirmation
  token, and the approval store is append-only. `run.js --approval <id>` executes
  against a granted, non-reusable, non-expired token bound to the right host and
  action.
- **Pacing is a ceiling, not a target.** `max_requests_per_second` is enforced
  globally across concurrent processes, with automatic backoff on 429/403.

The consequence, and the point of the design: **the agent cannot talk its way past
this layer, because it is not in the conversation.** That is why the harness treats
a model refusal on an in-scope target as a malfunction rather than caution — the
guard has already made the authorization decision, and a second opinion from the
model is strictly less informed.

### The honest gap

The guards cover in-process tool calls. **MCP tools do not go through them** — a
mounted MCP server runs in its own process with its own tool surface. The harness
instructs the agent to scope-check those manually, but that is procedural, not
enforced. This is the one place the architecture leaks, and it is documented rather
than papered over, in `README.md` and `SECURITY.md`.

## L1 — why severity is capped

The failure mode of an automated pentest tool is not missing a vulnerability. It is
*inventing* one, at High, in a report that a human then has to disprove. So the
harness makes over-claiming structurally impossible rather than merely discouraged:

- **A verification ladder with a hard ceiling.** `suspected` → Low, `triggered` →
  Medium, `exploited` → High, `proven_impact` → Critical. `record-finding.js` rejects
  a record whose severity exceeds its level; it does not warn, it refuses.
- **Reality claims require an oracle.** Anything at `verified`/`exploited`/
  `proven_impact` must carry a `verify` block. The harness re-executes that oracle
  live, N/N, before the status holds. A finding that cannot be re-derived from a
  machine check cannot be reported as proven.
- **Evidence must be quoted, not summarized.** `evidence-quote.js` requires reality
  claims to quote an exact slice of a workspace artifact. Model prose goes to
  `diagnostics`, where it cannot masquerade as evidence.
- **Independent re-verification.** A separate verifier agent re-checks findings
  against the target rather than against the reporter's own summary.
- **The gate refuses to produce a report.** `gate.js` blocks report generation until
  the coverage matrix is complete and no finding is pending. An incomplete assessment
  yields no artifact that could be mistaken for a finished one.

The result is the property this project is actually about: **a finding's severity is
a function of its evidence, not of the model's confidence.**

## L0 — state and the deterministic core

Agents are good at choosing what to try and bad at being reproducible. So the
mechanical part is pinned down:

- `tools/stavros.js recon|scan|enumerate` write to `reports/state.db`; agents do not
  hand-run these pipelines. What the model picks is tests and exploits, not the scan.
- Stage gates (`gate.js`) make the engagement order structural: recon → map → test →
  authenticated → chains → report, with explicit criteria per stage.
- `memory/` distills verified lessons across engagements (`distiller.js`) through a
  sanitizer that refuses in-scope hosts, emails, tokens and credentials. Only
  `verify_level`-eligible findings are eligible to become lessons.
- The CLI runner executes the test suite with no network and no dependencies, which is
  what makes CI a meaningful signal.

## Deliberate non-goals

Worth stating, because they look like omissions:

- **No third-party npm dependencies.** Not a purity contest: it is what makes the
  harness auditable in one sitting and runnable on an air-gapped engagement network.
  CI asserts this stays true.
- **No auto-fix / PR generation.** The competing tools generate patches. Patching
  someone else's production code is a different decision, with a different approval
  model, and it belongs to the human who owns the target.
- **The guard is not a sandbox.** It constrains scope and rate, not containment. If
  you need containment, that is a separate layer (containers, dedicated hosts), and
  the harness will not pretend otherwise.
