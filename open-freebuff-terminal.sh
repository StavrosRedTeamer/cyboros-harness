#!/usr/bin/env bash
# Apre Stavros/Freebuff in una VERA finestra di terminale interattivo.
#
# Perché: il launcher .desktop con Terminal=true, su XFCE, delega l'avvio a un
# meccanismo (exo/x-terminal-emulator) che spesso avvia la TUI in un contesto TTY
# degradato -> frecce che non navigano nel picker dei modelli e colori assenti
# (tutto bianco/nero). Qui apriamo esplicitamente qterminal (o un fallback) in modo
# che stdin sia in raw-mode reale e il TERM sia color-capable.
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

if command -v qterminal >/dev/null 2>&1; then
  exec qterminal -e bash -lc "$INNER"
elif command -v x-terminal-emulator >/dev/null 2>&1; then
  exec x-terminal-emulator -e bash -lc "$INNER"
elif command -v xterm >/dev/null 2>&1; then
  exec xterm -e bash -lc "$INNER"
else
  printf '\033[1;31m[stavros]\033[0m Nessun terminale grafico trovato (qterminal/x-terminal-emulator/xterm).\n' >&2
  printf '[stavros] Avvia manualmente: %s\n' "$LAUNCH" >&2
  exit 1
fi
