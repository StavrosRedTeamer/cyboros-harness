#!/usr/bin/env bash
# Apre l'AGENTE LOCALE (modello abliterato + harness) in una VERA finestra di terminale.
#
# Perché: un .desktop con Terminal=true può avviare la TUI in un contesto TTY degradato
# (frecce che non navigano, colori assenti, stdin non raw). Qui apriamo esplicitamente
# konsole (KDE Plasma) così stdin è in raw-mode reale e TERM è color-capable.
# La finestra resta aperta a fine sessione, così errori e output restano leggibili.
#
#   ./local/open-agent-local-terminal.sh            # menu del launcher
#   ./local/open-agent-local-terminal.sh --plan HOST
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCH="$SCRIPT_DIR/agent-local.sh"
chmod +x "$LAUNCH" 2>/dev/null || true

export TERM=xterm-256color COLORTERM=truecolor FORCE_COLOR=1

# Argomenti passati al launcher (es. --plan <host>), quotati per il comando interno.
ARGS=""
for a in "$@"; do ARGS="$ARGS $(printf '%q' "$a")"; done

INNER="'$LAUNCH'$ARGS; rc=\$?; echo; printf '\\033[1;36m[local] agente terminato (exit %s)\\033[0m\\n' \"\$rc\"; read -n1 -s -r -p 'Premi un tasto per chiudere...'; echo"

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
  printf '\\033[1;31m[local]\\033[0m Nessun terminale grafico trovato (konsole/qterminal/x-terminal-emulator/xterm).\\n' >&2
  printf '[local] Avvia manualmente: %s\\n' "$LAUNCH" >&2
  exit 1
fi
