# Launch plan

> The whole campaign in one document: the thesis, the discipline, what is already
> built, what blocks the release, the sequence, where each piece goes, and how to
> tell whether it worked. Written so it can be handed to someone else and
> executed without a briefing.

## The thesis

Most AI pentest agents are built to *find* things. The bottleneck in this field
is not generation and it is not recall — it is that **severity is still a human
judgment made after the run**. A tool with an enforced severity ceiling will
score *worse* on the axis existing benchmarks reward, because it refuses to
report what it cannot prove. That is the correct behaviour and it is why the axis
is not measuring what people want it to measure.

Everything below is arranged to make that argument credibly, once, in public, and
then to stop talking.

## The discipline

These are not preferences. Each one is a way this has gone wrong before, in this
field or in this repository.

- **Content is the answer to a question someone is already asking.** Never a post
  about the tool. The tool is the proof, the problem is the subject.
- **Two pieces, two different theses.** The anchor argues the measurement. The
  follow-up argues the architecture. The same thesis twice, three weeks apart,
  to the same audience, is the signature of a campaign and it is what makes a
  reader distrust the first one.
- **No repository link in the body of the anchor post.** In the footnotes, in the
  profile, or nowhere. A repository that arrives without context generates
  nothing; one that arrives as the answer to a question the reader already has
  generates a reader.
- **No secondary accounts. No voting rings.** They violate HN's submission rules
  and the outcome is negative for both the rule and the reader. The rules are
  explicit and the penalty is not a warning.
- **Silence after the burst.** One post, one follow-up, one Show HN, LinkedIn
  once in English. Diluted self-promotion is the thing this audience punishes
  hardest, and it is unrecoverable.
- **Only claim what is measured.** Every number published ships with its seed,
  its agent and its model version. This includes the numbers about us.

## Done, and on the remote

| | |
|---|---|
| `docs/METHODOLOGY.md` | the citable artifact. Three metrics, the contamination argument, the severity ceiling. Written to be applied to agents that have nothing to do with us |
| `docs/TOOL-LANDSCAPE.md` | where the published benchmarks stop. The narrow gap, argued against the strongest existing work rather than around it |
| `docs/THREAT-MODEL.md` | our own attack surface, written down before someone else finds it. Framed as a challenge |
| `docs/RECORDING.md` + `docs/demo.tape` + `tools/demo.sh` | the README demo: deterministic, isolated, one command from a GIF |
| `tools/ensure-test-scope.js` | a clean clone can run its own suite: 91 pass, 0 fail, verified from scratch |
| `tools/mcp-guard-proxy.js` | committed and tested. It was untracked while the README documented it |
| `tools/testkit.js` | landed alone, so the three tests that require it can land safely |
| `tools/gen-bench.js` | the contamination-proof generator and evaluator, instrument ready, no scores published yet |
| Citation fixes | the 87% / 13% / HTB figures attributed, "up to 13%" corrected, a "Citing this project" block |
| De-identification | tailnet IP, adb serial and login user gone; they are required arguments now |
| `refs/` provenance | the licensing gap made visible, then the directory unpublished until it is recoverable |
| `package.json` | `repository`, `bugs`, `homepage`, `files` whitelist, five verified `bin` entries |

## Strategy correction

The first version of this plan proposed publishing a comparison of AI pentest
tools. That was half wrong, and finding out why changed the plan.

**Escape published that benchmark in June 2026**
(<https://escape.tech/blog/modern-ai-powered-pentesting-tools-in-depth-benchmark/>)
— Cascade against a bare Claude Opus 4.8, plus Aikido and XBOW measured
independently by Doyensec
(March–April 2026). It reports true positives, severity distribution and
high-severity count, weights conclusions toward the hardest-to-game axis, and it
already makes the contamination argument better than we would have: they built
their own target because Juice Shop lives in training data, and they caught the
model reaching for public write-ups mid-run. They also state the dedup rule as
one that "should be applied to every tool before anything is published", which is
the kind of methodological generosity that makes a benchmark credible.

Beating a funded vendor at their own benchmark with a smaller budget is not a
plan. So the content anchor moved to the axis that is genuinely unmeasured, and
`TOOL-LANDSCAPE.md` is an argument about where the field stops rather than a
ranking:

> Severity is still a human judgment made after the run, precision is computed
> by hand and then discarded, nothing reports what a tool withheld, and no
> published benchmark measures whether a tool was *capable* of overstating.

The uncomfortable corollary belongs in the anchor post and not in a footnote: a
tool with an enforced ceiling scores **worse** on the axis the field rewards. Say
that before someone else does. It is the single most credible sentence available,
because it is a cost we are volunteering to pay.

## Blockers

**1. `refs/` licensing — resolved, reversibly.**
Verbatim reproductions of third-party documents with the per-group sources
stripped, plus an explicit Tencent copyright claim. Out of the index and
gitignored; files on disk; `git add -f refs/` brings them back. Nothing in code
reads it. `docs/REFS-PROVENANCE.md` keeps it legible and names the eight
documents `refs/README.md` calls self-written, in case the answer is a clean
subset rather than all or nothing.

**2. A clean clone could not run its own suite — resolved.**
`scope.json` is gitignored, correctly, which left a clean checkout with no
authorization, and the fail-closed guard blocked the loopback the offline tests
legitimately need. `tools/ensure-test-scope.js` provisions a loopback-only scope
when none exists, and never touches one that does. Loopback-only is still
fail-closed for everything remote.

**3. The remaining red, which is not ours to commit.**
`doctor --check` exits 2 on a clean clone on one check only: `.agents/*.ts
(agenti definiti) 1 agenti`. The committed `countAgents()` counts one file while
demanding twenty. **The fix is already in the working tree, uncommitted.** It
lands with the rest of that change set; until then CI on a clean checkout cannot
be green.

**4. That change set is coupled and must move as one.**
`tools/test-repo-invariants.js` asserts every number the README declares is real —
test count, agent count, module count. It earns its keep: it caught this
repository claiming 140 modules the moment `tools/ensure-test-scope.js` made it
141. It is satisfied only by the pending README edit, and those numbers are
already stale in one place. **Re-derive them when the test lands.** The three
tests that require `tools/testkit.js` must land with it already in place, which
it now is.

## The sequence

Nothing is published before the thing it depends on exists.

**Week 0 — make it publishable.**
Land the pending change set as one unit. Record the demo. Link the new documents
from the README. `npm test` green from a clean clone, 92/0 or 91/0 depending on
whether `test-repo-invariants` has landed. Nothing goes public this week.

**Week 1 — measure, do not write.**
Run the A/B: N seeds, same model, guard on and guard off, populating
`reports/bench-history.jsonl`. This is the only thing standing between the plan
and its own evidence — see the blocker note in `BENCHMARK.md` that no scores are
published yet. No post can be written until this is done, because the post *is*
the delta.

**Week 2 — the anchor post.**
`docs/TOOL-LANDSCAPE.md`, turned into a post. Title is the thesis, not the
product: *"Severity is still a human decision, and that is why your AI pentest
numbers are soft."* No repository link in the body. Publish on the blog and on
the venues below.

**Week 3 — the repository goes public.**
Visibility is a separate switch from pushing, and it is deliberate: everything
the anchor references is already true and public by then. Show HN as **Show HN**
(not a link — a three-day-old repository with no issues fails validity), Tue to
Thu, 8–9am ET. Then stay in the thread for the first two hours answering
everything. Comment activity and freshness is what actually moves the ranking, not
the submission.

**Week 4 — the challenge.**
`docs/THREAT-MODEL.md` published with a deadline and a reward. It is the piece
with the longest tail: it converts skeptics into contributors, and the people who
can break it are exactly the people whose opinion is worth having. One real
public answer from the first person who tries is worth more than the document.

**Weeks 5–16 — the part that works.**
Answer questions on r/netsec, r/security and HN without mentioning the tool. When
someone eventually asks what you use, answer with a link. It is slow, it costs
nothing, and it is the only strategy that does not self-destruct at the first
sign of rejection.

## Channels

**Hacker News.** Not a mailing list, nothing is sent. It is shown: a short
recording of the suite going green, and a title carrying the thesis. One to two
submissions in twenty reach the front page; that is the base rate, not a verdict
on the work. Be in the thread for two hours.

**Reddit.** r/security removes blog posts from new accounts, reliably. Build
karma for a week with comments only, then post as text with the numbers in the
body and the link in a comment. r/netsec is the better home for this content and
is friendlier to technical writing. r/MachineLearning is a different conversation
— the AI-safety angle exists but a penetration harness is not that post.

**The agent-framework Discords** (Strix, PentAGI, and whatever else is active).
Highest ratio of value to cost in this whole plan, and the most under-used. The
persona that matters there is not looking for a tool, they are evaluating
alternatives and they have a build already. Arrive with something to contribute
and a one-line integration, not a demo. Participate in the discussion; pitching
is the fastest way to become noise.

**LinkedIn, once, in English.** For the people who will never read a technical
post but will forward a link to someone who will. One post, then nothing.

**The curated newsletter or venue you already read.** Whatever it is: it must be
a *different* thesis from the anchor — architecture rather than measurement — and
it must stand alone if read with no other context. The reader who sees both
should think those are two pieces of work, not one message sent twice.

## What to judge it by

Stars are a vanity metric with a long lag. These are the real signals, in order
of how much they mean:

1. **Someone competent disagrees in public and is wrong for a reason you did not
   anticipate.** That is the outcome — it means the argument was taken seriously
   enough to be worth attacking.
2. **An outside contribution, or an outside harness being scored with
   `tools/gen-bench.js`.** The benchmark spreading further than the tool is the whole
   thesis working.
3. **Someone asks "what do you use".** That is the conversion, and it arrives on
   its own schedule if the first four things happened.
4. **Forks, issues from strangers, and people running the guard in their own
   pipeline.**
5. Stars. Last, and eventually.

Failure looks like: one front page that nobody comments on, or a comment thread
where the only replies are yours. Both mean the argument did not land, and the
right response is to fix the argument, not to post again.

## Two things on your side, unrelated to launch

- **`scope.json` records that its own comment once held a plaintext credential**
  (user plus password), truncated, and that the file was later rebuilt from
  `doctor` output after corruption. It is gitignored, so it was never in history,
  and the CI hygiene job enforces that. Rotate the password anyway, and check the
  shell history of whoever edited it.
- **`git config user.name` / `user.email` are unset**, so every commit needs an
  override. One `git config user.email "..."` in this repo and it stops being a
  per-command flag. Deliberately not done here: altering git config inside
  someone else's repository is not a thing to do without being asked.
