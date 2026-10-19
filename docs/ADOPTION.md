# Adopting Cyboros in an organization

A due-diligence page for the security lead, the legal reviewer and the procurement
desk who decide whether a team may run this harness on client or corporate systems.
It does not restate the marketing — the project has none. Every answer below names
the file that proves it, because that is the same rule the harness holds its own
findings to: a claim is only a claim if code can prove it.

If you are an operator who just wants to run a scan, start at the [README quick
start](../README.md#quick-start), not here.

---

## What an evaluator is actually asking

A pentest tool that drives an LLM is a liability question before it is a technical
one. The five questions a serious reviewer asks, and where each is answered:

| Question | Short answer | Proof |
|---|---|---|
| Can it touch a system nobody authorized? | No. Scope is enforced below the model, fail-closed. | [`tools/scope-guard.js`](../tools/scope-guard.js), [`tools/ssrf-guard.js`](../tools/ssrf-guard.js) |
| Who is liable, and what covers us legally? | A signed RoE / authorization letter you adapt with counsel; a safe harbor that mirrors Kali/OWASP. | [`legal/RoE-template.md`](../legal/RoE-template.md), [`SECURITY.md`](../SECURITY.md#safe-harbor) |
| Where does client data go? | Only to disk the operator controls, mode `0600`, never into git. | [`.gitignore`](../.gitignore), [`tools/privacy.js`](../tools/privacy.js), [`tools/doctor.js`](../tools/doctor.js) |
| Can we reconstruct what happened? | Append-only, hash-chained, tamper-evident audit trail. | [`tools/audit-trail.js`](../tools/audit-trail.js), [`tools/record-finding.js`](../tools/record-finding.js) |
| What is the tool's own attack surface? | Zero runtime dependencies; a private disclosure channel; one honest caveat. | [`package.json`](../package.json), [`SECURITY.md`](../SECURITY.md) |

The rest of this page expands each row.

---

## 1. Authorization — the agent cannot decide whether it is allowed

The design principle, stated so it survives a code review: **a refusal by the model
is a bug, because the guard already made that decision.** Policy lives in programs
that run below the model and fail closed.

- **Scope.** Nothing runs against a host absent from `scope.json`. An empty
  `scope.json` blocks everything; there is no flag to disable the check
  ([`tools/scope-guard.js`](../tools/scope-guard.js)).
- **DNS-rebinding / SSRF.** An in-scope hostname that resolves to a private,
  loopback, link-local or cloud-metadata address is refused unless the matching
  subnet is explicitly allowed. This is a second, independent layer that re-judges
  the pinned address ([`tools/ssrf-guard.js`](../tools/ssrf-guard.js),
  [`tools/net.js`](../tools/net.js)).
- **Consent for high-impact actions.** Confirm-tier and approval-token checks mean
  a destructive or high-impact action cannot start without an explicit operator
  grant ([`tools/request-approval.js`](../tools/request-approval.js),
  [`tools/cc-approvals.js`](../tools/cc-approvals.js)).

### The paperwork that must exist before anyone presses start

[`legal/RoE-template.md`](../legal/RoE-template.md) is a Rules-of-Engagement and
authorization-letter template, with the clauses that protect the operator criminally
marked `[CRITICA]`. It is **not legal advice**: have counsel review and adapt it to
your jurisdiction, corporate form and insurance before first use. A retroactive
authorization is worth nothing — the signature comes before any active activity.

The project's [safe harbor](../SECURITY.md#safe-harbor) applies only to use within
that written authorization, and is not a substitute for it.

---

## 2. Client data governance

The operating assumption is that engagement data is the client's, is sensitive, and
must never leave the machine that produced it except by the operator's deliberate
act.

- **Where it lives.** Findings, loot, session state, evidence and raw per-engagement
  dumps are written under `reports/`, `artifacts/`, `temp/` and the engagement
  directories — all **git-ignored** so they cannot be committed by accident
  ([`.gitignore`](../.gitignore), which documents, file by file, why each path is
  excluded).
- **At rest.** Secret and authorization files (`scope.json`, `auth.json`, the
  provider config) are expected at mode `0600`; `doctor` detects any that are
  group/other-readable and tightens them back to `0600`
  ([`tools/doctor.js`](../tools/doctor.js)).
- **Toward a hosted model.** When privacy mode is enabled, discovered PII — internal
  IPs, emails, secrets, hashes — is replaced with typed deterministic placeholders
  (`HOST_`, `IP_`, `EMAIL_`, `SECRET_`) before a prompt can reach a free hosted
  model, and rehydrated only locally at report time
  ([`tools/privacy.js`](../tools/privacy.js); gated by `CYBOROS_PRIVACY=1`, off by
  default — turn it on for third-party model endpoints).
- **Retention and disposal.** There is no hidden store. Data lives in the
  engagement directories above; disposing of an engagement is deleting those
  directories, which are never tracked by git. The harness never writes client
  response bodies or credentials into the repository or into `memory/` — a path that
  did would be an in-scope security bug ([`SECURITY.md`](../SECURITY.md)).

A continuous integration check enforces the boundary from the other side: no host
listed in `scope.json` may appear inside any git-tracked file
([`tools/test-repo-invariants.js`](../tools/test-repo-invariants.js), the "leak"
invariant).

---

## 3. Auditability and evidence integrity

- **Every run is logged, and the log cannot be quietly edited.** The audit trail is
  append-only and hash-chained (sha256 of the previous line); appending onto a
  broken chain is refused, so any tampering is visible on `verify`. Directory `0700`,
  files `0600`, atomic writes ([`tools/audit-trail.js`](../tools/audit-trail.js)).
- **Severity can never exceed evidence.** A finding's severity is capped by its
  verification level; a record that claims reality (`verified`, `exploited`,
  `proven_impact`) must carry a machine-re-executed oracle, or it is refused rather
  than warned about ([`tools/record-finding.js`](../tools/record-finding.js); the
  ladder is in the [README](../README.md)). For an enterprise this means a report
  cannot inflate a Low into a Critical — the tooling will not let it.
- **MCP tools are judged too.** Tools reached over MCP run in their own process and
  bypass the in-process guard unless you mount them through
  [`tools/mcp-guard-proxy.js`](../tools/mcp-guard-proxy.js), which applies the same
  scope + SSRF decision to every `tools/call` and logs every verdict.

---

## 4. The tool's own security posture

- **Supply chain.** Zero runtime dependencies and zero install-time dependencies for
  the core harness: the engine is Node ≥22 and the standard library, nothing from npm
  to vet or to be compromised through ([`package.json`](../package.json) — no
  `dependencies` block). This removes an entire class of supply-chain review.
- **Disclosure.** Vulnerabilities in the guardrails are reported privately through
  GitHub Security Advisories, with a stated 7-day acknowledgement target and an
  explicit in-scope / out-of-scope list ([`SECURITY.md`](../SECURITY.md)).
- **Threat model.** The assets, trust boundaries and assumptions are written down
  ([`docs/THREAT-MODEL.md`](THREAT-MODEL.md)); the architecture that enforces them is
  in [`docs/ARCHITECTURE.md`](ARCHITECTURE.md).

---

## 5. Honest limits — read these before you decide

The project states its own boundaries so you do not discover them in production
([`SECURITY.md`](../SECURITY.md#the-one-honest-caveat)):

- The scope guard is enforced **in-process**, inside the tools the agent calls. **It
  is not a sandbox and not a containment boundary.** For isolation, run the harness
  in a VM or container you control.
- A tool mounted over MCP **raw** (not through the guard proxy) is outside the guard;
  you are responsible for it.
- The local runner talks to a model you choose; anything that reaches a target
  through it is only as safe as that model's judgment plus your `scope.json`.
- On hard, real targets the agent's success rate is low — the project says so
  plainly in the [README](../README.md). The value here is disciplined, provable,
  auditable testing, not autonomous exploitation.

---

## Deploying for a team

1. **Prerequisite:** Node ≥22. No other runtime install for the core harness.
2. **Per operator:** clone, `npm install` (dev/test tooling only), `npm test` to
   confirm the guardrails pass on their machine, then `npm run doctor` for a health
   and secret-exposure check.
3. **Per engagement:** fill `scope.json` from [`scope.example.json`](../scope.example.json)
   and have the client sign the RoE *before* any active step. An empty or absent
   `scope.json` is fail-closed — the safe default.
4. **Extended arsenal (optional, Linux/Kali):** `./install-tools.sh` installs the
   offensive tooling; `doctor` reports what is present and what is missing, so a
   workstation without it still runs the core harness and simply reports the gap.

---

## Due-diligence checklist

A reviewer can tick these against the repository directly:

- [ ] Scope enforcement is fail-closed and cannot be disabled — [`tools/scope-guard.js`](../tools/scope-guard.js)
- [ ] SSRF / rebinding and cloud-metadata are denied by default — [`tools/ssrf-guard.js`](../tools/ssrf-guard.js)
- [ ] An authorization/RoE template exists and is marked as not-legal-advice — [`legal/RoE-template.md`](../legal/RoE-template.md)
- [ ] A safe-harbor statement exists — [`SECURITY.md`](../SECURITY.md#safe-harbor)
- [ ] Client data is git-ignored and `0600` at rest — [`.gitignore`](../.gitignore), [`tools/doctor.js`](../tools/doctor.js)
- [ ] PII can be withheld from hosted models — [`tools/privacy.js`](../tools/privacy.js)
- [ ] The audit trail is append-only and tamper-evident — [`tools/audit-trail.js`](../tools/audit-trail.js)
- [ ] Severity is capped by evidence — [`tools/record-finding.js`](../tools/record-finding.js)
- [ ] Zero runtime dependencies — [`package.json`](../package.json)
- [ ] A private vulnerability-disclosure channel exists — [`SECURITY.md`](../SECURITY.md)
- [ ] The tool states its own limits — [`SECURITY.md`](../SECURITY.md#the-one-honest-caveat)

If a row cannot be ticked from the code, treat it as unmet and raise it on the
issue tracker — that is exactly the kind of gap this project wants reported.
