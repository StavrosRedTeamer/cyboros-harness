# Measuring whether an AI pentest agent's findings are real

> This is the citable artifact. It states a method, not a product. Nothing here
> requires you to use this harness — the claims are about how to measure any
> agent, including one you build yourself.
>
> Cite it with the commit sha, not `master`. If you use the numbers, publish the
> seed, the agent, and the model version alongside the percentage.

## The problem this measures

An agent that reports everything it can think of scores 100% recall and is
useless. An agent that reports nothing scores 0% recall and is also useless.
The number that decides whether an engagement is worth reading is neither: it is
**precision** — of what the agent said, how much was real — and, underneath it,
whether finding something and *proving* it are the same event.

Every public benchmark we could find reports recall, or total findings, or
high-severity counts with a human in the loop re-severitizing at the end. Those
are useful and we do not dispute them. What none of them measures is whether the
tool would have been *capable* of reporting a severity it had not earned — because
in all of them the last mile of severity is a judgment, made by a person, after
the run. That judgment is the expensive part, it does not scale, and it is the
part a defender has to redo.

So this document describes three metrics, a contamination argument, and a
mechanism that removes the last human judgment from the severity field entirely.

## Metric 1 — recall (`detectedPct`)

Ground-truth classes with at least one matching finding.

Necessary and nowhere near sufficient. Report it, but never alone: a recall-only
score is trivially maximized by reporting everything, and a tool optimized for
a leaderboard column will discover that immediately.

## Metric 2 — precision (`precisionPct`)

Reported findings that map to a known class, over findings attributed to the
target. **Was anything it said real?**

This is the metric that carries the argument, and it is the one most easily
faked by a reporting layer that quietly discards what it cannot prove. So it has
to be read next to the count of what was *withheld*. A harness that filters hard
shows a high precision and a low absolute count; a harness that filters nothing
shows a low precision and a high absolute count. Neither number means anything
without the other, and a tool that publishes only one is choosing which story to
tell.

## Metric 3 — verification rate (`verifiedPct`)

Of the classes found, the share whose finding reached `verified` / `exploited` /
`proven_impact` rather than stopping at `triggered`.

This is the hard one, and it is the one that actually separates harnesses.
Finding a class and proving it are different problems. Proof means a machine
re-executes the condition and the condition holds, N/N, live. A harness with no
enforced oracle reports `triggered` and stops — and its recall looks *identical*
to a harness that proved everything, because recall cannot see the difference.

## The contamination problem, and why it breaks recall

Public security targets are in the model's training data. "Solved" on OWASP
Juice Shop, DVWA, PortSwigger labs or a public HTB box measures recall of
training material, not capability. The tell is visible in the data: on
contaminated targets a bare model keeps pace with a heavily engineered harness,
and on novel targets it does not. Escape's benchmark documents this cleanly —
Claude Opus 4.8 alone matches their harness on Juice Shop, falls far behind on
Fider and Photoview, and was observed mid-run reaching for public write-ups
instead of working the application. That is not a model failure; it is a
measurement artifact.

The fix is a target the model has never seen. Generate it from a seeded PRNG:
two runs with different seeds share zero routes, and the same seed reproduces
byte-identically so a score is repeatable.

## What we do not claim

- We do not claim better exploitation. A disciplined harness does not make a
  model smarter; it makes what the model found worth acting on. Those compose,
  and neither substitutes for the other.
- We publish no leaderboard row, because no multi-seed run has been published
  yet. Instrument without results is not a result.
- Nothing here is a claim about any commercial tool. It is a claim about what a
  metric suite should contain.

## The mechanism: severity as a function of evidence

The part we think the field is missing is not a better model of severity. It is
removing the human from the last step.

Findings declare a `verify_level`, and the runtime — not the prompt, not the
model's judgement, not a reviewer's — maps it to a severity ceiling:

| `verify_level` | means | severity ceiling |
|---|---|---|
| `suspected` | plausible, not reproduced | Low |
| `triggered` | condition triggered, not exploited | Medium |
| `exploited` | full exploit chain demonstrated | High |
| `proven_impact` | real impact proven (data read, ATO, RCE) | Critical |

Declaring `proven_impact` without a valid oracle is not a warning, it is a
refusal. A finding that claims reality — `status: verified`, or `exploited` /
`proven_impact` — must carry an oracle the harness re-executes itself, live,
N/N. A separate verifier agent re-checks it independently, and `gen-poc.js`
emits a parameterized reproducer a human can run without trusting the harness.

Consequence worth stating plainly: **this lowers reported severity, and it lowers
reported high-severity counts.** A tool with an enforced ceiling will score worse
on the axis existing benchmarks weight most. That is the correct behaviour and it
is the reason the axis is not measuring what people want it to measure. A finding
that cannot be proven should not be a Critical, and the number of Criticals a
tool reports is downstream of a judgment that nobody has automated yet.

## Reproducing this without our harness

1. Build or borrow a target the model has not seen, with a known ground truth
   you control, kept outside the agent's reach.
2. Run the agent. Record the model, version, date, and the exact target commit.
3. Score recall **and** precision **and** verification rate. Publish all three,
   or publish none of them — a single "findings found" number is not a claim.
4. Publish what was withheld, not just what was reported.
5. Re-severitize by hand as a separate step and report the delta. That delta is
   the real cost of the human in the loop, and it is the number nobody publishes.

## Sources

- Fan et al. 2024, *LLM Agents can Autonomously Exploit One-day Vulnerabilities*
  — <https://arxiv.org/abs/2404.08144>. 87% for GPT-4 given the advisory text,
  and 0% for every other model tested.
- Zhu et al. 2025, *CVE-Bench* (ICML 2025) — <https://arxiv.org/abs/2503.17332>.
  Up to 13% of real-world web CVEs resolved by the strongest agent framework.
- Wang et al. 2026, *ExploitGym* — <https://arxiv.org/abs/2605.11086>. 898 real
  CVEs; a model-capability benchmark, complementary to this one.
- Escape 2026, *Modern AI-powered Pentesting Tools In-Depth Benchmark* —
  <https://escape.tech/blog/modern-ai-powered-pentesting-tools-in-depth-benchmark/>.
  The contamination gradient and the recall-on-contaminated-targets effect are
  theirs, and they are measured, not asserted.
- Doyensec 2026, independent comparison of Aikido and XBOW (March–April 2026),
  re-severitized by their reviewers and reused as the external reference in the
  Escape study.
