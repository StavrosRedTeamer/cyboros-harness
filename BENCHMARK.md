# Benchmark

`gen-bench.js` is a **contamination-proof** benchmark for this harness. It measures the
one thing that separates this project from every other agent in the space: not how much
an agent *finds*, but whether what it reports is *real*.

## Why another benchmark

Public security benchmarks are in the model's training data. "Solved" on OWASP Juice
Shop, DVWA, PortSwigger labs or an HTB box measures recall of training material, not
harness capability. This is the same class of problem the field has with CVE benchmarks
generally, and it has a name: **contamination**.

So the benchmark generates its own target:

```bash
node tools/gen-bench.js new --classes all --seed 4242
node tools/gen-bench.js start ~/bench/bench-4242-84e8
```

- A deliberately vulnerable, zero-dependency Node HTTP app, generated from a **seeded
  PRNG**. Two runs with different seeds share **zero** routes.
- 16 vulnerability classes: SQLi, IDOR, JWT (alg:none), SSTI, SSRF, upload traversal,
  broken authz, race condition, XSS, open redirect, command injection, NoSQL injection,
  prototype pollution, CORS misconfiguration, weak auth, mass assignment.
- The ground-truth manifest lives in `~/bench/`, **outside the harness workspace**. The
  harness only ever sees a loopback URL. It cannot read the answer key even by accident;
  `main.js` still exposes the route registry, so route discovery is a legitimate
  JS-analysis surface rather than a leak.
- Same seed → byte-identical routes, so a score is reproducible.

## The three metrics

`node tools/gen-bench.js eval <benchdir>` reports:

| Metric | Definition | Why it matters |
|---|---|---|
| **recall** (`detectedPct`) | ground-truth classes with at least one matching finding | Can it find things at all? |
| **precision** (`precisionPct`) | reported findings that map to a seeded class, over findings attributed to the target | **Was anything it said real?** |
| **verification rate** (`verifiedPct`) | of classes found, the share whose finding reached `verified` / `exploited` / `proven_impact` | Does finding equal proving? |

Plus `routeConfirmed` (the finding names the correct route, not just the class) and a
triage list of the false positives by title.

### Why precision is the one that matters

Recall alone is a trap, and it is a trap the whole field has fallen into. A harness that
reports *every* class it can think of gets 100% recall and is completely useless. The
self-test pins exactly this case:

```
PASS  recall still 100% while precision drops below 100%
PASS  junk findings on-target are counted as false positives
```

Two fabricated findings on the correct target, and recall stays at 16/16 while precision
collapses. Under a recall-only benchmark, that harness scores a perfect 100%. **That is
why publishing a single "findings found" number is not a meaningful claim, and why this
one is published with precision and the verification rate beside it or not at all.**

The verification rate is the one that is genuinely hard to move. Finding a class and
proving it are different problems: proof requires a `verify` oracle that the harness
re-executes live, N/N. A harness without enforced oracles reports `triggered` and stops
there — recall looks the same, verification rate caps out low.

## Status of results

**Measured rows exist (2026-10-02); no leaderboard is published yet.** Four agent runs
have gone through the instrument end to end, so the numbers in
`reports/bench-history.jsonl` are measurements rather than projections. They are not a
leaderboard: they come from one agent, one model and one operator, and rows #3-#5 were
measured against a generator that could not prove one of its own classes (see `race`
below).

To produce a real row:

```bash
node tools/gen-bench.js new --classes all --seed <seed> --port 3001
node tools/gen-bench.js start ~/bench/bench-<...>
# run the harness against http://127.0.0.1:3001 with the seed's scope authorized
node tools/gen-bench.js eval ~/bench/bench-<...> --findings <findings> --agent <agent> --model <model> --json
```

Every eval appends to `reports/bench-history.jsonl` with seed, recall, precision,
verification rate and the missed classes — so regressions per class are measurable over
time rather than asserted once.

### What the first four rows say

| row | seed | recall | precision | verification | detected | missed |
|---|---|---|---|---|---|---|
| #3 | 20261002 | 88% | 100% | 100% | 14/16 | jwt, race |
| #4 | 20261003 | 88% | 100% | 100% | 14/16 | jwt, race |
| #5 | 20261004 | 94% | 100% | 100% | 15/16 | race |
| #6 | 20261005 | **100%** | 100% | 100% | **16/16** | — |

All four: `freebuff` / `deepseek-v4.1-flash`, zero false positives, zero unattributed
findings, zero contamination. Rows #3-#5 are pre-fix (16-classes-to-test ratio aside,
their `race` MISSED is the instrument's fault); row #6 is the first post-fix seed and the
only one where 16/16 means anything. Each row's `note` carries its own caveats — the
harness set-up, the identity token, and the agent's own disclosure all differ between
runs, and a row without them is not reproducible.

### The `race` class was unprovable until 2026-10-02 (rows #3, #4, #5)

The first three agent runs all reported `race` as MISSED, with the agent correctly
reporting that the endpoint kept no state. The agent was right: **the generator was
broken**. Every class fragment is injected inside the request handler
(`${blocks.join('\n')}` in `buildApp`), so `let BALANCE = 1000` was re-executed on every
request: the 40 ms TOCTOU window opened on state that had just been recreated, and a lost
update was impossible by construction.

Classes can now return a `top` field, emitted at module scope before `createServer`, which
is the only place state survives a request. `race` uses it: 5 concurrent `+100` deposits from
1000 now leave **1100**, not 1500.

Two things make this worth writing down:

- the generated test for `race` asserted only `final < target`, which **passed on the broken
  code** — a stateless endpoint also has `1000 < 1500`. It now also asserts the deposits
  landed (`final > before`), which is what distinguishes "lost update" from "nothing
  happened";
- **rows #3, #4 and #5 of `bench-history.jsonl` were measured against the pre-fix generator.**
  Their `race` MISSED is a property of the instrument, not of the agent. They stay citable
  with that caveat; a row with `detected` 16/16 is only meaningful on a post-fix seed.

## Running it against an agent that is not `run-local.js`

`eval` does not run an agent. It reads a findings file and scores it against the ground
truth, so the agent under test can be anything that writes findings through the harness's
tools — including a Freebuff session that drives `repeater.js`, `record-finding.js` and
`verify-finding.js` itself. That is not a shortcut around the harness: the discipline the
benchmark measures is enforced by those tools, not by the model.

### The two environment variables nobody sees

```bash
source bench.env.sh
```

- **`SCOPE_JSON=scope.bench.json`.** The engagement scope's `time_window` is bound to that
  engagement, and an expired window denies *everything*, loopback included. The bench scope
  is loopback-only, has no time window, and is pinned **by prefix** (`allowed_hosts` empty),
  so `127.0.0.1:3001` is authorized and no other local service is.
- **`ALLOW_METADATA_TARGET=1`.** The B9 layer in `repeater.js` denies loopback by default
  (HARD tier, the same rule that protects `169.254.169.254`). Without this opt-in every
  request is refused, the agent records nothing, and `eval` reports a run with zero
  findings — which reads as "the harness found nothing" instead of "the setup was wrong".
  It is the cleanest way to falsify a measurement without touching anything.

`bench.env.sh` also points the findings file, the head anchor, the verification log and the
oracle log at bench-specific paths, so a benchmark run never reads or writes the engagement's
own data.

### The chain, and why step 3 is not optional

```bash
# 1. record hypotheses: status inconclusive + verify_level suspected|triggered + a `verify` block
node tools/record-finding.js '{"severity":"Medium",...,"status":"inconclusive","verify_level":"triggered",
  "verify":{"method":"GET","url":"http://127.0.0.1:3001/...","expect":{"status":400,"body_contains":"..."}}}'

# 2. re-fire every PoC N/N against the live target: writes the oracle receipt, appends the outcome
node tools/verify-finding.js batch --file reports/bench-findings.jsonl

# 3. the effective view, as an array JSON `eval` accepts
node tools/effective-findings.js list --out reports/bench-effective.json

# 4. score it
node tools/gen-bench.js eval "$BENCH_DIR" --findings reports/bench-effective.json \
  --agent freebuff --model <model-version> --json
```

`findings.jsonl` is chained and is never rewritten, so a finding verified *after* it was
registered is `verified` only in the fold of step 3 — and only if its oracle and its
`evidence_quote` still validate on disk at that moment. Scoring the raw `findings.jsonl`
would under-report every proven finding, which is the one direction a benchmark must never
be wrong in. `record-finding.js` likewise refuses `status: verified` without a mechanical
oracle on disk: a claim of reality needs `oracle.js record` (or the `batch` step above) behind it.

### The rules that decide whether the number means anything

- **Never read `manifest.full.json`.** `app.js` exposes the route registry on purpose —
  enumerating routes is a legitimate analysis surface. The manifest is the answer key.
- **One finding per class, honestly levelled.** A class you suspect but cannot re-fire is
  `inconclusive`/`suspected`, and it costs you the verification rate rather than the recall.
  That trade is the entire measurement.
- **`status: verified` without a live re-fire is a fabrication**, and it is the one this
  benchmark is built to catch. A strong model finds shortcuts here; the score rewards not
  taking them.
- **Cite the seed, the agent and the model version.** `--agent` and `--model` write them into
  the history line; a percentage without them is not a result.

## Putting it in a pipeline (the CI one-liner)

A score nobody gates on is a table. `eval` takes thresholds, and fails the process when a
metric falls below one, so the same instrument runs inside someone else's CI on the
findings that harness already emits:

```bash
node tools/gen-bench.js eval "$BENCH_DIR" \
  --findings findings.jsonl \
  --fail-under-precision 90 --fail-under-recall 80 --fail-under-verified 50
```

**Input.** `--findings <file>` accepts either a JSONL file (one finding object per line,
what `record-finding.js` appends) or a JSON array. Matching uses `id`, `title`, `type`,
`host`, `target`, `endpoint`, `poc`, `description`, `cwe`; verification uses `status`
(`verified`) or `verify_level` (`exploited` / `proven_impact`). A finding is attributed to
the bench when it names the bench's port, or names no port and targets loopback.

**Exit codes.** `0` — no threshold set, or every threshold met. `1` — a threshold was set
and missed. `2` — usage error or an unreadable `--findings` file. A `--findings` path that
does not exist is exit 2, never a silent zero: a gate that reads the wrong file and passes
is worse than no gate.

**Output contract.** `--json` prints the `bench-eval/1` schema. The fields a consumer should
rely on:

| field | meaning |
|---|---|
| `schema` | `"bench-eval/1"` — the format version |
| `detectedPct` / `verifiedPct` / `precisionPct` | the three metrics, 0–100 |
| `reported`, `truePositives`, `falsePositives` | the precision counts behind the percentage |
| `falsePositiveList` | triage list: the findings that mapped to no seeded class (max 20) |
| `unattributed`, `unattributedList` | findings left out of the measurement (they cite another port, or another host). Reported, never silently dropped: "precision 100% on 3" and "precision 100% on 30 of which 27 excluded" must not print the same line |
| `contamination` | `{ checked, suspect }` — findings that quote a manifest-only string (`trigger`, `expectedEvidence`, `expectInBody`) verbatim. Report-only by default; `--fail-on-contamination` turns it into a failing gate |
| `row` | per-class `{ class, severity, status, findings }` |
| `gate` | `{ gated, passed, thresholds, failures }` — absent thresholds give `gated: false` |

## What a cheater can and cannot do here

The harness is the thing being measured, so the interesting question is not whether an
agent can *claim* something — it can always type text — but whether the score can move
without the corresponding work. Three attempts, all executed, all pinned in
`tools/test-benchgen.js`:

**Claiming a proven finding without touching the target — closed.** `status: verified`,
`verify_level: exploited|proven_impact` mean one thing: the PoC was re-fired and passed N/N.
Only code that made the request can know that. Registering them by hand used to be possible
with a minted oracle (`oracle.js record` with an invented token, then quoting that same log
line as `evidence_quote`) and the effective view reported `verified`. `record-finding.js`
now refuses those levels unless it is on the path that actually fired
(`record-finding --verify`, `verify-finding batch`); `confirmed` — the agent's assertion —
stays registrable by hand, which is what it means.

**Reporting everything — measured, not prevented.** Sixteen one-line hypotheses, one per
route, no probing at all, score **recall 75% · precision 75% · verification rate 0%**. The
route registry `app.js` exposes is a class→route map, so recall on a bench like this is close
to mechanical and says nothing about quality. The only number that resists this is the
verification rate, and it is zero. Publish recall and precision from a run like that and you
are quoting the cheat.

**Dropping inconvenient findings — closed.** A finding whose PoC cites a different port used
to vanish from the report entirely: not a true positive, not a false positive, gone. The
precision denominator was quietly smaller than the file. `unattributed` now counts them.

**Reading the answer key — detectable, not preventable.** Ground truth lives outside the
workspace, but the agent runs on the same machine, so the rule is procedural. The one
mechanical signal is `contamination`: verbatim overlap with the manifest's trigger or
expected evidence. It is a signal, not proof — a genuine finding may describe the same
trigger — which is why it reports instead of failing by default.

With `--fail-under-*` set, the human output ends with a `gate: PASS` or `FAIL — <metric> <n>% < <m>%` line, and the JSON carries the same list in `gate.failures`.

## Reproducing the instrument itself

```bash
node tools/test-benchgen.js
```

This exercises the generator, proves the anti-contamination property (same seed →
identical routes; different seed → no shared routes), boots the app, triggers all 16
vulnerabilities, and checks the evaluator including the precision regressions. It is part
of `npm test`. A benchmark whose scoring function is untested is not a benchmark.

## Relationship to external benchmarks

This measures something different from [ExploitGym](https://arxiv.org/abs/2605.11086)
(898 real-world CVEs) and similar model-development suites. ExploitGym asks: *given a known
vulnerability, can an agent write the exploit?* That is a **model capability** question,
and it is largely independent of harness design — a better harness does not make a model
smarter.

This asks: *given a target the model has never seen, does the harness report only what
it can prove?* That is a **harness discipline** question, and the two compose: a
disciplined harness makes whatever the model finds worth acting on.

Running both is more informative than either alone. Neither substitutes for the other.
