#!/usr/bin/env bash
# Installer best-effort dell'arsenale usato da Stavros, per Parrot OS / Debian-based (echo/Debian 13).
#   ./install-tools.sh            -> apt (tool Parrot) + go install (ProjectDiscovery) + nuclei templates
#   ./install-tools.sh --sliver   -> in piu stampa il comando di install di Sliver (NON lo esegue)
#
# Copre web + rete/AD + creds + recon/OSINT + wireless (Fase 5, modalita separata), e chiude
# con la Fase 6 che concede i privilegi minimi ai binari di attacco (grant-tool-caps.sh).
# Ogni step
# salta cio che non serve o non e disponibile; i tool mancanti vengono comunque aggirati con
# curl/repeater.js.

set -uo pipefail

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'; CYAN=$'\033[0;36m'; NC=$'\033[0m'

say()  { printf '%s\n' "$*"; }
info() { printf '%s== %s%s\n' "$CYAN" "$*" "$NC"; }
warn() { printf '%s!! %s%s\n' "$YELLOW" "$*" "$NC"; }
ok()   { printf '%sOK: %s%s\n' "$GREEN" "$*" "$NC"; }

have() { command -v "$1" >/dev/null 2>&1; }

# Root vendor ESTERNA per i binari grossi (obscura, frida-server) — fuori dal repo, cosi
# copiare/spostare la workspace non trascina 290 MB. Ordine: $STAVROS_VENDOR_DIR → XDG →
# ~/.local/share/stavros/vendor. Layout identico al workspace vendor/ (tools/<name>, mirror, ...).
vendor_root() {
  if [ -n "${STAVROS_VENDOR_DIR:-}" ]; then printf '%s' "$STAVROS_VENDOR_DIR"; return; fi
  if [ -n "${XDG_DATA_HOME:-}" ]; then printf '%s' "$XDG_DATA_HOME/stavros/vendor"; return; fi
  printf '%s' "$HOME/.local/share/stavros/vendor"
}
VENDOR_ROOT="$(vendor_root)"

# -------------------- 0. ambiente (Parrot / Node) --------------------
if [ -r /etc/os-release ]; then . /etc/os-release; info "Distro: ${PRETTY_NAME:-$ID} (atteso: Parrot OS / Debian-based)"; fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 22 ]; then
  warn "Node $(node --version 2>/dev/null || echo assente) < 22: il Command Center (tools/gui-server.js usa node:sqlite) NON parte."
  warn "Parrot/Debian apt fornisce solo Node 20 -> installa Node 22 LTS via NodeSource:"
  say  "  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs"
  say  "  # in alternativa nvm:  nvm install 22 && nvm use 22"
else
  ok "Node $(node --version) >= 22"
fi

# -------------------- 1. pacchetti apt (tool nativi Kali) --------------------
info "Fase 1/6: pacchetti apt (tool Parrot)"
APT_PKGS=(
  # core rete / recon
  nmap masscan naabu netcat-openbsd bind9-dnsutils whois curl proxychains4
  # web app testing
  sqlmap nuclei ffuf feroxbuster gobuster dirb dirsearch wfuzz wpscan nikto
  whatweb wafw00f arjun eyewitness
  # injection / fuzzing specializzati
  xsser commix
  # subdomain / OSINT / crawling
  amass subfinder dnsx httpx-toolkit theharvester dnsrecon fierce dnsenum recon-ng python3-shodan
  # network / AD (certipy-ad = ADCS ESC1..ESC16 enumeration, driven by tools/ad.js)
  metasploit-framework netexec impacket-scripts responder evil-winrm enum4linux-ng ldap-utils bloodhound.py certipy-ad
  # wireless (Fase 4 — modalita separata; richiede NIC in monitor mode)
  aircrack-ng reaver hcxdumptool hcxtools wifite
  # wireless — reti aperte / captive portal (associazione, spoof MAC, sniff, rogue AP)
  iw wireless-tools macchanger tcpdump tshark dnsmasq hostapd
  # password / creds
  john hashcat hydra medusa cewl crunch
  # wordlist / payload
  seclists wordlists
  # browser per dom-check.js (CDP) + toolchain
  chromium golang-go pipx
)

MISSING_APT=()
for p in "${APT_PKGS[@]}"; do
  dpkg -s "$p" >/dev/null 2>&1 || MISSING_APT+=("$p")
done

if [ "${#MISSING_APT[@]}" -gt 0 ]; then
  if [ "$(id -u)" -eq 0 ]; then
    SUDO=""
  elif have sudo; then
    SUDO="sudo"
  else
    warn "Serve root per apt. Esegui: sudo ./install-tools.sh"
    SUDO=""
  fi
  info "apt-get update && apt-get install: ${MISSING_APT[*]}"
  if [ -n "$SUDO" ] || [ "$(id -u)" -eq 0 ]; then
    $SUDO apt-get update -y
    # DEBIAN_FRONTEND noninteractive: tshark apre un debconf prompt (dumpcap non-root) che
    # altrimenti blocca l'installer in attesa di input.
    $SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y "${MISSING_APT[@]}" || warn "apt install parziale: alcuni pacchetti non trovati (nome diverso su questa release?)"
  fi
else
  ok "tutti i pacchetti apt gia presenti"
fi

# -------------------- 2. go install (ultime release ProjectDiscovery/altro) ---
info "Fase 2/6: go install (ultime release dei tool non in apt)"
GO_TOOLS=(
  "github.com/projectdiscovery/httpx/cmd/httpx@latest"
  "github.com/projectdiscovery/subfinder/v2/cmd/subfinder@latest"
  "github.com/projectdiscovery/dnsx/cmd/dnsx@latest"
  "github.com/projectdiscovery/katana/cmd/katana@latest"
  "github.com/projectdiscovery/nuclei/v3/cmd/nuclei@latest"
  "github.com/projectdiscovery/naabu/v2/cmd/naabu@latest"
  "github.com/projectdiscovery/shuffledns/cmd/shuffledns@latest"
  "github.com/projectdiscovery/mapcidr/cmd/mapcidr@latest"
  "github.com/projectdiscovery/uncover/cmd/uncover@latest"
  "github.com/projectdiscovery/interactsh/cmd/interactsh-client@latest"
  "github.com/ffuf/ffuf/v2@latest"
  "github.com/hahwul/dalfox/v2@latest"
  "github.com/lc/gau/v2/cmd/gau@latest"
  "github.com/tomnomnom/waybackurls@latest"
  # community scout 2026-10 (Praetorian, Apache-2.0): credenziali multi-protocollo (workflow
  # attack-creds) e secrets scan con scoring/estrazione binari. Titus senza tag `vectorscan`
  # compila il motore pure-Go: nessuna lib C richiesta per `go install`.
  "github.com/praetorian-inc/brutus/cmd/brutus@latest"
  "github.com/praetorian-inc/titus/cmd/titus@latest"
)

if have go; then
  GOPATH_BIN="$(go env GOPATH)/bin"
  info "GOBIN = $GOPATH_BIN (verifica che sia nel PATH)"
  for p in "${GO_TOOLS[@]}"; do
    name="${p##*/}"; name="${name%%@*}"
    if have "$name"; then ok "$name gia presente"; continue; fi
    info "go install $p"
    GOBIN="$GOPATH_BIN" go install "$p" && ok "$name installato" || warn "go install $name fallito (riprova, serve internet)"
  done
  if [[ ":$PATH:" != *":$GOPATH_BIN:"* ]]; then
    warn "Aggiungi al PATH: export PATH=\"\$PATH:$GOPATH_BIN\"  (o in ~/.bashrc / ~/.zshrc)"
  fi
else
  warn "Go non trovato: salto i tool go install (usa le versioni apt o installa golang-go)"
fi

# -------------------- 3. pip (breach hunting / OSINT aggiuntivi) --------------
info "Fase 3/6: pip (h8mail — breach hunting, BSD-3)"
if have h8mail; then
  ok "h8mail gia presente"
elif have pipx; then
  info "pipx install h8mail"
  pipx install h8mail && ok "h8mail installato (binario in ~/.local/bin; verifica il PATH)" \
    || warn "pipx install h8mail fallito (serve internet)"
elif have pip3; then
  info "pip3 install --user h8mail"
  pip3 install --user h8mail && ok "h8mail installato" || warn "pip3 install h8mail fallito"
else
  warn "pip3/pipx assenti: salto h8mail (installa python3-pip o pipx)"
fi

# tool Python che su Kali erano in apt ma su Parrot NON sono pacchettizzati: pipx best-effort.
# schemathesis (MIT) = property-based stateful API fuzzing: workflow attack-api-stateful.
for t in ghauri xsstrike lfimap schemathesis; do
  if have "$t"; then ok "$t gia presente"; continue; fi
  if have pipx; then info "pipx install $t"; pipx install "$t" && ok "$t installato" || warn "pipx install $t fallito (serve internet)";
  elif have pip3; then pip3 install --user "$t" && ok "$t installato" || warn "pip3 install $t fallito";
  else warn "pipx/pip3 assenti: salto $t"; fi
done
have linkfinder || warn "linkfinder: non in apt/PyPI su Parrot -> git clone https://github.com/GerbenJavado/LinkFinder"
warn "tplmap/nosqlmap non pacchettizzati su Parrot: git clone upstream se servono (coperti anche da sqlmap/commix/repeater.js)"

# h2csmuggler (BishopFox, Apache-2.0) — h2c smuggling detection: workflow attack-h2c.
# La CLI upstream e' uno script Python (richiede il solo `h2`), NON un binario go: `go install`
# sul repo compila solo demo.go. Si installa con un hash pin, come il resto del piano esterno.
H2C_URL="https://raw.githubusercontent.com/BishopFox/h2csmuggler/master/h2csmuggler.py"
H2C_SHA256="9a9999fffd585878d9247817a2285cd7937d28b00458f4a7bd6bec2819ec7dee"
if have h2csmuggler; then
  ok "h2csmuggler gia presente"
elif have curl; then
  info "download h2csmuggler.py (pin sha256)"
  tmp_h2c="$(mktemp)"
  if curl -sSL -o "$tmp_h2c" "$H2C_URL" \
     && echo "$H2C_SHA256  $tmp_h2c" | sha256sum -c - >/dev/null 2>&1; then
    install -m 0755 "$tmp_h2c" "$HOME/.local/bin/h2csmuggler" \
      && ok "h2csmuggler installato in ~/.local/bin (sha256 verificato)" \
      || warn "install h2csmuggler fallito"
  else
    warn "h2csmuggler: download o sha256 MISMATCHATO — non installato (revoca se il mirror è cambiato)"
  fi
  rm -f "$tmp_h2c"
  python3 -c 'import h2' 2>/dev/null || warn "h2csmuggler richiede il modulo python 'h2' (pip3 install h2)"
else
  warn "curl assente: salto h2csmuggler"
fi

# certipy (ADCS ESC1..ESC16) — apt package is certipy-ad; pipx fallback if the apt name differs.
if have certipy; then
  ok "certipy gia presente (ADCS enumeration per tools/ad.js)"
elif have pipx; then
  info "pipx install certipy-ad"
  pipx install certipy-ad && ok "certipy installato" || warn "pipx install certipy-ad fallito (serve internet)"
else
  warn "certipy assente e pipx non trovato: ADCS (tools/ad.js adcs) non disponibile finche non lo installi"
fi

# -------------------- 4. nuclei templates ------------------------------------
info "Fase 4/6: nuclei templates"
if have nuclei; then
  info "nuclei -update-templates"
  nuclei -update-templates || warn "nuclei -update-templates fallito (serve internet / permessi di scrittura)"
else
  warn "nuclei assente: salto l'aggiornamento template"
fi

# -------------------- 4b. Obscura headless browser (CDP backend per dom-check.js) ----
# Engine Rust CDP-compatibile (Apache-2.0, https://github.com/h4ckf0r0day/obscura). Versione
# PINNATA: il progetto e giovane e la CLI puo cambiare tra release. Il tarball estrae obscura +
# obscura-worker in $OBSCURA_DIR (root vendor esterna, vedi vendor_root(); risolto da
# tools/obscura.js; override con STAVROS_OBSCURA_BIN). Se imposti OBSCURA_SHA256=<sha256>
# l'archivio viene verificato.
info "Fase 4b/6: Obscura (headless browser antidetect, backend CDP opzionale)"
OBSCURA_VERSION="${OBSCURA_VERSION:-v0.2.0}"
OBSCURA_DIR="$VENDOR_ROOT/tools/obscura"
case "$(uname -m)" in
  x86_64)          OBSCURA_ASSET="obscura-x86_64-linux-stealth.tar.gz" ;;
  aarch64|arm64)   OBSCURA_ASSET="obscura-aarch64-linux-stealth.tar.gz" ;;
  *)               OBSCURA_ASSET="" ;;
esac
if [ -z "$OBSCURA_ASSET" ]; then
  warn "architettura $(uname -m) non coperta: scarica manualmente da github.com/h4ckf0r0day/obscura/releases"
elif [ -x "$OBSCURA_DIR/obscura" ] || [ -x "vendor/tools/obscura/obscura" ]; then
  if [ -x "$OBSCURA_DIR/obscura" ]; then
    ok "Obscura gia presente in $OBSCURA_DIR ($($OBSCURA_DIR/obscura --version 2>/dev/null | head -1))"
  else
    ok "Obscura gia presente in vendor/tools/obscura (legacy in-workspace — considera ./install-tools.sh per spostarlo fuori)"
  fi
else
  OBSCURA_URL="https://github.com/h4ckf0r0day/obscura/releases/download/${OBSCURA_VERSION}/${OBSCURA_ASSET}"
  OBSCURA_TMP="$(mktemp -d)"
  info "download ${OBSCURA_VERSION} (${OBSCURA_ASSET})"
  if curl -fL --max-time 600 -o "$OBSCURA_TMP/obscura.tar.gz" "$OBSCURA_URL"; then
    if [ -n "${OBSCURA_SHA256:-}" ]; then
      echo "${OBSCURA_SHA256}  $OBSCURA_TMP/obscura.tar.gz" | sha256sum -c - \
        || { warn "sha256 MISMATCH: archivio scartato (supply-chain guard)"; rm -rf "$OBSCURA_TMP"; OBSCURA_FAILED=1; }
    fi
    if [ -z "${OBSCURA_FAILED:-}" ]; then
      echo "sha256 ($(basename "$OBSCURA_TMP")/obscura.tar.gz): $(sha256sum "$OBSCURA_TMP/obscura.tar.gz" | cut -d' ' -f1)  # registra questo hash nel vendor-mirror"
      mkdir -p "$OBSCURA_DIR"
      tar xzf "$OBSCURA_TMP/obscura.tar.gz" -C "$OBSCURA_DIR" \
        && chmod +x "$OBSCURA_DIR/obscura" "$OBSCURA_DIR/obscura-worker" 2>/dev/null
      if [ -x "$OBSCURA_DIR/obscura" ]; then
        ok "Obscura installato in $OBSCURA_DIR (verifica: node tools/obscura.js status)"
      else
        warn "estrazione completata ma il binario obscura non e eseguibile: controlla il contenuto del tarball"
      fi
    fi
  else
    warn "download fallito (serve internet): dom-check.js resta usabile con chromium locale"
  fi
  rm -rf "$OBSCURA_TMP"
fi

# -------------------- 4c. Mobile / Android lab (ReDroid + APK static/dynamic) ----
# Target: ReDroid locale (adb su 127.0.0.1:5555) + APK lab/bounty in-scope.
# Best-effort come il resto dello script; i tool mancanti restano segnalati nel riepilogo.
info "Fase 4c/6: Mobile / Android (apktool, jadx, frida, objection, mitmproxy)"
MOBILE_APT=(apktool mitmproxy aapt jadx)
MISSING_MOBILE=()
for p in "${MOBILE_APT[@]}"; do
  dpkg -s "$p" >/dev/null 2>&1 || MISSING_MOBILE+=("$p")
done
if [ "${#MISSING_MOBILE[@]}" -gt 0 ]; then
  if [ "$(id -u)" -eq 0 ]; then SUDO_M=""; elif have sudo; then SUDO_M="sudo"; else SUDO_M=""; warn "Serve root per apt (mobile). Esegui: sudo ./install-tools.sh"; fi
  if [ -n "$SUDO_M" ] || [ "$(id -u)" -eq 0 ]; then
    info "apt-get install (mobile): ${MISSING_MOBILE[*]}"
    $SUDO_M apt-get install -y "${MISSING_MOBILE[@]}" || warn "apt install mobile parziale (aapt puo chiamarsi diversamente: prova android-sdk-build-tools)"
  fi
else
  ok "pacchetti apt mobile gia presenti"
fi
# jadx: su Parrot e in apt (installato in Fase 4c); fallback release GitHub su Debian puro. Versione pinnata, verificabile via JADX_SHA256.
JADX_VERSION="${JADX_VERSION:-v1.5.1}"
if have jadx; then
  ok "jadx gia presente ($(command -v jadx))"
else
  case "$(uname -m)" in
    x86_64|aarch64|arm64)
      JADX_URL="https://github.com/skylot/jadx/releases/download/${JADX_VERSION}/jadx-${JADX_VERSION}.zip"
      JADX_TMP="$(mktemp -d)"
      info "download jadx ${JADX_VERSION}"
      if curl -fL --max-time 600 -o "$JADX_TMP/jadx.zip" "$JADX_URL"; then
        if [ -n "${JADX_SHA256:-}" ]; then
          echo "${JADX_SHA256}  $JADX_TMP/jadx.zip" | sha256sum -c - \
            || { warn "jadx sha256 MISMATCH: archivio scartato"; rm -rf "$JADX_TMP"; JADX_FAILED=1; }
        fi
        if [ -z "${JADX_FAILED:-}" ]; then
          echo "sha256 (jadx.zip): $(sha256sum "$JADX_TMP/jadx.zip" | cut -d' ' -f1)  # registra nel vendor-mirror"
          mkdir -p "$HOME/.local/share/jadx"
          unzip -q -o "$JADX_TMP/jadx.zip" -d "$HOME/.local/share/jadx" \
            && mkdir -p "$HOME/.local/bin" \
            && ln -sf "$HOME/.local/share/jadx/bin/jadx" "$HOME/.local/bin/jadx" \
            && ok "jadx installato in ~/.local/share/jadx (symlink ~/.local/bin/jadx; verifica il PATH)" \
            || warn "estrazione jadx fallita"
        fi
      else
        warn "download jadx fallito (serve internet): statica APK resta coperta da apktool"
      fi
      rm -rf "$JADX_TMP"
      ;;
    *) warn "architettura $(uname -m) non coperta per jadx: scarica manualmente da github.com/skylot/jadx/releases" ;;
  esac
fi
# frida + objection + uiautomator (python): pipx preferito, fallback pip3 --user.
for py in frida-tools objection; do
  if have "$py" || { [ "$py" = "frida-tools" ] && have frida; }; then ok "$py gia presente"; continue; fi
  if have uv; then uv tool install "$py" && ok "$py installato (uv)" || warn "uv install $py fallito";
  elif have pipx; then pipx install "$py" && ok "$py installato" || warn "pipx install $py fallito";
  elif have pip3; then pip3 install --user "$py" && ok "$py installato" || warn "pip3 install $py fallito";
  else warn "uv/pip3/pipx assenti: salto $py (installa uv: curl -LsSf astral.sh/uv/install.sh | sh)"; fi
done
if python3 -c "import uiautomator2" >/dev/null 2>&1; then ok "uiautomator2 gia presente";
elif [ -x "$HOME/.venv-mobile/bin/python" ] && "$HOME/.venv-mobile/bin/python" -c "import uiautomator2" >/dev/null 2>&1; then ok "uiautomator2 gia presente in ~/.venv-mobile";
elif have uv; then uv venv "$HOME/.venv-mobile" && uv pip install --python "$HOME/.venv-mobile/bin/python" uiautomator2 adbutils && ok "uiautomator2/adbutils in ~/.venv-mobile (attiva: source ~/.venv-mobile/bin/activate)" || warn "uv venv/pip fallito";
elif have pipx; then pipx inject objection uiautomator2 adbutils 2>/dev/null && ok "uiautomator2/adbutils installati" || warn "uiautomator2 non installato (pipx inject fallito)";
elif have pip3; then pip3 install --user uiautomator2 adbutils && ok "uiautomator2/adbutils installati" || warn "pip install uiautomator2 fallito"; fi
# frida-server per ReDroid: binario Android x86_64 da abbinare al client (versione pinnata).
FRIDA_VERSION="${FRIDA_VERSION:-17.17.0}"
FRIDA_DIR="$VENDOR_ROOT/tools/frida"
if [ -x "$FRIDA_DIR/frida-server" ] || [ -x "vendor/tools/frida/frida-server" ]; then
  if [ -x "$FRIDA_DIR/frida-server" ]; then
    ok "frida-server gia presente in $FRIDA_DIR"
  else
    ok "frida-server gia presente in vendor/tools/frida (legacy in-workspace — considera ./install-tools.sh per spostarlo fuori)"
  fi
else
  FRIDA_URL="https://github.com/frida/frida/releases/download/${FRIDA_VERSION}/frida-server-${FRIDA_VERSION}-android-x86_64.xz"
  FRIDA_TMP="$(mktemp -d)"
  info "download frida-server ${FRIDA_VERSION} (android-x86_64)"
  if curl -fL --max-time 600 -o "$FRIDA_TMP/frida-server.xz" "$FRIDA_URL"; then
    if [ -n "${FRIDA_SHA256:-}" ]; then
      echo "${FRIDA_SHA256}  $FRIDA_TMP/frida-server.xz" | sha256sum -c - \
        || { warn "frida-server sha256 MISMATCH: archivio scartato"; rm -rf "$FRIDA_TMP"; FRIDA_FAILED=1; }
    fi
    if [ -z "${FRIDA_FAILED:-}" ]; then
      echo "sha256 (frida-server.xz): $(sha256sum "$FRIDA_TMP/frida-server.xz" | cut -d' ' -f1)  # registra nel vendor-mirror"
      mkdir -p "$FRIDA_DIR"
      xz -d -c "$FRIDA_TMP/frida-server.xz" > "$FRIDA_DIR/frida-server" \
        && chmod +x "$FRIDA_DIR/frida-server" \
        && ok "frida-server in $FRIDA_DIR (push su ReDroid: adb push + chmod 755, poi adb shell su 0 ./frida-server &)" \
        || warn "estrazione frida-server fallita"
    fi
  else
    warn "download frida-server fallito (serve internet): dinamica resta coperta da objection/mitmproxy"
  fi
  rm -rf "$FRIDA_TMP"
fi
info "ReDroid: se non l'hai fatto, avvia una volta: sudo ~/redroid/setup-redroid.sh && newgrp docker && ~/redroid/redroid start"

# -------------------- 5. Sliver (solo istruzioni, mai eseguito) --------------
info "Fase 5/6: Sliver (C2 per host exploitation) — istruzioni"
if have sliver-client && have sliver-server; then
  ok "Sliver gia installato"
else
  warn "Sliver non trovato. Installazione ufficiale (script remoto, eseguila SOLO tu, con giudizio):"
  say "  curl https://sliver.sh/install | sudo bash"
  say "  # poi: sudo systemctl enable --now sliver  (server) e  sliver-client  (operatore)"
  if [[ " ${*} " == *" --sliver "* ]]; then
    say "  # (binari precompilati: https://github.com/BishopFox/sliver/releases)"
  fi
fi

# -------------------- 6. Privilegi minimi dei binari di attacco --------------
# Senza questa fase i tool che aprono raw socket (masscan, nmap -sS, hping3, airodump-ng,
# hcxdumptool...) si fermano su "permission denied" e i tool che fanno bind sotto 1024
# (responder 445, ntlmrelayx 445, chisel, hostapd, dnsmasq 53) su EACCES: l'agente deve
# allora chiedere una password all'operatore a meta' engagement. Qui si concede il minimo
# necessario, una volta sola.
#
# Il dettaglio e' in grant-tool-caps.sh + tools/cap-manifest.json: `setcap` per capability
# (non NOPASSWD sudo — vedi `_why_not_nopasswd` nel manifest) e sysctl per la soglia delle
# porte. Niente di eseguito senza che l'installatore sia gia' root o abbia sudo: se nessuno
# dei due e' disponibile, la fase salta con un avviso e resta eseguibile a mano.
info "Fase 6/6: privilegi minimi per i binari di attacco (setcap + sysctl)"
if [ "$(id -u)" -eq 0 ]; then CAPS_SUDO=""
elif have sudo; then CAPS_SUDO="sudo"
else CAPS_SUDO=""; warn "Niente sudo e non sei root: la fase privilegi salta. Applicala con 'sudo ./grant-tool-caps.sh' quando vuoi."; fi
if [ -n "$CAPS_SUDO" ] || [ "$(id -u)" -eq 0 ]; then
  if [ -x ./grant-tool-caps.sh ]; then
    $CAPS_SUDO ./grant-tool-caps.sh || warn "grant-tool-caps.sh non ha completato tutto: 'node tools/capcheck.js' dice cosa manca"
  else
    warn "grant-tool-caps.sh non trovato nella root del repo: salto la fase privilegi"
  fi
fi

# -------------------- riepilogo ----------------------------------------------
say ""
info "Riepilogo tool disponibili:"
for b in nmap masscan naabu sqlmap ghauri nuclei ffuf feroxbuster gobuster wfuzz dirsearch \
         dalfox xsstrike commix tplmap lfimap nosqlmap wpscan nikto whatweb wafw00f arjun httpx subfinder \
         amass theHarvester dnsrecon fierce katana gau waybackurls interactsh-client eyewitness h8mail msfconsole \
         netexec impacket-GetNPUsers impacket-secretsdump impacket-GetUserSPNs certipy responder evil-winrm enum4linux-ng ldapsearch bloodhound-python \
          airodump-ng aireplay-ng airmon-ng aircrack-ng reaver hcxdumptool wifite \
          iw iwconfig macchanger tcpdump tshark dnsmasq hostapd \
          adb apktool jadx frida objection mitmproxy mitmdump aapt apksigner \
          john hashcat hydra medusa cewl crunch chromium curl; do
  if have "$b"; then
    printf '  %-22s %s%s%s\n' "$b" "$GREEN" "$(command -v "$b")" "$NC"
  else
    printf '  %-22s %sMISSING%s\n' "$b" "$RED" "$NC"
  fi
done
# Obscura vive nella root vendor esterna (non nel PATH): stato dedicato.
if [ -x "$OBSCURA_DIR/obscura" ] || [ -x "vendor/tools/obscura/obscura" ]; then
  printf '  %-22s %s%s%s\n' "obscura" "$GREEN" "$([ -x "$OBSCURA_DIR/obscura" ] && echo "$OBSCURA_DIR" || echo 'vendor/tools/obscura (legacy)') (node tools/obscura.js status)" "$NC"
else
  printf '  %-22s %sMISSING%s (opzionale: backend CDP per dom-check.js — ./install-tools.sh lo installa in %s)\n' "obscura" "$YELLOW" "$NC" "$VENDOR_ROOT/tools/obscura"
fi

say ""
ok "Fatto (best-effort). I tool mancanti vengono comunque aggirati con curl / repeater.js."
