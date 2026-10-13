#!/usr/bin/env bash
# evo-x2-lab — validazione build di llama.cpp
#
# Perché: su Strix Halo (gfx1151) sono state osservate build di llama.cpp che
# davano output corrotto *silenziosamente* (token degradati, non crash).
# Ogni build va validata prima di essere promossa; la build nota-buona va
# sempre salvata come bin-backup-<git-sha>.
#
# Uso:
#   validate-llamacpp-build.sh --model /path/model.gguf [--bin /path/build/bin]
#                              [--llama-cpp ~/llama.cpp] [--prompt-file f]
#
# Exit code: 0 = build valida, 1 = validazione fallita, 2 = errore di setup.

set -euo pipefail

BIN=""
MODEL=""
LLAMA_CPP="$HOME/llama.cpp"
PROMPT_FILE=""
GOLDEN_DIR="$HOME/.evo-x2-lab/golden"
PROMPT_DEFAULT="Explain in exactly three sentences why input validation matters in a login form."

usage() {
    grep '^#' "$0" | sed 's/^# \{0,1\}//' | head -20
    exit 2
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --bin)        BIN="$2"; shift 2 ;;
        --model)      MODEL="$2"; shift 2 ;;
        --llama-cpp)  LLAMA_CPP="$2"; shift 2 ;;
        --prompt-file) PROMPT_FILE="$2"; shift 2 ;;
        -h|--help)    usage ;;
        *) echo "argomento sconosciuto: $1" >&2; usage ;;
    esac
done

[[ -n "$MODEL" && -f "$MODEL" ]] || { echo "ERRORE: --model mancante o inesistente" >&2; exit 2; }
if [[ -z "$BIN" ]]; then
    BIN="$LLAMA_CPP/build/bin"
fi
[[ -x "$BIN/llama-cli" ]] || { echo "ERRORE: llama-cli non trovato in $BIN" >&2; exit 2; }
[[ -x "$BIN/llama-bench" ]] || echo "ATTENZIONE: llama-bench assente (benchmark.sh ne ha bisogno)" >&2

# --- 1. Backup della build corrente ------------------------------------------
SHA="unknown"
if git -C "$LLAMA_CPP" rev-parse --short HEAD >/dev/null 2>&1; then
    SHA="$(git -C "$LLAMA_CPP" rev-parse --short HEAD)"
fi
BACKUP="$LLAMA_CPP/build/bin-backup-$SHA"
if [[ ! -d "$BACKUP" && "$(realpath "$BIN")" == "$(realpath "$LLAMA_CPP/build/bin")" ]]; then
    cp -r "$BIN" "$BACKUP"
    echo "[ok] build salvata in $BACKUP"
else
    echo "[skip] backup già presente o build esterna: $BACKUP"
fi

# --- 2. Generazione deterministica -------------------------------------------
PROMPT="$PROMPT_DEFAULT"
if [[ -n "$PROMPT_FILE" ]]; then
    PROMPT="$(cat "$PROMPT_FILE")"
fi

mkdir -p "$GOLDEN_DIR"
MODEL_ID="$(basename "$MODEL" .gguf | tr -c 'A-Za-z0-9._-' '_')"
GOLDEN="$GOLDEN_DIR/$MODEL_ID.sha256"

OUT="$(mktemp /tmp/evo-validate-XXXXXX.txt)"
trap 'rm -f "$OUT"' EXIT

echo "[..] generazione deterministica con $MODEL_ID"
LD_LIBRARY_PATH="/opt/rocm-7.2.4/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
"$BIN/llama-cli" \
    -m "$MODEL" \
    --no-mmap -ngl 99 -fa 1 \
    --temp 0 --seed 42 \
    -n 128 \
    -p "$PROMPT" \
    > "$OUT" 2>/dev/null || { echo "ERRORE: llama-cli ha fallito" >&2; exit 1; }

# --- 3. Controlli di sanità ---------------------------------------------------
if [[ ! -s "$OUT" ]]; then
    echo "FALLITO: output vuoto" >&2; exit 1
fi

# UTF-8 valido (l'output corrotto spesso contiene byte invalidi)
if ! iconv -f UTF-8 -t UTF-8 "$OUT" >/dev/null 2>&1; then
    echo "FALLITO: output non UTF-8 valido (corruzione probabile)" >&2; exit 1
fi

# Ripetizione degenera: stesso token per >20 volte di fila
if awk '{
    for (i = 1; i <= NF; i++) {
        if ($i == prev) { run++ } else { run = 1; prev = $i }
        if (run > 20) { exit 1 }
    }
}' "$OUT"; then
    :
else
    echo "FALLITO: loop di token ripetuti (degenerazione del modello)" >&2; exit 1
fi

# --- 4. Confronto con la baseline --------------------------------------------
HASH="$(sha256sum "$OUT" | awk '{print $1}')"
if [[ -f "$GOLDEN" ]]; then
    EXPECTED="$(cat "$GOLDEN")"
    if [[ "$HASH" == "$EXPECTED" ]]; then
        echo "[ok] output identico alla baseline ($HASH)"
    else
        echo "FALLITO: output diverso dalla baseline" >&2
        echo "  baseline: $EXPECTED" >&2
        echo "  attuale : $HASH" >&2
        echo "  (se la modifica è INTENZIONATA, cancellare $GOLDEN per registrare la nuova baseline)" >&2
        exit 1
    fi
else
    echo "$HASH" > "$GOLDEN"
    echo "[ok] prima esecuzione: baseline registrata in $GOLDEN ($HASH)"
fi

echo "[ok] build $SHA valida per $MODEL_ID"
