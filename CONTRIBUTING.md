# Contributing

This repository is a penetration-testing harness built around one claim: a finding is only a
finding if code can prove it, and the agent cannot violate scope because the enforcement sits
*beneath* it. Contributions are welcome as long as they keep that claim true.

## Setup

Node **>= 22**. `.nvmrc` pins the major and `package.json` declares `engines.node >= 22`; the
Command Center backend uses `node:sqlite`, which is why the floor is that high.

There is **nothing to install**:

```bash
git clone https://github.com/stavrosredteamer/cyboros-harness.git
cd cyboros-harness
npm test          # the full offline suite, ~35 s
```

`npm test` runs `node tools/run-tests.js`: it discovers every `tools/test-*.js`, classifies it
from a marker in its header (`// test-tags: loopback` or `e2e`) and runs the offline + loopback
sets with two workers. `npm run test:ci` is the same command with `--jobs 2` explicit (what CI
runs). `npm run test:all` (`--e2e`) adds the live tests and **needs network and a real
browser**: it is not the gate.

## Zero dependencies is a design constraint, not a preference

`package.json` has no `dependencies` and no `devDependencies`, and there is no
`package-lock.json`. The CI job fails if either ever appears. The reason is in the README: on a
client network `npm install` does nothing, and the harness has to run air-gapped. The Node
standard library is the only toolchain you get.

Practically: no test framework, no bundler, no linter package. `tools/run-tests.js` is the
runner, `tools/testkit.js` is the shared test scaffolding, and a new dependency is a change to
the project's deployment story — treat it as a design decision, not a convenience.

## Adding a tool or a test

A tool is `tools/<name>.js` starting with `#!/usr/bin/env node`, invoked as
`node tools/<name>.js`. A test is `tools/test-<name>.js` and uses the shared scaffolding:

```js
const { ok, okAsync, summary, fixture } = require('./testkit');

ok('what is being claimed', () => { assert.strictEqual(a, b); });
summary('name');
```

The gates enforce the rest, so you do not have to remember it:

- **Use `testkit.js`.** A test that re-implements the pass/fail counter and `ok()` fails the
  suite.
- **Everything your module requires must be committed.** `tools/test-lint.js` fails when a
  relative `require` resolves to a file that git does not track: a module that exists only on
  your disk breaks every clone. That defect kept `master` red once, with three suites in
  `MODULE_NOT_FOUND` while every local run was green.
- **`docs/INDEX.md` is generated.** After adding, renaming or moving any `.md` in the root,
  `docs/` or `ops/`, run `node tools/docs-index.js`; `--check` is the gate. Only files that git
  tracks are indexed, so a gitignored file can never make the index irreproducible.
- **The README's numbers are checked against reality** — tests, modules, pipelines, agent
  definitions. If you add a test, update the count. Do **not** adjust the number to make the
  gate pass: the gate is measuring the repository, and it is right.
- **`AGENTS.md` has a 6000-character budget**: it is injected verbatim into the system prompt
  of every agent session. Long-form detail belongs in `ops/harness.md` — leave a pointer, not
  the text.

## Engagement data never enters the repository

`scope.json` **is** the written authorization, and it is not versioned. Neither are `reports/`,
`temp/`, `auth.json`, `c2.json`, `wifi-scope.json`, `mobile-scope.json`, `campaign.json`, or
any `*.bak` backup of them. Two CI jobs and one invariant enforce this over the index, over the
whole history of every ref, and over the content of tracked files.

If you are testing against something real, it has to be something you own or are authorized in
writing to test.

## Commits and pull requests

Commit subjects follow Conventional Commits — `feat:`, `fix:`, `docs:`, `test:`, `chore:`,
`refactor:`, `perf:`, `build:`, `ci:`, `style:` — with an optional scope (`fix(ci):`) and `!`
for a breaking change. The `pr-title` CI job checks the pull request title, because with squash
merges the PR title *is* the commit message on `master`. Write the subject in the imperative
and use the body to explain **why**, not what: the diff already says what.

Please do not rewrite history to make older commits conform — the rule applies from now on.

The pull request template asks what changed, how you verified it, which commands you ran, and
whether you touched the engagement rules or the generated index.

## Reporting a vulnerability

Not in a public issue. See [SECURITY.md](SECURITY.md).
