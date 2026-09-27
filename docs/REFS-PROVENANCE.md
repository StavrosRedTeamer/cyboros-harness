# `refs/` — provenance, licensing, and why it is not in this repository

> `refs/` is the agent's knowledge corpus: roughly 100 deep reference documents
> on web, API, mobile, miniprogram, component and AI-application testing, much of
> it in Chinese. It is **not published in this repository**, and this page exists
> so that decision is legible instead of looking like something was quietly
> deleted.

## What happened

The corpus is **not wholly first-party**. Its own `refs/README.md` states that
large parts of `web/`, `api/`, `mobile/`, `components/`, `offensive/`, `zh/`
and `miniprogram/` are reproduced **verbatim** from third-party documents
(按原文收录 — "reproduced as-is from the original").

Two things then went wrong:

1. **The per-group source names were stripped.** The attribution section of that
   README listed which groups came from where, and the names were removed,
   leaving bare punctuation. Several lines now read as a claim of verbatim
   reproduction with no source attached to it. The affected entries are marked
   `【来源未记录】` in the file itself.
2. **The stated licence trail does not exist.** That README says per-file
   licence notes for third-party content live in each directory's README. There
   are three such READMEs for 106 files. 88 of 106 files carry inline source
   links or `来源:` / `Source:` attributions, which is a partial record, not a
   licence grant.

One file carries an explicit third-party copyright claim:
`miniprogram/wmpf-debugger.md` states that code in `src/third-party` is "fully
copyrighted by Tencent Holdings Ltd." Only documentation is reproduced there —
no tool code ships — but the claim is unresolved.

## Why it was removed from the public tree

Redistributing verbatim third-party works without a recorded licence is the
kind of thing that gets a repository taken down, and it would do so the week
you are trying to be credible in front of an audience that has every reason to
check. Better to ship less and be able to answer "where did this come from?"

**Nothing in the code reads `refs/`.** Not `npm test`, not `doctor --check`, not
any tool under `tools/`. It is read on demand by the agent at engagement time,
from the working copy. Removing it from the repository costs the public
readers the knowledge base and costs the engine nothing.

The files are untouched on disk in the maintainer's working copy. They are
removed from the git index only.

## How to put it back

Once the sources are recovered, one command:

```bash
git add -f refs/
```

The three routes, in order of preference:

1. **Recover the sources.** Record them per file with their licence, fill in the
   `【来源未记录】` entries, and correct the sentence about per-directory licence
   notes so it describes what is actually there. Then the corpus is
   redistributable and can be published.
2. **Hold the rights.** If you wrote or commissioned the originals, or hold a
   licence that permits redistribution, say so on this page in writing, naming
   the licences. Then publishing is straightforward.
3. **Publish a self-written subset only.** `refs/README.md` names eight documents
   it describes as self-written (`web/WAF_PRODUCT_MATRIX.md`,
   `web/honeypot-detection.md`, `zh/waf-bypass-cn.md`,
   `zh/dynamic-waf-reverse.md`, `api/http3-quic-attacks.md`, `api/sse-security.md`,
   `api/grpc-security.md`, `zh/tools/tools-burp-plugin-ecosystem.md`). It also
   notes eight existing documents were *extended* rather than written, which is
   murkier and needs judgement per file. A subset of eight documents is a thin
   knowledge base, but it is a clean one.

## If you take nothing else from this

The reason the harness refuses to publish what it cannot account for is the same
reason it refuses to record a finding it cannot prove. It is not inconsistent to
apply the evidence standard to your own repository. It would be inconsistent not
to.
