# ORM / query-builder SQL injection (detection-only reference)

The injection is not in the SQL string the app wrote — it is in the fragment the ORM builds for you:
an identifier, a sort direction, a cast type, an inline ID list. `sqlmap` does not see these, so the
test is a code read plus a targeted request, not a fuzz run.

> **Detection-only.** `node tools/scope-guard.js check <url>` first (exit 0). Use a quote/backtick
> marker and a canary row; never modify or delete rows, never mass-extract. Time-based probes are
> capped at ≤ 7s, 2 attempts. Escalation past "the parameter reaches SQL unparameterised" is
> confirm-tier (`--confirm "<reason>"` + explicit approval, knowledge.md rule 2).

## 1. Where ORM SQLi lives

- **Dynamic identifiers** — `ORDER BY <user>`, `<user>_asc`, column/alias names, `SELECT <user>`.
  Bound parameters never cover identifiers, so the builder interpolates.
- **Inline ID predicates** — bulk `UPDATE`/`DELETE` built from a list of ids; string ids get
  concatenated instead of bound.
- **JSON/JSONB cast types** — `WHERE data->>'k' = ?::<user-type>`; the cast target is raw SQL.
- **Dialect-specific escaping** — a quote that is escaped for MySQL may terminate for Oracle, or
  vice versa; the same value can be safe on one dialect and injectable on another.
- **Order direction** — `orderBy` / `addOrderBy` taking `ASC|DESC` from the request unchecked.

## 2. Probe recipe

1. Find a parameter that becomes an identifier, not a value: `sort`, `order`, `fields`, `select`,
   `expand`, `alias`, a query-parameter *name* used as a column. Semgrep/grep the app's handlers for
   `.orderBy(`, `sql.identifier(`, `.as(`, `addOrderBy(`, `::`.
2. Baseline the endpoint, then send one benign marker and diff — a quote alone should be a **400 or
   a clean error** on a parameterised path:

```
node tools/repeater.js --url "https://target/api/items?sort=name" --diff
node tools/repeater.js --url "https://target/api/items?sort=name'" --diff
node tools/repeater.js --url "https://target/api/items?sort=name%60" --diff      # backtick (MySQL)
node tools/repeater.js --url "https://target/api/items?sort=name%22" --diff      # double quote (Oracle/PG)
```

3. Read the differential: a **500 alone is not a finding** (any parser rejects junk). The signal is
   a SQL error surfaced in the body, or a 200 whose row order/length changes with the marker —
   `--diff` similarity is the discriminator.
4. Boolean confirmation: `sort=name,(SELECT 1)` vs `sort=name,(SELECT 1/0)` — differing status or
   error class means the fragment executed. Time-based last, capped: 2 probes, ≤ 7s, compare against
   baseline latency.

## 3. Per-framework notes

- **Drizzle** — `sql.identifier()` and `.as()` are the raw sinks; the 2026 fix escapes delimiters per
  dialect. Probe `sort`/`alias` values containing `"`, backtick and `]`.
- **Hibernate** — `InlineIdsOrClauseBuilder` builds `id in (...)` from strings; second-order, so the
  injection point is the *earlier* write that stored the id.
- **Sequelize** — JSON/JSONB where-clauses and the Oracle dialect (`TO_DATE`-prefixed strings) had
  separate escaping bugs; v7 is not affected by the JSON one.
- **TypeORM** — `UpdateQueryBuilder`/`SoftDeleteQueryBuilder` `orderBy` direction, and request
  parameter names interpolated as column identifiers (MySQL/MariaDB paths).
- **ReactPress** — unauthenticated list/filter endpoints where a query-parameter name becomes a
  column name.

## 4. Disclosures 2026 (dated)

| Technique | CVE / advisory | Date | Affected | Probe |
|---|---|---|---|---|
| Unescaped identifier delimiters | CVE-2026-39356 / GHSA-gpj5-g38j-94v9 | 2026-04 | Drizzle ORM <0.45.2; 1.0.0-beta.2–<1.0.0-beta.20 | quote/backtick in sort, alias, `sql.identifier()`/`.as()` paths |
| Second-order SQLi via inline ID predicates | CVE-2026-0603 / GHSA-2p5w-cvg5-gc5c | 2026-01 | Hibernate ORM 5.2.8–<5.3.38 (fix 5.3.38) | trace stored string ids into bulk UPDATE/DELETE; inspect generated SQL |
| JSON/JSONB cast type | CVE-2026-30951 / GHSA-6457-6jrx-69cr | 2026-03 | Sequelize 6.0.0-beta.1–6.37.7 (fixed 6.37.8); v7 unaffected | client-controlled JSON keys in where-clauses; `::` cast target |
| Oracle escaping bypass (`TO_DATE` prefix) | CVE-2026-69240 / GHSA-v8fg-2rw7-q452 | 2026-07 | Sequelize <6.37.4, Oracle dialect | string filter starting `TO_DATE`/`TO_TIMESTAMP`; diff generated SQL |
| Unvalidated sort direction | GHSA-9ggv-8w38-r7pm (no CVE) | 2026-06 | TypeORM 0.1.12–0.3.28 (fixed 0.3.29, 1.0.0), MySQL/MariaDB | `orderBy`/`addOrderBy` direction from the request |
| Query-parameter name as column | CVE-2026-61685 / GHSA-wmw4-mw6x-6vfm | 2026-06 | ReactPress ≤3.6.0 (fixed 3.7.0) | unauthenticated list/filter: vary parameter *names* |

## 5. Record

`class: "sqli"`, `cwe: "CWE-89"`. An error/boolean difference is `triggered` (Medium); reading a
canary row you placed is `exploited`; any write is confirm-tier and must be authorised per action.
Attach the two request/response pairs (baseline + probe) as `poc` — the diff is the evidence.
