#!/usr/bin/env bash
# local/agent-local.sh — LAUNCHER UNICO dell'agente LOCALE: modello abliterato + harness.
#
# Cosa fa, in ordine:
#   1. controlla se llama-server è già attivo su 127.0.0.1:8080; se NON lo è, avvia
#      ~/models/qwen36-35b-abl/serve.sh e ASPETTA il caricamento (30-60s) mostrando l'avanzamento;
#   2. se il server attivo è quello "CHAT" (serve-chat.sh, DRY attivo) avvisa e propone il
#      riavvio pulito: il DRY tronca gli argomenti ripetuti dei tool (192.168 -> 192.16);
#   3. apre l'harness:
#        (nessun argomento)  -> menu: REPL interattivo | recon->opzioni | stato | esci
#        [host]              -> REPL interattivo (local/chat-local.js) su quell'host
#        --plan [host]       -> recon autonomo -> opzioni -> STOP in attesa tua
#        --check             -> smoke test dell'harness (endpoint + tools + GBNF)
#
# Uso:
#   bash ~/Desktop/cyboros-harness/local/agent-local.sh
#   bash ~/Desktop/cyboros-harness/local/agent-local.sh --plan target.example
#
# Zero dipendenze: curl, node (già richiesto dall'harness) e serve.sh del modello.

set -u

WS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVE="$HOME/models/qwen36-35b-abl/serve.sh"
ENDPOINT="http://127.0.0.1:8080"
SRVLOG="/tmp/llama-server-local-agent.log"

MODEL_NAME="Qwen3.6-35B-A3B-abliterated Q4_K_M"

# ---------------------------------------------------------------- helper
up() { curl -s --max-time 3 "$ENDPOINT/v1/models" >/dev/null 2>&1; }

# Legge un valore da /props (JSON) senza dipendenze: node è già un requisito dell'harness.
prop() {
  curl -s --max-time 5 "$ENDPOINT/props" | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        const p = JSON.parse(s);
        const path = process.argv[1].split(".");
        let v = p; for (const k of path) v = v == null ? undefined : v[k];
        process.stdout.write(v == null ? "" : String(v));
      } catch { process.stdout.write(""); }
    });' "$1" 2>/dev/null
}

wait_model() {
  printf '     caricamento del modello (VRAM ~5,5 GB, 30-60s)'
  local i
  for i in $(seq 1 150); do
    if up; then echo " → pronto."; return 0; fi
    printf '.'; sleep 2
  done
  echo
  echo "  ✗ il modello non risponde su $ENDPOINT dopo 5 minuti."
  echo "    Log del server: $SRVLOG"
  echo "    Ultime righe:"
  tail -n 12 "$SRVLOG" 2>/dev/null | sed 's/^/      /'
  return 1
}

start_serve() {
  if [ ! -f "$SERVE" ]; then
    echo "  ✗ manca $SERVE — non posso avviare il modello."
    return 1
  fi
  echo "  · modello non attivo → avvio $(basename "$SERVE") (server PULITO, no DRY)"
  setsid bash "$SERVE" >"$SRVLOG" 2>&1 &
  wait_model
}

# Il server CHAT (DRY) è ottimo per conversare ma tronca gli argomenti dei tool.
check_dry() {
  local dm
  dm="$(prop default_generation_settings.params.dry_multiplier)"
  case "$dm" in ""|"0"|"0.0") return 0 ;; esac
  echo
  echo "  ⚠ il server attivo ha il DRY attivo (dry_multiplier=$dm): è la variante CHAT."
  echo "    Con il DRY gli argomenti dei tool possono troncarsi (es. 192.168 -> 192.16)."
  local a
  read -r -p "    Riavvio con il server pulito (serve.sh)? (y/N) " a
  case "$a" in
    y|Y|si|sì|s)
      pkill -x llama-server 2>/dev/null && sleep 3
      start_serve
      ;;
    *) echo "    ok: continuo con il DRY attivo (tool-calling a tuo rischio)." ;;
  esac
}

ensure_model() {
  if up; then
    echo "  ✓ modello già attivo su $ENDPOINT — non lo riavvio."
    check_dry
    return 0
  fi
  start_serve
  [ ! -f "$SRVLOG" ] || echo "  (log del server: $SRVLOG)"
}

status() {
  echo
  local temp top_p
  temp="$(prop default_generation_settings.params.temperature)"
  top_p="$(prop default_generation_settings.params.top_p)"
  echo "  endpoint ....... $ENDPOINT"
  echo "  modello ........ $(prop model_path)"
  echo "  ftype .......... $(prop model_ftype)"
  echo "  contesto ....... $(prop default_generation_settings.n_ctx) token"
  # LC_ALL=C: il locale IT usa la virgola decimale e bash printf rifiuterebbe "0.60".
  echo "  sampler ........ temp $(LC_ALL=C printf '%.2f' "${temp:-0}") · top_p $(LC_ALL=C printf '%.2f' "${top_p:-0}") · top_k $(prop default_generation_settings.params.top_k) · dry $(prop default_generation_settings.params.dry_multiplier)"
  if command -v nvidia-smi >/dev/null 2>&1; then
    echo "  GPU ............ $(nvidia-smi --query-gpu=memory.used,memory.total,temperature.gpu --format=csv,noheader 2>/dev/null)"
  fi
  printf '  velocità ....... '
  curl -s --max-time 120 "$ENDPOINT/v1/chat/completions" -H 'Content-Type: application/json' \
    -d '{"messages":[{"role":"user","content":"Conta da 1 a 20 separati da virgola."}],"max_tokens":60,"temperature":0.2,"chat_template_kwargs":{"enable_thinking":false}}' \
  | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        const t = JSON.parse(s).timings || {};
        process.stdout.write(`${(t.predicted_per_second || 0).toFixed(1)} tok/s generazione · ${(t.prompt_per_second || 0).toFixed(0)} tok/s prefill\n`);
      } catch { process.stdout.write("non misurabile\n"); }
    });' 2>/dev/null
  echo
}

# ---------------------------------------------------------------- harness
run_repl() { cd "$WS" || exit 1; exec node local/chat-local.js "$@"; }
run_plan() { cd "$WS" || exit 1; exec node local/run-local.js "$1" --plan; }
run_check() { cd "$WS" || exit 1; exec node local/run-local.js --check; }

menu() {
  while :; do
    echo
    echo "  Cosa vuoi fare?"
    echo "    1) Agente interattivo (REPL) — chatti e lui chiama i tool guardati"
    echo "    2) Recon → opzioni → mi fermo in attesa della tua scelta  (--plan)"
    echo "    3) Stato del modello (VRAM / sampler / tok-s)"
    echo "    4) Smoke test dell'harness (endpoint + tools + GBNF)"
    echo "    q) Esci"
    echo
    # EOF (stdin chiuso) = esci: senza questo, un read fallito farebbe girare il menu a vuoto.
    if ! read -r -p "  Scelta > " c; then echo; echo "  stdin chiuso: esco."; exit 0; fi
    case "$c" in
      q|Q|"") echo "  ciao."; exit 0 ;;
      1) run_repl ;;
      2)
        read -r -p "  Host in scope > " h
        if [ -n "$h" ]; then run_plan "$h"; else echo "  nessun host: annullo."; fi
        ;;
      3) status ;;
      4) run_check ;;
      *) echo "  scelta non valida." ;;
    esac
  done
}

# ---------------------------------------------------------------- main
echo
echo "  ╭───────────────────────────────────────────────────────────╮"
echo "  │   S T A V R O S   R E D T E A M E R  ·  local edition     │"
echo "  ╰───────────────────────────────────────────────────────────╯"
echo "   modello  $MODEL_NAME"
echo "   harness  $WS/local"
echo

case "${1:-}" in
  --plan)
    shift
    host="${1:-}"
    if [ -z "$host" ]; then read -r -p "  Host in scope > " host; fi
    if [ -z "$host" ]; then echo "  nessun host: esco."; exit 2; fi
    ensure_model && run_plan "$host"
    ;;
  --check) ensure_model && run_check ;;
  --status) ensure_model && status ;;
  ""|--menu) ensure_model && menu ;;
  *) ensure_model && run_repl "$1" ;;
esac
