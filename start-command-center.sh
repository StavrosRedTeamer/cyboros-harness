#!/usr/bin/env bash
# Cyboros RedTeamer — avvio del Command Center (dashboard web locale).
#
#   ./start-command-center.sh                 # avvia e apre il browser su 127.0.0.1:8787
#   ./start-command-center.sh --port 9000     # porta custom
#   ./start-command-center.sh --host 0.0.0.0  # bind diverso (sconsigliato: la console è loopback-only per design)
#   ./start-command-center.sh --no-open       # non aprire il browser
#
# Serve la SPA tools/gui/ ("Cyboros Redteamer · Command Center") via
# tools/gui-server.js: zero-dipendenze, bound su loopback, non bypassa mai i guard.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

say()  { printf '\033[1;32m[stavros]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[stavros]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[stavros]\033[0m %s\n' "$*" >&2; exit 1; }

# --- 0. parse args (i flag ignoti vengono inoltrati a gui-server.js) ---
HOST="127.0.0.1"
PORT="8787"
OPEN=1
TOKEN_USER=""
PASS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="${2:?--host richiede un valore}"; PASS+=(--host "$2"); shift 2 ;;
    --port) PORT="${2:?--port richiede un valore}"; PASS+=(--port "$2"); shift 2 ;;
    --no-open) OPEN=0; shift ;;
    --token) TOKEN_USER="${2:?--token richiede un valore}"; PASS+=(--token "$2"); shift 2 ;;
    -h|--help)
      sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) PASS+=("$1"); shift ;;
  esac
done

# --- 1. runtime: Node >= 22 (come da package.json engines) ---
command -v node >/dev/null 2>&1 || die "Node.js non trovato nel PATH (richiesto >= 22)."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[[ "$NODE_MAJOR" -ge 22 ]] || warn "Node $(node --version) < 22: la console potrebbe non funzionare (node:sqlite/PTY)."

# --- 2. server presente ---
SERVER="$SCRIPT_DIR/tools/gui-server.js"
[[ -f "$SERVER" ]] || die "tools/gui-server.js mancante in $SCRIPT_DIR."

# --- 2b. istanza già viva? → attach (due backend sulla stessa workspace si pestano i piedi) ---
if [[ "$OPEN" == "1" ]]; then
  EXISTING="$(node "$SCRIPT_DIR/tools/cc-instance.js" url 2>/dev/null || true)"
  if [[ -n "$EXISTING" ]]; then
    say "istanza già attiva → ${EXISTING}"
    OPENER_BIN="$(command -v xdg-open 2>/dev/null || command -v gio 2>/dev/null || true)"
    if [[ -n "$OPENER_BIN" ]]; then
      if [[ "$(basename "$OPENER_BIN")" == "gio" ]]; then "$OPENER_BIN" open "$EXISTING" >/dev/null 2>&1 &
      else "$OPENER_BIN" "$EXISTING" >/dev/null 2>&1 & fi
    fi
    exit 0
  fi
fi

# --- 2c. token di sessione: write e terminali passano solo dall'URL con token ---
if [[ -z "$TOKEN_USER" ]]; then
  TOKEN_USER="$(node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("hex"))')"
  PASS+=(--token "$TOKEN_USER")
fi

URL="http://${HOST}:${PORT}/?token=${TOKEN_USER}"
say "Command Center → ${URL}   (ctrl-c per fermare)"

# --- 3. apri il browser quando la porta risponde (in background, non bloccante) ---
if [[ "$OPEN" == "1" ]]; then
  OPENER="$(command -v xdg-open 2>/dev/null || command -v gio 2>/dev/null || true)"
  if [[ -n "$OPENER" ]]; then
    (
      for _ in $(seq 1 50); do
        if (exec 3<>"/dev/tcp/${HOST}/${PORT}") 2>/dev/null; then exec 3>&- 3<&-; break; fi
        sleep 0.2
      done
      case "$(basename "$OPENER")" in
        gio) "$OPENER" open "$URL" ;;
        *)   "$OPENER" "$URL" ;;
      esac
    ) >/dev/null 2>&1 &
  else
    warn "Nessun opener grafico (xdg-open/gio): apri manualmente ${URL}"
  fi
fi

# --- 4. avvio server (in foreground: ctrl-c lo ferma) ---
exec node "$SERVER" "${PASS[@]}"
