#!/usr/bin/env bash
# Installa l'icona cliccabile "Cyboros Sage" sul desktop.
# Idempotente: rigenera il .desktop con il path REALE del progetto (funziona anche se il
# repo viene spostato) e usa l'icona già presente nel repo.
#
#   ./scripts/install-sage-launcher.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAUNCH="$SCRIPT_DIR/local/sage/sage.sh"
WRAP="$SCRIPT_DIR/local/sage/open-terminal.sh"
ICON="$SCRIPT_DIR/tools/app/icons/cyboros-cc.svg"
chmod +x "$LAUNCH" "$WRAP" "$SCRIPT_DIR/local/sage/serve.sh" "$SCRIPT_DIR/local/sage/download.sh" 2>/dev/null || true

# Desktop dir: Scrivania su sistemi IT, Desktop altrimenti.
DESKTOP_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || true)"
if [[ -z "$DESKTOP_DIR" || ! -d "$DESKTOP_DIR" ]]; then
  DESKTOP_DIR=""
  for d in "$HOME/Desktop" "$HOME/Scrivania"; do
    if [[ -d "$d" ]]; then DESKTOP_DIR="$d"; break; fi
  done
fi
[[ -z "$DESKTOP_DIR" ]] && { mkdir -p "$HOME/Desktop"; DESKTOP_DIR="$HOME/Desktop"; }

DESKTOP_FILE="$DESKTOP_DIR/cyboros-sage.desktop"
cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=Cyboros Sage
GenericName=Deep research locale
Comment=Ricerca approfondita su vulnerabilità, playbook e capacità dell'harness con Sage-A1.5 locale (report citati, proposte revisionabili)
Exec=$WRAP
Icon=$ICON
Terminal=false
Categories=Development;Security;
StartupNotify=true
EOF
chmod +x "$DESKTOP_FILE"
# Best-effort: su GNOME/derivati il flag "trusted" evita il prompt; su KDE è innocuo.
command -v gio >/dev/null 2>&1 && gio set "$DESKTOP_FILE" metadata::trusted true >/dev/null 2>&1 || true

echo "[sage] launcher installato: $DESKTOP_FILE"
echo "[sage] doppio clic su \"Cyboros Sage\" per aprire il menu."
echo "[sage] prima volta: scarica il modello con  bash $SCRIPT_DIR/local/sage/download.sh"
echo "[sage] avvio da terminale: $LAUNCH"
