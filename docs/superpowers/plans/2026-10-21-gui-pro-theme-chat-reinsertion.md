# Reinsert Pro Theme, Guide and Chat into the Identity-era Console — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Stato (2026-10-21): completato e branch ritirato.** Il lavoro è su `master`; `feat/gui-pro-theme-guide`
> non esiste più (locale e `origin`), quindi i commit citati qui sotto sono riferimenti storici, non
> qualcosa da recuperare. L'unica parte del branch che non era già stata reimplementata — l'isolamento
> fail-closed di `scripts/demo-command-center.sh` — è stata portata su `master` prima della rimozione.

**Goal:** Bring the professional theme overlay, the interactive guide, and the OpenAI-style Chat view — all built on branch `feat/gui-pro-theme-guide` (commit `4ec6db8`) — into the current `master` working tree, which has since diverged with an unrelated identity/role/config rewrite of the same GUI (`tools/console/*`, `tools/identity.js`, `tools/config.js`, login/users).

**Architecture:** `master` and `feat/gui-pro-theme-guide` are sibling branches off the same `v0.2.0` release (`de9be27`); neither has the other's work, and a textual merge is not possible because `tools/gui-server.js` was gutted from ~955 lines to a 239-line composition root on `master`. This plan re-implements the branch's three features *on top of* the new `tools/console/` architecture: the theme (CSS+JS) and guide (JS) are additive and copy over with only wiring changes; the Chat view's backend (~120 lines that lived inline in the old `gui-server.js`) becomes a new `tools/console/chat.js` module + `tools/console/routes/chat.js` route family, and its frontend is ported from the old token-in-`sessionStorage` auth to the new cookie-based `api()`/role model.

**Tech Stack:** Node.js (zero npm dependencies), vanilla JS SPA, CSS cascade layers, `node:sqlite`, the repo's own `tools/test-*.js` hermetic test runner.

**Spec:** No separate spec document — the spec is commit `4ec6db8` on branch `feat/gui-pro-theme-guide` (`git show 4ec6db8 --stat` / `git show 4ec6db8 -- <path>` for each file below) plus the current `master` working tree (`tools/console/*`, `tools/identity.js`, `tools/config.js`, `tools/gui/app.js`, `tools/gui/index.html`) as the architecture the branch's work must land on. Read both before starting.

## Global Constraints

- Zero npm dependencies; zero network egress beyond loopback (the chat backend talks to `127.0.0.1` local LLM endpoints by default; cloud profiles require `allow_cloud` in `runtime/providers.json` — unchanged from the branch).
- No session credential may live in page JS or `sessionStorage`. The session is an `HttpOnly` cookie; every new fetch that needs auth uses the shared `api()` helper (`tools/gui/app.js`) or explicitly sets `credentials: 'same-origin'` when it cannot (streaming bodies).
- Role matrix is `viewer(1) < operator(2) < admin(3)`, enforced once in `tools/identity.js`'s `requiredRole(url, method)` (GET/HEAD → viewer, else → operator, with named exceptions). Do not duplicate this check in a route handler.
- No `!important` in any CSS file under `tools/gui/`; this is a standing assertion in `tools/test-gui-theme.js`.
- New backend prose comments (anything under `tools/console/`) are in English, matching every existing file in that directory. Files ported verbatim from the branch (`guide.js`, `views-chat.js`, `test-gui-theme.js`) keep their existing Italian comments — do not translate them.
- `node tools/run-tests.js` must stay green (currently 121 pass / 1 pre-existing unrelated fail `test-repo-invariants` / 1 e2e skip — see Task 5) after every task; `tools/run-tests.js` auto-discovers any `tools/test-*.js` file, no registration step needed.
- Do **not** port the branch's `scripts/demo-command-center.sh` isolation patch (env-redirecting `STATE_DB`/`ARTIFACT_LEDGER_FILE`/`AUDIT_DIR`/…). That leak is already closed differently on `master`: `tools/config.js`'s `dataPaths()` now resolves those paths under the configured data root by default, and the tools that still honor an env override (`artifact-ledger.js`, `identity.js`, …) fall back to `dataPaths()` first. Reintroducing the branch's raw env-exports would fight the new config precedence instead of helping. Task 5 just verifies the demo is still isolated.

## Review Focus

- **Chat session expires mid-stream.** A long chat response outlives the session's idle/absolute TTL; the POST `/api/chat` fetch must detect a `401` and send the tab to `/login`, not hang or throw an uncaught rejection into a dead composer. (Task 2)
- **Viewer role opens the Chat tab.** `POST /api/chat` must come back a clean `403` (role gate), and the composer must say why instead of silently failing on submit. (Task 1 test, Task 2 UI)
- **Fresh install, no `runtime/providers.json`.** `GET /api/chat/profiles` must degrade to `200 {error, profiles: []}` (never `500`/crash), and the UI must show the error instead of leaving "loading providers…" forever. (Task 1, Task 2)
- **17→19 tabs now wrap to two lines under the *pro* theme too**, not just cyberdeck. The new dynamic `--topbar-h`/`--tabs-h` sticky offsets (added on `master` after the branch forked) must still position `#tabs`/`#status-rail` correctly once `app.pro.css` is loaded. (Task 3)
- **`index.html` references a file that was never added** (or a typo'd filename) — the exact failure `tools/test-gui-theme.js`'s asset-integrity check exists to catch. Each task that edits `index.html` re-runs that one test by name, not just the full suite. (Task 3, Task 4)

---

## Task 1: Chat backend — `tools/console/chat.js` + route family

**Files:**
- Create: `tools/console/chat.js`
- Create: `tools/console/routes/chat.js`
- Modify: `tools/console/routes/index.js` (register the family)
- Modify: `tools/gui-server.js` (construct `chat`, add it to `ctx`)
- Modify: `tools/test-console-rbac.js` (role-gate assertions)

**Interfaces:**
- Consumes: `sendJson` from `./console/http` (already imported everywhere); `runtime/live.js`'s `loadConfig()`/`resolveProfile(cfg, name)`/`resolveKey(profile, keyEnv)`; `local/llm.js`'s `LocalLLM`/`trimContext` — all unchanged on `master`.
- Produces: `createChat()` returning `{ profiles(): object, stream(req, res, body): Promise<void> }`, consumed by `tools/console/routes/chat.js` and wired into `ctx.chat` in `tools/gui-server.js`.

- [ ] **Step 1: Write the failing test** — append to `tools/test-console-rbac.js`, right after the existing viewer/operator/admin sections (reuse `call`, `viewCookie`, `opaCookie` already in scope):

```js
// ── chat: conversation, not an engagement action — but still gated by role ──
assert.strictEqual((await call(port, 'GET', '/api/chat/profiles', { cookie: viewCookie })).status, 200, 'viewer may read chat profiles');
assert.strictEqual((await call(port, 'POST', '/api/chat', { cookie: viewCookie, body: { messages: [{ role: 'user', content: 'hi' }] } })).status, 403, 'viewer cannot start a chat');
assert.strictEqual((await call(port, 'POST', '/api/chat', { body: { messages: [{ role: 'user', content: 'hi' }] } })).status, 401, 'anonymous cannot start a chat');
const opChat = await call(port, 'POST', '/api/chat', { cookie: opaCookie, body: { messages: [{ role: 'user', content: 'hi' }] } });
assert.strictEqual(opChat.status, 500, 'operator passes the role gate and reaches the handler (no provider config in this sandbox, so it fails past auth, not at it)');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tools/test-console-rbac.js`
Expected: FAIL — `/api/chat/profiles` and `/api/chat` are unknown endpoints (404), not yet routed.

- [ ] **Step 3: Implement `tools/console/chat.js`**

```js
'use strict';
function createChat() { /* returns { profiles, stream } */ }
module.exports = { createChat };
```

Port the body of `chatMod()`, `inferEgress()`, `chatProfiles()` and `chatStream()` from `git show 4ec6db8:tools/gui-server.js` (the block right after `bodyJson()`, roughly 120 lines, header comment `// ── Chat (conversational LLM over the configured providers) ──`) almost verbatim inside `createChat()`: keep the four functions as closures, rename `chatProfiles` → the returned `profiles` method and `chatStream` → the returned `stream` method, import `sendJson` from `./http` at the top of the file instead of relying on the old closure variable, and change `require('../runtime/live')` / `require('../local/llm')` to `require('../../runtime/live')` / `require('../../local/llm')` (one directory deeper than the old `tools/gui-server.js`). Everything else — the availability/egress logic, the `messages[]` validation, the SSE `sse()` writer, the abort-on-close handling — is an exact copy.

- [ ] **Step 4: Implement `tools/console/routes/chat.js`**

```js
'use strict';

async function handle(ctx, req, res, url, query) {
  const { sendJson, bodyJson, chat } = ctx;
  if (url === '/api/chat/profiles' && req.method === 'GET') { sendJson(res, 200, chat.profiles()); return true; }
  if (url === '/api/chat' && req.method === 'POST') { await chat.stream(req, res, await bodyJson(req)); return true; }
  return false;
}

module.exports = { handle };
```

- [ ] **Step 5: Register the family in `tools/console/routes/index.js`**

Add `require('./chat')` to the `families` array (after `require('./accounts')`, before `state`, matching the file's existing comment about dispatch order — chat has no data dependency on the others, so where it sits in the array doesn't change behavior, only readability; put it next to the other new-ish families).

- [ ] **Step 6: Wire into `tools/gui-server.js`**

Add near the other module constructions (after `const terminals = createTerminals(...)`):
```js
const { createChat } = require('./console/chat');   // add to the require block at the top with the others
const chat = createChat();
```
Add `chat,` to the `ctx` object's module list (next to `scope, findings, pipeline, engagement, jobs, terminals,`).

- [ ] **Step 7: Run test to verify it passes**

Run: `node tools/test-console-rbac.js`
Expected: PASS, including the new assertions. Also run `node tools/test-cc-server.js` (unrelated server smoke test) to confirm nothing else broke.

- [ ] **Step 8: Commit**

```bash
git add tools/console/chat.js tools/console/routes/chat.js tools/console/routes/index.js tools/gui-server.js tools/test-console-rbac.js
git commit -m "feat(console): chat backend — /api/chat and /api/chat/profiles, role-gated"
```

---

## Task 2: Chat frontend — `tools/gui/views-chat.js` ported to cookie auth

**Files:**
- Create: `tools/gui/views-chat.js` (ported from the branch)
- Modify: `tools/gui/index.html` (Chat tab button, tabpane, script tag)
- Modify: `tools/gui/app.css` (append the Chat CSS block)

**Interfaces:**
- Consumes: `tools/gui/app.js`'s globals `el`, `byId`, `esc`, `toast`, `api(path, opts)`, `can(role)` (all already exported onto `window` implicitly as top-level functions in that file — this is the existing pattern every `views-*.js` file already relies on).
- Produces: `window.renderChat()`, called from `app.js`'s existing `renderTab()` dispatch (already has the `else if (tab === 'chat')` branch to add — see Step 4).

- [ ] **Step 1: Port the file**

`git show 4ec6db8:tools/gui/views-chat.js > tools/gui/views-chat.js`, then make exactly these edits:
1. Delete the `function token() { try { return sessionStorage.getItem('cc_token') || ''; } catch (e) { return ''; } }` helper (lines ~23) — the cookie travels automatically, nothing reads it from JS any more.
2. Replace the provider-list fetch (near the bottom, `fetch('/api/chat/profiles', { headers: { 'X-Cyboros-Token': token() } })...`) with `api('/api/chat/profiles').then(function (d) { ... })` — same `.then` body, just dropping the now-redundant `r.json()` step since `api()` already returns the parsed body, and dropping the `.catch` inherited `e.message` shape stays the same (`api()` throws `Error` the same way the old code's thrown errors did).
3. In the streaming `send()` function, change the `fetch('/api/chat', {...})` call: drop `'X-Cyboros-Token': token()` from `headers`, add `credentials: 'same-origin'` to the options object, and before the existing `if (!res.ok || !res.body)` check add:
   ```js
   if (res.status === 401) { location.replace('/login?next=' + encodeURIComponent(location.pathname + location.search)); return; }
   ```
   (mirrors `app.js`'s `api()` 401 handling exactly, duplicated here because this fetch streams a body and cannot go through `api()`).
4. In the mount/init function (where `chat-send`/`chat-stop`/`chat-new` listeners are wired), add a role check: if `!can('operator')`, disable `byId('chat-send')` and set its `title` to something like `'requires the operator role'`, and leave `chat-stop`/`chat-new` as-is (nothing to stop/clear for a viewer who never sent anything).

- [ ] **Step 2: Wire the tab into `tools/gui/index.html`**

Add a tab button after `tabbtn-control` and before the `Console` navgroup span (matching the branch's placement, which put Chat first in the Console group):
```html
<button class="tab" data-tab="chat" role="tab" id="tabbtn-chat" aria-controls="tab-chat" aria-selected="false" tabindex="-1">Chat</button>
```
Add the matching pane after `tab-control`'s `<section>`:
```html
<section id="tab-chat" class="tabpane" role="tabpanel" aria-labelledby="tabbtn-chat"></section>
```
Add `<script src="views-chat.js"></script>` to the script block, after `views-admin.js` and before `app.js` (scripts load in order; `app.js`'s `renderTab()` must be able to call `renderChat` once it's defined — load order consistent with every other `views-*.js`).

- [ ] **Step 3: Append the Chat CSS block to `tools/gui/app.css`**

`git show 4ec6db8:tools/gui/app.css | tail -53` is the whole added block (`/* ── Chat view ... */` through the closing `}` of the `@layer views { ... }`). Append it verbatim at the end of the current `tools/gui/app.css` (after the existing `.chip.ok { ... }` block added for the Users view — do not interleave, just append).

- [ ] **Step 4: Wire `renderTab()` in `tools/gui/app.js`**

In the existing `renderTab(tab)` function, add one line next to the `users` branch:
```js
else if (tab === 'chat') { showSkeleton('chat'); renderChat(); }
```
(Match whichever of `showSkeleton(...)` / no-skeleton the `freebuff` branch uses instead if `renderChat()` is meant to own its own loading state the way `renderFreebuffTab()` does — check that branch's convention in the current file before picking.)

- [ ] **Step 5: Run the test suite**

Run: `node tools/test-gui-theme.js` — expected FAIL at this point (file doesn't exist yet, see Task 4) is fine; instead run: `node tools/run-tests.js` and confirm no *new* failures relative to the Task 1 baseline (same 1 pre-existing `test-repo-invariants` failure, nothing else).

- [ ] **Step 6: Manual smoke check**

Start the console against a scratch data root (`CC_ROOT=$(mktemp -d) node tools/gui-server.js --instance --print-port`), create an admin (`node tools/users.js add root --role admin --generate`), log in, open the Chat tab, confirm: the provider dropdown populates or shows a clear "provider config not found" message (depending on whether `runtime/providers.json` exists on this machine), and a viewer-role session shows the composer disabled with the role message from Step 1.4.

- [ ] **Step 7: Commit**

```bash
git add tools/gui/views-chat.js tools/gui/index.html tools/gui/app.css tools/gui/app.js
git commit -m "feat(gui): Chat view, ported to cookie-based identity"
```

---

## Task 3: Professional theme overlay

**Files:**
- Create: `tools/gui/app.pro.css` (ported verbatim)
- Modify: `tools/gui/index.html` (theme link, toggle button, no-flash boot script)

**Interfaces:**
- Consumes: the CSS custom properties already defined in `tools/gui/app.css`'s `tokens` layer, plus the new `--topbar-h`/`--tabs-h` properties `app.js`'s `measureChrome()` already sets on `document.documentElement` (Task 2 did not touch this; it predates this plan).
- Produces: a `data-theme` attribute on `<html>` and a disabled/enabled `<link id="theme-pro-css">`, read by nothing else in this plan (the guide in Task 4 only reads the theme to know its own glyph, it doesn't depend on this task's DOM structure beyond the button's `id`).

- [ ] **Step 1: Port the CSS file verbatim**

`git show 4ec6db8:tools/gui/app.pro.css > tools/gui/app.pro.css` — no edits. (It does not hardcode `#tabs`/`#status-rail`'s `top` offset — it only sets `background`/`border-bottom`/`flex-wrap`/`padding` on those selectors — so it does not fight the dynamic `--topbar-h`/`--tabs-h` sticky positioning added on `master` after the branch forked. Verified in Step 4 below rather than assumed.)

- [ ] **Step 2: Wire the stylesheet link and no-flash boot script into `tools/gui/index.html`**

In `<head>`, after `<link rel="stylesheet" href="app.css">`, add:
```html
<link id="theme-pro-css" rel="stylesheet" href="app.pro.css">
<script>
(function () {
  try {
    var t = localStorage.getItem('cyboros-theme') || 'pro';
    var l = document.getElementById('theme-pro-css');
    if (l) l.disabled = (t !== 'pro');
    document.documentElement.setAttribute('data-theme', t);
  } catch (e) {}
})();
</script>
```

- [ ] **Step 3: Add the theme toggle button and its script**

In the `.badges` div, add the button *before* `#cc-user` is fine either side, but keep `#btn-logout` last — insert after the opening `<div class="badges">` tag, before the existing `#cc-user` chip:
```html
<button id="btn-theme" class="btn btn-ghost" title="Switch theme (professional ⇄ cyberdeck)" aria-label="Switch theme"><span id="theme-glyph">◐</span> <span id="theme-label">pro</span></button>
```
Add the toggle script from `git show 4ec6db8:tools/gui/index.html` (the `/* Theme switch ... */` IIFE) just before `</body>`, after the existing script tags — it only touches `#theme-pro-css`/`#btn-theme`/`#theme-label`/`#theme-glyph`, nothing Task 2 or the existing identity code owns.

- [ ] **Step 4: Visual verification — both themes, laptop width, wrapped tabs**

Run the app (same scratch-root recipe as Task 2 Step 6) and take two Playwright screenshots at 1440×900: one with the default `pro` theme, one after clicking `#btn-theme` to `cyberdeck`. Confirm in both: the tab row wraps to two lines without clipping (19 tabs now, after Task 2), `#status-rail` sits directly under the wrapped tab row with no gap or overlap, and nothing uses `!important` to force it (if it needs force, the dynamic offset calculation has a bug — fix `app.css`, not `app.pro.css`).

- [ ] **Step 5: Run tests**

Run: `node tools/run-tests.js` — same baseline as Task 2 (no new failures).

- [ ] **Step 6: Commit**

```bash
git add tools/gui/app.pro.css tools/gui/index.html
git commit -m "feat(gui): professional theme overlay"
```

---

## Task 4: Interactive guide

**Files:**
- Create: `tools/gui/guide.js` (ported, `VIEWS` array updated)
- Create: `tools/test-gui-theme.js` (ported verbatim)
- Modify: `tools/gui/index.html` (guide button, script tag)

**Interfaces:**
- Consumes: nothing beyond the DOM and `localStorage`; explicitly zero-network by the test in this task (`tools/test-gui-theme.js`'s "opsec: offline" assertion).
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Port the file and update its view list**

`git show 4ec6db8:tools/gui/guide.js > tools/gui/guide.js`, then edit the `VIEWS` array (near the top):
- In the `'Control'` group, add a fourth entry after `['control', 'Control', ...]`:
  ```js
  ['users', 'Users', 'Account e ruoli (viewer · operator · admin): chi può leggere, agire o gestire gli account. Visibile solo con ruolo admin.'],
  ```
- Leave the existing `'Console'` group's `['chat', 'Chat', ...]` entry as-is — it already describes the view this plan's Task 2 reinstates.
- Leave `CONCEPTS`, `SHORTCUTS`, `TOUR` untouched; none of them name a specific view count.

- [ ] **Step 2: Wire the guide button and script into `tools/gui/index.html`**

Add after the `#btn-theme` button added in Task 3 (or, if Task 3 is skipped/reordered, after the opening `.badges` tag):
```html
<button id="btn-guide" class="btn btn-ghost" title="Guida interattiva (premi ? o F1)" aria-haspopup="dialog"><span aria-hidden="true">?</span> Guida</button>
```
Add `<script src="guide.js"></script>` to the script block, after `app.js` (the branch loads it last; `guide.js` is self-contained and doesn't need any other script's globals).

- [ ] **Step 3: Port the guard test verbatim**

`git show 4ec6db8:tools/test-gui-theme.js > tools/test-gui-theme.js` — no edits; it was written against `index.html`'s general shape (default-theme check, button/script presence, asset-integrity scan over every local `href`/`src`, no-`!important`, no-egress, first-run-once), none of which assume the old file's exact tab list.

- [ ] **Step 4: Run test to verify it passes**

Run: `node tools/test-gui-theme.js`
Expected: PASS, all 6 assertions (default theme, guide button+script, asset integrity, no `!important`, offline, first-run-once).

- [ ] **Step 5: Run the full suite**

Run: `node tools/run-tests.js`
Expected: same baseline plus this new test, now 1 pre-existing unrelated failure (`test-repo-invariants`, fixed in Task 5) and everything else green.

- [ ] **Step 6: Commit**

```bash
git add tools/gui/guide.js tools/gui/index.html tools/test-gui-theme.js
git commit -m "feat(gui): interactive in-app guide"
```

---

## Task 5: Docs/count sync and full-suite verification

**Files:**
- Modify: `README.md` (test/module counts)
- Modify: `docs/command-center-desktop.md` (mention theme, guide, Chat, Users)
- Regenerate: `docs/project-map.html`, `docs/INDEX.md` (generated files, not hand-edited)

- [ ] **Step 1: Regenerate the generated docs**

Run: `node tools/project-map.js` and whatever companion command regenerates `docs/INDEX.md` (check `tools/docs-index.js`'s own `--help`/header comment for its invocation — it was not read in detail during planning; read it before running). Confirm the printed summary line's module/test counts.

- [ ] **Step 2: Update `README.md`'s hand-written counts**

Find the lines matching `XXX tests` / `XXX modules` (currently `122 tests` / `183 modules` in the two spots `grep -n "tests,\|modules"` turns up) and set them to the counts `tools/project-map.js` just printed in Step 1.

- [ ] **Step 3: Update `docs/command-center-desktop.md`**

Add short mentions of: the theme toggle (`#btn-theme`, default `pro`), the in-app guide (`?`/F1), the Chat view (role-gated, local-first), and the Users/admin view (already shipped by the identity work, likely already documented — check before adding a duplicate).

- [ ] **Step 4: Full suite, clean**

Run: `node tools/run-tests.js`
Expected: `test-repo-invariants`'s pre-existing failure (stale `docs/INDEX.md` entry for `archive/command-center-redesign.md`) is now resolved as a side effect of Step 1's regeneration — confirm this by re-reading its output rather than assuming it. If it is not resolved, that specific invariant is unrelated to this plan's scope; do not chase it further here, just confirm it is the *same* pre-existing failure and not a new one.

- [ ] **Step 5: Verify the demo is still isolated (Global Constraints note)**

Run `bash scripts/demo-command-center.sh` (or read it if it's not meant to run unattended) against its own throwaway `CC_ROOT`, then hit `/api/cc/ledger` and `/api/cc/graph` on the demo instance and confirm the response does not contain any real host/IP from this machine's actual `reports/`. This exercises the config.js-based fix already in place — no code change expected here, just confirmation it still holds with the three new views added.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/command-center-desktop.md docs/project-map.html docs/INDEX.md
git commit -m "docs: sync counts and views after theme/guide/chat reinsertion"
```
