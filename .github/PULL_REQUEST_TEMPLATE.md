## What changes

<!-- One sentence. The "why", not the "what": the diff already says what. -->

## What it touches

- [ ] `tools/` — a tool or a test (new test → the README count moves with it)
- [ ] `docs/`, `ops/` or a root `.md` → I regenerated `docs/INDEX.md`
- [ ] `.gitignore` / `.gitattributes` — rules about engagement data
- [ ] `AGENTS.md` — still inside the 6000-character prompt budget
- [ ] `package.json` — no dependency added (CI fails if one appears)

## How it was verified

<!-- The commands you ran and their outcome — not "tests pass". -->

```
npm test                              # exit …
node tools/test-repo-invariants.js
node tools/docs-index.js --check
```

## Does it still work from a clean clone?

<!-- If the change adds files, the answer has to be yes: `test-lint` fails on a relative
     require that points at a file git does not track, and that is exactly what kept master red. -->

## For the reviewer

<!-- Open doubts, options you discarded, anything you did not verify. -->
