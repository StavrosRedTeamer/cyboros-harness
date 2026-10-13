#!/usr/bin/env bash
# chat.sh — apre il REPL interattivo Cyboros Harness, assicurandosi che il modello locale
# sia su col server PULITO (serve.sh, NIENTE DRY: il REPL fa tool-calling e il DRY lo rompe).
# Uso:  bash ~/Desktop/cyboros-harness/local/chat.sh [host] [--phase ...] [--class ...] [--auto]
set -u
SERVE="$HOME/models/qwen36-35b-abl/serve.sh"
REPL="$HOME/Desktop/cyboros-harness/local/chat-local.js"

if ! curl -s http://127.0.0.1:8080/v1/models >/dev/null 2>&1; then
  echo "· Modello non attivo → avvio serve.sh (pulito, no DRY)…"
  setsid bash "$SERVE" >/tmp/srv-clean.log 2>&1 &
  printf "· Caricamento"
  for _ in $(seq 1 90); do
    curl -s http://127.0.0.1:8080/v1/models >/dev/null 2>&1 && break
    printf "."; sleep 2
  done
  echo " pronto."
else
  echo "· Modello già attivo su :8080."
  echo "  (se l'avevi avviato con serve-chat.sh/DRY, per il tool-calling conviene: pkill -x llama-server && bash $SERVE)"
fi

exec node "$REPL" "$@"
