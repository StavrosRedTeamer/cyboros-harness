# Glossary

The harness uses a small set of terms with exact meanings. They are load-bearing:
the code enforces distinctions between them, so substituting a synonym in a finding
or a report is a semantic change, not a stylistic one.

**Canonical language is English.** The harness originally carried these terms in
Italian and Chinese as well; those renderings are kept below as translations for
readability, but only the English term is what appears in code, findings, and the
CLI. Everything the agent writes should use the English term.

## Verification levels

The ladder enforced by `record-finding.js`. A finding's severity may never exceed
its level — the record is rejected, not warned about.

| Term | Meaning | Severity ceiling |
|---|---|---|
| `suspected` | plausible, not reproduced | Low |
| `triggered` | condition triggered, not exploited | Medium |
| `exploited` | full exploit chain demonstrated | High |
| `proven_impact` | real impact proven (data read, ATO, RCE) | Critical |

Translations: 疑似 · 已触发未利用 · 完整利用链 · 影响证明

## Finding status

Distinct from the level above: status is the outcome of verification, level is the
depth of the exploit.

| Term | Meaning |
|---|---|
| `inconclusive` | tested, no signal — the hypothesis lane, needs no oracle |
| `confirmed` | behaviour observed on the target, but not reproduced as an oracle |
| `verified` | re-executed by the harness N/N live; stronger than `confirmed` |

A finding that claims reality — `status: confirmed`/`verified`, or
`verify_level: exploited`/`proven_impact` — must carry a valid `verify` oracle and
an `evidence_quote` (an exact slice of a workspace artifact, not a model summary).

## Harness terms

| Term | Meaning |
|---|---|
| **guard** | a fail-closed program that enforces scope, rate, or tier, running in-process and outside the model's reach |
| **scope** | the set of hosts authorized in `scope.json`; empty scope means everything is blocked |
| **confirm-tier** | an action that requires explicit operator confirmation before it executes |
| **consent token** | the single-use, host-bound, non-reusable grant a confirm-tier action needs |
| **oracle** | a machine-executed check the harness re-runs live to decide whether a finding holds |
| **stage gate** | a structural checkpoint (recon → map → test → authed → chains → report) with explicit pass criteria |
| **coverage matrix** | the record of which surface classes were actually tested; a complete matrix is required before reporting |
| **repeater** | the scope-safe request tampering tool, used instead of raw `curl` |
| **runBin / run.js** | the only supported path to an external binary: scope-check, audit, and pace it |
| **rehydrate** | to restore a privacy-mode placeholder (`HOST_NNN`, `{{IP}}`) to its real value before use |
| **lifecycle** | `planning → recon → scan → test → verify → report`; deterministic stages are not chosen by the agent |

## Terms to avoid in findings

- "confirmed" for something only observed once — that is `triggered` at best.
- "RCE" or "ATO" without a `proven_impact` oracle. Severity caps enforce this, but
  the prose should match the record.
- "probably" / "likely" in a title. A title states what was proven; the uncertainty
  belongs in `notes`, and usually means the level is `suspected`.
