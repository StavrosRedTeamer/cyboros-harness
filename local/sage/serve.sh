#!/usr/bin/env bash
# local/sage/serve.sh — llama.cpp per Sage-A1.5 (GGUF Q4_K_M) su 127.0.0.1:8092.
#
# Perché una porta dedicata: il modello del pentest (Qwen3.6-35B abliterato) vive su 8080 e
# resta il default dell'harness. Sage serve alla ricerca. Su una RTX 4050 da 6 GB i due non
# convivono: questo script si rifiuta di partire se 8080 è occupato, a meno di --takeover
# esplicito (che ferma l'altro server per PID, non per pattern).
#
#   bash local/sage/serve.sh              # foreground (ctrl-c ferma il server)
#   bash local/sage/serve.sh --check      # carica, verifica /v1/models, esce (0 = pronto)
#   bash local/sage/serve.sh --takeover   # libera la GPU fermando l'altro llama-server
#   bash local/sage/serve.sh --stop       # ferma il server su SAGE_PORT, se c'è
#
# Tunable: SAGE_MODEL=<path.gguf>  SAGE_CTX=32768  SAGE_PORT=8092  SAGE_N_CPU_MOE=32
#          LLAMA_SERVER=<binario>  LLAMA_ALLOW_CPU=1
#
# NOTA sul tuning: --n-cpu-moe decide quanti esperti restano in RAM. Troppo basso = OOM di
# VRAM; troppo alto = lento. MISURATO su Sage-A1.5 Q4_K_M a 32k: 32 esperti → OOM su
# cudaMalloc (492 MiB di compute buffer), 36 → carica con 4,3 GB di VRAM, 40 → 2,3 GB.
# Il default è 36; se cambi modello o contesto, riparti da qui.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WS="$(cd "$SCRIPT_DIR/../.." && pwd)"

PORT="${SAGE_PORT:-8092}"
CTX="${SAGE_CTX:-32768}"
N_CPU_MOE="${SAGE_N_CPU_MOE:-36}"
MODEL_DIR="${SAGE_MODEL_DIR:-$HOME/models/sage-a15}"
BIN="${LLAMA_SERVER:-$HOME/llama.cpp/build/bin/llama-server}"
LOG="${SAGE_LOG:-/tmp/sage-serve.log}"

MODE="serve"
TAKEOVER=0
for a in "$@"; do
  case "$a" in
    --check) MODE="check" ;;
    --takeover) TAKEOVER=1 ;;
    --stop) MODE="stop" ;;
    -h|--help) sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "flag sconosciuto: $a" >&2; exit 2 ;;
  esac
done

say()  { printf '\033[1;32m[sage]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[sage]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[sage]\033[0m %s\n' "$*" >&2; exit 1; }

# Readiness vera: 200 + campo `data`. Un servizio che risponde 404 su /v1/models non è
# un llama-server, e trattarlo come "pronto" fa partire la ricerca contro il nulla.
up() { curl -sf --max-time 3 "http://127.0.0.1:${PORT}/v1/models" 2>/dev/null | grep -q '"data"'; }

# PID che ascolta su una porta, senza pkill: un pattern può colpire processi che non
# c'entrano (compresa la shell che lancia il comando).
pid_on_port() {
  local port="$1" pid=""
  if command -v ss >/dev/null 2>&1; then
    pid="$(ss -ltnpH "sport = :${port}" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)"
  fi
  if [[ -z "$pid" ]] && command -v fuser >/dev/null 2>&1; then
    pid="$(fuser -n tcp "$port" 2>/dev/null | tr -s ' ' '\n' | grep -E '^[0-9]+$' | head -1)"
  fi
  printf '%s' "$pid"
}

if [[ "$MODE" == "stop" ]]; then
  pid="$(pid_on_port "$PORT")"
  if [[ -z "$pid" ]]; then say "nessun server su :${PORT}"; exit 0; fi
  kill "$pid" 2>/dev/null || die "kill $pid fallito"
  for _ in $(seq 1 30); do up || { say "fermato (pid $pid)"; exit 0; }; sleep 1; done
  kill -9 "$pid" 2>/dev/null; say "fermato con SIGKILL (pid $pid)"; exit 0
fi

# --- 0. già attivo? -----------------------------------------------------------
if up; then
  IDS="$(curl -s --max-time 3 "http://127.0.0.1:${PORT}/v1/models" | grep -o '"id":"[^"]*"' | cut -d'"' -f4 | tr '\n' ' ')"
  say "server già attivo su :${PORT} — ${IDS:-?}"
  exit 0
fi

# --- 0b. porta occupata da qualcos'altro --------------------------------------
BUSY="$(pid_on_port "$PORT")"
if [[ -n "$BUSY" ]]; then
  die "la porta ${PORT} è occupata dal processo $BUSY, che non è un llama-server.
  Scegli un'altra porta:  SAGE_PORT=8093 bash local/sage/serve.sh"
fi

# --- 1. binario ---------------------------------------------------------------
[[ -x "$BIN" ]] || die "llama-server non trovato in $BIN
  Compila llama.cpp (>= commit con supporto qwen35moe):
    cd ~/llama.cpp && git pull
    cmake -B build -DGGML_CUDA=ON && cmake --build build -j\$(nproc)
  Oppure indica il binario: LLAMA_SERVER=/percorso/llama-server bash local/sage/serve.sh"

# --- 2. modello ---------------------------------------------------------------
MODEL="${SAGE_MODEL:-}"
if [[ -z "$MODEL" ]]; then
  # Shard multipli: si carica il PRIMO (-00001-of-...), non il più grande a caso.
  MODEL="$(ls "$MODEL_DIR"/*00001-of-*.gguf 2>/dev/null | head -1)"
  [[ -z "$MODEL" ]] && MODEL="$(ls -S "$MODEL_DIR"/*.gguf 2>/dev/null | grep -viE 'mmproj|vision' | head -1)"
fi
[[ -n "$MODEL" && -f "$MODEL" ]] || die "modello GGUF non trovato in $MODEL_DIR
  Scaricalo: bash local/sage/download.sh"
say "modello: $MODEL"

# --- 3. CUDA: llama.cpp ripiega in SILENZIO sulla CPU se CUDA non si inizializza ---
if ! "$BIN" --list-devices 2>/dev/null | grep -qE '^ +CUDA[0-9]+:'; then
  if [[ "${LLAMA_ALLOW_CPU:-0}" == "1" ]]; then
    warn "CUDA non disponibile: vado in solo-CPU (forzato da LLAMA_ALLOW_CPU=1). Attesa: pochi tok/s."
  else
    die "CUDA non disponibile: partirebbe in solo-CPU (~10x più lento) senza dirlo.
  Ripristino:  sudo modprobe -r nvidia_uvm && sudo modprobe nvidia_uvm   (o riavvio a freddo)
  Diagnosi:    $BIN --list-devices
  Forzare:     LLAMA_ALLOW_CPU=1 bash local/sage/serve.sh"
  fi
fi

# --- 4. GPU contesa: un solo modello alla volta su 6 GB ------------------------
OTHER="$(pid_on_port 8080)"
if [[ -n "$OTHER" ]]; then
  if [[ "$TAKEOVER" == "1" ]]; then
    warn "fermo il server su :8080 (pid $OTHER) per liberare la VRAM"
    kill "$OTHER" 2>/dev/null
    for _ in $(seq 1 20); do curl -s --max-time 1 http://127.0.0.1:8080/v1/models >/dev/null 2>&1 || break; sleep 1; done
  else
    die "la porta 8080 è occupata (probabile Qwen del pentest, pid $OTHER).
  Su 6 GB di VRAM i due modelli non convivono: ferma quello, oppure:
    bash local/sage/serve.sh --takeover"
  fi
fi

# --- 5. avvio -----------------------------------------------------------------
ARGS=(
  -m "$MODEL"
  -c "$CTX"
  -ngl 99 --n-cpu-moe "$N_CPU_MOE"
  -fa on -ctk q8_0 -ctv q8_0
  -t 6 -b 2048 -ub 512
  --parallel 1 --jinja
  --temp 0.3 --top-p 0.9 --top-k 20 --min-p 0.0
  --presence-penalty 0.1 --frequency-penalty 0.0
  --host 127.0.0.1 --port "$PORT"
)

arch_hint() {
  if grep -qiE 'unknown model architecture|unsupported (model|architecture)|qwen35moe' "$LOG" 2>/dev/null; then
    warn "il build di llama.cpp non conosce questa architettura (qwen35moe)."
    warn "Aggiorna e ricompila:"
    warn "  cd ~/llama.cpp && git pull && cmake -B build -DGGML_CUDA=ON && cmake --build build -j\$(nproc)"
  fi
}

if [[ "$MODE" == "check" ]]; then
  say "check: carico con contesto ${CTX} (può richiedere 1-3 minuti)..."
  taskset -c 0-7 "$BIN" "${ARGS[@]}" >"$LOG" 2>&1 &
  PID=$!
  ok=0
  for i in $(seq 1 120); do
    if up; then ok=1; break; fi
    if ! kill -0 "$PID" 2>/dev/null; then break; fi
    if (( i % 10 == 0 )); then printf '.'; fi
    sleep 2
  done
  echo
  if [[ "$ok" == "1" ]]; then
    IDS="$(curl -s "http://127.0.0.1:${PORT}/v1/models" | grep -o '"id":"[^"]*"' | cut -d'"' -f4 | tr '\n' ' ')"
    say "pronto: ${IDS:-?} · VRAM $(nvidia-smi --query-gpu=memory.used --format=csv,noheader 2>/dev/null || echo 'n/d')"
    say "RAM libera: $(free -g | awk '/^Mem:/{print $7" GB"}')"
    kill "$PID" 2>/dev/null
    exit 0
  fi
  kill "$PID" 2>/dev/null
  warn "non è diventato pronto. Ultime righe del log:"
  tail -n 15 "$LOG" 2>/dev/null | sed 's/^/    /'
  arch_hint
  exit 1
fi

say "avvio su http://127.0.0.1:${PORT} (ctx ${CTX}, n-cpu-moe ${N_CPU_MOE}) — log: $LOG"
exec taskset -c 0-7 "$BIN" "${ARGS[@]}"
