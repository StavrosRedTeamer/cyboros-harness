# Data API — Supabase / PostgREST / Firebase (detection-only)

> **Detection-only, canary-first.** This class is almost never a CVE: the flaw is an
> authorization rule that lets the public key read or write rows it should not. Test with a
> **seeded canary row**, never with real tenant data, and never with a `service_role` key.

Backend-as-a-service platforms expose the database to the browser directly. The app's own
authorization is therefore the only boundary between the public anon key and the tables.

## 1. Fingerprint and collect the public key

- Supabase/PostgREST: `/rest/v1/`, `/auth/v1/`, `/storage/v1/`, `<project>.supabase.co` in the
  bundle. The public key is a JWT with `"role":"anon"` — it is **meant** to be public.
- Firebase: database realtime (`firebaseio.com`), hosting (`<project>.firebaseapp.com`), il
  namespace Firestore su `googleapis`, `/__/firebase/init.json`, `google-services.json` in un APK.

```
node tools/analyze-bundle.js <url-or-local-file>     # endpoints + embedded keys
```

Take the `anon` / publishable key from the bundle, not from a leaked `.env`. If the only key
you can find is `service_role`, stop: that is a leak finding (`config`), not a data-API test.

## 2. PostgREST / Supabase

Every table and view is an endpoint. Start read-only on a canary:

```
node tools/repeater.js --url "<url>/rest/v1/<table>?select=*&limit=1" \
  --header "apikey: <anon>" --header "Authorization: Bearer <anon>"
```

What each result means:

| Result | Meaning |
|---|---|
| `200` + rows | the anon role can read that table → check whether the rows are public by design |
| `401/403` | RLS/grants deny the anon role → correct |
| `404` + `PGRST205` | table not exposed (or wrong schema) |
| `200` + `[]` | permission granted but no rows: still a rule worth checking with a canary row |

Then widen the read in this order, stopping at the first real leak:

1. **Views** (`?select=*` on a view) — `security_invoker` is often off, so a view can bypass the
   base table's RLS.
2. **Nested resources** (`?select=*,other_table(*)`) — a join can walk into a table the anon
   role cannot read directly.
3. **RPC** (`POST /rest/v1/rpc/<function>`) — `SECURITY DEFINER` functions run with the
   definer's rights. Detection: call it with empty/benign args and read the error; do not call
   state-changing functions.
4. **Grants vs RLS**: RLS filters rows, `GRANT` decides whether the table is reachable at all.
   A missing `GRANT` is not a finding; a grant plus a permissive policy is.

Write tests (insert/update/delete) are **confirm-tier**: only with a canary row and explicit
approval, e.g. `--method POST` with `Prefer: return=representation` and a marker value.

Storage and Realtime are separate surfaces: `/storage/v1/object/public/<bucket>/…` for
public buckets, and a Realtime subscription that delivers rows of a table the anon role cannot
`SELECT` is still a leak.

## 3. Firebase

```
node tools/repeater.js --url "<url>/.json?shallow=true"
node tools/repeater.js --url "<url>/<canary_path>.json"
```

- `permission_denied` → default-deny rules, correct.
- `null` → the path is empty but readable (rules allow it; check whether the path is public).
- JSON object → readable collection; repeat with a second identity to see cross-user reads.
- Writes (`PUT`/`PATCH`) only against a canary path, only with explicit approval.

Firestore rules are not visible from the client: infer them from behavior (`/v1/projects/...`
documents API with the Web API key) and treat any cross-tenant document read as `exploited`.

## 4. Verify and record

- Cross-tenant read of a canary row placed by a second identity → `exploited` (that is the PoC).
- Public key can read a table that holds non-public columns → `triggered`; escalate to `exploited`
  only after reading a value that belongs to another principal.
- A permissive rule with no reachable sensitive data → `suspected`, severity Low, class `config`.

Record with `class: "data-api"`, `cwe`: CWE-284 / CWE-863 / CWE-732, `owasp_api`: API1/API3/API8.
Note in the evidence which key was used and whether it was the public `anon` key — a report that
does not say this is not reproducible.
