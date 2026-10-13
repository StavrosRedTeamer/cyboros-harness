#!/usr/bin/env bash
# Installa il launcher cliccabile "Cyboros RedTeaming — Freebuff" sul desktop.
# Idempotente: rigenera il .desktop con il path REALE del progetto (funziona anche
# se il repo è stato spostato) e lo copia in ~/Scrivania (o ~/Desktop su sistemi EN).
#
#   ./freebuff-edition/install-launcher.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EDITION="$(cd "$SCRIPT_DIR" && pwd)"
ROOT="$(cd "$EDITION/.." && pwd)"

LAUNCH="$EDITION/launch-freebuff.sh"
WRAP="$EDITION/open-freebuff-terminal.sh"
chmod +x "$LAUNCH" "$WRAP" 2>/dev/null || true

# Desktop dir: Scrivania su sistemi IT, Desktop altrimenti
DESKTOP_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || true)"
if [[ -z "$DESKTOP_DIR" || ! -d "$DESKTOP_DIR" ]]; then
  DESKTOP_DIR=""
  for d in "$HOME/Desktop" "$HOME/Scrivania"; do
    if [[ -d "$d" ]]; then DESKTOP_DIR="$d"; break; fi
  done
fi
[[ -z "$DESKTOP_DIR" ]] && { mkdir -p "$HOME/Desktop"; DESKTOP_DIR="$HOME/Desktop"; }

DESKTOP_FILE="$DESKTOP_DIR/cyboros-freebuff.desktop"
cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=Cyboros RedTeaming — Freebuff
Comment=Avvia Cyboros (orchestratore red-team) su Freebuff — variante freebuff-edition (disciplina pentest + MCP)
Exec=$WRAP
Icon=applications-development
Terminal=false
Categories=Development;Security;
StartupNotify=true
EOF
chmod +x "$DESKTOP_FILE"

echo "[stavros] launcher installato: $DESKTOP_FILE"
echo "[stavros] doppio clic su \"Cyboros RedTeaming — Freebuff\" per avviare."
echo "[stavros] prima volta: se il sistema chiede \"consenti esecuzione\", scegli Esegui/Apri."
echo "[stavros] pre-flight: ./freebuff-edition/launch-freebuff.sh --check"
