#!/usr/bin/env bash
# evo-x2-lab — benchmark per-modello
#
# Misura: prompt processing (t/s), generazione (t/s), concorrenza (richieste
# parallele) e fan-out best-of-k. Produce un report markdown in reports/.
#
# Uso:
#   benchmark.sh --model /path/model.gguf --label coder [--bin /path/build/bin]
#                [--port 8101] [--parallel 3] [--skip-concurrency]
#
# Requisiti: llama-bench, curl, jq (opzionale per il parse dei usage).

set -euo pipefail

MODEL=""
LABEL=""
BIN="$HOME/llama.cpp/build/bin"
PORT=8199
PARALLEL=3
SKIP_CONCURRENCY=0
OUT_DIR="$(dirname "$0")/../reports"
TS="$(date +%Y%m%d-%H%M%S)"

usage() {
    grep '^#' "$0" | sed 's/^# \{0,1\}//' | head -14
    exit 2
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --model)   MODEL="$2"; shift 2 ;;
        --label)   LABEL="$2"; shift 2 ;;
        --bin)     BIN="$2"; shift 2 ;;
        --port)    PORT="$2"; shift 2 ;;
        --parallel) PARALLEL="$2"; shift 2 ;;
        --skip-concurrency) SKIP_CONCURRENCY=1; shift ;;
        -h|--help) usage ;;
        *) echo "argomento sconosciuto: $1" >&2; usage ;;
    esac
done

[[ -n "$MODEL" && -f "$MODEL" ]] || { echo "ERRORE: --model mancante" >&2; exit 2; }
[[ -n "$LABEL" ]] || { echo "ERRORE: --label mancante" >&2; exit 2; }
[[ -x "$BIN/llama-bench" ]] || { echo "ERRORE: llama-bench non trovato in $BIN" >&2; exit 2; }

mkdir -p "$OUT_DIR"
REPORT="$OUT_DIR/bench-$LABEL-$TS.md"
CSV="$OUT_DIR/bench-summary.csv"

export LD_LIBRARY_PATH="/opt/rocm-7.2.4/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

echo "# Benchmark — $LABEL ($TS)" > "$REPORT"
echo "" >> "$REPORT"
echo "- modello: \`$MODEL\`" >> "$REPORT"
echo "- build: \`$BIN\` ($(git -C "$(dirname "$BIN")/.." rev-parse --short HEAD 2>/dev/null || echo 'n/d'))" >> "$REPORT"
echo "- data: $(date -Is)" >> "$REPORT"
echo "" >> "$REPORT"

# --- 1. llama-bench: prompt processing + generazione -------------------------
echo "## Throughput (llama-bench)" >> "$REPORT"
echo '```' >> "$REPORT"
"$BIN/llama-bench" \
    -m "$MODEL" \
    -ngl 99 -fa 1 --no-mmap \
    -p 512 -n 128 \
    -r 3 \
    | tee -a "$REPORT"
echo '```' >> "$REPORT"
echo "" >> "$REPORT"

# --- 2. Concorrenza: N richieste parallele su llama-server -------------------
if [[ "$SKIP_CONCURRENCY" -eq 0 ]]; then
    echo "## Concorrenza ($PARALLEL richieste parallele)" >> "$REPORT"

    SERVER="$BIN/llama-server"
    if [[ ! -x "$SERVER" ]]; then
        echo "llama-server assente: test di concorrenza saltato." >> "$REPORT"
    else
        "$SERVER" -m "$MODEL" --host 127.0.0.1 --port "$PORT" \
            -ngl 99 -fa 1 --no-mmap --parallel "$PARALLEL" \
            >/tmp/evo-bench-server.log 2>&1 &
        SERVER_PID=$!
        trap 'kill $SERVER_PID 2>/dev/null || true' EXIT

        # attesa readiness
        for _ in $(seq 1 60); do
            curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
            sleep 1
        done

        T0=$(date +%s.%N)
        PIDS=()
        for i in $(seq 1 "$PARALLEL"); do
            curl -s "http://127.0.0.1:$PORT/v1/chat/completions" \
                -H 'Content-Type: application/json' \
                -d "{\"model\":\"bench\",\"messages\":[{\"role\":\"user\",\"content\":\"Write a short technical note ($i) on network reconnaissance.\"}],\"max_tokens\":128}" \
                > "/tmp/evo-bench-resp-$i.json" &
            PIDS+=($!)
        done
        for p in "${PIDS[@]}"; do wait "$p"; done
        T1=$(date +%s.%N)

        TOTAL_TOKENS=0
        for i in $(seq 1 "$PARALLEL"); do
            if command -v jq >/dev/null 2>&1; then
                T="$(jq -r '.usage.completion_tokens // 0' "/tmp/evo-bench-resp-$i.json" 2>/dev/null || echo 0)"
                TOTAL_TOKENS=$((TOTAL_TOKENS + T))
            fi
        done
        WALL="$(awk "BEGIN {printf \"%.2f\", $T1 - $T0}")"

        {
            echo "- richieste: $PARALLEL, wall time: ${WALL}s"
            if [[ "$TOTAL_TOKENS" -gt 0 ]]; then
                echo "- token totali generati: $TOTAL_TOKENS (~$(awk "BEGIN {printf \"%.1f\", $TOTAL_TOKENS / $WALL}") t/s aggregati)"
            else
                echo "- token totali: n/d (installare jq per i usage)"
            fi
        } >> "$REPORT"

        kill "$SERVER_PID" 2>/dev/null || true
    fi
    echo "" >> "$REPORT"
fi

# --- 3. Riga CSV di sintesi --------------------------------------------------
PP="$(grep -oE '[0-9.]+ *t/s' "$REPORT" | head -1 | awk '{print $1}' || echo "")"
TG="$(grep -oE '[0-9.]+ *t/s' "$REPORT" | sed -n '2p' | awk '{print $1}' || echo "")"
[[ -f "$CSV" ]] || echo "timestamp,label,model,pp_tps,tg_tps,parallel" > "$CSV"
echo "$TS,$LABEL,$MODEL,$PP,$TG,$PARALLEL" >> "$CSV"

echo "Report: $REPORT"
echo "Summary CSV: $CSV"
