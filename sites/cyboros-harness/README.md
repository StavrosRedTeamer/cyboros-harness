# Cyboros Harness — landing page

A single static page that presents the Cyboros Harness project: the thesis, the two
ideas, the verification ladder, the quick start, and links to the documentation.

This directory is **independent of the harness engine**. It is not a tool, it is not
tested by `tools/run-tests.js`, and it does not read `scope.json` or any engagement data.
It contains no engagement information of any kind.

## Layout

| Path | Purpose |
|---|---|
| `public/` | the deployable static output — `index.html`, `styles.css`, `app.js`, PNG favicons, and `img/` (the ouroboros mark and hero art, WebP) |
| `worker.js` | Worker entrypoint: `env.ASSETS.fetch(request)`, nothing else |
| `wrangler.jsonc` | local dev config (`wrangler dev`) |
| `deploy.manifest.json` | manifest for the Sites deploy tool |

## Content rules

Every factual claim on the page is taken from the repository `README.md`, with the same
attributions. Two rules were applied when writing it:

- The 87% / ≤13% figures keep their citations (Fan et al. 2024; Zhu et al., CVE-Bench,
  ICML 2025).
- The near-zero HackTheBox figure is labelled as the project's own **unreleased
  observation**, not a published result — exactly as the README labels it.

The terminal excerpt in the hero is marked *illustrative output* on the page itself.

## Local verification

```bash
npx wrangler dev --config wrangler.jsonc    # http://localhost:8787
```

Check the page renders, that `index.html`, `styles.css`, `app.js`, the PNG
favicons and the `img/*.webp` assets all return 200 with correct content types,
and that the console is clean.

## Deploying

Deployment is done through the Sites tools, not from here. The manifest
`deploy.manifest.json` is the input: it points at `./worker.js` as the entrypoint
module and `./public` as the assets directory. `spa` is `false`: there are no
client-side routes, so an unknown path should 404 rather than answer 200 with the
landing page (a soft 404).

| | |
|---|---|
| Site id | `3eafaf35-6896-4a3f-9338-88de06d92397` |
| Preview | https://site-6ba69c0b9c024eada8f509aaa66fa160.freebuff.page |
| Production | not published |

`.wrangler/` is build state from `wrangler dev` and is gitignored.

Nothing in this directory is versioned as part of the harness's zero-dependency
guarantee — there is no `package.json` here and there never should be one. `wrangler`
is run through `npx` so it never becomes a dependency of the repository.
