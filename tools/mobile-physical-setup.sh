#!/usr/bin/env bash
# mobile-physical-setup.sh — prepara un device Android FISICO (root) per l'intercettazione,
# in alternativa al flusso ReDroid di tools/mobile.js. Idempotente e ripetibile.
#
# Cosa fa (Fase 4.1 + 4.2 del piano Example Fest):
#   1. verifica che il serial sia in scope (mobile-guard.js, fail-closed);
#   2. installa la CA mitmproxy nello store DI SISTEMA via ~/bin/android-ca-install
#      (bind-mount conscrypt + su, SELinux enforcing — NON il flusso ReDroid);
#   3. instrada il traffico verso mitmproxy con `adb reverse` + proxy globale guest.
#
# NB Flutter: dart:io (HttpClient) IGNORA sia il proxy globale sia il trust store di sistema.
# Il proxy globale qui cattura il traffico di sistema/WebView; per il traffico Flutter serve in
# aggiunta lo hook BoringSSL (tools/frida/disable-flutter-tls.js) sul processo gia' avviato.
#
# Su un telefono che parla col C2 solo via reverse tunnel (2222), il PC NON vede adb:
# adb devices sul C2 e' vuoto perche' adb-server gira sul telefono. Due strade:
#   A) esegui QUESTO SCRIPT DAL C2 verso il telefono: adb parte sul telefono (SSH_ADBSH)
#      e ogni comando adb qui lo raggiunge via ssh -p 2222 (vedi adbsh() sotto);
#   B) dal telefono, solo per la CA: bash f3bot/f3-ca-install.sh (trigger C2 via /cmd).
# adb reverse + http_proxy restano validi e configurati qui (il reverse e' del device,
# viene su dal canale USB quando il telefono e' collegato, o via tcp adbd sul wifi).
#
# Uso:  tools/mobile-physical-setup.sh [serial] [proxy_port] [--ca-remove]
#       CYBOROS_ADB_SERIAL=<serial> tools/mobile-physical-setup.sh
#       Il serial NON ha default: questo script non indovina quale device e' quello in scope.
#       --ca-remove: rimuove proxy globale e bind-mount CA (teardown fine engagement, P7)
set -euo pipefail
cd "$(dirname "$0")/.."

SERIAL=""
PORT="${2:-8080}"
CA_REMOVE=0
for a in "$@"; do
  case "$a" in
    --ca-remove) CA_REMOVE=1 ;;
    -*) echo "[!] flag sconosciuto: $a"; exit 2 ;;
    *) [ -z "$SERIAL" ] && SERIAL="$a" ;;
  esac
done
SERIAL="${SERIAL:-${CYBOROS_ADB_SERIAL:-}}"
if [ -z "$SERIAL" ]; then
  echo "[!] serve il serial del device: tools/mobile-physical-setup.sh <serial> (o CYBOROS_ADB_SERIAL=<serial>)"
  exit 2
fi
CA_INSTALL="${ANDROID_CA_INSTALL:-$HOME/bin/android-ca-install}"

# adbsh: esegue un comando adb INDIRIZZANDOLO al telefono quando adb non gira qui.
# Default: locale (ReDroid/USB diretto). Con SSH_ADBSH=1 ogni invocazione adb va via
# ssh al telefono (sshd :8022 dietro il reverse 2222) — e' il modo in cui il C2 pilota
# un device fisico che non ha cavo USB attaccato al C2 stesso.
if [ "${SSH_ADBSH:-0}" = "1" ]; then
  adbsh() { ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -p 2222 root@127.0.0.1 "adb $*"; }
else
  adbsh() { adb "$@"; }
fi

echo "[*] Scope check serial $SERIAL ..."
node tools/mobile-guard.js check "$SERIAL" >/dev/null || {
  echo "[!] $SERIAL NON in scope (mobile-scope.json). Interrompo (fail-closed)."; exit 1; }
echo "[+] serial in scope."

if [ "$CA_REMOVE" = "1" ]; then
  echo "[*] teardown: proxy globale + bind-mount CA via adbsh ($SERIAL) ..."
  adbsh -s "$SERIAL" shell settings delete global http_proxy 2>/dev/null || true
  # il bind e' dentro il mount-ns di init: smontare da zygote/app non basta, serve nsenter
  adbsh -s "$SERIAL" shell su 0 sh -c 'nsenter --mount=/proc/1/ns/mnt -- /bin/umount /apex/com.android.conscrypt/cacerts 2>/dev/null; for p in $(ls /proc | grep -E "^[0-9]+$"); do nsenter --mount=/proc/$p/ns/mnt -- /bin/umount /apex/com.android.conscrypt/cacerts 2>/dev/null || true; done; rm -rf /data/local/tmp/ca-copy; echo CA-RIMOSSA' | tr -d '\r'
  echo "[+] CA rimossa dal trust store di sistema (finche' non si rilancia il bind)."
  echo "[i] NB: il reboot rimuove comunque il bind-mount; --ca-remove serve per il teardown A CALDO."
  exit 0
fi

echo "[*] adb wait-for-device ($SERIAL) ..."
adbsh -s "$SERIAL" wait-for-device

echo "[*] CA mitmproxy nello store di sistema (via $CA_INSTALL) ..."
if [ -x "$CA_INSTALL" ] && [ "${SSH_ADBSH:-0}" != "1" ]; then
  # android-ca-install usa 'adb' senza -s: lo forziamo sul device scelto con ANDROID_SERIAL.
  ANDROID_SERIAL="$SERIAL" "$CA_INSTALL"
elif [ "${SSH_ADBSH:-0}" = "1" ]; then
  # flusso telefono-con-adb: la CA la installiamo con lo stesso meccanismo ma via adbsh
  # (il telefono ha su; lo script C2-side manda i comandi uno a uno)
  HASH=$(openssl x509 -inform PEM -subject_hash_old -in "${MITMPROXY_CA:-$HOME/.mitmproxy/mitmproxy-ca-cert.pem}" -noout)
  { cat "${MITMPROXY_CA:-$HOME/.mitmproxy/mitmproxy-ca-cert.pem}"; openssl x509 -in "${MITMPROXY_CA:-$HOME/.mitmproxy/mitmproxy-ca-cert.pem}" -text -fingerprint -noout; } > "/tmp/$HASH.0"
  adbsh push "/tmp/$HASH.0" /data/local/tmp/
  adbsh shell 'su 0 sh -c "rm -rf /data/local/tmp/ca-copy && mkdir -p -m 700 /data/local/tmp/ca-copy && cp /apex/com.android.conscrypt/cacerts/* /data/local/tmp/ca-copy/ 2>/dev/null || cp /system/etc/security/cacerts/* /data/local/tmp/ca-copy/; mv /data/local/tmp/'"$HASH"'.0 /data/local/tmp/ca-copy/; chown root:root -R /data/local/tmp/ca-copy; chmod 755 /data/local/tmp/ca-copy; chmod 644 /data/local/tmp/ca-copy/*; chcon u:object_r:system_security_cacerts_file:s0 /data/local/tmp/ca-copy /data/local/tmp/ca-copy/* 2>/dev/null || chcon u:object_r:system_file:s0 /data/local/tmp/ca-copy 2>/dev/null || true; nsenter --mount=/proc/1/ns/mnt -- /bin/mount --bind /data/local/tmp/ca-copy /apex/com.android.conscrypt/cacerts; echo CA-OK"' | tr -d '\r'
else
  echo "[!] $CA_INSTALL non trovato/eseguibile — salto l'install CA (fallo a mano)."
fi

echo "[*] Instradamento proxy: adb reverse tcp:$PORT -> host mitmproxy:$PORT ..."
adbsh -s "$SERIAL" reverse --remove-all 2>/dev/null || true
adbsh -s "$SERIAL" reverse "tcp:$PORT" "tcp:$PORT"
echo "[*] Proxy globale guest -> 127.0.0.1:$PORT (via reverse) ..."
adbsh -s "$SERIAL" shell settings put global http_proxy "127.0.0.1:$PORT"

echo
echo "[+] Fatto. Verifiche:"
echo "    proxy globale : $(adbsh -s "$SERIAL" shell settings get global http_proxy | tr -d '\r')"
echo "    reverse attivi: $(adbsh -s "$SERIAL" reverse --list | tr -d '\r' | tr '\n' ';')"
echo
echo "[i] Per azzerare il proxy:  ${SSH_ADBSH:+ssh -p 2222 root@127.0.0.1 }adb -s $SERIAL shell settings delete global http_proxy"
echo "[i] Teardown CA+proxy (P7): tools/mobile-physical-setup.sh $SERIAL --ca-remove"
echo "[i] Traffico Flutter: avvia l'app, poi"
echo "    node tools/mobile.js frida $SERIAL com.example.fest \\"
echo "         -l tools/frida/disable-flutter-tls.js --confirm \"flutter tls mitm\""
