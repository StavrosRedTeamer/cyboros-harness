#!/usr/bin/env bash
# Cyboros Command Center — 2-minute demo (WP9).
#
# Runs the whole lifecycle against a THROWAWAY engagement root (CC_ROOT in mktemp), so it never
# touches your real scope.json / campaign.json / reports. Nothing here bypasses a guard: every
# write is a wrapper over the existing tools, exactly as the desktop app does.
set -euo pipefail

WS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$WS"

DEMO_ROOT="$(mktemp -d -t stavros-demo-XXXXXX)"
export CC_ROOT="$DEMO_ROOT"
export SCOPE_JSON="$DEMO_ROOT/scope.json"
export CC_CAMPAIGN_FILE="$DEMO_ROOT/campaign.json"
export CC_CAMPAIGNS_DIR="$DEMO_ROOT/campaigns"
export CC_HISTORY_FILE="$DEMO_ROOT/reports/campaign-history.jsonl"
export CC_APPROVALS_FILE="$DEMO_ROOT/reports/approvals.jsonl"
export CC_OPSTATE_FILE="$DEMO_ROOT/operation-state.json"
export CC_TEMPLATES_DIR="$WS/templates/campaign"

step() { printf '\n\033[1;36m▶ %s\033[0m\n' "$1"; }

# 1) scope (this is an authorization file: the demo uses a lab host only)
cat > "$SCOPE_JSON" <<'EOF'
{ "allowed_hosts": ["lab.demo.local"], "max_requests_per_second": 2 }
EOF

# 2) campaign from a template, then activate
step "1/6  Create + activate a campaign from the web-app template"
node tools/cc-campaign.js from-template web-app --client "Demo Corp" --name "Demo App" --id demo-app \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(!j.ok){console.error(j);process.exit(1)}process.stdout.write(JSON.stringify(j.campaign))})' \
  | node tools/cc-campaign.js activate - --by demo
node tools/cc-campaign.js show | head -20

# 3) mission control (deterministic: same numbers as the CLI modules)
step "2/6  Mission control — what to do next and why"
node tools/cc-mission.js show | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=JSON.parse(s);console.log("headline:",JSON.stringify(m.headline));console.log("actions:",m.actions.length,"| first:",m.actions[0]?m.actions[0].label+" — "+m.actions[0].why:"none")})'

# 4) approval inbox: agent asks, operator grants
step "3/6  Approval inbox — the human-in-the-loop token"
APID=$(node tools/request-approval.js --host lab.demo.local --action c2 --command "nmap -sV lab.demo.local" --reason "demo consent" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id))')
echo "requested token: $APID"
node tools/cc-approvals.js list
node tools/cc-approvals.js grant "$APID" --by demo
node tools/cc-approvals.js verify "$APID" --host lab.demo.local --command "nmap -sV lab.demo.local"

# 5) ledger + chain + evidence bundle
step "4/6  Ledger — timeline + hash-chain verdict + verifiable evidence bundle"
node tools/cc-ledger.js chain
node tools/cc-ledger.js evidence | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log("bundle:",r.manifest,"files:",r.files,"tar:",r.tar||"(tar unavailable)")})'

# 6) start the real backend so you can click through the SPA
step "5/6  Start the backend (loopback + session token)"
node tools/gui-server.js --instance --print-port &
SERVER_PID=$!
sleep 1
trap 'kill "$SERVER_PID" 2>/dev/null || true; rm -rf "$DEMO_ROOT"' EXIT

step "6/6  Open the URL below in a browser (or run: ./stavros-cc --web)"
node tools/cc-instance.js url

cat <<EOF

Demo root kept for inspection until you press Ctrl-C: $DEMO_ROOT
Suggested click-through: Campaign → Mission (Dispatch an auto action) → Approvals → Ledger.
EOF
wait "$SERVER_PID"
