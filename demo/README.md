# Demo target — authorized, loopback only

`demo/target.js` is a synthetic shop with three deliberate flaws:

| endpoint | flaw |
|---|---|
| `GET /api/users/:id` | no authorization at all (IDOR) |
| `GET /api/orders/:id` | checks `X-User` exists, not that it owns the order (BOLA) |
| `GET /search?q=` | unescaped reflection (reflected XSS) |

The data is invented (`demo.example` emails, fake card endings). The server binds
`127.0.0.1` only. `demo/scope.demo.json` is a loopback-only authorization — use it with
`SCOPE_JSON`; do not merge it into a real engagement.

## 1. Start the target

```bash
node demo/target.js                 # http://127.0.0.1:8787
# or: PORT=9000 node demo/target.js
```

## 2. Configure the provider

```bash
cp runtime/providers.example.json runtime/providers.json
# pick the profile / model you want, then put the key in the environment:
export OPENROUTER_API_KEY=sk-or-v1-...
```

`runtime/providers.json` is gitignored and contains no key: only `api_key_env`.
An inline `api_key` is refused by `runtime/live.js`. Cloud profiles need both
`"allow_cloud": true` in the file and `--allow-cloud` on the command line.

## 3. Run the live agent

Second terminal, from the repository root:

```bash
export SCOPE_JSON="$PWD/demo/scope.demo.json"
npm run tui -- --live --allow-cloud 127.0.0.1:8787
```

Then ask, for example:

```
Map the demo shop and prove an access-control issue between alice and bob.
```

The same session answers questions about itself — `what did we find on this host?` reads
`findings_query` and `sessions_list`, it does not touch the target. The reasoning streams
under `✻`; `/thinking off` hides it. After a run, `/findings` shows the ledger and `/cost`
the tokens and provider-reported price.

Or run one turn without the interactive prompt:

```bash
export SCOPE_JSON="$PWD/demo/scope.demo.json"
npm run tui -- --live --allow-cloud 127.0.0.1:8787 \
  --task "Map the demo shop and prove an access-control issue between alice and bob."
```

To keep the demo finding out of a real engagement ledger, also point the findings
store at a scratch file:

```bash
export FINDINGS_JSONL="$PWD/reports/demo/findings.jsonl"
export FINDINGS_HEAD_ANCHOR_FILE="$PWD/reports/demo/findings-head-anchor.jsonl"
export FINDINGS_TAB_DB="$PWD/reports/demo/results.db"
mkdir -p reports/demo
```

The agent sees the same guarded surface as the rest of the harness: `scope_check` is
real, `run_tool` goes through `tools/run.js`, `record_finding` through
`tools/record-finding.js`, and `write_file` is confined to `reports/`. Intrusive
binaries (`sqlmap`, `netexec`, …) stop for an operator approval; `curl` is read-tier.
Session events land in `reports/agent/sessions/<id>/`, approvals in
`reports/approvals.jsonl`.

Expected proof: `GET /api/orders/42` with `X-User: bob` returns alice's order,
including `card_last4`, while the same request as alice also returns 200. That is a
`triggered` BOLA, not `exploited`: no data was exfiltrated beyond the response.
