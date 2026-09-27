# What the published benchmarks measure, and what they leave out

> A short positioning document, written to be disagreeable with. Its purpose is
> to state precisely where an existing body of work stops, so that the gap can
> be argued about instead of assumed.
>
> If you think the gap does not exist, the most useful thing you can do is
> produce a number that closes it. That would be a good outcome for the field and
> a boring one for us.

## The state of the art

As of mid-2026 there is real, serious work here, and none of it is
self-reported-only:

- **Escape, _Modern AI-powered Pentesting Tools In-Depth Benchmark_ (June 2026).**
  Cascade (their multi-agent engine) against a bare frontier model on the same
  targets, plus Aikido and XBOW as external references measured by Doyensec
  (March–April 2026) and re-severitized by Doyensec's reviewers. Three axes,
  ordered by how well each resists gaming: total true positives, severity
  distribution, high-severity count — weighting conclusions toward the last.
- **CVE-Bench** (Zhu et al., ICML 2025). Up to 13% of real-world web CVEs
  resolved by the strongest agent framework.
- **ExploitGym** (Wang et al. 2026). 898 real CVEs across userspace, V8, and
  kernel. A model-capability benchmark.
- **Fan et al. 2024.** 87% for GPT-4 *given the advisory description*, 0% for
  every other model tested.
- Curated harness lists (e.g. `Ed-Marcavage/awesome-security-agent-harnesses`)
  and vendor comparisons from Doyensec, Strobes, FireCompass and others.

Two methodological things in this work deserve credit rather than a footnote,
because we would not have thought to do them:

**The contamination gradient.** Escape did not benchmark on Juice Shop and call
it a day. They built a deliberately vulnerable app of their own because Juice
Shop lives in every model's training data, and they report the gradient
explicitly: the bare model keeps pace on the contaminated target and falls far
behind on the novel ones. They also observed the model reaching for public
write-ups mid-run. That is the single most important measurement artifact in
this space and it is already published.

**Deduplication before counting, stated as a rule that should apply to everyone.**
Not "we deduplicated ours" but "the same rule should be applied to every tool
before anything is published."

## Where it stops

Read those three axes closely and one property is shared by all of them:

**Severity is a human judgment, made after the run.**

Escape's "exploit validation" is findings being checked and carrying
reproduction evidence — real, and a genuine improvement over a bare model. But
the severity assignment in the cross-tool comparison is *Doyensec's reviewers
re-severitizing*, and Cascade's own severities are "Escape-reported and
Escape-validated." Correctly labelled by them as an uncontrolled external
reference — but the consequence stands: at the moment a number becomes a
severity, a person is in the loop.

That is the gap, and it is narrower than "nobody has measured precision."

1. **No published benchmark reports precision as a first-class metric.** They
   report true positives *after* discarding false positives, by hand. That is
   precision, computed expensively, and then thrown away. The number a reader
   most wants — of what the tool said, how much was real — is never on the page.

2. **No published benchmark reports what the tool withheld.** Only surviving
   findings are counted. A tool that filters aggressively and a tool that
   floods both post the same high-severity count, and nothing in the results
   distinguishes them. Recall and precision are only interpretable as a pair.

3. **Verification rate is not separated from recall.** "Found" and "proved" are
   different events. A finding that reached `triggered` and one whose exploit
   chain was re-executed N/N live are reported in the same column. Recall cannot
   see the difference between them.

4. **Nothing measures whether a tool was *capable* of overstating severity.**
   The counterfactual — run it, see what it would have claimed without the
   judgment, subtract — is not reported by anyone, because no widely-used tool
   has the severity decision in a place where it can be removed and compared.

5. **The cost of the human in the loop is not published.** Everyone knows a
   reviewer is in there. Nobody reports the delta between what the tool said and
   what the reviewer said. That delta is the actual cost of the current design,
   and it is the number that would make the case for automation.

## Why this matters more than a leaderboard

There is a quiet incentive in the existing axes. Total findings is easiest to
inflate. Severity distribution is harder. High-severity count is hardest — and
so it is the column the field rewards. But a high-severity count is trivially
maximized by a tool that overstates, because nothing in the pipeline stops it.

The tools that score well on that column are not necessarily the ones that would
be safe to leave running unattended on a production estate. And the
organizational cost lands on the defender, who re-triages every report.

So the honest statement of the thesis is narrow, and it survives contact with
the existing literature:

> The bottleneck in AI pentesting is not generation, and it is not recall. It is
> that **severity is still decided by a person**, and the tools that score best
> on the axis the field rewards are the ones with the most room to overstate. The
> fix is to move the severity decision out of the prompt and into the runtime,
> where it is bounded by evidence the machine re-executes — and then to publish
> what that costs in reported high-severity counts, because it will look worse.

We are not claiming the first two sentences are new. We are claiming the third
is unimplemented and unmeasured.

## Reproducing the gap claim

You do not need to take our word for any of this. To check claim 1 and 2, take
any published result set and compute, yourself:

- precision = (findings that survived manual validation) / (findings reported);
- suppression = (findings the tool generated but did not report) / (findings
  reported), if the tool logs it at all.

If either number is unavailable for the tools you evaluate, that is the finding.
The methodology is in [`METHODOLOGY.md`](METHODOLOGY.md), and it is written to be
applied to agents that have nothing to do with us.
