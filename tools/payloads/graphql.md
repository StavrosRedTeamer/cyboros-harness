# GraphQL and API-gateway authorization surfaces (detection-only reference)

GraphQL puts every operation on one endpoint, so the flaw is never "is GraphQL there" — it is which resolver, field or transport reaches data the caller should not see. Gateways add a second parser in front, which is where 2026 produced most of the bypasses below.

> **Detection-only.** `node tools/scope-guard.js check <url>` first (exit 0). Introspection and read-only queries are safe; **never** send a state-changing mutation to prove a point, and never send a mutation over a GET-shaped probe — that is the bug class in §3. Benign marker only, at most two specifically created test identities.

## 1. Introspection and schema

```
node tools/graphql.js introspect <url>          # saves reports/tmp/<host>-schema.json
```

Open introspection is a **Low/config** finding, not a vulnerability: it lists fields and mutations and proves nothing about resolver authorization. If disabled, mine the bundle (`node tools/analyze-bundle.js <url>` for `.graphql` fragments and operation names).

## 2. Field-level authorization

```
node tools/repeater.js --url "https://target/graphql" --as user_a --data '{"query":"{ <field>(id:\"<canary>\") { id } }"}' --diff
node tools/repeater.js --url "https://target/graphql" --as user_b --data '<same>'
```

- Same bytes for both identities ⇒ no object-level check on that resolver (BOLA, `authz`/`graphql`).
- Error/`null` for B but data for A ⇒ correct; do not escalate on an error alone.
- Two 2026 shapes: computed-field `where` evaluated without the row filter (Hasura, CVE-2026-54698) and authz annotations on a superclass not applied to the overriding resolver (Spring for GraphQL, CVE-2026-41856). Read-only to detect: ask for one hidden row by id.

## 3. Transport abuse: GET multiplex, method override, subscriptions

- **GET multiplex** (GitLab, CVE-2026-19650): confirm a GET carrying a mutation is **rejected before execution** — do not let it execute.
- **Method override** (grpc-gateway, CVE-2026-37236): form-encoded `POST` + `X-HTTP-Method-Override` against a read-only path; the finding is a routing differential, not a write.
- **Subscription identity** (Neo4j GraphQL, CVE-2026-5423): `connectionParams` reach the resolver context and a pre-decoded JWT can be forged. `node tools/ws.js <url>`, dummy token, must be rejected.

## 4. Pre-execution resource exhaustion

GraphQL Java's fragment-cycle validation (2026-09) burns CPU before any resolver runs. Probe with a handful of fragments, one request, hard timeout:

```
node tools/repeater.js --url "https://target/graphql" --timeout 10000 --data '{"query":"query Q { ...F1 } fragment F1 on Query { ...F2 } fragment F2 on Query { __typename }"}'
```

A latency cliff versus a trivial query is `suspected`. Never scale it: repeated or amplified payloads are confirm-tier and out of scope for detection.

## 5. Disclosures 2026 (dated)

| Technique | CVE / advisory | Date | Affected | Probe |
|---|---|---|---|---|
| GraphQL directive code injection | CVE-2026-19478 | 2026-08 | GitLab CE/EE: 18.2 < 18.11.11; 19.0 < 19.0.8; 19.1 < 19.1.6; 19.2 < 19.2.4 | Version check + directive audit (advisory does not name the directive); no probe payload |
| GraphQL multiplex GET mutation / CSRF | CVE-2026-19650 | 2026-08 | same GitLab ranges | GET read-only operation; mutation verbs must be rejected |
| Authz annotation missed in controller type hierarchy | CVE-2026-41856 / GHSA-phxq-526m-79px | 2026-06 | Spring for GraphQL 2.0.0–2.0.3, 1.4.0–1.4.5, 1.3.0–1.3.8, 1.0.0–1.0.6 | Two-identity read of an inherited resolver (§2) |
| Forged subscription identity via connection params | CVE-2026-5423 / GHSA-fcpg-3fw5-vc65 | 2026-08 | @neo4j/graphql 7.x < 7.5.6; 5.x < 5.12.14; 6.x EOL (no fix) | `ws.js` subscription with a dummy token must be rejected |
| Computed-field `where` omits row filter | CVE-2026-54698 | 2026-06 | Hasura GraphQL Engine 2.x < 2.49.2 (backport 2.45.5) | Low-priv role filters a `SETOF` computed field for a hidden row |
| Configserver no-op authz + permissive CORS | CVE-2026-47671 / GHSA-64cj-qvx5-m4f3 | 2026-05 | Nhost CLI versions before 0.0.0-20260518172022-e407511627d2 (that build is patched; CLI 1.46.0), local dev only | Arbitrary `Origin` on the local configserver; unauthenticated read must fail |
| Fragment-cycle validation CPU exhaustion | no CVE in source (GHSA-7p4r-9rcc-8vhv draft) | 2026-09 | GraphQL Java; fixed 24.4, 25.1, 26.1 | Bounded single-request latency comparison (§4) |
| Path-based authz bypass, missing leading `/` in `:path` | CVE-2026-33186 / GHSA-p77j-4mvh-x3m3 | 2026-03 | gRPC-Go < 1.79.3 | Malformed method path must be rejected before the authz interceptor |
| Method override reaches upstream controls | CVE-2026-37236 / GHSA-6gx8-r37x-4vw8 | 2026-08 | grpc-gateway v2.28.0 named; ranges not stated | Read-only form POST + `X-HTTP-Method-Override` |
| etcd gRPC API authz bypass | CVE-2026-33413 / GHSA-q8m4-xhhv-38mg | 2026-03 | `go.etcd.io/etcd` ≤3.3.27; `/v3` ≤3.6.8, ≤3.5.27, ≤3.4.41 (fixes 3.6.9/3.5.28/3.4.42) | Unprivileged identity against sensitive APIs (staging cluster) |
| Nested transactions bypass key-range RBAC | CVE-2026-33343 / GHSA-rfx7-8w68-q57q | 2026-03 | same etcd ranges, including `go.etcd.io/etcd` ≤3.3.27 | Restricted identity, nested txn outside its key range |
| Envoy RBAC bypass with duplicate header values | CVE-2026-26308 | 2026-03 | Istio 1.29.0; 1.28.0–1.28.4; 1.27.0–1.27.7 | Repeat the matched header with a second value |
| JWKS failure falls back to known default keys | CVE-2026-31837 / GHSA-v75c-crr9-733c | 2026-03 | same Istio releases | Make JWKS unavailable in staging; validation must fail closed |
| Gateway `crossProviderNamespaces` allowlist bypass | CVE-2026-54761 / GHSA-3g6v-2r68-prfc | 2026-06 | Traefik v1 ≤1.7.34, v2 ≤2.11.50, v3 ≤3.6.20 and 3.7.0-ea.1–3.7.4 (fixes 3.6.21/3.7.5) | Mixed-backend route referencing an internal service (test cluster) |
| OpenAPI-guided access-policy + injection fuzzing | no CVE (arXiv 2604.00702, EvoMaster extension) | 2026-04 | research method; 52 APIs tested | Generate operations from the spec, run as ≥2 roles, diff the oracles |

## 6. Record

```
node tools/record-finding.js '{"severity":"High","title":"GraphQL field read across tenants","host":"HOST","endpoint":"POST /graphql","class":"graphql","cwe":"CWE-862","verify_level":"exploited","poc":"<two-identity request/response pair>"}'
```

`class: "graphql"` (CWE-862, API1/API6). An error for the second identity is `suspected`/Low at most; a cross-tenant read of a canary row is `exploited`. Transport findings (§3) stay `triggered` until impact is shown; gateway/etcd/Istio items are `config`/`authz` — classify by impact, not by product.
