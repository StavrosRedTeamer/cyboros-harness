# bench.env.sh — ambiente per una run del benchmark (gen-bench) con un agente esterno.
#
#   source bench.env.sh                                  # seed/porta di default
#   BENCH_SEED=20261003 BENCH_PORT=3002 source bench.env.sh
#
# Perché un file invece di una riga da ricordare: i due env che rendono possibile la run sono
# invisibili. Senza SCOPE_JSON il guard legge l'engagement scope (finestra scaduta → nega
# tutto); senza ALLOW_METADATA_TARGET il B9 di repeater.js nega il loopback (tier HARD) e
# l'agente fa zero finding senza che nulla sembri rotto — il modo più pulito di falsare una
# misura senza toccare niente.
#
# Genera ANCHE lo scope, pinnato alla porta di questa run. Editare a mano quel file a ogni
# seed era il passaggio più facile da sbagliare in assoluto, e un pin sbagliato non fallisce:
# nega semplicemente tutto, e il risultato si legge come "l'harness non ha trovato niente".

# ── il run corrente ────────────────────────────────────────────────────────────
export BENCH_SEED="${BENCH_SEED:-20261002}"
export BENCH_PORT="${BENCH_PORT:-3001}"
BENCH_HOME="$(ls -dt "$HOME"/bench/bench-$BENCH_SEED-* 2>/dev/null | head -1)"
if [[ -z "$BENCH_HOME" || ! -f "$BENCH_HOME/manifest.full.json" ]]; then
  echo "bench.env: nessun bench per seed $BENCH_SEED in ~/bench — prima: node tools/gen-bench.js new --classes all --seed $BENCH_SEED --port $BENCH_PORT" >&2
  return 1 2>/dev/null || exit 1
fi
export BENCH_DIR="$BENCH_HOME"
export BENCH_AGENT="${BENCH_AGENT:-freebuff}"
export BENCH_MODEL="${BENCH_MODEL:-deepseek/deepseek-v4.1-flash}"

# ── scope di questa run: loopback, porta del bench, e nient'altro ───────────────
# allowed_hosts e allowed_ips VUOTI di proposito: il permesso passa solo per prefisso URL,
# quindi 127.0.0.1 è autorizzato esclusivamente sulla porta del bench e nessun altro servizio
# locale è raggiungibile. `localhost` è negato per lo stesso motivo: usa sempre il literal.
cat > "$PWD/scope.bench.json" <<EOF
{
  "_comment": "SCOPE DEL BENCHMARK seed $BENCH_SEED — generato da bench.env.sh, gitignored. Loopback-only, pin per prefisso sulla porta $BENCH_PORT: allowed_hosts e allowed_ips sono vuoti, quindi 127.0.0.1 vale solo qui. 20 rps invece dei 2 di default perché la classe 'race' vuole 5 POST in parallelo dentro una finestra di 40ms; --no-pace esiste per il burst esplicito. ALLOW_METADATA_TARGET=1 serve perché il B9 di repeater.js nega il loopback di default: senza, l'agente fa zero finding e il risultato si legge come recall 0% invece che come setup sbagliato. La ground truth in ~/bench/$BENCH_SEED-*/manifest.full.json NON va letta: app.js espone il route registry di proposito, il manifest è la risposta.",
  "allowed_hosts": [],
  "allowed_ips": [],
  "allowed_url_prefixes": [
    "http://127.0.0.1:$BENCH_PORT"
  ],
  "max_requests_per_second": 20
}
EOF

# ── guard e opt-in ──────────────────────────────────────────────────────────────
export SCOPE_JSON="$PWD/scope.bench.json"
export ALLOW_METADATA_TARGET=1

# ── finding della run, con catena e ancora ─────────────────────────────────────
# Un file per seed: l'attribuzione di gen-bench è per PORTA, e due run sulla stessa porta si
# mixerebbero nella stessa riga di history.
export FINDINGS_JSONL="$PWD/reports/bench-findings-$BENCH_SEED.jsonl"
export FINDINGS_HEAD_ANCHOR_FILE="$PWD/reports/bench-findings-$BENCH_SEED-anchor.jsonl"

# ── fatti di verifica e oracoli, isolati dai log d'engagement ───────────────────
export VERIFICATIONS_JSONL="$PWD/reports/bench-verifications-$BENCH_SEED.jsonl"
export VERIFICATIONS_HEAD_ANCHOR_FILE="$PWD/reports/bench-verifications-$BENCH_SEED-anchor.jsonl"
export ORACLE_LOG="$PWD/reports/bench-tmp-$BENCH_SEED/oracle-log.jsonl"
export ORACLE_ARTIFACTS="$PWD/artifacts/bench-oracle-$BENCH_SEED"
mkdir -p "$PWD/reports/bench-tmp-$BENCH_SEED" "$ORACLE_ARTIFACTS"
export BENCH_FINDINGS_EFFECTIVE="$PWD/reports/bench-effective-$BENCH_SEED.json"

cat <<EOF
bench env pronto — target http://127.0.0.1:$BENCH_PORT · seed $BENCH_SEED
  dir       : $BENCH_DIR
  scope     : $SCOPE_JSON (pin: http://127.0.0.1:$BENCH_PORT)
  findings  : $FINDINGS_JSONL
  effettivi : $BENCH_FINDINGS_EFFECTIVE
  NON leggere $BENCH_DIR/manifest.full.json — è la risposta, non il bersaglio.

Prima di partire, questo DEVE dire ok:true:
  node tools/scope-guard.js check http://127.0.0.1:$BENCH_PORT/

Ultimo passo, a sessione finita:
  node tools/verify-finding.js batch --file "\$FINDINGS_JSONL"
  node tools/effective-findings.js list --out "\$BENCH_FINDINGS_EFFECTIVE"
  node tools/gen-bench.js eval "\$BENCH_DIR" --findings "\$BENCH_FINDINGS_EFFECTIVE" \\
    --agent "\$BENCH_AGENT" --model "\$BENCH_MODEL" --fail-on-contamination --note "<nota>"
EOF