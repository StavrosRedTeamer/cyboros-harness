# Recording the demo

> The README needs one moving picture: the hero screenshot shows the Command
> Center, and nothing shows the part that matters, which is a program refusing
> to do something. `tools/demo.sh` is written, tested and deterministic. What is
> left is one command on a machine with a terminal.

## What is already done

`tools/demo.sh` runs three refusals and a green test subset. It is fully
isolated — it provisions its own throwaway scope, findings file, head anchor and
tab database, and refuses to run if any of them is not redirected. It never
touches your real `scope.json`, `reports/` or `~/.dsh/`.

```
$ DEMO_FAST=1 DEMO_PACE=3 ./tools/demo.sh
```

`DEMO_FAST=1` runs the real guard tests (`--only guard`, 4 tests) instead of the
full 94-test gate. `DEMO_PACE=3` holds each step for three seconds.

**Run it and read the output before recording anything.** The GIF is only worth
making if the thing it shows is the thing you are willing to be known for.

## Two things that were got wrong first, and why they are now in the script

**Pacing belongs to the demo, not the renderer.** The real work finishes in about
a second. Recorded as-is that is a one-second GIF nobody can read. The usual fix
is to add `Sleep` commands to the tape — which means the timing lives in two
places and drifts the first time the demo changes. `DEMO_PACE` puts the hold in
the script, so asciinema and VHS produce the same result and a change to the demo
changes the timing with it.

**Determinism.** The demo writes to a fixed `$TMPDIR/cyboros-demo` rather than
`mktemp -d`, because the paths appear in the output and
`/tmp/tmp.RZ4eFZFPvB/f.json` is both ugly and different every run. Two run
concurrently, they collide — do not run the demo twice at once while diffing it,
which is exactly what I did while testing this. Sequentially the output is
identical across runs except two real timing numbers.

## The one command

Requires a terminal, which the agent session does not have, so this is the part
that has to happen on your machine.

```bash
npm i -g vhs            # or: brew install vhs
vhs docs/demo.tape
```

`docs/assets/demo.gif` lands ready for the README. That is it.

If you prefer to record a live session instead, the equivalent is:

```bash
pipx install asciinema          # asciinema 3 bundles the GIF renderer
asciinema rec -c "DEMO_FAST=1 DEMO_PACE=3 ./tools/demo.sh" demo.cast
asciinema agg --theme github-dark --font-size 15 --idle-time-limit 2 demo.cast docs/assets/demo.gif
```

## Which tool, honestly

| | VHS | asciinema + agg |
|---|---|---|
| Produces | GIF, MP4, WebP | GIF |
| Input | a declarative tape | a recorded session |
| Reproducible | yes, byte-for-byte on the same machine | no — timing depends on the run |
| Pacing | comes from the script, via `DEMO_PACE` | same, since the pacing is in the script |
| Cost | one Go binary, writes GIF and MP4 | Python install, one renderer |

**VHS, for the reason above.** The demo is a script, so there is nothing to
discover by recording it, and a published artifact that comes out differently
every time is a bad property for a project whose entire claim is rigour. VHS
also emits MP4, which matters for the next point.

asciinema is the better tool when you are recording a human doing something
irreducible — a live exploit, an interactive TUI, a race you can only watch once.
This is not that.

## The size budget, which is the part people get wrong

A 50-second, 80-column terminal GIF at default settings is routinely 8–15 MB.
That is a README that takes a visible moment to render, and it is the difference
between a visitor reading past it and bouncing.

`docs/demo.tape` is set up to land in the 1–2 MB range: ~12 seconds of content,
font size 15, 1000px wide. Check it:

```bash
ls -lh docs/assets/demo.gif
gifsicle -O3 --lossy=80 docs/assets/demo.gif -o docs/assets/demo.gif   # optional
```

If it still comes out over 3 MB, render WebP instead — roughly 60% smaller, and
GitHub renders it in a README. `vhs docs/demo.tape` with `Output
docs/assets/demo.webp` does it.

## Where the artifact lives

`docs/assets/demo.gif`, committed, referenced from the README next to the
Command Center screenshot.

For the anchor post, the same file needs a stable public URL:
`https://github.com/stavrosredteamer/cyboros-harness/raw/master/docs/assets/demo.gif`
works and costs nothing, and it inherits the repository's credibility. Do not
upload the recording to a third-party GIF service — not because the content is
sensitive (it is all synthetic `.example` hosts), but because a canonical URL on
your own repository is one fewer thing that can rot.

## Checklist before it goes in the README

- [ ] Watch the GIF at least twice as a stranger would. Is every refusal on
      screen long enough to read?
- [ ] Confirm no real host, no real path outside `$TMPDIR`, no real token.
- [ ] Confirm the output on screen matches what the command actually prints today.
- [ ] Under 3 MB, or switch to WebP.
- [ ] `docs/assets/` is tracked and the file is actually committed — an asset
      referenced but not pushed is the most common way this silently fails.
