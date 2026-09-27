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

**No harness scores are published yet.** The instrument is complete and self-tested; the
numbers are not. Publishing a leaderboard row before an agent has actually been run
through several seeds would be a fabricated result, so there isn't one.

To produce a real row:

```bash
node tools/gen-bench.js new --classes all --seed <seed> --port 3001
node tools/gen-bench.js start ~/bench/bench-<...>
# run the harness against http://127.0.0.1:3001 with the seed's scope authorized
node tools/gen-bench.js eval ~/bench/bench-<...> --json
```

Every eval appends to `reports/bench-history.jsonl` with seed, recall, precision,
verification rate and the missed classes — so regressions per class are measurable over
time rather than asserted once.

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
