#!/usr/bin/env bash
# Concede i privilegi minimi (file capabilities + soglia porte) per cui i binari di attacco
# girano come utente NON-root, senza prompt di password. Idempotente: rieseguibile, applica
# solo cio che manca e lo dichiara.
#
#   sudo ./grant-tool-caps.sh            # applica cio che manca
#   sudo ./grant-tool-caps.sh --check    # applica NULLA, dice solo cosa manca (exit 1 se manca)
#   sudo ./grant-tool-caps.sh --print    # mostra il piano, non tocca nulla
#
# Perche' `setcap` e non NOPASSWD sudo: `setcap` concede ESATTAMENTE le capability elencate,
# per quel binario, e non esiste un percorso che produca una shell root. NOPASSWD su
# /bin/bash o find equivarrebbe a root shell senza password; NOPASSWD su masscan no.
# Le capability sono pero' un privilegio reale (cap_net_admin manipola le interfacce):
# questo script NON e' un modo per dare piu' poteri dell'operatore, che e' gia' nel gruppo
# `sudo` — e' un modo per togliere un prompt a un operatore autorizzato.
#
# Attenzione: le capability NON sopravvivono a un upgrade del pacchetto (`apt upgrade nmap`
# riscrive il binario e azzera l'xattr). Riesegui questo script, o verifica con
# `node tools/capcheck.js`, che e' l'unico modo per sapere se il dono e' ancora valido.
set -uo pipefail

MODE="apply"
case "${1:-}" in
  --check) MODE="check" ;;
  --print) MODE="print" ;;
  "")      MODE="apply" ;;
  *) printf 'uso: %s [--check|--print]\n' "$0" >&2; exit 2 ;;
esac

[ "$(id -u)" -eq 0 ] || { printf 'serve root (le capability si applicano come root)\n' >&2; exit 2; }

here="$(cd "$(dirname "$0")" && pwd)"
MANIFEST="$here/tools/cap-manifest.json"
[ -r "$MANIFEST" ] || { printf 'manifest non leggibile: %s\n' "$MANIFEST" >&2; exit 2; }
command -v node >/dev/null 2>&1 || { printf 'serve node per leggere il manifest\n' >&2; exit 2; }

say()  { printf '%s\n' "$*"; }
info() { printf '== %s\n' "$*"; }
ok()   { printf 'OK: %s\n' "$*"; }
warn() { printf '!! %s\n' "$*"; }

# Il piano viene calcolato da tools/cap-plan.js (sorgente unica = manifest, validato, e
# testato a parte). Formato: KIND<TAB>CHIAVE<TAB>ARGOMENTI — senza tab né newline nei campi,
# garantito dalla validazione del manifest.
plan() {
  node "$here/tools/cap-plan.js" "$MANIFEST"
}

# Da root, il PATH non contiene le directory dell'OPERATORE: ~/go/bin (naabu, rustscan,
# dalfox) e ~/.local/bin (pipx) semplicemente non esistono. Senza questo correttivo i binari
# go-installati risultano "non installati", vengono saltati, e lo script dichiara un esito che
# sembra buono ma e' falso. Misurato: naabu e rustscan erano installati e hanno ricevuto
# "non installato".
#
# SUDO_USER non basta: con l'elevazione via GUI (polkit) la variabile non viene popolata e
# il fallback a $HOME dava /root. Cerchiamo allora l'utente non-root che ha davvero una home
# da operatore — cioe' con dentro ~/go/bin o ~/.local/bin — e, in assenza, il primo membro non
# root del gruppo sudo. CYBOROS_OPERATOR_HOME ha la precedenza esplicita (box multi-utente,
# stessa convenzione di CYBOROS_VENDOR_DIR).
#
# I membri del gruppo stanno nel QUARTO campo di getent group (`sudo:x:27:utente1,utente2`),
# separati da virgole: si prende `cut -d: -f4` e poi si splitta sulle virgole. Splittando
# l'intera riga con `tr ',' ' '` si ottiene un unico candidato "sudo:x:27:utente1 utente2", che
# `getent passwd` non risolve, e il ciclo scarta tutto ricadendo su $HOME=/root — che e'
# esattamente il guasto che questo script aveva, e che da utente era invisibile perche' il
# fallback dava per caso la risposta giusta.
operator_home() {
  if [ -n "${CYBOROS_OPERATOR_HOME:-}" ] && [ -d "$CYBOROS_OPERATOR_HOME" ]; then
    printf '%s' "$CYBOROS_OPERATOR_HOME"; return
  fi
  local u h first=""
  for u in "${SUDO_USER:-}" $(getent group sudo 2>/dev/null | cut -d: -f4 | tr ',' ' '); do
    [ -n "$u" ] && [ "$u" != root ] || continue
    h="$(getent passwd "$u" 2>/dev/null | cut -d: -f6)"
    [ -n "$h" ] && [ -d "$h" ] || continue
    [ -n "$first" ] || first="$h"
    if [ -d "$h/go/bin" ] || [ -d "$h/.local/bin" ]; then printf '%s' "$h"; return; fi
  done
  printf '%s' "${first:-$HOME}"
}
OPERATOR_HOME="$(operator_home)"
SEARCH_PATH="$OPERATOR_HOME/.local/bin:$OPERATOR_HOME/go/bin:$OPERATOR_HOME/bin:/usr/local/sbin:/usr/sbin:/sbin:/usr/local/bin:/usr/bin:/bin"

resolve() { # bin -> path installato sull'utente operatore, o vuoto
  PATH="$SEARCH_PATH" command -v "$1" 2>/dev/null
}

# getcap stampa `/percorso cap_a,cap_b=ep`: i flag (=ep) vanno tolti, altrimenti il confronto
# con la voluta fallisce per sempre e lo script riapplica le capability a ogni esecuzione
# invece di essere idempotente. Il percorso NON puo' contenere spazi su un sistema installato
# normalmente, quindi il campo 2 e' l'unico da guardare.
current_caps() {
  getcap "$1" 2>/dev/null | head -1 | awk '{ if (NF>=2 && $2 ~ /^cap_/) { sub(/[=+].*$/, "", $2); print $2 } }'
}

missing=0
applied=0
skipped=0
absent=0

# ---------------------------------------------------------------- sysctl
run_sysctl() {
  local key="$1" want="$2" persist="$3" cur
  cur="$(cat "/proc/sys/${key//.//}" 2>/dev/null || echo '?')"
  if [ "$cur" = "$want" ]; then
    ok "$key = $cur"
    return
  fi
  if [ -n "$persist" ] && [ -r "$persist" ] && grep -qE "^${key}[[:space:]]*=[[:space:]]*${want}\b" "$persist"; then
    warn "$key = $cur ma $persist dichiara gia' $want (riavvio pendente o overridden da un file successivo)"
    return
  fi
  warn "$key = $cur, serve $want"
  if [ "$MODE" = "print" ]; then return; fi
  if [ "$MODE" = "check" ]; then missing=$((missing+1)); return; fi
  sysctl -q -w "${key}=${want}" || { warn "sysctl -w $key fallito"; missing=$((missing+1)); return; }
  # Persistenza: senza, un reboot o un `sysctl --system` successivo rimette 1024 e i tool
  # tornano a chiedere la password. Scriviamo il file solo se non dichiara gia' il valore.
  if [ -n "$persist" ] && ! grep -qE "^${key}[[:space:]]*=" "$persist" 2>/dev/null; then
    printf '%s = %s\n' "$key" "$want" > "$persist" && ok "persistito in $persist" \
      || warn "non ho potuto scrivere $persist (il valore regge solo per questa sessione)"
  fi
  applied=$((applied+1))
}

# ---------------------------------------------------------------- setcap
run_bin() {
  local bin="$1" want="$2" p cur
  p="$(resolve "$bin")"
  if [ -z "$p" ]; then
    warn "$bin non installato — niente da concedere (tool-plane lo segnera' come assente)"
    absent=$((absent+1))
    return
  fi
  # Script: setcap non ha effetto (l'xattr andrebbe sull'interprete). Non e' un errore,
  # ma va detto, altrimenti il manifest sembra mentire.
  if head -c 4 "$p" 2>/dev/null | grep -q '#!'; then
    warn "$bin e' uno script ($p): setcap non applicabile, l'xattr andrebbe sull'interprete"
    return
  fi
  cur="$(current_caps "$p")"
  # Normalizza: l'ordine delle capability in un xattr non e' significativo, quindi
  # confrontiamo insiemi ordinati, non stringhe.
  local want_n cur_n
  want_n="$(printf '%s' "$want" | tr ',' '\n' | LC_ALL=C sort | paste -sd, -)"
  cur_n="$(printf '%s' "$cur"  | tr ',' '\n' | LC_ALL=C sort | paste -sd, -)"
  if [ -n "$cur" ] && [ "$cur_n" = "$want_n" ]; then
    ok "$bin gia' ha $want_n"
    return
  fi
  warn "$bin: attuale='${cur:-nessuna}' voluta='$want_n'"
  if [ "$MODE" = "print" ]; then return; fi
  if [ "$MODE" = "check" ]; then missing=$((missing+1)); return; fi
  if setcap "$want_n+ep" "$p" 2>/dev/null; then
    applied=$((applied+1))
  else
    # btrfs senza il supporto xattr, o filesystem montato nosuid: riporta il motivo vero.
    warn "setcap fallito su $p — filesystem senza supporto security.capability?"
    missing=$((missing+1))
  fi
}

# ---------------------------------------------------------------- driver
info "manifest: $MANIFEST"
info "modalita': $MODE"
info "home operatore risolta: $OPERATOR_HOME"

while IFS="$(printf '\t')" read -r kind key arg3 arg4; do
  [ -n "${kind:-}" ] || continue
  case "$kind" in
    SYSCTL) run_sysctl "$key" "$arg3" "$arg4" ;;
    BIN)    run_bin    "$key" "$arg3" ;;
    *)      warn "riga di piano sconosciuta: $kind" ;;
  esac
done < <(plan)

echo
case "$MODE" in
  apply)
    printf 'applicati: %d, assenti: %d\n' "$applied" "$absent"
    if [ "$missing" -gt 0 ]; then
      warn "$missing interventi non riusciti — niente viene dichiarato pronto"
      exit 1
    fi
    say "verifica indipendente: node tools/capcheck.js"
    ;;
  check)
    if [ "$missing" -gt 0 ]; then
      warn "manca: $missing interventi — esegui 'sudo ./grant-tool-caps.sh'"
      exit 1
    fi
    ok "tutto gia' in ordine (manca: 0)"
    ;;
  print)
    say "piano sopra: nulla e' stato modificato"
    ;;
esac
