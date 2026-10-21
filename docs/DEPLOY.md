# Deploying the console

A deployment is two things: **code** (this repository, or the container image) and a
**data directory** the operator owns — config, accounts, authorization, reports and
the audit trail. Nothing in the data directory lives in git, and nothing in the data
directory is needed to upgrade the code.

```
/srv/cyboros/                  ← data directory (yours)
  cyboros.config.json          ← one validated config
  users.json                   ← accounts (0600)
  scope.json                   ← the written authorization (0600, fail-closed)
  operation-state.json
  reports/                     ← findings, reports, state.db
  artifacts/audit/             ← hash-chained audit trail
```

## 1. First run (no container)

```bash
node tools/init.js --dir /srv/cyboros --admin alice
# prints the generated password exactly once
CYBOROS_CONFIG=/srv/cyboros/cyboros.config.json node tools/gui-server.js
```

`init.js` writes only inside `--dir`: config, a fail-closed `scope.json`, and the
first admin. It never overwrites an existing config or accounts file unless
`--force` is given, and it validates what it wrote with the same loader the server
uses before it exits.

Then open `http://127.0.0.1:8787/login`, sign in as `alice`, and add the hosts you
are authorized to test to `scope.json` (Scope tab, or the file). An empty scope
blocks every action, by design.

## 2. Configuration

One file, `cyboros.config.json`, found in this order:

1. `--config <path>`
2. `$CYBOROS_CONFIG`
3. `./cyboros.config.json` at the repository root
4. built-in defaults (development: data root = repository root)

Precedence for any individual setting: **CLI flag > environment variable >
config file > default**. Relative paths resolve against `data_root`; `data_root`
resolves against the config file's directory. `node tools/config.js --print` shows
the effective configuration with the service token redacted, and
`node tools/config.js --check` validates it without starting anything (exit 2 on a
problem, with every problem listed).

`cyboros.config.example.json` is the annotated template. The settings that matter:

| Setting | Meaning |
|---|---|
| `data_root` | where accounts, scope, reports and the audit trail live |
| `http.host`, `http.port` | listener; `0` = ephemeral (used by tests) |
| `http.allowed_hosts` | extra hostnames accepted by the Host/Origin guard (container, reverse proxy) |
| `paths.*` | file names inside `data_root` |
| `identity.session_ttl_hours`, `idle_minutes` | session lifetime |
| `identity.provider` | optional external identity module (see [IDENTITY.md](IDENTITY.md)) |
| `service_token` | `auto` (mint per run), `off`, or a literal ≥16 chars |
| `service_token_role` | role of the machine token, default `operator` |
| `read_only` | refuse every mutation |

**Environment overrides** (for containers, tests and one-off runs):
`CYBOROS_CONFIG`, `CC_ROOT` → `data_root`, `SCOPE_JSON` → `paths.scope`,
`CYBOROS_USERS_FILE` → `paths.users`, `AUDIT_DIR` → `paths.audit`,
`GUI_HOST`, `GUI_PORT`, `SCC_TOKEN` → `service_token`,
`CYBOROS_TOKEN_ROLE` → `service_token_role`, `CYBOROS_ALLOWED_HOSTS`
(comma-separated addition to `http.allowed_hosts`), `CYBOROS_AUTH_PROVIDER`,
`SCC_READ_ONLY=1`.

An invalid config does not start "with defaults": the server prints every problem
with the file path and exits 2.

**The tools follow the same file.** A tool the console runs — the report generator, the
gate, `cyboros resume`, `run.js`, the scope guard — resolves its engagement paths through
`tools/config.js` (`dataPaths()`), not through `__dirname/..`. The server exports
`CYBOROS_CONFIG` (when it was started from a file) and `CC_ROOT` to everything it spawns,
so a job launched without `--config` still reads and writes the data root and never the
code tree — which matters in the container, where the code is read-only. Standalone CLI
use honours the same two variables; with neither set, the default is still the repo root.
A tool started against an invalid config refuses with the same one-message diagnosis
instead of silently falling back to the checkout.

**The status rail says which tree you are looking at.** Below the tabs the console shows
`instance <host>:<port> · packaged|checkout` and `data <root>` (full path in the tooltip),
next to the scope and run state. `packaged` means the data root lives outside the code
tree — the container/volume layout; `checkout` means code and data share one tree, the
development default. Two consoles on different ports over different roots are otherwise
indistinguishable, and the line stays put when a poll fails or you switch tabs.

## 3. Container

```bash
mkdir -p deploy/config deploy/data
cp cyboros.config.example.json deploy/config/cyboros.config.json
CYBOROS_USERS_FILE=deploy/data/users.json \
  node tools/users.js add admin --role admin --generate
docker compose up -d
```

`docker-compose.yml` mounts `deploy/config` read-only at `/config`, `deploy/data` at
`/data`, publishes `127.0.0.1:8787` only, runs with `read_only: true` and
`no-new-privileges`. The image holds code only; upgrading it does not touch either
volume.

One ownership note, learned the hard way: with rootless podman the container uid is
mapped to a subordinate id, so a data directory owned by your user is **not**
writable inside it (`EACCES` on `users.json` during first run). Either run with
`--userns=keep-id`, or `chown -R 100:101 deploy/data` to match the image's
`cyboros` user.

Inside a container the listener must not be loopback, and the browser presents the
proxy's hostname, so **both** need a decision:

```json
{ "http": { "host": "0.0.0.0", "port": 8787, "allowed_hosts": ["console.example.com"] } }
```

`127.0.0.1`, `localhost` and `::1` remain allowed; `allowed_hosts` is an allowlist,
not a switch. Put TLS in front (nginx, Caddy, Traefik): the session cookie becomes
`Secure` automatically when the request arrives with `X-Forwarded-Proto: https`.

## 4. What this deployment does not give you

- **No TLS termination of its own.** Loopback HTTP is the supported mode; anything
  beyond that is a reverse proxy you operate.
- **Sessions are in memory.** Restarting the console signs everyone out. That is
  the honest current behaviour; the identity seam is where a shared session store
  or an OIDC provider replaces it.
- **No orchestrator manifests** beyond the compose file. The image is a plain Node
  process with a health endpoint, which is what a Kubernetes Deployment needs, but
  no chart is shipped.
- **One installation is one engagement workspace.** Multi-client tenancy is
  intentionally not part of this release.
