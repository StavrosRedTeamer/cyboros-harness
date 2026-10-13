#!/usr/bin/env bash
# demo.sh — three refusals, and a green suite. Meant to be recorded, not read.
#
#   ./tools/demo.sh              # full run, ~50s: the whole 92-test gate
#   DEMO_FAST=1 ./tools/demo.sh  # the guard tests only, for a README GIF
#   DEMO_PACE=3 DEMO_FAST=1 ./tools/demo.sh   # ...with 3s of hold per step
#
# What it shows, in order: an empty scope authorizes nothing; a severity that
# exceeds its evidence is refused rather than warned about; a claim of reality
# without a machine-checked oracle is refused. Then tests, offline, no install.
#
# DEMO_FAST runs a real subset (--only guard) rather than a canned summary. A GIF
# is the one place where showing something shorter than what actually happened is
# exactly the kind of dishonesty this project is about.
#
# DEMO_PACE holds each step for N seconds. The real work finishes in about a
# second, which is unwatchable as a recording and unreadable as a GIF — a reader
# needs time to read a refusal before the next one lands. The hold goes HERE
# rather than in the renderer so that asciinema and VHS produce the same pacing,
# and so a change to the demo changes the timing with it.
#
# SAFETY: every path this touches is inside a throwaway temp dir. It never reads
# or writes your real scope.json, reports/, or the findings tab database. That is
# not incidental — an earlier draft of this script did write to them, which is
# exactly the kind of thing a demo must never do.
set -euo pipefail

DEMO_FAST="${DEMO_FAST:-0}"
DEMO_PACE="${DEMO_PACE:-0}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
# A fixed name, not mktemp: the paths appear in the recorded output, and a GIF
# that spells /tmp/tmp.RZ4eFZFPvB/f.json is both ugly and different every run.
# Costs: two concurrent demo runs collide. That is a fine trade for a
# reproducible artifact.
DEMO_DIR="${TMPDIR:-/tmp}/cyboros-demo"
rm -rf "$DEMO_DIR"
mkdir -p "$DEMO_DIR"
trap 'rm -rf "$DEMO_DIR"' EXIT

# Full isolation. FINDINGS_JSONL is not enough on its own: the head anchor and
# the findings tab database have their own defaults and will happily write into
# the repo and into $HOME if you do not redirect them too.
export SCOPE_JSON="$DEMO_DIR/scope.json"
export FINDINGS_JSONL="$DEMO_DIR/findings.jsonl"
export FINDINGS_HEAD_ANCHOR_FILE="$DEMO_DIR/head-anchor.jsonl"
export FINDINGS_TAB_DB="$DEMO_DIR/results.db"
export SCOPE_PINS_FILE="$DEMO_DIR/dns-pins.json"
export SCOPE_DIVERGENCE_LOG="$DEMO_DIR/dns-divergence.log"

step() { printf '\n\033[1;36m── %s\033[0m\n' "$*"; }
# Hold the current frame so a recorded GIF is readable. No-op when not recording.
hold() { [ "$DEMO_PACE" != "0" ] && sleep "$DEMO_PACE" || true; }
# `expect_refusal` runs a command that is SUPPOSED to exit non-zero. Without it,
# `set -e` ends the demo at the first refusal — which is the whole point of the
# demo. The exit code is the evidence, so it gets printed.
cmd()  { printf '\033[2m$ %s\033[0m\n' "$*"; eval "$*"; }
refuse() {
  printf '\033[2m$ %s\033[0m\n' "$1"
  local rc=0; eval "$1" || rc=$?
  printf '   \033[1;31mexit %s\033[0m\n' "$rc"
  return 0
}

echo '{}' > "$SCOPE_JSON"

# The demo runs from the repo root, so any bare relative path — `cat scope.json`,
# `ls reports/` — resolves to the OPERATOR'S real engagement data, not the
# throwaway files. An earlier draft printed the real scope.json, client hostnames
# and all. Every path below is absolute into $DEMO_DIR, and this guard trips if
# one of the redirected env vars is not actually in effect.
for v in SCOPE_JSON FINDINGS_JSONL FINDINGS_HEAD_ANCHOR_FILE FINDINGS_TAB_DB; do
  case "${!v}" in
    "$DEMO_DIR"/*) ;;
    *) echo "demo: $v is not isolated (got '${!v}') — refusing to run" >&2; exit 2 ;;
  esac
done
if [ -e "$REPO/scope.json" ]; then
  echo "note: a real scope.json exists in this checkout. It is gitignored and this" >&2
  echo "      demo never reads it, but do not paste its contents anywhere." >&2
fi

step "1. An empty scope authorizes nothing"
cmd "cat '$SCOPE_JSON'"
refuse "node tools/scope-guard.js check https://target.example"
echo "   Not a warning. The guard decided, not the model."
hold

step "2. Severity cannot exceed evidence"
cat > "$DEMO_DIR/f.json" <<'JSON'
{"title":"IDOR on /api/invoices","host":"target.example",
 "url":"https://target.example/api/invoices/1",
 "poc":"GET /api/invoices/1 with the user_b cookie",
 "verify_level":"suspected","status":"inconclusive","severity":"Critical"}
JSON
refuse "node tools/record-finding.js \"\$(cat $DEMO_DIR/f.json)\""
echo "   Critical on a suspected finding. The ceiling is suspected→Low."
echo "   The same finding, honestly rated:"
cmd "node tools/record-finding.js \"\$(sed 's/\\\"Critical\\\"/\\\"Low\\\"/' $DEMO_DIR/f.json)\""
echo "   Accepted — same evidence, severity it can carry."
hold

step "3. A claim of reality needs a machine-checked oracle"
cat > "$DEMO_DIR/g.json" <<'JSON'
{"title":"RCE via file upload","host":"target.example",
 "url":"https://target.example/upload","poc":"upload a JSP shell",
 "verify_level":"exploited","status":"verified","severity":"High"}
JSON
refuse "node tools/record-finding.js \"\$(cat $DEMO_DIR/g.json)\""
echo "   'verified' with no oracle is not a downgraded finding. It is a refusal."
hold

if [ "$DEMO_FAST" = "1" ]; then
  step "4. The guards, under test, offline"
  cmd "npm test -- --only guard 2>&1 | tail -3  # 4 tests, ~5s"
  echo
  echo "The full gate is 92 tests in ~45s. Zero dependencies either way:"
  echo "nothing to audit but the repository."
else
  step "4. 92 tests, no install, no network"
  cmd "npm test 2>&1 | tail -3  # ~45s"
  echo
  echo "Zero dependencies. Nothing to audit but the repository."
fi
echo "Scope of use: authorized testing only — see SECURITY.md."
