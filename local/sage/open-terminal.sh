#!/usr/bin/env bash
# Apre il menu di Cyboros Sage in una vera finestra di terminale.
#
# Perché non Terminal=true nel .desktop: alcune TUI/readline partono con un TERM degradato
# e stdin non interattivo. Qui apriamo esplicitamente un emulatore, e la finestra resta
# aperta a fine sessione così errori e output restano leggibili.
#
#   ./local/sage/open-terminal.sh            # menu
#   ./local/sage/open-terminal.sh status     # passthrough al CLI
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCH="$SCRIPT_DIR/sage.sh"
chmod +x "$LAUNCH" 2>/dev/null || true

export TERM=xterm-256color COLORTERM=truecolor FORCE_COLOR=1

ARGS=""
for a in "$@"; do ARGS="$ARGS $(printf '%q' "$a")"; done

INNER="'$LAUNCH'$ARGS; rc=\$?; echo; printf '\\033[1;36m[sage] terminato (exit %s)\\033[0m\\n' \"\$rc\"; read -n1 -s -r -p 'Premi un tasto per chiudere...'; echo"

if command -v konsole >/dev/null 2>&1; then
  exec konsole -e bash -lc "$INNER"
elif command -v qterminal >/dev/null 2>&1; then
  exec qterminal -e bash -lc "$INNER"
elif command -v mate-terminal >/dev/null 2>&1; then
  exec mate-terminal -x bash -lc "$INNER"
elif command -v x-terminal-emulator >/dev/null 2>&1; then
  exec x-terminal-emulator -e bash -lc "$INNER"
elif command -v xterm >/dev/null 2>&1; then
  exec xterm -e bash -lc "$INNER"
else
  printf '\033[1;31m[sage]\033[0m Nessun terminale grafico trovato (konsole/qterminal/mate-terminal/xterm).\n' >&2
  printf '[sage] Avvia manualmente: %s\n' "$LAUNCH" >&2
  exit 1
fi
