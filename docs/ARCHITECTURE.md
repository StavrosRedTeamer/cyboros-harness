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

## Providers declare what they accept

`local/adapters.js` is the seam between "a model endpoint" and the request the loop builds.
A profile in `providers.json` is a `type` plus a `capabilities` block; `resolveCapabilities()`
merges the type's defaults with what the profile declares, and `buildRequest()` can only emit
a field that some capability pays for. The loop no longer names a single provider field:
`native_tools`, `chat_template_kwargs` and the llama.cpp `grammar` used to be hardcoded
true/always-on, which worked for exactly one endpoint and 400'd on the others.

The capability matrix (what each key controls, and what happens when it is absent) lives in
[README.md](../README.md#what-a-profile-declares) and is the only copy: a capability that is
documented but never read is deleted here rather than described. The parts worth knowing:

- **An unknown key is an error.** `validateCapabilities()` runs at load time in
  `runtime/live.js` and in `resolveCapabilities()`; a typo (`reasoning_echo_with_tool`) fails
the config instead of doing nothing at request time.
- **A strict profile is asserted, not trusted.** With `strict_unknown_fields`, every key in
the built body must map to a capability (`strictCheck()`), including `tools` and
`tool_choice`: those are the fields the tool capabilities exist to gate, so they are not
treated as always-legal.
- **The adapter arbitrates, and refuses the impossible.** A GBNF grammar and a native tool
  schema cannot both be offered: a declared grammar withholds the schema, and a grammar
  requested on a profile that never declared one throws `grammar_unsupported`. The caller
  hands over both; only this layer decides, so a run can no longer end up with neither.
- **Reasoning is read tolerantly, written exactly.** `readReasoning()` accepts either field
  name a vendor has used; `echoReasoning()`/`attachReasoning()` only ever write the declared
  one, and only when `reasoning_echo_with_tools` says the provider requires it.
- **The window is the budget.** `context_window_tokens − reserved_output_tokens −
safety` feeds `local/context.js`; without it the run falls back to the legacy character
  field and reports `legacy_chars` instead of pretending the context is full.

`runtime/live.js#capabilitiesFor()` returns the resolved `describe()`, and the TUI prints the
`summary` line it contains — rendering, not interpreting, so a new capability never needs an
edit in `runtime/terminal/commands.js`. The console passes the same declaration into the loop but carries
no capability payload in its HTTP frames: nothing rendered it, and an unread field drifts.
`tools/test-adapters.js` proves the matrix against a fake endpoint that rejects undeclared
fields, and runs the shipped DeepSeek profile end-to-end through the live path.

## Continuity is a file, not a memory

`events.jsonl` records what happened; it is not something you can resume from. The
conversation lived in the process, so a kill meant the next process rediscovered the target
from zero. `runtime/session-state.js` owns one file per session — `state.json`, next to the
log — holding the history the next turn would send, the facts extracted from it, and the
run's identity and usage. `runtime/live.js` writes it at the end of every turn (not at
exit: a crash never reaches `finish`), and `createLive({resume})` loads it *before* the
session is opened, so the restored history is what the first turn sends.

The facts are `local/context.js#extractFacts()` — the compactor's own extractor — not a
second classifier of what a finding or a target looks like. That is what lets a trim, a
repair and a compaction agree about what survives. The rules that make it safe:

- **Verified, not trusted.** The payload is hashed on write and re-hashed on read: a
  truncated write, an interrupted rename or a hand-edited file is refused with the reason.
  An absent file is `absent`, never "empty history".
- **Sendable at the boundary.** A loaded history goes through the same `validate()` the
  loop applies, and is repaired with `compile()` when it fails (an orphaned tool result is
  dropped and named); a history that cannot be made valid is refused, not silently reduced.
- **What is missing is stated.** A file trimmed by the size cap carries a `trimmed` record,
  so resume inserts the digest of what its kept turns no longer contain. `/resume` prints
  the messages, targets, findings, artifacts and actions restored, plus any repair.
- **Stale is a fact.** Past `DEFAULT_MAX_AGE_HOURS` the session is `stale` and unusable
  without `--allow-stale`: resuming a week-old engagement unnoticed is how a stale map gets
  treated as current.

## What a run cost is a fact with a source

An operator comparing this harness with an in-house one needs a bill they can defend, so the
number is not enough: which price produced it, and whether it covers every call, travel with
it. `runtime/usage.js` owns one rollup — tokens in/out, requests, and cost split into
`provider` (the endpoint billed itself), `declared` (the profile's `capabilities.pricing`) and
`unattributed` (a pre-rollup figure whose source was never recorded). `local/llm.js` labels
each call as it reports usage; `costView()` is the only calculator, so `/cost`, the status bar,
`/budget`, `/status` and the end-of-turn line cannot disagree about the amount.

Three rules make the display honest rather than merely formatted:

- **Unknown is not zero.** A profile that declares no price table and an endpoint that
  reports none yields `unknown (N call(s), no price reported or declared)` — never `$0.00`,
  never a guess. A genuine `0` is still a price, and reads as `$0`.
- **A partial total says it is partial.** When only some calls were priced, the amount is
  labelled a floor with the number of unpriced calls; the badge appends `+`. `/cost` also
  names each bucket, so a mixed session cannot pass for a measured one.
- **Precision follows magnitude.** Two decimal places at dollars, three at cents, five to six
  below a cent: a `$0.000004` run stays readable instead of collapsing to `$0.00`.

The rollup is saved with the session (`state.json`), so `--resume` continues the accounting
of the engagement instead of starting a silent second bill, and a save that carries no usage
(compaction, metadata) does not reset it. `tools/test-cost.js` proves accumulation across
turns and across a resume, the unknown and floor cases, and the surfaces themselves through
the real TUI against a local provider.

Three modules, one direction of data:

| Module | Owns | Does not |
|---|---|---|
| `runtime/usage.js` | the rollup's shape, its accumulation rules, unknown/floor, and every rendering of the amount | touch disk, a provider, or the environment |
| `runtime/session-state.js` | the resumable file — history, facts, integrity, staleness — and the stored rollup by value | define what a bill is, or format one |
| `runtime/terminal/state.js` · `surfaces.js` · `ledger.js` · `tools/console/chat.js` | a copy of the loop's rollup and where it is shown | compute, reformat or reinterpret an amount |

The terminal keeps the loop's rollup in `state.liveUsage` and reads spend through one
`budget()` accessor; the scripted demo, which calls no provider, is the only thing that
advances `state.budget`, so a live number has exactly one owner and cannot drift from a mirror.

`tools/accounting.js` is the other consumer of usage-shaped records, and deliberately not
this module: it aggregates audit entries per binary and per agent (with durations) for the
report, sums only what the trail already persisted, and prices nothing. One is the live bill
of a conversation; the other is a rollup over evidence.

The console chat is a second surface over the same owner. Its conversation store
(`app/chat/<id>.json`) is deliberately not the CLI's session file — a browser conversation
has its own lifetime, id space and client — but it keeps `usage` in the rollup's shape and
accumulates it with `addUsage()`, and its `usage`/`done` frames carry the label and sentence
`costBadge()`/`costText()` produce. The browser renders that string and cannot format a dollar
figure itself, so an unpriced console turn shows `cost unknown` and a mixed one shows the
floor, exactly as `/cost` does.

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
| `usage` · `timings` · `error` | `{tokensIn, tokensOut, totalTokensIn, totalTokensOut, cost, source, costLabel, costText, costKnown, costPartial}` (this call, then the conversation rollup) · `{timings}` · `{message}` |
| `done` | `session, text, stopped, error?, usage` — this turn's tokens plus the conversation's cost rollup |

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
