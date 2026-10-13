#!/usr/bin/env bash
# Apre Cyboros/Freebuff in una VERA finestra di terminale interattivo.
#
# Perche: il launcher .desktop con Terminal=true puo avviare la TUI in un contesto TTY
# degradato (frecce che non navigano nel picker dei modelli, colori assenti). Qui apriamo
# esplicitamente il terminale nativo del desktop (konsole su Parrot/KDE Plasma) cosi stdin
# e in raw-mode reale e il TERM e color-capable. Fallback per altri ambienti a seguire.
#
#   ./freebuff-edition/open-freebuff-terminal.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCH="$SCRIPT_DIR/launch-freebuff.sh"
chmod +x "$LAUNCH" 2>/dev/null || true

# Ambiente color-capable anche per il terminale figlio.
export TERM=xterm-256color COLORTERM=truecolor FORCE_COLOR=1

# Comando eseguito DENTRO la finestra: avvia il launcher e tiene aperta la finestra
# a fine sessione, così eventuali errori di pre-flight restano leggibili.
INNER="'$LAUNCH'; rc=\$?; echo; printf '\\033[1;33m[stavros] freebuff terminato (exit %s)\\033[0m\\n' \"\$rc\"; read -n1 -s -r -p 'Premi un tasto per chiudere...'; echo"

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
  printf '\033[1;31m[stavros]\033[0m Nessun terminale grafico trovato (konsole/qterminal/x-terminal-emulator/xterm).\n' >&2
  printf '[stavros] Avvia manualmente: %s\n' "$LAUNCH" >&2
  exit 1
fi
