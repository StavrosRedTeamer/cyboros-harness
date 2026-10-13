#!/usr/bin/env bash
# Install the Cyboros Command Center desktop launcher (WP2/WP9).
# Idempotent: re-running overwrites the generated files with the current workspace path.
#   ./install-cyboros-cc-launcher.sh            # install
#   ./install-cyboros-cc-launcher.sh --uninstall
set -euo pipefail

WS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"
APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
DESKTOP="$APP_DIR/cyboros-cc.desktop"
ICON="$WS/tools/app/icons/cyboros-cc.svg"

usage() { sed -n '2,5p' "$0" | sed 's/^# \{0,1\}//'; }

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then usage; exit 0; fi

if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$DESKTOP" "$BIN_DIR/cyboros-cc"
  echo "removed launcher and desktop entry"
  exit 0
fi

[ -x "$WS/cyboros-cc" ] || chmod +x "$WS/cyboros-cc"
mkdir -p "$BIN_DIR" "$APP_DIR"

ln -sf "$WS/cyboros-cc" "$BIN_DIR/cyboros-cc"

cat > "$DESKTOP" <<EOF
[Desktop Entry]
Type=Application
Name=Cyboros Command Center
GenericName=Red team console
Comment=Desktop console for Cyboros Harness (campaign → mission → approval → execution → report)
Exec=$WS/cyboros-cc %U
TryExec=$WS/cyboros-cc
Icon=$ICON
Terminal=false
Categories=Development;Security;
StartupNotify=true
StartupWMClass=cyboros-cc
Actions=ReadOnly;Web;

[Desktop Action ReadOnly]
Name=Open read-only
Exec=$WS/cyboros-cc --read-only

[Desktop Action Web]
Name=Open in browser
Exec=$WS/cyboros-cc --web
EOF

echo "installed:"
echo "  $DESKTOP"
echo "  $BIN_DIR/cyboros-cc -> $WS/cyboros-cc"
echo "run: cyboros-cc  (or click the icon)"
