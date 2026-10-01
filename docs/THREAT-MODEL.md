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

### What the guard boundary actually covers — and what it does not

Stated precisely, because "policy in the runtime" is a strong claim and it is
only true inside a boundary. (Decision of record, 2026-10-01: keep it this way
rather than adding a network-namespace guard; the trade-off is written down
below instead of being left implied.)

**Enforced in code, not in the prompt.** Anything reached through `run.js`,
`repeater.js`, `desync.js`, `oob.js`, the `wifi`/`mobile`/`ad` wrappers, and
`mcp-guard-proxy.js` inherits scope-checking, tiering and rate limiting. Those
guards are separate processes running below the model, and they are fail-closed:
empty `scope.json` blocks everything and there is no flag to turn that into a
warning. Inside that boundary the claim holds.

**Outside the boundary, by three routes.**

1. **An MCP server mounted raw.** It bypasses every guard. `mcp-guard-proxy.js`
   is the supported path and puts `scope-guard` + `ssrf-guard` in front of every
   `tools/call`, but nothing enforces that you used it — mounting `npx
   chrome-devtools-mcp` directly is outside the guard and the operator's
   responsibility. This is the route most likely to be taken by accident.
2. **A binary invoked outside `run.js`.** Direct `nmap`, `curl` or `sqlmap` from
   a shell skips scope, audit and pacing entirely. The convention is documented;
   only `run.js` makes it true.
3. **No kernel-level egress enforcement.** Even inside the boundary the harness
   confines *itself*: nothing stops a spawned binary from opening its own socket
   to a host `scope.json` never saw. `--dry-run` shows what the harness believes
   it is touching; it does not constrain what a child process then does.

**What we chose not to add, and why.** The available answer is a network
namespace (`bwrap --unshare-net` plus an nftables allowlist derived from
`scope.json`), which would put an enforceable egress boundary under the guards
rather than beside them. It was declined for a concrete reason, not waved away:
masscan, interface tuning, ARP spoofing and tun/tap do not work inside such a
namespace, and those are exactly the tools the wireless and host-exploitation
modes depend on. Making it the default would trade the capability to test
wireless networks for a stronger boundary on everything else. An operator who
wants it should run that surface under `bwrap` explicitly rather than have the
harness force it on the paths that cannot work inside it.

So: **the guard architecture is sound inside its boundary and is not a
containment mechanism outside it.** Treat the boundary as the thing to protect,
not the code inside it.

### The privilege the operator's own tools carry

The harness runs as the operator's user, not as root, and the attack binaries
need privileges the user does not have by default: raw sockets for SYN scanning
and packet crafting, `net_admin` for monitor mode, and privileged ports for the
services that impersonate one. Rather than leave that to a password prompt
mid-engagement, the operator grants the **minimum**, once, and the harness
verifies it instead of assuming it.

**What is granted, and by what mechanism.** `tools/cap-manifest.json` declares
per binary the minimum capability set and the reason for it.
`sudo ./grant-tool-caps.sh` applies it with `setcap`, plus
`net.ipv4.ip_unprivileged_port_start=0` for the binds below 1024. `node
tools/capcheck.js` reports the real state; `sudo ./grant-tool-caps.sh --check`
applies nothing and exits non-zero if anything is missing. `tcpdump` and
`tshark` need nothing: the operator is already in `dialout`.

**Why capabilities and not `NOPASSWD` sudo.** A `NOPASSWD` rule grants the
ability to *execute those programs as root*, and some of these programs execute
arbitrary code: `nmap --script=evil.lua` runs inside the Lua interpreter as root,
so the rule is a root shell for anyone who can write a file. `setcap` grants a
set of capabilities, not a uid, and no flag of nmap, hping3 or masscan turns a
capability into a shell. Python tools (responder, ntlmrelayx) would need
capabilities on the interpreter, which would be root for everything, so they are
covered by the port threshold instead — no interpreter is touched.

**What it costs, stated plainly.** This is a real privilege, not a formality.
`cap_net_admin` permits interface manipulation and is a known escalation vector on
some kernels; anyone who can replace a binary in the grant list inherits its
capabilities. It is still narrower than the password-authenticated sudo the
operator already holds — the difference is only that nothing has to be typed —
but the narrower thing is not the same as the safe thing, and an operator who
wants zero capability on the box should not run `grant-tool-caps.sh`.

**What it does not buy, so nobody assumes it did.** `nmap` still refuses raw
scan types (`-sS`, `-sU`, `-sA`) with its own `geteuid()` check regardless of
capabilities; `-sT` and `-sV` work as the user, and SYN scanning is covered by
`masscan` and `naabu`, which do work. Monitor mode still requires hardware that
advertises it — measured on this box, `wlo1` offers `managed`/`IBSS`/`AP` and
not `monitor`, so `airodump-ng` clears the privilege check and then fails the
`SIOCSIWMODE` ioctl. And capabilities do not survive a package upgrade: an
`apt upgrade` rewrites the binary and clears the xattr, which is why the state is
checked by a tool rather than asserted in prose.

## How to report

GitHub **Security → Report a vulnerability** on this repository. Tell us the
claim you broke, the commit you broke it on, and a test. A test that fails on
`master` is worth more to us than a description, and we will credit it unless
you would rather we did not.

If your break is a real finding in a third-party system you were authorized to
test, that is a disclosure to *that* system's owner, and we will help you write
it up if you want.
