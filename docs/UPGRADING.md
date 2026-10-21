# Upgrading an installation

Two things move independently: the **code** (checkout or image) and the **data
directory** (config, accounts, scope, reports, audit). This page is about moving the
code without losing or corrupting the second one.

The data directory layout is in [DEPLOY.md](DEPLOY.md).

## Before you upgrade

```bash
# 1. stop the console (it owns PTY sessions and background jobs)
docker compose stop console        # or: ctrl-c the `node tools/gui-server.js` process

# 2. back up the data directory — it is the whole installation
tar -C /srv -czf cyboros-data-$(date -u +%Y%m%dT%H%M%SZ).tgz cyboros

# 3. check that the trail and the findings chain are intact BEFORE the change,
#    so a broken chain later is not blamed on the upgrade
node tools/audit-trail.js verify
node -e "const c=require('./tools/chain-log'),l=c.readLines('reports/findings.jsonl');console.log(c.verifyChain(l))"
```

`scope.json` and `users.json` are mode `0600` and are included in the backup; the
audit trail is append-only and must be backed up byte-for-byte, never edited.

## Upgrade

```bash
# checkout or image pull
git fetch --tags && git checkout vX.Y.Z      # code
docker compose pull && docker compose up -d  # image

# validate the existing config against the new build, then start
CYBOROS_CONFIG=/srv/cyboros/cyboros.config.json node tools/config.js --check
CYBOROS_CONFIG=/srv/cyboros/cyboros.config.json node tools/gui-server.js
```

If `--check` exits 2, it names **every** problem and the file to edit; nothing has
started, so the old data is untouched. An unknown `version` in the config is
refused on purpose — a newer file is not silently interpreted with older rules.

After the first start, confirm:

- sign-in works for an admin (`GET /api/users` returns the account list);
- the scope still shows the same hosts (Scope tab / `scope.json`);
- `node tools/audit-trail.js verify` is still `ok`;
- recent findings are still visible (Findings tab) and the gate still opens.

## What the upgrade touches

| Data | Compatibility | Action required |
|---|---|---|
| `cyboros.config.json` | `version: 1` schema, validated strictly | none within v1; a new version refuses to start and points here |
| `users.json` | `version: 1`: usernames, roles, scrypt hashes | none; `tools/users.js` keeps writing the same shape |
| `scope.json` / `wifi-scope.json` / `mobile-scope.json` | plain authorization files | none |
| `reports/findings.jsonl` | append-only, hash-chained, deduplicated by key; the status of a finding is a **fold** over `verifications.jsonl`, never an edit | never edit or regenerate by hand. If the chain is broken (e.g. a partial restore), `tools/rechain.js` is the only supported repair — it backs up, rebuilds the chain over the existing content, and records the old/new head plus a mandatory reason in the anchor log |
| `reports/verifications.jsonl` | append-only | none |
| `artifacts/audit/YYYY-MM-DD.jsonl` | one hash-chained file per day; appending to a broken chain is refused | never edit; restore the whole file from backup if damaged |
| `reports/state.db` | SQLite, schema owned by the engine | none within v1; it is derived data and may be rebuilt by re-running the pipeline |

Sessions are in memory: after an upgrade everyone signs in again. Account
passwords and roles are untouched by that.

## Rolling back

The code is stateless; the data is the state.

```bash
git checkout <previous tag>            # or: docker compose down && docker image tag ...
tar -C /srv -xzf cyboros-data-<stamp>.tgz   # only if the new build wrote anything
```

Restoring the backup is safe because the new build only **appends** to
`findings.jsonl`, `verifications.jsonl` and the audit trail: a restore removes
records the new code wrote, and every consumer fails closed on a missing record
rather than inventing one.

## Version policy

Pre-1.0: a minor bump may carry a breaking change in the **config schema** or the
module CLIs, and will say so in `CHANGELOG.md` with a migration note. The data
formats above are versioned independently and change only with a documented
migration step.

The canonical machine-readable answer to "what is this installation?" is:

```bash
node tools/config.js --print     # effective config, token redacted
node tools/doctor.js             # environment, binaries, secret permissions
node tools/audit-trail.js verify # trail integrity
```
