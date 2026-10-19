#!/usr/bin/env bash
# Installa il launcher cliccabile "Cyboros Command Center" sul desktop.
# Idempotente: genera il .desktop con il path REALE del progetto (funziona anche
# se il repo è stato spostato) e lo copia in ~/Scrivania (o ~/Desktop su sistemi EN),
# marcandolo eseguibile/affidabile così il doppio click parte senza avvisi.
#
#   ./scripts/install-command-center-launcher.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EDITION="$(cd "$SCRIPT_DIR/.." && pwd)"

START="$EDITION/start-command-center.sh"
[[ -f "$START" ]] || { echo "[cyboros] start-command-center.sh mancante in $EDITION" >&2; exit 1; }
chmod +x "$START" 2>/dev/null || true

# Desktop dir: Scrivania su sistemi IT, Desktop altrimenti
DESKTOP_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || true)"
if [[ -z "$DESKTOP_DIR" || ! -d "$DESKTOP_DIR" ]]; then
  DESKTOP_DIR=""
  for d in "$HOME/Desktop" "$HOME/Scrivania"; do
    if [[ -d "$d" ]]; then DESKTOP_DIR="$d"; break; fi
  done
fi
[[ -z "$DESKTOP_DIR" ]] && { mkdir -p "$HOME/Desktop"; DESKTOP_DIR="$HOME/Desktop"; }

# Solo la copia sul desktop. Il repo non versiona piu' un .desktop: `Exec` non ha un field code
# portabile per la home — `%h` esiste in systemd, non nell'Exec di un Desktop Entry, dove un
# codice non previsto rende la riga invalida e non processabile — quindi un file versionato con
# `/home/<utente>/...` funziona per il solo autore. Qui il path reale si risolve all'installazione.
TARGET="$DESKTOP_DIR/cyboros-command-center.desktop"
cat > "$TARGET" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=Cyboros Command Center
Comment=Avvia la dashboard web locale (Command Center) di Cyboros Harness e apre il browser
Exec=$START
Icon=utilities-system-monitor
Terminal=true
Categories=Development;Security;
StartupNotify=true
EOF
chmod +x "$TARGET"
# GNOME/Nautilus: serve il flag "trusted" per lanciare senza prompt.
gio set "$TARGET" metadata::trusted true 2>/dev/null || true

echo "[cyboros] launcher installato: $DESKTOP_DIR/cyboros-command-center.desktop"
echo "[cyboros] doppio clic su \"Cyboros Command Center\" per avviare la dashboard."
echo "[cyboros] prima volta: se il sistema chiede \"consenti esecuzione\", scegli Esegui/Apri."
