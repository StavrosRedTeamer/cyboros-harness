# Security Policy

Cyboros Harness is offensive-security tooling. It executes reconnaissance and
exploitation techniques against targets you point it at. That shapes both what
this file is about and who should read it.

## Supported versions

This project is pre-1.0 and ships from a single line of development. Guardrail and
security fixes land on `master`; there are no maintained release branches yet, so the
supported version is **the latest commit on `master`**. Pin a commit for
reproducibility if you must, but take guardrail fixes from the tip.

| Version | Supported |
|---|---|
| `master` (latest) | ✅ |
| Older commits / tags | ⚠️ update to the latest `master` for guardrail fixes |

## Reporting a vulnerability in the harness

Report privately, not in a public issue. Use GitHub's
**Security → Report a vulnerability** (private advisory) on this repository.

Please do **not** open a public issue for a vulnerability in the guardrails.

**In scope — high priority.** Anything that defeats the safety architecture, since
that is the core claim this project makes:

- A way to make a guard pass a target that is not in `scope.json` (scope-guard
  bypass, fail-open condition, race in the scope check).
- A way to defeat the DNS-rebinding protection: an in-scope hostname that resolves
  to a private, loopback or link-local address without the matching `allowed_ips`
  entry.
- A way to record a finding whose `severity` exceeds its `verify_level` ceiling, or
  to mark a finding `verified` without a valid oracle. This breaks the central
  guarantee.
- A way to make a confirm-tier or approval-token check pass without consent.
- A path where credentials, engagement data or a target's response body is written
  to a location the operator did not intend (e.g. inside the repo, or into
  `memory/`).
- Remote code execution in the harness itself — `gui-server.js`, `repeater.js`,
  `run.js`, the local runner, the Command Center API, or `mcp-guard-proxy.js`.
- A way to make `mcp-guard-proxy.js` forward a `tools/call` whose target is out of
  scope, or to make it lose a block from the audit log.

**In scope — normal priority.** Correctness and robustness bugs in the tooling:
crashes, wrong scope decisions, data loss, findings that fail to record.

**Out of scope.** The harness working exactly as documented on a target it was
authorized to test. Finding a vulnerability in a third-party target is the purpose
of the tool, not a vulnerability in the tool. If you want to report a real
vulnerability in something you tested, that is a disclosure to *that* target's
owner, not to us.

We aim to acknowledge within 7 days.

## Safe harbor

Cyboros Harness is intended for authorized security testing: penetration tests
under a signed scope, bug-bounty programs where the target is in scope, and
laboratory environments you own.

By using this project you agree that, **if** you use it only within that
authorization, you will not be held liable or subject to legal action from the
project maintainers for your use of the tool. This mirrors the safe-harbor terms
used by Kali Linux, OWASP and major bug-bounty programs.

This safe harbor does not apply to activity that violates the terms of a program
you are participating in, or to unauthorized access to systems. Nothing in it is
a legal opinion, and it is not a substitute for your own counsel or for written
authorization from the system owner. **Get the authorization in writing before you
start.**

## The one honest caveat

The scope guard is enforced in-process, in the tools the agent calls. It is not a
sandbox and it is not a containment boundary.

Tools reached through **MCP** (`chrome-devtools`, or anything else you mount in
`mcp.json`) bypass the guard — they run in their own process. There is a supported
way to close that: mount the server through `tools/mcp-guard-proxy.js`, which
judges every `tools/call` with the same `scope-guard` + `ssrf-guard` decision the
in-process tools get, blocks out-of-scope and rebinding targets before the request
leaves the machine, and logs every verdict to `reports/tmp/mcp-guard.jsonl`.
Its declared limits: the judgement is over targets extracted from the call
arguments (a tool that reaches the network without naming it is not judged), and an
in-scope hostname must resolve, or the call is refused (fail-closed). Mount a server
raw and you are outside the guard, responsible for it yourself.

Similarly, the local runner in `local/` talks to a model you choose. Anything that
reaches a target through it is only as safe as the model's judgment plus whatever
you configured in `scope.json`.
