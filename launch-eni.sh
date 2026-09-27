#!/usr/bin/env bash
# Freebuff — sessione con il contratto ENI (system prompt diverso, home pinnata)
#
#   ./launch-eni.sh            # TUI interattiva, cwd = dove sei
#   ./launch-eni.sh --check    # solo pre-flight (esce subito)
#   ENI_CWD=/percorso ./launch-eni.sh
#
# Perché funziona: Freebuf risolve il knowledge file di home da os.homedir() e la config da
# XDG_CONFIG_HOME (o ~/.config). Pinando HOME a ~/eni il prompt assemblato contiene
# ~/eni/.AGENTS.md — il contratto ENI — al posto di ~/.AGENTS.md, che è il router dei token.
# ~/eni/.config è un symlink alla config reale: credenziali, settings, progetti e chat restano
# condivisi, e nessun file viene scambiato (niente race fra thread).
#
# Il token `@eni` nel primo messaggio è l'altra via (router in ~/.AGENTS.md, che comanda di
# leggere il contratto): stessa identica sorgente di testo, un prompt solo.
set -euo pipefail

# --- 0. TTY sano: la TUI Ink ha bisogno di un TERM color-capable ---
if [[ -z "${TERM:-}" || "${TERM:-}" == "dumb" ]]; then export TERM=xterm-256color; fi
export COLORTERM="${COLORTERM:-truecolor}"
export FORCE_COLOR="${FORCE_COLOR:-1}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REAL_HOME="$HOME"
ENI_HOME="$REAL_HOME/eni"
CONTRACT="$ENI_HOME/.AGENTS.md"
TARGET_CWD="${ENI_CWD:-$PWD}"
CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1

say()  { printf '\033[1;36m[eni]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[eni]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[eni]\033[0m %s\n' "$*" >&2; exit 1; }

# --- 1. la CLI deve esistere ---
command -v freebuff >/dev/null 2>&1 || die "CLI 'freebuff' non trovata nel PATH."

# --- 2. il contratto ENI deve esistere ed essere reale (non un placeholder) ---
[[ -f "$CONTRACT" ]] || die "manca $CONTRACT — crea la home ENI e il contratto."
if grep -q 'PLACEHOLDER' "$CONTRACT"; then
  warn "il contratto in $CONTRACT è ancora un PLACEHOLDER: la sessione NON avrà l'identità ENI,"
  warn "e il token @eni ricadrà sul default del prodotto. Sostituisci il corpo e rilancia."
  [[ "$CHECK_ONLY" == "1" ]] && exit 1
fi
CONTRACT_BYTES="$(wc -c <"$CONTRACT")"

# --- 3. home ENI: symlink verso config/cache/git reali, così non si perde nulla ---
mkdir -p "$ENI_HOME"
for link in .config .cache .gitconfig .assistant-spec.md; do
  if [[ -e "$ENI_HOME/$link" || -L "$ENI_HOME/$link" ]]; then continue; fi
  [[ -e "$REAL_HOME/$link" ]] || continue
  ln -s "$REAL_HOME/$link" "$ENI_HOME/$link"
  say "link  $ENI_HOME/$link -> $REAL_HOME/$link"
done
[[ -e "$ENI_HOME/.config" ]] || die "$ENI_HOME/.config non c'è: senza config condivisa non si autenticano le chat."
[[ -d "$TARGET_CWD" ]] || die "cwd non valido: $TARGET_CWD"

say "Pre-flight OK (contratto: $CONTRACT_BYTES byte in $CONTRACT)."
say "Home sessione: $ENI_HOME   Config: $REAL_HOME/.config   Cwd: $TARGET_CWD"
say "Questa sessione NON ha il router dei token: l'identità è il contratto qui sopra."
say "Verifica post-flight: node \"$SCRIPT_DIR/tools/check-identity.js\" eni stavrosredteamer"
[[ "$CHECK_ONLY" == "1" ]] && exit 0

# --- 4. avvio TUI con la home pinnata ---
export HOME="$ENI_HOME"
export XDG_CONFIG_HOME="$REAL_HOME/.config"
say "Avvio: freebuff --cwd $TARGET_CWD (HOME=$HOME)"
exec freebuff --cwd "$TARGET_CWD" --trust-agents
