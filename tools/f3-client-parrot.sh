#!/usr/bin/env bash
# f3-client-parrot.sh — prepara il PC (Parrot) a ricevere il client dal Poco F3.
#
# Cosa serve al telefono per lavorare:
#   1. sshd attivo e raggiungibile SOLO via Tailscale (backend SSH di hermes-f3 + rsync + tunnel llama)
#   2. la chiave pubblica del telefono in authorized_keys
#   3. llama-server in ascolto su 127.0.0.1:8080 (il tunnel ssh del telefono lo inoltra)
#   4. adb locale non esposto (il telefono fa adb da sé quando è scollegato)
#
# Uso (sul PC):  bash tools/f3-client-parrot.sh [--pc-user <utente>]
# Idempotente.
set -euo pipefail

PC_USER="${SUDO_USER:-${USER:-}}"
[ "${1:-}" = "--pc-user" ] && PC_USER="$2"

say()  { printf '\n\033[1;36m[*]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[+]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }

say "1/5 sshd"
if ! command -v sshd >/dev/null 2>&1; then
  sudo apt-get install -y openssh-server
fi
if command -v systemctl >/dev/null 2>&1; then
  sudo systemctl enable --now ssh 2>/dev/null || sudo systemctl enable --now sshd
  ok "sshd enabled+active"
else
  warn "nessun systemd: avvia sshd a mano (/usr/sbin/sshd) o usa il supervisore che preferisci"
fi

say "2/5 authorized_keys del telefono (id_ed25519 f3-stavros)"
F3_PUB="$(ssh-keygen -F f3-stavros 2>/dev/null || true)"
sudo -u "$PC_USER" bash <<EOF
mkdir -p ~/.ssh && chmod 700 ~/.ssh
touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
EOF
if [ -n "${F3_PUB:-}" ]; then
  ok "una chiave 'f3-stavros' è già in authorized_keys"
else
  warn "dal telefono ho visto arrivare nessuna chiave. Coppia comoda: quando il telefono è in USB"
  warn "  adb shell 'cat /data/data/com.termux/files/home/.ssh/id_ed25519.pub' | sudo -u $PC_USER tee -a ~$PC_USER/.ssh/authorized_keys >/dev/null"
  warn "  (oppure: ssh-copy-id dal telefono durante f3-client-setup.sh — fa già tutto)"
fi

say "3/5 firewall: ssh SOLO su tailscale0"
if command -v ufw >/dev/null 2>&1 && sudo ufw status | grep -q "Status: active"; then
  sudo ufw allow in on tailscale0 to any port 22 proto tcp >/dev/null 2>&1 && \
    ok "ufw: 22/tcp consentito solo su tailscale0" || warn "ufw rule non aggiunta (già presente?)"
else
  warn "ufw non attivo: sshd resta raggiungibile su tutte le interfacce."
  warn "  Opzione dura (consigliata): /etc/ssh/sshd_config → ListenAddress \$(tailscale ip -4 | head -1), poi riavvia sshd."
fi

say "4/5 llama-server (per il tunnel f3-tunnel del telefono)"
if curl -fsS --max-time 3 http://127.0.0.1:8080/health >/dev/null 2>&1; then
  ok "llama-server risponde su 127.0.0.1:8080"
else
  warn "llama-server NON risponde su 127.0.0.1:8080."
  warn "  Avvialo:  bash ~/models/qwen36-35b-abl/serve.sh"
  warn "  (resta bindato su 127.0.0.1: il telefono ci arriva solo col tunnel — è quello che vogliamo)"
fi

say "5/5 adb (il telefono fa adb da sé; qui solo igiene)"
if pgrep -x adb >/dev/null 2>&1; then
  ok "adb server locale attivo (il F3 in USB resta il device B del piano mobile)"
else
  ok "nessun adb server attivo — nessuna porta adb esposta"
fi

ok "Parrot pronto per il client F3."
echo "
Lato telefono (una volta):  bash f3-client-setup.sh --pc-user $PC_USER --pc-host $(tailscale ip -4 2>/dev/null | head -1)
Uso quotidiano (telefono):  f3-tunnel &  →  hermes-f3
"
