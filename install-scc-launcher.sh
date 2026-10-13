#!/usr/bin/env bash
# Install the Cyboros Command Center desktop launcher (WP2/WP9).
# Idempotent: re-running overwrites the generated files with the current workspace path.
#   ./install-scc-launcher.sh            # install
#   ./install-scc-launcher.sh --uninstall
set -euo pipefail

WS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"
APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
DESKTOP="$APP_DIR/stavros-cc.desktop"
ICON="$WS/tools/app/icons/stavros-cc.svg"

usage() { sed -n '2,5p' "$0" | sed 's/^# \{0,1\}//'; }

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then usage; exit 0; fi

if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$DESKTOP" "$BIN_DIR/stavros-cc"
  echo "removed launcher and desktop entry"
  exit 0
fi

[ -x "$WS/stavros-cc" ] || chmod +x "$WS/stavros-cc"
mkdir -p "$BIN_DIR" "$APP_DIR"

ln -sf "$WS/stavros-cc" "$BIN_DIR/stavros-cc"

cat > "$DESKTOP" <<EOF
[Desktop Entry]
Type=Application
Name=Cyboros Command Center
GenericName=Red team console
Comment=Desktop console for Cyboros Harness (campaign → mission → approval → execution → report)
Exec=$WS/stavros-cc %U
TryExec=$WS/stavros-cc
Icon=$ICON
Terminal=false
Categories=Development;Security;
StartupNotify=true
StartupWMClass=stavros-cc
Actions=ReadOnly;Web;

[Desktop Action ReadOnly]
Name=Open read-only
Exec=$WS/stavros-cc --read-only

[Desktop Action Web]
Name=Open in browser
Exec=$WS/stavros-cc --web
EOF

echo "installed:"
echo "  $DESKTOP"
echo "  $BIN_DIR/stavros-cc -> $WS/stavros-cc"
echo "run: stavros-cc  (or click the icon)"
