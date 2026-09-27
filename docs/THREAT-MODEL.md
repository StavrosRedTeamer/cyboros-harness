# Threat model: attacking StavrosRedTeamer itself

> This project is offensive tooling whose central claim is that it cannot be
> talked into misbehaving. That claim is only worth anything if it can be
> attacked in public, so here is the attack surface, written down before anyone
> finds it.
>
> **We are looking for breaks.** Report them privately — see
> [`SECURITY.md`](../SECURITY.md). In-scope breaks are the high-priority list
> there; this document explains *why* each one matters and which ones we think
> are most likely.

## What we are defending

Not the target. The target is supposed to be attacked — that is the job. What is
defended is the set of properties this project claims, which are all statements
about the harness's own behaviour:

| Claim | Concrete form |
|---|---|
| The agent cannot exceed its authorized scope | `scope.json` is the written authorization; empty means everything is blocked |
| In-scope hostnames cannot be used to reach private space | DNS-rebinding guard, `allowed_ips` opt-in |
| Severity cannot exceed evidence | `verify_level` → severity ceiling, enforced at record time |
| A claim of reality must be machine-checked | oracle re-executed live, N/N |
| Destructive actions need consent | tiered confirmation + single-use, host-bound consent tokens |
| Third-party tools are inside the guard | `mcp-guard-proxy.js` puts `scope-guard` and `ssrf-guard` in series with a mounted MCP server |
| Engagement data never lands in the repo | `.gitignore` + a CI job that fails the build if it does |

Anyone who can make one of those false has found something. Preferably in public
and preferably with a test.

## Trust boundaries

```
        operator (writes scope.json, grants consent)
             |
   [1] policy surface — scope-guard, ssrf-guard, net.resolveAndGuard
             |
   [2] model surface — the agent, the fleet, the local runner, MCP servers
             |
   [3] execution surface — shells, external binaries, frida, adb, the repeater
             |
   [4] evidence surface — findings, oracles, reports, memory/, gen-poc output
```

The design principle is that [2] is the untrusted layer. It is assumed to be
manipulated — by the target, by injected content, by the model itself. Guards
live at [1] so that a manipulated [2] cannot talk its way past them. A break is
any path from [2] or [3] to a [1] decision that should have been refused, or any
path from [2] into [4] that produces an unsupported claim.

## The surface, in the order we think about it

### 1. The oracle is the sharpest edge

When a finding claims reality, the harness **re-executes the condition itself**.
The `verify` block is attacker-shaped data: a method, a URL, headers, an
`expect`. The harness then makes that request with its own privileges, from the
operator's network position, on the operator's engagement.

That is a re-entrant attack surface. The interesting questions are:

- Can a `verify.url` reach somewhere `scope-guard` would have refused if the
  agent had asked directly? The oracle is the harness asking, not the agent.
- Can an `expect` clause be satisfied by something that is not a
  vulnerability — a 200 from a login redirect, a substring that appears in an
  error page, a `body_similarity_to` match against a static asset?
- Can the oracle be made to pass without the condition ever holding — cached
  response, replayed session, or N copies of a request that is itself the bug?
- What is the ceiling on oracle concurrency, and can a target use it to DoS the
  operator's network from inside an authorized engagement?

We believe the oracle path runs through the same guard as any other request. We
would like that verified by someone who does not trust us.

### 2. Scope enforcement

- `scope-guard`: fail-open conditions, canonicalization mismatches between what
  the guard checks and what the tool actually connects to, races between the
  check and the request. There is a canonicalization test suite
  (`test-scope-canon.js`); it is a floor, not a proof.
- The pin/request gap: `net.resolveAndGuard` resolves and pins, then a later
  step connects. Anything that re-resolves in between is a rebinding primitive.
- `allowed_ips` is the documented escape hatch for private space. It is the
  sharpest edge in the whole design, because it is a *correct* bypass: whoever
  writes it is authorizing private space deliberately.

### 3. The MCP proxy

A third-party MCP server mounted raw is outside every guard. The proxy is the
supported path, and it is therefore the thing worth attacking: forward a
`tools/call` whose target is out of scope, lose a `block` from
`reports/tmp/mcp-guard.jsonl`, or find a method shape that skips the judge. The
audit log is only evidence if it cannot be edited or truncated by the thing it
is auditing.

### 4. Evidence integrity

- Forge an oracle that passes. Severity ceilings are only as good as the
  verification underneath them.
- Forge `verify_level`. If a record can claim `proven_impact` without a
  matching oracle, the ceiling table is decorative.
- `gen-poc.js` writes and runs a Python reproducer from finding content. That is
  code generation from untrusted input and deserves the same suspicion as any
  other such path.
- `memory/` is designed to compound across engagements, which means it is the
  one component whose value comes from being *wrong persistently*. Can a
  technique lesson carry a host, a credential, or a path that the sanitizer
  does not recognize?

### 5. The consent token

Single-use, host-bound, operator-granted. The questions are replay, cross-host
reuse, and the race between grant and use — and whether a confirm-tier action
can start with an approval that was issued for a different action.

### 6. The surfaces that are not about the guard

- `gui-server.js` issues its token in the URL (`?token=…`) so a bookmark works
  read-only. Tokens in URLs leak: browser history, referrer headers, shell
  history, access logs, screenshots. The blast radius of that leak is the
  command surface behind it.
- The Command Center API (`/api/cc/*`) and the desktop shell are a surface, not
  a gate. Anything that bypasses a guard is a finding, even if it is authorized.
- `cc-panic.js` stops only harness-owned processes. Can a crash or a kill leave
  something running that should not be?

## What is explicitly out of scope

The harness working as documented on a target you were authorized to test.
Finding a vulnerability in a third-party target is the purpose of the tool, not
a vulnerability in the tool. If you found something real in something you tested,
that disclosure belongs to that target's owner, not to us.

And the honest caveat, which is also in the README: **the guards run in-process
and are not a sandbox.** They constrain what this harness does. They do not
contain a process that has already been talked into running something. The MCP
proxy exists because that boundary is real, and it is the shape of the problem
rather than a complete answer to it.

## How to report

GitHub **Security → Report a vulnerability** on this repository. Tell us the
claim you broke, the commit you broke it on, and a test. A test that fails on
`master` is worth more to us than a description, and we will credit it unless
you would rather we did not.

If your break is a real finding in a third-party system you were authorized to
test, that is a disclosure to *that* system's owner, and we will help you write
it up if you want.
