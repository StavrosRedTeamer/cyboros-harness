#!/usr/bin/env bash
# Install the `cyboros` command: `cyboros` opens the TUI, `cyboros scan host` still runs the pipeline.
# Idempotent: re-running overwrites the symlink with the current workspace path.
#   ./scripts/install-cyboros-launcher.sh            # install
#   ./scripts/install-cyboros-launcher.sh --uninstall
set -euo pipefail

WS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"
TARGET="$WS/tools/cyboros.js"
LINK="$BIN_DIR/cyboros"

usage() { sed -n '2,5p' "$0" | sed 's/^# \{0,1\}//'; }

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then usage; exit 0; fi

if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$LINK"
  echo "removed $LINK"
  exit 0
fi

[ -f "$TARGET" ] || { echo "missing $TARGET" >&2; exit 1; }
chmod +x "$TARGET"
mkdir -p "$BIN_DIR"
ln -sf "$TARGET" "$LINK"

echo "installed:"
echo "  $LINK -> $TARGET"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "note: $BIN_DIR is not in PATH; add it or run $LINK directly" ;;
esac
echo "run: cyboros        (TUI)  ·  cyboros scan <host>  (pipeline)"
