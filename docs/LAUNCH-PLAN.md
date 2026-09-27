# Launch plan

> What is already built, what blocks the release, and what to do next — in that
> order. Written so it can be handed to someone else and executed.

## Done, and on the remote

| | |
|---|---|
| `docs/METHODOLOGY.md` | the citable artifact. Three metrics, the contamination argument, the severity ceiling. Written to be applied to agents that have nothing to do with us |
| `docs/TOOL-LANDSCAPE.md` | where the published benchmarks stop. The narrow gap, argued against the strongest existing work rather than around it |
| `docs/THREAT-MODEL.md` | our own attack surface, written down before someone else finds it. Framed as a challenge |
| `tools/demo.sh` | 45 seconds, three refusals, fully isolated. Ready to record |
| Citation fixes | the 87% / 13% / HTB figures attributed, "up to 13%" corrected, a "Citing this project" block |
| `mcp-guard-proxy.js` | committed and tested. It was untracked while the README documented it |
| De-identification | tailnet IP, adb serial and login user gone; they are required arguments now |
| `refs/` provenance | the licensing gap made visible instead of silent, then the directory unpublished until it is recoverable |
| `tools/ensure-test-scope.js` | a clean clone can now run its own suite: 91 pass, 0 fail, verified from scratch |
| `tools/demo.sh` + `docs/demo.tape` + `docs/RECORDING.md` | the README demo, deterministic and one command away from a GIF |

## Strategy correction

The first version of this plan proposed publishing a comparison of AI pentest
tools. That was half wrong, and finding out why changed the plan.

**Escape published that benchmark in June 2026** — Cascade against a bare
Claude Opus 4.8, plus Aikido and XBOW measured independently by Doyensec. It
reports true positives, severity distribution and high-severity count, weights
conclusions toward the hardest-to-game axis, and it already uses the
contamination argument: they built their own target because Juice Shop lives in
training data, and they caught the model reaching for public write-ups mid-run.

Beating a funded vendor at their own benchmark with a smaller budget is not a
plan. So the content anchor moved to the axis that is genuinely unmeasured, and
`TOOL-LANDSCAPE.md` is now an argument about where the field stops rather than a
ranking:

> Severity is still a human judgment made after the run, precision is computed
> by hand and then discarded, nothing reports what a tool withheld, and no
> published benchmark measures whether a tool was *capable* of overstating.

The uncomfortable part, which belongs in the anchor post and not in a footnote:
a tool with an enforced severity ceiling will score **worse** on the axis
existing benchmarks reward. Say that before someone else does.

## Blockers before the repo goes public

**1. `refs/` licensing — resolved, reversibly.**
The directory contained verbatim reproductions of third-party documents whose
per-group sources were stripped, so the attribution it needs in order to be
redistributable did not exist, and one file carried an explicit Tencent
copyright claim. It is out of the index and gitignored; the files are on disk and
`git add -f refs/` brings them back. Nothing in code reads it, so this costs
public readers a knowledge base and costs the engine nothing.
`docs/REFS-PROVENANCE.md` keeps the decision legible and names the eight
documents `refs/README.md` describes as self-written, in case the answer turns
out to be a clean subset rather than all or nothing.

**2. A fresh clone could not run its own test suite — resolved.**
`scope.json` is gitignored, correctly, but that left a clean checkout with no
authorization at all, and the scope-guard is fail-closed, so it blocked the
loopback targets the offline tests legitimately need. `npm test` failed on
`test-authn-depth`. `tools/ensure-test-scope.js` now copies a loopback-only
`scope.example.json` into place when `scope.json` is absent — never touching,
widening or repairing an existing one. Verified on a clean clone: 91 pass, 0
fail. Loopback-only is still fail-closed for everything remote.

**3. The remaining red, which is not ours to commit.**
`doctor --check` still exits 2 on a clean clone, on one check only:
`.agents/*.ts (agenti definiti) 1 agenti`. The committed `countAgents()` counts
only `.agents/*.ts` — one file — while demanding twenty. **The fix is already
sitting uncommitted in this working tree**, where `countAgents()` iterates
`AGENT_DIRS` across `local/fleet` and `.agents`. It lands with the rest of that
coordinated change set. This is why CI on a clean checkout cannot be green until
that set is committed as a unit.

**4. That same change set has a hard coupling.**
Three tracked tests — `test-attack-coverage.js`, `test-loop-watch.js`,
`test-reflector.js` — `require('./testkit')`. `tools/testkit.js` was untracked,
so the moment those three were committed the suite would break for everyone.
`testkit.js` is now committed on its own, so the coupling is defused and the
three can land whenever.

Note the other direction of that coupling: `tools/test-repo-invariants.js` (also
untracked) asserts that every number the README declares equals reality — the test
count, the agent count, the module count. It is a genuinely good gate: it caught
this repository declaring 140 modules the moment `ensure-test-scope.js` made it
141. **Re-derive the README numbers at the moment that test lands**, because
anything added since the pending README edit shifts them. Committing the test
against stale numbers turns CI red for a reason that has nothing to do with the
test being wrong.

## Next, in order

**5. Record the demo.**
`tools/demo.sh` is tested, isolated and deterministic, and now takes `DEMO_FAST`
(a real 4-test subset, not a canned summary) and `DEMO_PACE` (a hold between
steps, so a one-second run becomes a readable GIF). `docs/demo.tape` is a VHS
tape that renders it in one command. Full procedure, tool comparison and the
size budget: [`RECORDING.md`](RECORDING.md). The only reason it is not done is
that recording needs a terminal, and the agent session does not have one.

**6. Publish the challenge.**
`docs/THREAT-MODEL.md` is written. It needs a bounty amount or a deadline to be
a challenge rather than a document, and one real answer from you in public to the
first person who tries. Nothing else in this list has that compounding effect:
it converts skeptics into contributors, and the people who can break it are
exactly the people whose opinion you want.

**7. Publish the gap argument.**
`docs/TOOL-LANDSCAPE.md` is the post. Title is the thesis, not the product —
something in the shape of *"Severity is still a human decision, and that is why
your AI pentest numbers are soft."* No link to the repository in the body. The
link is in the profile and in the footnotes, and the repository arrives as the
answer to a question the reader already has.

**8. Decide npm.**
`package.json` now carries `repository`, `bugs`, `homepage`, a `files` whitelist
and five verified `bin` entries, so publishing is one flag and one command. It
is still `private: true` and `0.0.0` — publishing is a decision, not a task, and
it commits you to a support surface.

**9. The CI one-liner.**
A precision check that runs on a `findings.json` inside someone else's pipeline.
This is how developer tools actually get adopted, and it is much stronger than a
link in a thread. `gen-bench.js eval` already does the scoring; what is missing
is the packaging and a documented output format.

**10. Link the new documents from the README.**
`README.md` has uncommitted changes from another thread, so it was left alone
deliberately. Add `METHODOLOGY`, `TOOL-LANDSCAPE`, `THREAT-MODEL`,
`REFS-PROVENANCE` and `LAUNCH-PLAN` to the Documentation list when that file is
next committed by whoever owns it.

**11. The three-month part, which is the part that works.**
Answer questions on r/netsec, r/security and HN without mentioning the tool.
When someone eventually asks what you use, answer with a link. It is slow, it
costs nothing, and it is the only strategy that does not self-destruct at the
first sign of rejection.

## Two things to fix on your side, unrelated to launch

- **`scope.json` records that its own comment once held a plaintext credential**
  (user plus password), truncated, and that the file was later rebuilt from
  `doctor` output after corruption. It is gitignored so it was never in history,
  and the CI hygiene job enforces that. Worth rotating that password anyway,
  and worth checking the shell history of whoever edited it.
- **`git config user.name` / `user.email` are unset**, so every commit needs an
  override. One `git config user.email "..."` in this repo and it stops being a
  per-command flag. (Not done here on purpose: altering git config is not a thing
  to do inside someone else's repository without them asking for it explicitly.)
