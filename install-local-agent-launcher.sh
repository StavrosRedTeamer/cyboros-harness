#!/usr/bin/env bash
# Installa il launcher cliccabile "Cyboros — Agente Locale" sul desktop.
# Idempotente: rigenera il .desktop con il path REALE del progetto (funziona anche se il
# repo viene spostato) e lo copia in ~/Scrivania (o ~/Desktop su sistemi EN).
#
#   ./install-local-agent-launcher.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCH="$SCRIPT_DIR/local/agent-local.sh"
WRAP="$SCRIPT_DIR/local/open-agent-local-terminal.sh"
chmod +x "$LAUNCH" "$WRAP" 2>/dev/null || true

# Desktop dir: Scrivania su sistemi IT, Desktop altrimenti.
DESKTOP_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || true)"
if [[ -z "$DESKTOP_DIR" || ! -d "$DESKTOP_DIR" ]]; then
  DESKTOP_DIR=""
  for d in "$HOME/Desktop" "$HOME/Scrivania"; do
    if [[ -d "$d" ]]; then DESKTOP_DIR="$d"; break; fi
  done
fi
[[ -z "$DESKTOP_DIR" ]] && { mkdir -p "$HOME/Desktop"; DESKTOP_DIR="$HOME/Desktop"; }

DESKTOP_FILE="$DESKTOP_DIR/cyboros-agente-locale.desktop"
cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=Cyboros — Agente Locale
Comment=Avvia il modello Qwen3.6-35B-A3B-abliterated (se non è già attivo) e apre l'harness locale: REPL interattivo o recon→opzioni
Exec=$WRAP
Icon=utilities-terminal
Terminal=false
Categories=Development;Security;
StartupNotify=true
EOF
chmod +x "$DESKTOP_FILE"
# Best-effort: su GNOME/derivati il flag "trusted" evita il prompt; su KDE è innocuo.
command -v gio >/dev/null 2>&1 && gio set "$DESKTOP_FILE" metadata::trusted true >/dev/null 2>&1 || true

echo "[local] launcher installato: $DESKTOP_FILE"
echo "[local] doppio clic su \"Cyboros — Agente Locale\" per avviare."
echo "[local] prima volta: se il sistema chiede \"consenti esecuzione\", scegli Esegui/Apri."
echo "[local] avvio da terminale: $LAUNCH"
