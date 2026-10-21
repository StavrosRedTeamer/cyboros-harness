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
│  L0  State — state.db, findings.jsonl + verifications.jsonl      │
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
mounted MCP server runs in its own process with its own tool surface. This is the one
place the architecture leaked, and it is documented rather than papered over, in
`README.md` and `SECURITY.md`.

There are now two supported answers, one per direction:

- **Inbound (`tools/mcp-guard-proxy.js`).** The MCP client launches the proxy instead of
the server; the proxy judges each `tools/call` with the *same functions* the in-process
tools use — `scope-guard.inScope`, then `net.resolveAndGuard` (the DNS-rebinding layer),
then `ssrf-guard.checkAddress` on the pinned address — and only forwards what passes.
A blocked call never reaches the server, the agent receives an explicit error, and the
verdict is appended to `reports/tmp/mcp-guard.jsonl`. Declared limits, because a proxy
that overclaims is worse than no proxy: the judgement is over targets extracted from the
arguments (a tool that touches the network without naming it is not judged), and an
in-scope hostname that cannot be resolved is refused (fail-closed, same as `repeater.js`).
- **Outbound (`tools/mcp-bridge.js`).** Exposes *our* guarded tools as an MCP server
(rigid whitelist, `--dry-run` only, no external broker), so an MCP-capable client can
consume the harness without getting an ungated executor.

What remains procedural is the unsupported case: mounting a third-party server raw, with
no proxy in front of it. That is still outside the guard, and still the operator's call.

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
  yields no artifact that could be mistaken for a finished one. The verdict is scoped to
  one engagement: findings, pending rows, oracle revalidation and the per-host
  `reports/coverage-<host>.md` are read for that host only, and a pass recorded for
  another host neither blocks nor unlocks this one.

The result is the property this project is actually about: **a finding's severity is
a function of its evidence, not of the model's confidence.**

## L0 — state and the deterministic core

Agents are good at choosing what to try and bad at being reproducible. So the
mechanical part is pinned down:

- `tools/cyboros.js recon|scan|enumerate` write to `reports/state.db`; agents do not
  hand-run these pipelines. What the model picks is tests and exploits, not the scan.
- Stage gates (`gate.js`) make the engagement order structural: recon → map → test →
  authenticated → chains → report, with explicit criteria per stage.
- `memory/` distills verified lessons across engagements (`distiller.js`) through a
  sanitizer that refuses in-scope hosts, emails, tokens and credentials. Only
  `verify_level`-eligible findings are eligible to become lessons.
- The CLI runner executes the test suite with no network and no dependencies, which is
  what makes CI a meaningful signal.

### Why `findings.jsonl` is immutable

The findings log is append-only, hash-chained (A3) and externally anchored, and deduplicated by
key. So a verification that happens *after* recording has nowhere to go inside it, and rewriting
one of its lines is indistinguishable from tampering. A recorded finding therefore never changes:

- **`tools/chain-log.js`** owns the chain mechanics once — `prev_sha256` per line, `seq`
  continuity, and the external head anchor that catches a *wholesale* rewrite (a regenerated chain
  is internally consistent, so the chain alone cannot see one).
- **`tools/verification-log.js`** keeps the facts of verification in their own append-only log
  (`reports/verifications.jsonl`) under the same discipline. A `verified` record is refused unless
  its oracle and its verbatim quote re-validate **on disk at that moment** — never on the caller's
  word. A failed re-fire is a fact too, and is recorded as one.
- **`tools/effective-findings.js`** is the *view*: `findings.jsonl` folded with the side log. It is
  fail-closed downward (no record, no promotion) and it re-validates the oracle at fold time, so a
  deleted artifact takes the promotion away again. `gate.js` reads the view for `verify`,
  `noPending`, `oracle`, `evidenceQuote` and `pocReplay`; every other consumer still sees the
  recorded state, which is the conservative direction.
- **`tools/rechain.js`** is the only supported way to reconcile a broken chain: it backs the file
  up, rebuilds the chain over the *existing* content (only `chain` changes), and appends a
  `findings-rechain` event — old head, new head, mandatory reason — to the anchor log, so a rewrite
  becomes a legible fact in the history instead of an anomaly indistinguishable from an attack.

The consequence worth stating: **a finding's status is a fold, not a field.** Nothing in the
pipeline edits a recorded finding, and the gate's "no pending findings" criterion became
falsifiable in the process — it means "a reality claim whose proof does not hold on disk", which
its previous definition (`status === 'pending'`) could never be, since the record validator admits
only `confirmed|inconclusive|verified` and requires the field.

## The console is a composition

The Command Center backend grew inside one file that served static assets, routed every
API family, gated identity, ran jobs and owned the terminal PTYs. That is fine for a
prototype and hostile to the next change: every new endpoint had to be threaded through
code it had nothing to do with. It is now a composition root (`tools/gui-server.js`: read
the config, build the modules, own the process) plus one module per responsibility, all
under `tools/console/`:

| Module | Owns | Never does |
|---|---|---|
| `tools/console/app.js` | the request pipeline and its order | any policy of its own |
| `tools/console/http.js` | reply shapes, body cap, Host/Origin allowlist, static shell | authorization, data |
| `tools/console/gate.js` | authenticate → authorize → audit, one refusal shape | routing, data |
| `tools/console/routes/index.js` | dispatch: cc router, then the families below, in one visible order | routing policy of its own |
| `tools/console/routes/public.js` · `accounts.js` · `state.js` · `streams.js` | one route family each: handshake and sign-in, accounts, engagement state, streaming and terminals | transport, auth internals |
| `tools/console/jobs.js` | background jobs, their buffers and SSE viewers | which job to start |
| `tools/console/terminals.js` | PTY sessions, replay, viewer fan-out, auto-restart | HTTP routing |
| `tools/console/chat.js` | one conversational turn: model and preset resolution, SSE frames, session save | deciding what a tool may touch |
| `tools/console/chat-presets.js` | the allowlist each preset grants (pentest, analysis, conversation) | executing anything |
| `tools/console/chat-tools.js` | async spawn, preset refusal, operator approval, call/result frames | transport, prompts |
| `tools/console/chat-sessions.js` | one JSON document per conversation, atomic write, resume | the audit trail (that stays in `reports/agent/sessions`) |
| `tools/console/chat-settings.js` | the turn knobs the settings menu owns (model, preset, temperature, max tokens, streaming, approval policy), validated and written under the data root | anything that authorizes a target or a tool tier |
| `tools/console/scope.js` | the authorization file: validate, back up, write, check | routing |
| `tools/console/findings.js` · `pipeline.js` · `engagement.js` | read models over engine output | writes outside their own file |
| `tools/console/files.js` | tolerant JSON/JSONL reads, the 0600 atomic write | policy decisions |

The order in `app.js` *is* the security model, so it is stated once, top to bottom:
static shell → generated report (data-gated) → `/api` only → Host/Origin → public routes
(handshake, login) → gate → route families → uniform 404/405. A family cannot skip the
gate because it only receives a `principal` that the pipeline resolved.

The seam is one context object built in `gui-server.js`: modules receive their
dependencies (identity, job runner, terminal manager, read models, paths) explicitly and
read nothing else. Consequences worth relying on: swapping the identity or job backend is
a different constructor call in the composition root; adding an endpoint touches one
family file plus its read model; and the terminal/streaming side cannot reach into the
data routes. Behaviour is unchanged by the split — the RBAC matrix, the cc-route suite and
the config/startup checks all run against the same HTTP surface as before.

## The chat is a turn, not a script

The console chat is the same loop as the CLI, driven from a browser: a turn calls
`local/llm.js#runAgent` with the guarded switch in `local/tools-bridge.js#makeDispatch`
and the engagement prompt in `runtime/live.js#systemFor`. `tools/console/chat.js` adds
transport only — SSE, model/preset discovery, a resumable conversation, and an approval
channel a browser can answer. There is deliberately no second agent engine to drift.

Two things a client may rely on:

- **A refusal is a frame, not prose.** `tool_result {blocked:true, reason}` is emitted for
  every refused call — `reason: preset` when the preset does not grant the tool,
  `reason: approval` when the operator denied it, `reason: invalid-args` when the call
  was malformed. The model's own words are never the evidence that something ran.
- **The allowlist is data, in two layers.** `chat-presets.js` filters the schema offered to
  the model, and `chat-tools.js` refuses the same call if it arrives anyway (stale tab, a
  `ACTION:` line from the text fallback, a model inventing tools). Analysis mode is
  read-only by construction: `run_tool`, `pipeline`, `write_file` and `record_finding` are
  absent from its list, so no prompt can talk its way into them.

Frame contract (one JSON object per `data:` line, blank line between frames, additive
only — a client must ignore a `type` it does not know):

| Frame | Payload |
|---|---|
| `meta` | `session, model, modelId, profile, egress, preset, readonly, tools[]` |
| `session` | `id, title` |
| `start` · `thinking` · `token` | `{}` · `{t}` · `{t}` |
| `tool_call` | `id, tool, args` |
| `tool_result` | `id, tool, ok, exit, durationMs, output, blocked?, reason?` |
| `approval` | `id, tool, args, command, tier, reason, expiresAt` |
| `approval_result` | `id, decision` (`approve` · `deny` · `stop` · `timeout`) |
| `usage` · `timings` · `error` | `{tokensIn, tokensOut, cost}` · `{timings}` · `{message}` |
| `done` | `session, text, stopped, error?, usage` |

An intrusive tool (its `risk_tier` in `tools/tool-registry.json`, the same table `run.js`
consults) parks the turn on `POST /api/chat/approval`. Unanswered is denied: a closed tab
times out to `deny`, never to a grant.

Settings are server-owned (`app/chat/settings.json` under the data root) because each one
changes what the model receives or what a tool is allowed to do: a stale tab or a second
operator must not silently change an answer. The menu writes them, every turn reads them,
and `GET /api/chat/settings` also returns the read-only `context` (data root, session
store, settings file) that the dialog displays without pretending to edit it. Scope stays
in `scope.json` and tool tiers in `tools/tool-registry.json`; there is deliberately no
setting that widens either.

Conversations live under the data root (`app/chat/<id>.json`) while tool processes run
against the checkout. When the two differ, the chat hands the guarded switch the
configured reports directory for reads and evidence writes (`readRoots`/`reportRoots`)
and passes `FINDINGS_JSONL` / `CYBOROS_AGENT_DIR` to child tools, so analysis mode reads
the engagement the dashboard is showing rather than a stale checkout's `reports/`.

### Client shape (`tools/gui`)

The chat is four zero-build files over one state object, and the split is the frame
contract continued into the browser: each file receives data and returns DOM, and none of
them re-decides what the server already decided.

| File | Owns | Does not own |
|---|---|---|
| `views-chat.js` | the transcript model (`S`), the frame → state reducer, edit/regenerate, composer wiring | how a tool card is drawn, how a frame is parsed, the settings form |
| `chat-render.js` | transcript → DOM: markdown, user/assistant turns, tool and approval cards, the action row, the in-place painters | state, transport, scroll position |
| `chat-api.js` | every route the chat speaks, and the SSE pump (`ChatApi.stream(body, {signal, onFrame})`) | what to do with a frame |
| `chat-settings.js` | the settings surface (seven sections, one save path) | where settings come from, what saving means for the current conversation |

`views-chat.js` is the only place that mutates state, so a stream handler and a redraw
cannot disagree. Rendering asks for the three behaviours it cannot own — `onEdit`,
`onRegenerate`, `onDecide` — instead of reaching into the view, and `ChatSettings` takes
`{getState, onSaved}` rather than importing the view's globals. A refused request keeps
its `.notAccepted` flag through `chat-api.js`: that flag is what tells the view to reload
the stored transcript instead of showing a rewrite the server never applied.

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
