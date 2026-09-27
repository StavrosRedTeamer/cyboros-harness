#!/usr/bin/env bash
# mobile-pairip-repack.sh — bypass PairIP *license-check* (solo Java) su com.example.fest
# e reimpacchettamento dell'app-bundle. Incapsula lo step gia' validato a mano (piano Fase 4.4 /
# memoria fest-pairip-bypass). Confirm-tier per natura: NON installa nulla senza --install.
#
# Perche' funziona: PairIP qui e' SOLO com.pairip.licensecheck.* (Java), NIENTE libpairipcore.so
# → nessuna VM-protection / signature-check nativo, quindi repack+refirma e' sicuro. In
# com/pairip/application/Application.smali, attachBaseContext chiama LicenseClient.checkLicense():
# rimuovendo quella invoke-static l'app parte fuori dal Play senza System.exit(0).
#
# Toolchain (come da procedura validata):
#   APKEditor (d/b, NON usa aapt → non crasha sulle risorse Flutter come apktool)
#   zipalign + apksigner con la debug key (~/.android/debug.keystore, pass 'android',
#   alias 'androiddebugkey'). Tutti e 4 gli split rifirmati con la STESSA key (install-multiple
#   pretende firma uniforme).
#
# Uso:
#   tools/mobile-pairip-repack.sh <dir-con-i-4-split> [--install] [--serial <serial>]
#     <dir> deve contenere: base.apk + split_config.arm64_v8a.apk + split_config.xxhdpi.apk
#           + split_config.it.apk  (nomi liberi; il "base" e' l'APK che contiene lo smali PairIP)
#   Senza --install: produce ./out/*-signed.apk e stampa il comando install-multiple.
#   Con --install: adb uninstall + adb install-multiple sul device in scope.
#     Il serial NON ha default: passalo con --serial <serial> o STAVROS_ADB_SERIAL=<serial>.
#     Senza --install non serve (lo script non tocca nessun device).
set -euo pipefail
cd "$(dirname "$0")/.."

PKG="com.example.fest"
APKEDITOR="${APKEDITOR_JAR:-$HOME/tools/APKEditor-1.4.9.jar}"
KS="${DEBUG_KEYSTORE:-$HOME/.android/debug.keystore}"
KS_PASS="${DEBUG_KS_PASS:-android}"
KS_ALIAS="${DEBUG_KS_ALIAS:-androiddebugkey}"
SERIAL="${STAVROS_ADB_SERIAL:-}"
DO_INSTALL=0

SRC=""
while [ $# -gt 0 ]; do
  case "$1" in
    --install) DO_INSTALL=1 ;;
    --serial)  SERIAL="$2"; shift ;;
    -*) echo "[!] flag sconosciuto: $1"; exit 2 ;;
    *) SRC="$1" ;;
  esac
  shift
done
[ -n "$SRC" ] && [ -d "$SRC" ] || { echo "usage: $0 <dir-con-i-4-split> [--install] [--serial S]"; exit 2; }
[ -f "$APKEDITOR" ] || { echo "[!] APKEditor non trovato: $APKEDITOR (set APKEDITOR_JAR)"; exit 1; }
[ -f "$KS" ]        || { echo "[!] keystore non trovato: $KS (set DEBUG_KEYSTORE)"; exit 1; }
for t in java zipalign apksigner; do command -v "$t" >/dev/null || { echo "[!] manca '$t' nel PATH"; exit 1; }; done

# individua il base = l'APK il cui smali contiene il LicenseClient PairIP
echo "[*] Individuo il base APK (contiene com/pairip/licensecheck) in $SRC ..."
BASE=""
for f in "$SRC"/*.apk; do
  if unzip -l "$f" 2>/dev/null | grep -q 'classes.*\.dex'; then
    if unzip -p "$f" classes.dex 2>/dev/null | grep -qa 'pairip' ; then BASE="$f"; break; fi
  fi
done
# fallback: file che si chiama base*.apk
[ -z "$BASE" ] && BASE=$(ls "$SRC"/base*.apk 2>/dev/null | head -1 || true)
[ -n "$BASE" ] || { echo "[!] non trovo il base APK (quello con lo smali PairIP)"; exit 1; }
echo "[+] base = $BASE"

OUT="$SRC/out"; WORK="$SRC/.work"; rm -rf "$OUT" "$WORK"; mkdir -p "$OUT" "$WORK"

echo "[*] APKEditor d (decode senza aapt) ..."
java -jar "$APKEDITOR" d -i "$BASE" -o "$WORK/base-dec" -f

SMALI=$(grep -rl 'Lcom/pairip/application/Application;' "$WORK/base-dec" --include='Application.smali' 2>/dev/null | head -1)
[ -z "$SMALI" ] && SMALI=$(find "$WORK/base-dec" -path '*com/pairip/application/Application.smali' | head -1)
[ -n "$SMALI" ] || { echo "[!] Application.smali PairIP non trovato dopo il decode"; exit 1; }
echo "[+] patch: $SMALI"

if grep -q 'LicenseClient;->checkLicense' "$SMALI"; then
  cp "$SMALI" "$SMALI.orig"
  # rimuovi la invoke-static a checkLicense (la chiamata in attachBaseContext)
  sed -i '/invoke-static {p1}, Lcom\/pairip\/licensecheck\/LicenseClient;->checkLicense(Landroid\/content\/Context;)V/d' "$SMALI"
  # per sicurezza rimuovi anche eventuali altre invoke a checkLicense
  sed -i '/LicenseClient;->checkLicense/d' "$SMALI"
  echo "[+] checkLicense rimosso (diff):"; diff "$SMALI.orig" "$SMALI" || true
else
  echo "[i] checkLicense gia' assente in $SMALI (base gia' patchato?)"
fi

echo "[*] APKEditor b (rebuild) ..."
java -jar "$APKEDITOR" b -i "$WORK/base-dec" -o "$WORK/base-patched.apk" -f

sign_one() {  # $1 = apk in, $2 = apk out
  local in="$1" out="$2" al="$WORK/$(basename "$out" .apk)-aligned.apk"
  zipalign -f -p 4 "$in" "$al"
  apksigner sign --ks "$KS" --ks-pass "pass:$KS_PASS" --ks-key-alias "$KS_ALIAS" --key-pass "pass:$KS_PASS" --out "$out" "$al"
}

echo "[*] Rifirmo il base patchato ..."
sign_one "$WORK/base-patched.apk" "$OUT/base-signed.apk"

echo "[*] Rifirmo gli split di config con la STESSA key ..."
for f in "$SRC"/*.apk; do
  [ "$f" = "$BASE" ] && continue
  n=$(basename "$f" .apk)
  sign_one "$f" "$OUT/$n-signed.apk"
done

echo; echo "[+] APK firmati in: $OUT"; ls -1 "$OUT"/*-signed.apk
INSTALL_CMD="adb -s $SERIAL install-multiple -r $(printf '%q ' "$OUT"/*-signed.apk)"

if [ "$DO_INSTALL" -eq 1 ]; then
  if [ -z "$SERIAL" ]; then
    echo "[!] --install richiede un serial esplicito: --serial <serial> (o STAVROS_ADB_SERIAL)."
    echo "    Questo script non indovina quale device e' quello in scope."
    exit 2
  fi
  echo "[*] Scope check serial $SERIAL ..."
  node tools/mobile-guard.js check "$SERIAL" >/dev/null || { echo "[!] serial fuori scope"; exit 1; }
  echo "[*] adb uninstall $PKG (ignora se assente) ..."
  adb -s "$SERIAL" uninstall "$PKG" 2>/dev/null || true
  echo "[*] install-multiple ..."
  # shellcheck disable=SC2086
  adb -s "$SERIAL" install-multiple -r "$OUT"/*-signed.apk
  echo "[+] Installato. Avvia con: adb -s $SERIAL shell monkey -p $PKG 1"
else
  echo; echo "[i] Non installato (manca --install). Per installare:"; echo "    $INSTALL_CMD"
fi
