# Client-side path traversal (CSPT) — detection reference

> Class `cspt`. Detection-only, no payload that mutates state. The finding is a request that
> reaches an API surface the page never legitimately calls.

CSPT is the client-side twin of path traversal: a path fragment the attacker controls
(`location.hash`, `location.search`, `location.pathname`, `document.referrer`, a `postMessage`
payload, a URL returned by the API) is **concatenated** into a request path instead of being
validated or encoded.

```
fetch('/api/v1/' + location.hash.slice(1))        // attacker: #../admin/users
axios.get(`/api/users/${userId}/documents`)        // userId: ../../admin
```

## 1. Find the source → sink pair (read the code first)

```
node tools/analyze-bundle.js <url-or-local-file>   # endpoints + client code
node tools/dom-check.js <url>                      # DOM sinks, postMessage handlers
```

Look for string concatenation or template literals feeding `fetch`, `XMLHttpRequest.open`,
`axios`, `$.get`, `navigator.sendBeacon`, or a router's data loader. A path built with
`new URL()` and a `base` is usually safe; a path built with `+` is not.

## 2. Prove the traversal with a benign marker

Send the same request twice — once with a normal segment, once with a traversal segment — and
compare status, length and body:

```
node tools/repeater.js --url "<url>/api/v1/FUZZ" --vary "id=me,../admin/users" --diff
```

The finding is not "the server returned 200 for `../`": it is **a different endpoint answered**.
Confirm by checking the response for a field only that endpoint returns (a different JSON
schema, a different record shape). Status-only comparison produces false positives on SPA
fallbacks that return `index.html` for every path.

Variants worth one request each, in this order:

1. `../` and `..%2f` (encoded slash), `%2e%2e/`, `..%252f` (double encoding);
2. leading `//host/` — turns a path concatenation into an off-origin fetch (that variant is
   SSRF/CORS territory, record it as such);
3. `?` and `#` injection: `#/../admin` inside a SPA route, `?next=../admin`;
4. `postMessage`-driven paths: send `{type:'navigate', path:'../admin'}` from the console and
   watch the network panel (`dom-check.js` can drive this).

## 3. Chain it to CSRF (why the class matters)

A traversal that lands on a **state-changing** endpoint inherits the victim's cookies, so a
link or a `postMessage` becomes a CSRF primitive even when the app uses `SameSite=Lax`
(GET navigation) or a JSON API with no CSRF token. To test, use the smallest state change that
is reversible and in scope — a canary record, never a destructive action:

```
node tools/repeater.js --url "<url>/api/v1/FUZZ" --vary "id=../cart/add" --method POST \
  --data '{"item":"canary","qty":1}' --as <victim_identity>
```

The PoC is the canary appearing in the victim's cart; revert it immediately and say so in the
evidence. Anything that deletes, transfers or changes a real object needs explicit approval.

## 4. Record

| Observation | Class | verify_level |
|---|---|---|
| path segment reaches a different endpoint, read-only | `cspt` | triggered |
| traversal + state change performed as the victim | `cspt` (chain `csrf`) | exploited |
| off-origin fetch via `//host/` | `ssrf` or `cors`, not `cspt` | per that class |

`cwe`: CWE-22 (path traversal), CWE-352 (CSRF) when chained. Do not file it as `xss`: nothing
executed in the page — the browser was the one making the wrong request.
