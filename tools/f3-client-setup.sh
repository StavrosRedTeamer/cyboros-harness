#!/usr/bin/env bash
# f3-client-setup.sh — bootstrap del client sul Poco F3 (Termux), lato telefono.
#
# Design (coerente con ops/harness.md):
#   - Termux + proot-distro (Kali arm64) = ambiente Linux completo SENZA toccare il ROM.
#     Il root/TWRP NON serve a questo client: è la rete di sicurezza (nandroid + reflash).
#     Nessun binario dell'harness viene eseguito come root sul telefono.
#   - Il workspace del PC (il nome si risolve sul PC: `cyboros-harness` dopo il rebrand,
#     `stavrosredteamer` prima) + il fork hermes-stavros (già patchato) arrivano via rsync dal PC:
#     i 5 patch STAVROS e il trim del payload restano identici al profilo desktop.
#   - L'inferenza resta remota: llama di casa via tunnel SSH (f3-tunnel) o provider cloud.
#   - Scope discipline INVARIATA: scope.json / mobile-scope.json / wifi-scope.json viaggiano
#     con la workspace e restano fail-closed.
#   - opsec: tutto su Tailscale (llama + ssh), nessuna porta esposta sulla LAN.
#
# Uso (DENTRO Termux, utente normale):
#   pkg install -y curl git openssh rsync
#   bash f3-client-setup.sh --pc-user <utente> --pc-host <ip-tailscale-del-pc>
#   [--pc-ws-dir <nome-cartella>]   # opzionale: senza, si risolve interrogando il PC
# Idempotente: rilanciabile, salta i passi già fatti.
#
# --pc-user e --pc-host sono OBBLIGATORI e non hanno default: questo script non porta con
# sé l'host o l'utente di nessuno. Dichiarali a ogni run, come si dichiara uno scope.
set -euo pipefail

PC_USER=""; PC_HOST=""
# Cartella del workspace sul PC. Vuota = risolta al passo 4 interrogando il PC: il nome cambia
# col rebrand (stavrosredteamer → cyboros-harness) e cablarlo qui lo fa invecchiare in silenzio —
# un rsync verso una cartella inesistente copia zero file ed esce 0.
PC_WS_DIR="${PC_WS_DIR:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --pc-user) PC_USER="$2"; shift 2 ;;
    --pc-host) PC_HOST="$2"; shift 2 ;;
    --pc-ws-dir) PC_WS_DIR="$2"; shift 2 ;;
    *) echo "opzione ignota: $1" >&2; exit 2 ;;
  esac
done

say()  { printf '\n\033[1;36m[*]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[+]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }

if [ -z "$PC_USER" ] || [ -z "$PC_HOST" ]; then
  warn "--pc-user e --pc-host sono obbligatori."
  warn "  Dal PC, l'IP tailscale si trova con:  tailscale ip -4 | head -1"
  warn "  Esempio:  bash f3-client-setup.sh --pc-user \"\$(whoami)\" --pc-host <ip-tailscale>"
  exit 2
fi

# ---- 0. sanity: sei davvero in Termux? --------------------------------------
if [ -z "${TERMUX_VERSION:-}" ] && ! [[ "${PREFIX:-}" == *com.termux* ]]; then
  warn "Non sembra Termux (TERMUX_VERSION/PREFIX assenti). Interrompo." >&2
  exit 1
fi

say "0/8 pacchetti di base Termux"
pkg install -y coreutils bash tar xz-utils proot proot-distro openssh rsync git \
  python python-pip binutils patch termux-api termux-tools

# Senza wake-lock Android congela Termux appena lo schermo si spegne.
termux-wake-lock 2>/dev/null || true

# ---- 1. Phantom process killer (Android 12+) --------------------------------
say "1/8 phantom process killer"
if command -v device_config >/dev/null 2>&1; then
  device_config put activity_manager max_phantom_processes 2147483647 2>/dev/null \
    && ok "phantom killer disattivato da Termux" \
    || warn "device_config rifiuta — dal PC: adb shell device_config put activity_manager max_phantom_processes 2147483647 (vedi runbook §3)"
else
  warn "device_config non disponibile qui — dal PC: adb shell device_config put activity_manager max_phantom_processes 2147483647"
fi
warn "disativa anche l'ottimizzazione batteria per Termux: Impostazioni → Batteria → Termux → Nessuna restrizione"

# ---- 2. Chiave SSH del telefono → authorized_keys sul PC --------------------
say "2/8 chiavi SSH (telefono → PC)"
[ -f ~/.ssh/id_ed25519 ] || ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519 -C "f3-stavros"
if ! ssh -o BatchMode=yes -o ConnectTimeout=5 "$PC_USER@$PC_HOST" true 2>/dev/null; then
  warn "Serve la password del PC UNA volta per installare la chiave:"
  ssh-copy-id "$PC_USER@$PC_HOST" || warn "ssh-copy-id fallito — appendi ~/.ssh/id_ed25519.pub a ~/.ssh/authorized_keys sul PC e rilancia"
fi
ssh -o BatchMode=yes -o ConnectTimeout=8 "$PC_USER@$PC_HOST" true \
  && ok "SSH passwordless verso $PC_USER@$PC_HOST" \
  || warn "SSH non ancora passwordless: risolvi e rilancia questo script"

# ---- 3. proot Kali arm64 ------------------------------------------------------
say "3/8 proot-distro Kali (arm64)"
proot-distro list 2>/dev/null | grep -q '^kali' || proot-distro install kali

cat > "$PREFIX/bin/f3-kali" <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
# f3-kali — entra in Kali proot con la workspace stavros montata su /root/stavros
exec proot-distro login kali \
  --bind /data/data/com.termux/files/home/stavros:/root/stavros \
  --fix-low-ports -- "$@"
EOF
chmod +x "$PREFIX/bin/f3-kali"
ok "launcher $PREFIX/bin/f3-kali"

# ---- 4. rsync workspace (PC → telefono) -------------------------------------
if [ -z "$PC_WS_DIR" ]; then
  for d in cyboros-harness stavrosredteamer; do
    if ssh -o BatchMode=yes -o ConnectTimeout=8 "$PC_USER@$PC_HOST" "test -d Desktop/$d" 2>/dev/null; then
      PC_WS_DIR="$d"; break
    fi
  done
fi
[ -n "$PC_WS_DIR" ] || { warn "nessuna workspace in ~/Desktop sul PC (attese: cyboros-harness, stavrosredteamer) — usa --pc-ws-dir <nome>"; exit 1; }
say "4/8 rsync workspace $PC_WS_DIR"
mkdir -p ~/stavros
rsync -az --delete \
  --exclude '.git/' --exclude 'node_modules/' --exclude 'reports/tmp/' \
  --exclude 'vendor/tools/obscura/' --exclude 'vendor/tools/frida/' \
  --exclude 'mirror/' --exclude 'noauth_results/' --exclude 'temp/' \
  "$PC_USER@$PC_HOST:Desktop/$PC_WS_DIR/" ~/stavros/
ok "workspace in ~/stavros ($(du -sh ~/stavros | cut -f1))"

# ---- 5. rsync del fork hermes-stavros (PC → telefono, con i 5 patch) --------
say "5/8 rsync fork hermes-stavros"
rsync -az --delete \
  --exclude '.git/' --exclude '__pycache__/' --exclude '*.pyc' \
  --exclude 'hermes_agent.egg-info/' --exclude 'uv.lock' \
  "$PC_USER@$PC_HOST:hermes-stavros/" ~/hermes-stavros/
ok "fork in ~/hermes-stavros (patch STAVROS inclusi)"

# ---- 6. venv hermes sul telefono (pipeline Termux: venv stdlib + pip) -------
say "6/8 venv hermes-f3 (extra termux + mcp)"
if [ ! -x "$HOME/.hermes-f3/bin/python" ]; then
  python -m venv "$HOME/.hermes-f3"
  "$HOME/.hermes-f3/bin/pip" install --upgrade pip wheel
fi
"$HOME/.hermes-f3/bin/pip" install -e "$HOME/hermes-stavros[termux,mcp]" \
  -c "$HOME/hermes-stavros/constraints-termux.txt"

mkdir -p ~/.hermes-f3-home
cat > "$PREFIX/bin/hermes-f3" <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
# hermes-f3 — TUI hermes sul telefono, profilo dedicato, cwd = workspace stavros
export HERMES_HOME="$HOME/.hermes-f3-home"
cd "${STAVROS_DIR:-$HOME/stavros}"
exec "$HOME/.hermes-f3/bin/python" -m hermes_cli "$@"
EOF
chmod +x "$PREFIX/bin/hermes-f3"
ok "launcher $PREFIX/bin/hermes-f3"

# ---- 7. config profilo F3 -----------------------------------------------------
# Stesso trim del profilo PC (15 tool + MCP stavros, 4.6k token), backend ssh verso
# Parrot per l'exec pesante, MCP stavros locale (bridge zero-dep col node di Termux:
# i 7 tool MCP sono read-only e non toccano binari Kali).
say "7/8 config ~/.hermes-f3-home/config.yaml"
cat > ~/.hermes-f3-home/config.yaml <<EOF
model:
  provider: custom
  base_url: ${STAVROS_LLM_URL:-http://127.0.0.1:8080/v1}
  default: qwen36-35b-abl
  context_length: 131072
  streaming: true
  api_mode: chat_completions
agent:
  tool_use_enforcement: false
  execution_guidance: false
  task_completion_guidance: false
  parallel_tool_call_guidance: false
  steer_channel_note: false
  disabled_toolsets:
    - browser
    - browser-use
    - vision
    - image_gen
    - video
    - video_gen
    - tts
    - stt
    - x_search
    - code_execution
    - delegation
    - session_search
    - connections
    - cronjob
    - kanban
    - homeassistant
    - spotify
    - discord
    - discord_admin
    - yuanbao
    - computer_use
  disabled_tools: [skill_manage, search_files, process_manage]
  reasoning_effort: high
auxiliary:
  title_generation:
    enabled: false
skills:
  index_prose: concise
tools:
  tool_search:
    enabled: 'off'
onboarding:
  seen:
    tool_progress_prompt: true
_config_version: 45
platform_toolsets:
  cli: [web, terminal, file, skills]
terminal:
  backend: ssh
  cwd: /home/${PC_USER}/Desktop/${PC_WS_DIR}
  timeout: 240
  ssh_host: ${PC_HOST}
  ssh_user: ${PC_USER}
  ssh_port: 22
  ssh_key: ~/.ssh/id_ed25519
mcp_servers:
  stavros:
    command: node
    args: [/data/data/com.termux/files/home/stavros/tools/mcp-bridge.js]
    enabled: true
    timeout: 120
    connect_timeout: 20
EOF

# Tunnel llama: hermes-f3 parla con 127.0.0.1:8080, il tunnel lo inoltra al PC su Tailscale.
cat > "$PREFIX/bin/f3-tunnel" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
# f3-tunnel — porta la llama di casa su 127.0.0.1:8080 del telefono (Ctrl-C per chiudere)
# Se usi OpenRouter non serve: exporta STAVROS_LLM_URL e cambia model.base_url nel config.
while true; do
  ssh -N -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \\
      -o ExitOnForwardFailure=yes -L 8080:127.0.0.1:8080 ${PC_USER}@${PC_HOST} \\
      && break
  echo "[!] tunnel caduto — retry tra 3s (Ctrl-C per uscire)" >&2
  sleep 3
done
EOF
chmod +x "$PREFIX/bin/f3-tunnel"
ok "launcher $PREFIX/bin/f3-tunnel (llama locale via SSH)"

# ---- 8. bootstrap arsenale dentro proot Kali ---------------------------------
say "8/8 arsenale arm64 dentro Kali proot"
cat > "$PREFIX/f3-kali-bootstrap.sh" <<'EOF'
#!/usr/bin/env bash
# Eseguito DENTRO proot Kali (via f3-kali): arsenal arm64 dell'harness.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends \
  nodejs npm adb fastboot frida-tools python3-pip python3-venv \
  nmap sqlmap nikto ffuf nuclei wafw00f hydra hashid \
  dnsutils netcat-openbsd curl wget git jq unzip zip file procps sudo mitmproxy

# P2 — arsenale ANDROID (idempotente). Serve alla linea mobile della harness:
#   static/surface/firebase di mobile.js (apktool/jadx), repack firmabile
#   (apksigner/zipalign, il pezzo che manca a mobile-pairip-repack.sh),
#   triage APK (androguard/apkid) e componenti esportate (drozer).
# Senza questi il tool-plane mobile resta 3/5 (adb+frida+objection) — vedi
# setup-official.sh in f3bot, che ha lo stesso blocco.
# ATTENZIONE: apkid e smali NON sono nei repo Kali. Metterli nella riga apt
# fa abortire l'INTERA installazione (apt-get install fallisce se un nome è
# sconosciuto e non installa NULLA) — per questo apkid/drozer vanno da pip e
# per smali restano i jar di libsmali-java. Non rimettere apkid/smali in apt.
#
# PROOT: jadx/apksigner tirano default-jre (JRE completo) -> cups/dbus/gtk -> systemd.
# In proot non c'è un PID1 systemd e i postinst di systemd/dbus/gtk falliscono
# (`Protocol driver not attached`): apt abortisce e NON configura nulla, in silenzio.
# Perciò: installa, e se fallisce neutralizza (no-op) i postinst dei pacchetti che
# restano iF/iU, completa con `dpkg --configure -a`, riprova; poi ripristina i
# postinst. Alla fine dpkg resta coerente e i binari girano con la JRE headless.
proot_neutralize_postinst() {
  local p f
  for p in $(dpkg -l 2>/dev/null | awk '$1=="iF"||$1=="iU"{print $2}'); do
    f="/var/lib/dpkg/info/$p.postinst"
    [ -e "$f" ] || continue
    [ -e "$f.real" ] || mv "$f" "$f.real"
    ln -sf /bin/true "$f"
  done
}
proot_restore_postinst() {
  local f
  for f in /var/lib/dpkg/info/*.postinst.real; do
    [ -e "$f" ] || continue
    rm -f "${f%.real}"; mv "$f" "${f%.real}"
  done
}
proot_install() {
  local i
  for i in 1 2 3; do
    apt-get install -y --no-install-recommends "$@" && return 0
    proot_neutralize_postinst
    dpkg --configure -a || true
  done
  return 1
}
proot_install apktool jadx apksigner zipalign androguard libsmali-java \
  || echo '[i] arsenale android incompleto (vedi /root/android-apt*.log)'
proot_restore_postinst
pip3 install --break-system-packages apkid drozer \
  || echo '[i] apkid/drozer non installati (best-effort: mobile.js funziona senza)'

# Node >= 22 (NodeSource): richiesto da gui-server.js e dalla harness
if [ "$(node -v | cut -dv -f2 | cut -d. -f1)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

pip3 install --break-system-packages -U frida-tools objection

# Symlink comodo + bashrc
ln -sfn /root/stavros /root/stavrosredteamer
grep -q 'STAVROS_DIR' /root/.bashrc 2>/dev/null || cat >> /root/.bashrc <<'BRC'
export STAVROS_DIR=/root/stavros
cd /root/stavros
BRC
echo '[+] Kali proot pronto.'
EOF
f3-kali bash /data/data/com.termux/files/usr/f3-kali-bootstrap.sh

ok "Bootstrap F3 completato."
echo "
Verifica (vedi docs/f3-client-runbook.md):
  1) PC:      bash tools/f3-client-parrot.sh          # sshd + adb hardening (una volta)
  2) telefono: f3-tunnel &                            # llama su 127.0.0.1:8080
  3) telefono: hermes-f3 -z 'che verdetto dà lo scope-guard per https://example.com?'
  4) telefono: f3-kali → cd /root/stavros && node tools/doctor.js
"
