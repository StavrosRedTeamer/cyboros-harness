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
| `refs/` provenance | the licensing gap made visible instead of silent |

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

**1. `refs/` licensing — the only hard blocker.**
The directory contains verbatim reproductions of third-party documents whose
per-group sources were stripped, so the attribution it needs to be
redistributable does not exist. One file carries an explicit Tencent copyright
claim. Three ways out, in order of preference:

- recover the sources and record them per file with their licence; or
- drop the verbatim groups from the public repo and keep them private — nothing
  in `npm test`, `doctor --check` or any tool reads `refs/`, so this is clean; or
- state in writing that you hold redistribution rights, naming the licences.

**2. The `testkit` landmine.**
`tools/test-attack-coverage.js`, `tools/test-loop-watch.js` and
`tools/test-reflector.js` all `require('./testkit')`, and `tools/testkit.js` is
untracked. HEAD is fine today. The moment those three are committed without it,
`npm test` breaks for everyone who clones. **Commit them together or not at
all.** This is one `git add`, not a bug.

**3. Decide on `session-prompt-egress-f3.md`.**
It is untracked and contains only loopback addresses, but it is a runbook for
one specific phone setup. Add it to `.gitignore` or just never stage it.

## Next, in order

**4. Record the demo.**
`./tools/demo.sh` is tested and isolated. Two commands:
```bash
asciinema rec -c ./tools/demo.sh demo.cast && agg demo.cast demo.gif
```
The GIF goes in the README next to the Command Center screenshot, which is
currently the only visual. `asciinema` and `agg` are not installed here.

**5. Publish the challenge.**
`docs/THREAT-MODEL.md` is written. It needs a bounty amount or a deadline to be
a challenge rather than a document, and one real answer from you in public to the
first person who tries. Nothing else in this list has that compounding effect:
it converts skeptics into contributors, and the people who can break it are
exactly the people whose opinion you want.

**6. Publish the gap argument.**
`docs/TOOL-LANDSCAPE.md` is the post. Title is the thesis, not the product —
something in the shape of *"Severity is still a human decision, and that is why
your AI pentest numbers are soft."* No link to the repository in the body. The
link is in the profile and in the footnotes, and the repository arrives as the
answer to a question the reader already has.

**7. Decide npm.**
`package.json` is still `private: true`, `0.0.0`. `npx` is the difference
between "clone, fill in scope.json, read two hundred lines" and "try it in ten
seconds", and it is the single largest adoption lever available. It also
commits you to a support surface, so it is a decision rather than a task.

**8. The CI one-liner.**
A precision check that runs on a `findings.json` inside someone else's pipeline.
This is how developer tools actually get adopted, and it is much stronger than a
link in a thread. `gen-bench.js eval` already does the scoring; what is missing
is the packaging and a documented output format.

**9. Link the new documents from the README.**
`README.md` has uncommitted changes from another thread, so it was left alone
deliberately. Add `METHODOLOGY`, `TOOL-LANDSCAPE` and `THREAT-MODEL` to the
Documentation list when that file is next committed by whoever owns it.

**10. The three-month part, which is the part that works.**
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
  per-command flag.
