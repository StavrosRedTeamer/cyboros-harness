#!/usr/bin/env bash
# Stavros RedTeaming — avvio della variante Freebuff (freebuff-edition)
#
#   ./freebuff-edition/launch-freebuff.sh          # avvio interattivo
#   ./freebuff-edition/launch-freebuff.sh --check  # solo pre-flight (esce subito)
#
# Pre-flight (fail-closed): scope.json non vuoto, CLI freebuff presente,
# Chrome per chrome-devtools MCP (warning, non bloccante).
# Poi lancia: freebuff --cwd "$EDITION" (TUI interattiva).
set -euo pipefail

# --- 0. TTY sano: colori + input tasti (frecce) nella TUI Freebuff ---
# Se lanciato da un launcher che degrada il TERM (es. .desktop Terminal=true),
# forziamo un terminale color-capable così la TUI Ink mostra i colori e le
# frecce navigano nel picker dei modelli. Un TERM valido preesistente è rispettato.
if [[ -z "${TERM:-}" || "${TERM}" == "dumb" ]]; then
  export TERM=xterm-256color
fi
export COLORTERM="${COLORTERM:-truecolor}"
export FORCE_COLOR="${FORCE_COLOR:-1}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EDITION="$(cd "$SCRIPT_DIR" && pwd)"
ROOT="$(cd "$EDITION/.." && pwd)"

CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1

say()  { printf '\033[1;32m[stavros]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[stavros]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[stavros]\033[0m %s\n' "$*" >&2; exit 1; }

cd "$EDITION"

# --- 1. CLI freebuff ---
if ! command -v freebuff >/dev/null 2>&1; then
  die "CLI 'freebuff' non trovata nel PATH. Installa Freebuff o aggiungila al PATH."
fi

# --- 2. scope.json presente e non vuoto (fail-closed) ---
if [[ ! -f "$EDITION/scope.json" ]]; then
  die "scope.json mancante in $EDITION — copia da un esempio e compila gli host autorizzati."
fi
SCOPE_OK="$(node -e "
  const s = require('fs').existsSync('$EDITION/scope.json')
    ? JSON.parse(require('fs').readFileSync('$EDITION/scope.json', 'utf8')) : {};
  const hosts = (s.allowed_hosts || []).length;
  const ips   = (s.allowed_ips || []).length;
  const prefixes = (s.allowed_url_prefixes || []).length;
  process.stdout.write(String(hosts + ips + prefixes));
" 2>/dev/null || echo "0")"
if [[ "$SCOPE_OK" == "0" ]]; then
  warn "scope.json è VUOTO (nessun host/IP autorizzato): il guard bloccherà tutto (fail-closed)."
  warn "Compila $EDITION/scope.json prima di iniziare un assessment."
  [[ "$CHECK_ONLY" == "1" ]] && exit 1
fi

# --- 3. verifica scope-guard risponde (tool condivisi via symlink) ---
if ! node "$EDITION/tools/scope-guard.js" --help >/dev/null 2>&1; then
  # scope-guard non ha --help: prova un check innocuo per capire se il modulo gira
  if ! node -e "require('$EDITION/tools/scope-guard.js')" >/dev/null 2>&1; then
    die "tools/ non risponde (symlink rotto?). Verifica: ls -la $EDITION/tools"
  fi
fi
say "Pre-flight OK (scope: ${SCOPE_OK} entry autorizzate)."

# --- 4. Chrome per chrome-devtools MCP (warning non bloccante) ---
CHROME_BIN="$(command -v google-chrome 2>/dev/null || command -v chromium 2>/dev/null || command -v chromium-browser 2>/dev/null || true)"
if [[ -z "$CHROME_BIN" ]]; then
  warn "Chrome/Chromium non trovato: il server MCP 'chrome-devtools' non partirà."
  warn "Installa Chrome oppure disattiva chrome-devtools in build-agents.mjs (MCP_SERVERS)."
fi

# --- 5. modello di default (info) ---
say "Agente root: stavros (orchestratore) — modello scelto dal picker all'avvio di Freebuff."
say "Avvio: freebuff --cwd $EDITION"

[[ "$CHECK_ONLY" == "1" ]] && exit 0

# --- 6. avvio TUI ---
exec freebuff --cwd "$EDITION"
