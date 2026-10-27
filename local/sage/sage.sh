#!/usr/bin/env bash
# local/sage/sage.sh — il menu che apre l'icona "Cyboros Sage" sul desktop.
#
# Avvia il modello se non è attivo, poi offre: nuova ricerca, riprendi, chat, check, report.
# Il run è un JOB STACCATO (setsid): chiudere il monitor o il terminale non lo uccide, e
# dopo un'interruzione si riprende dal primo URL non completato.
#
#   bash local/sage/sage.sh                 # menu
#   bash local/sage/sage.sh run --brief "…" # passthrough al CLI (nessun menu)
#   SAGE_MODEL_ID=qwen bash local/sage/sage.sh   # usa il server Qwen già attivo (8080)
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WS="$(cd "$SCRIPT_DIR/../.." && pwd)"
MODEL="${SAGE_MODEL_ID:-sage}"
PORT=8092
[[ "$MODEL" == "qwen" ]] && PORT=8080
SRVLOG="/tmp/sage-serve.log"

say()  { printf '\033[1;32m[sage]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[sage]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[sage]\033[0m %s\n' "$*" >&2; exit 1; }

up() { curl -sf --max-time 2 "http://127.0.0.1:${PORT}/v1/models" 2>/dev/null | grep -q '"data"'; }

ensure_server() {
  if up; then say "modello pronto su :${PORT}"; return 0; fi
  if [[ "$MODEL" == "qwen" ]]; then
    warn "nessun server su :8080. Avvia il modello del pentest: bash ~/models/qwen36-35b-abl/serve.sh"
    return 1
  fi
  say "avvio Sage-A1.5 su :${PORT} (caricamento 1-3 minuti)"
  setsid bash "$SCRIPT_DIR/serve.sh" >"$SRVLOG" 2>&1 < /dev/null &
  for _ in $(seq 1 120); do
    if up; then say "pronto"; return 0; fi
    # Un OOM o un'architettura non supportata non si "risolvono" aspettando: fermarsi qui
    # evita 4 minuti di puntini davanti a un processo già morto.
    if grep -qiE 'cudaMalloc failed|failed to load model|out of memory|unknown model architecture|address already in use' "$SRVLOG" 2>/dev/null; then
      echo
      warn "avvio fallito (non aspetto il timeout). Ultime righe di $SRVLOG:"
      tail -n 20 "$SRVLOG" 2>/dev/null | sed 's/^/    /'
      warn "se è VRAM: SAGE_N_CPU_MOE=40 bash local/sage/serve.sh (più esperti su CPU)"
      return 1
    fi
    sleep 2; printf '.'
  done
  echo; warn "non è diventato pronto. Ultime righe di $SRVLOG:"
  tail -n 15 "$SRVLOG" 2>/dev/null | sed 's/^/    /'
  return 1
}

# Monitor di un job staccato: Ctrl-C stacca SOLO il tail.
monitor() {
  local log="$1"
  trap 'echo; say "monitor staccato — il job continua (status / resume per seguirlo)"; return 0' INT
  tail -n +1 -f "$log" || true
  trap - INT
}

launch_job() {
  local log="/tmp/sage-run-$(date +%Y%m%d-%H%M%S).log"
  setsid nohup node "$WS/tools/sage/index.js" "$@" >"$log" 2>&1 < /dev/null &
  echo "$!" > /tmp/sage-last-job.pid
  say "job avviato (pid $!) — log: $log"
  say "Ctrl-C stacca il monitor: il job continua."
  monitor "$log"
}

new_research() {
  ensure_server || return 1
  local lane brief ms bm
  read -r -p "Lane [offensive/capability] (offensive): " lane
  lane="${lane:-offensive}"
  [[ "$lane" == "capability" || "$lane" == "offensive" ]] || { warn "lane non valida: $lane"; return 1; }
  read -r -p "Cosa vuoi indagare (brief): " brief
  [[ -n "${brief:-}" ]] || { warn "brief obbligatorio"; return 1; }
  read -r -p "Fonti massime (12): " ms
  read -r -p "Budget in minuti (90): " bm
  local args=(run --brief "$brief" --lane "$lane" --open)
  [[ -n "${ms:-}" ]] && args+=(--max-sources "$ms")
  [[ -n "${bm:-}" ]] && args+=(--budget-min "$bm")
  [[ "$MODEL" == "qwen" ]] && args+=(--model qwen)
  launch_job "${args[@]}"
}

resume_run() {
  ensure_server || return 1
  node "$WS/tools/sage/index.js" status
  local id
  read -r -p "run da riprendere (invio = l'ultimo): " id
  local args=(resume --open)
  [[ -n "${id:-}" ]] && args+=("$id")
  [[ "$MODEL" == "qwen" ]] && args+=(--model qwen)
  launch_job "${args[@]}"
}

chat_run() {
  ensure_server || return 1
  node "$WS/tools/sage/index.js" chat
}

check_stack() {
  echo
  if [[ "$MODEL" == "sage" ]]; then
    bash "$SCRIPT_DIR/serve.sh" --check || warn "serve.sh --check fallito"
  fi
  node "$WS/tools/sage/index.js" check --model "$MODEL"
  echo
  node "$WS/tools/sage/index.js" status
}

open_last_report() {
  local rel
  rel="$(node -e '
    const fs = require("fs");
    const f = "reports/sage/index.jsonl";
    try {
      const lines = fs.readFileSync(f, "utf8").trim().split("\n");
      const last = JSON.parse(lines[lines.length - 1]);
      if (last && last.report) process.stdout.write(last.report);
    } catch {}
  ' 2>/dev/null)"
  [[ -n "$rel" ]] || { warn "nessun report in reports/sage/index.jsonl"; return 1; }
  local abs="$WS/$rel"
  [[ -f "$abs" ]] || { warn "report non trovato: $rel"; return 1; }
  say "apro $rel"
  if command -v xdg-open >/dev/null 2>&1; then xdg-open "$abs" >/dev/null 2>&1 &
  elif command -v gio >/dev/null 2>&1; then gio open "$abs" >/dev/null 2>&1 &
  else warn "nessun opener grafico: $abs"; fi
}

# --- passthrough: se ci sono argomenti non aprire il menu ----------------------
if [[ $# -gt 0 ]]; then
  exec node "$WS/tools/sage/index.js" "$@"
fi

while true; do
  echo
  echo "  Cyboros Sage — deep research locale (${MODEL}, :${PORT})"
  echo "  ────────────────────────────────────────────────────────"
  echo "  1) nuova ricerca"
  echo "  2) riprendi un run"
  echo "  3) chat sui risultati"
  echo "  4) stato + check dello stack"
  echo "  5) apri l'ultimo report"
  echo "  0) esci"
  echo
  read -r -p "  scelta: " choice || exit 0
  case "$choice" in
    1) new_research ;;
    2) resume_run ;;
    3) chat_run ;;
    4) check_stack ;;
    5) open_last_report ;;
    0|q|"") exit 0 ;;
    *) warn "scelta non valida" ;;
  esac
done
