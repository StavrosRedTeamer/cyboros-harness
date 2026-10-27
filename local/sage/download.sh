#!/usr/bin/env bash
# local/sage/download.sh — scarica Sage-A1.5 (GGUF Q4_K_M) in ~/models/sage-a15.
#
# I nomi dei file NON sono scritti qui: si chiedono all'API di Hugging Face. Un repo GGUF
# può essere shardato (`...-00001-of-00004.gguf`) o cambiare nome, e uno script che
# indovina il filename fallisce nel modo peggiore — dopo 20 GB di download.
#
#   bash local/sage/download.sh --list    # cosa scaricherebbe (nessun download)
#   bash local/sage/download.sh           # scarica/riprende
#   bash local/sage/download.sh --check   # verifica che i file ci siano
#
# Tunable: SAGE_MODEL_DIR, SAGE_HF_REPO
set -euo pipefail

REPO="${SAGE_HF_REPO:-InternScience/Sage-A1.5-Q4_K_M-GGUF}"
DIR="${SAGE_MODEL_DIR:-$HOME/models/sage-a15}"
# `?blobs=true` è obbligatorio per avere `size`: senza, il campo manca e nessun controllo di
# completezza sarebbe possibile.
API="https://huggingface.co/api/models/${REPO}?blobs=true"

say()  { printf '\033[1;32m[sage]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[sage]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[sage]\033[0m %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die "curl non trovato"
command -v node >/dev/null 2>&1 || die "node non trovato (serve per leggere l'API HF)"

MODE="download"
case "${1:-}" in
  --list) MODE="list" ;;
  --check) MODE="check" ;;
  "") ;;
  *) die "flag sconosciuto: $1" ;;
esac

say "repo: $REPO"
FILES="$(curl -fsSL --max-time 30 "$API" | node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    let j; try { j = JSON.parse(s); } catch { process.exit(3); }
    // nome + dimensione attesa: senza la dimensione non si distingue un file completo da uno
    // troncato, e `curl -C -` su un file già completo riceve 416 e fa fallire lo script.
    for (const f of j.siblings || []) if (/\.gguf$/i.test(f.rfilename)) console.log(`${f.rfilename}\t${f.size || 0}`);
  });')" || die "API HF non raggiungibile o risposta non valida: $API"
[[ -n "$FILES" ]] || die "nessun .gguf nel repo $REPO"

if [[ "$MODE" == "list" ]]; then
  while IFS=$'\t' read -r rel size; do
    [[ -z "$rel" ]] && continue
    printf '%10s  %s\n' "$(numfmt --to=iec --suffix=B "$size" 2>/dev/null || echo "${size} B")" "$rel"
  done <<< "$FILES"
  exit 0
fi

if [[ "$MODE" == "check" ]]; then
  miss=0
  while IFS=$'\t' read -r rel size; do
    [[ -z "$rel" ]] && continue
    f="$DIR/$rel"
    if [[ ! -f "$f" ]]; then
      warn "MANCA $rel"; miss=1; continue
    fi
    have="$(stat -c%s "$f")"
    if [[ "$size" -gt 0 && "$have" -ne "$size" ]]; then
      warn "INCOMPLETO $rel ($((have / 1024 / 1024))/$((size / 1024 / 1024)) MB)"; miss=1
    else
      say "ok   $(du -h "$f" | cut -f1)  $rel"
    fi
  done <<< "$FILES"
  [[ "$miss" == "0" ]] || die "download incompleto: lancia bash local/sage/download.sh"
  say "tutto presente in $DIR"
  exit 0
fi

mkdir -p "$DIR"
# Spazio: i pesi Q4_K_M sono ~22 GB più il proiettore vision. Chiediamo 24 GB liberi.
free_kb="$(df -Pk "$DIR" | awk 'NR==2{print $4}')"
need_kb=$((24 * 1024 * 1024))
if (( free_kb < need_kb )); then
  die "spazio insufficiente in $DIR: $((free_kb / 1024 / 1024)) GB liberi, servono ~24 GB"
fi

while IFS=$'\t' read -r rel size; do
  [[ -z "$rel" ]] && continue
  out="$DIR/$rel"
  mkdir -p "$(dirname "$out")"
  if [[ -f "$out" && "$size" -gt 0 && "$(stat -c%s "$out")" -eq "$size" ]]; then
    say "✓ già completo  $rel"; continue
  fi
  say "↓ $rel"
  # -C - riprende un download interrotto invece di ripartire da zero.
  curl -fL --retry 3 --retry-delay 2 -C - --progress-bar \
    "https://huggingface.co/${REPO}/resolve/main/${rel}" -o "$out" \
    || die "download fallito: $rel (rilancia lo script: riprende da dove era)"
done <<< "$FILES"

say "fatto: $DIR ($(du -sh "$DIR" | cut -f1))"
say "prossimo passo: bash local/sage/serve.sh --check"
