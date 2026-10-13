# F3 — Arsenale completo + root: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** portare il Poco F3 (client *e* target mobile della harness) alla parità con l'arsenale
che Stavros usa sul PC e che è eseguibile su arm64, rendere il provisioning riproducibile dentro
proot, e aggiungere il root Magisk con il tooling di self-pentest (frida-server, CA di sistema).

**Architecture:** tre piani separati che si toccano solo negli artefatti. (1) *Repo*: la fix a
`tools/f3-client-setup.sh` già applicata oggi viene bloccata da un'invariante di regressione; il
provisioning diventa proot-safe perché in proot non esiste un PID1 systemd e un package name
sconosciuto abortisce l'intera transazione `apt`. (2) *f3bot* (fuori repo): lo stesso blocco rotto
esiste in `~/f3bot/setup-official.sh`, ed è da lì che è stato provisionato il telefono. (3)
*Device*: un installer idempotente e per-package installa l'arsenale ampio, le wordlist, i template
nuclei, obscura aarch64 e chromium; poi Magisk sblocca frida-server/CA/cattura raw.

**Tech Stack:** Node ≥22 (zero dipendenze), bash, `proot-distro` + Kali arm64 su Termux/Android 16,
`adb`/`fastboot`, Magisk, ProjectDiscovery (go), pipx, obscura (Rust, CDP).

**Spec:** `docs/f3-client-runbook.md` (§1 architettura, §2 setup, §3 hardening, §4 self-pentest,
§5 limiti fisici) e `docs/f3-rom-alioth.md` (§3.6 root Magisk). Contesto di linea: `docs/mobile.md`,
`docs/toolbox.md` (Obscura), `session-prompt-egress-f3.md` (egress dal telefono).

## Global Constraints

- Node **≥ 22** su entrambi i lati; repo **zero dipendenze** e offline-capable.
- Ogni tool di terze parti tocca un target **solo** via guard (`tools/run.js`, `tools/mobile.js`,
  `tools/obscura.js`): scope fail-closed, mai binari diretti.
- Il proot Kali **non ha systemd/PID1**: i postinst di `systemd`/`dbus`/`gtk` falliscono
  (`Protocol driver not attached`) e `apt` non configura nulla → vanno neutralizzati durante
  l'installazione e ripristinati dopo.
- `apkid` e `smali` **non esistono nei repo Kali**: mai in una riga `apt-get install` (aborta
  l'intera transazione). `apkid`/`drozer` da `pip3`; per lo smali i jar `libsmali-java`.
- Repo: README dichiara **103 tests** e **147 modules** — se cambiano, aggiorna il README
  (lo verificano `tools/test-repo-invariants.js`). `docs/INDEX.md` è generato:
  dopo ogni doc nuovo esegui `node tools/docs-index.js`.
- Device: build installata `23.2-20260916-NIGHTLY-alioth`, serial adb `bb83609b`.
- Obscura: versione pinnata **v0.2.3**, asset arm64 `obscura-aarch64-linux-stealth.tar.gz`
  (SHA256 pin opzionale via hash registrato).
- Egress: le scansioni escono dalla rete del F3, non dal PC (`session-prompt-egress-f3.md`).
- `fastboot flash` / Magisk = operazione **irreversibile**: solo con conferma esplicita
  dell'operatore in sessione, dopo backup e battery ≥50%.

## Review Focus

1. **Rilancio su un telefono con bootstrap stale** (idempotenza): rieseguire il provisioning non
   deve rompere ciò che già funziona né duplicare installazioni.
2. **Nome pacchetto inesistente in una riga apt**: un solo nome sbagliato fa fallire *tutto* in
   silenzio — l'installer deve installare per-package e riportare i mancati.
3. **Postinst che falliscono in proot**: se non neutralizzati, dpkg resta mezzo-configurato e il
   `apt` successivo è rotto — la coerenza di `dpkg --audit` a fine run va verificata.
4. **OTA LineageOS dopo il root**: un aggiornamento riscrive `boot` e il root sparisce; serve il
   flusso Magisk "install to inactive slot" o un re-patch.
5. **Cieco per mancanza di dati**: `nuclei` senza template e `ffuf`/dir-buster senza wordlist non
   producono nulla pur essendo "presenti" — un tool installato non è un tool utilizzabile.

---

### Task 1: Repo — invariante di regressione sul bootstrap F3

**Files:**
- Modify: `tools/f3-client-setup.sh` (blocco Android + `proot_install`, **già applicato oggi**:
  questo task lo blinda, non lo riscrive)
- Modify: `tools/test-repo-invariants.js` (nuovo `ok(...)`)

**Interfaces:**
- Consumes: helper `read(rel)` e `ok(name, fn)` già presenti in `tools/test-repo-invariants.js`.
- Produces: nulla (solo un check in più nel gate `npm test`).

- [ ] **Step 1: Aggiungi il check di regressione** in `tools/test-repo-invariants.js`, subito dopo
  il check `docs/INDEX.md è aggiornato`:

```js
// Il bootstrap del F3 gira in proot, dove non esiste un PID1 systemd: i postinst di
// systemd/dbus/gtk falliscono e apt non configura nulla. Inoltre apkid e smali NON sono nei
// repo Kali e un nome sconosciuto fa abortire l'INTERA transazione apt. Questa invariante
// impedisce il ritorno dei due bug trovati il 2026-09-30.
ok('f3-client-setup: arsenale android proot-safe (no apkid/smali in apt)', () => {
  const src = read('tools/f3-client-setup.sh');
  const m = src.match(/<<'EOF'\n([\s\S]*?)\nEOF\n/);
  assert.ok(m, 'heredoc del bootstrap non trovato in tools/f3-client-setup.sh');
  const body = m[1];
  const code = body.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n').replace(/\\\n/g, ' ');
  const aptCmds = code.match(/apt-get install[^\n]*/g) || [];
  assert.ok(aptCmds.length > 0, 'nessun apt-get install nel bootstrap F3');
  for (const c of aptCmds) {
    assert.ok(!/\bapkid\b/.test(c), 'apkid non è nei repo Kali: niente apt — ' + c.trim());
    assert.ok(!/(^|\s)smali(\s|$)/.test(c), 'smali non è nei repo Kali: usa libsmali-java — ' + c.trim());
  }
  assert.ok(/proot_neutralize_postinst/.test(body), 'manca la neutralizzazione dei postinst (proot)');
  assert.ok(/proot_restore_postinst/.test(body), 'manca il ripristino dei postinst (proot)');
  assert.ok(/libsmali-java/.test(body), 'libsmali-java atteso per i jar smali');
  assert.ok(/pip3 install[^\n]*\bapkid\b/.test(body), 'apkid deve essere installato da pip');
});
```

- [ ] **Step 2: Verifica che il check passi** (la fix è già nel file)

Run: `node tools/test-repo-invariants.js`
Expected: `PASS f3-client-setup: arsenale android proot-safe` e `0 fail` (exit 0).

- [ ] **Step 3: Verifica che il check sappia fallire** (prova negativa, poi annulla)

Run: `git stash -- tools/f3-client-setup.sh && node tools/test-repo-invariants.js; git stash pop`
Expected: FAIL con "apkid non è nei repo Kali" (o "manca la neutralizzazione"). Se non fallisce,
il check non protegge nulla: correggilo.

- [ ] **Step 4: Gate completo**

Run: `npm test`
Expected: `PASS=103  FAIL=0`.

- [ ] **Step 5: Commit**

```bash
git add tools/f3-client-setup.sh tools/test-repo-invariants.js
git commit -m "fix(f3): arsenale android nel bootstrap proot + invariante di regressione"
```

---

### Task 2: Repo — documentare il caveat proot e l'arsenale atteso

**Files:**
- Modify: `docs/f3-client-runbook.md` (nuova §2-bis dopo §2)
- Regenerate: `docs/INDEX.md`

**Interfaces:**
- Consumes: nulla.
- Produces: nulla (documentazione).

- [ ] **Step 1: Aggiungi la sezione** dopo il paragrafo "Poi verifica:" di §2:

```markdown
## 2-bis. Arsenale dentro il proot: cosa è locale e cosa no

Il Kali del F3 è l'immagine **minimale**: il bootstrap di `f3-client-setup.sh` (o
`~/f3bot/setup-official.sh`) è l'unica cosa che popola l'arsenale. Due trappole del proot:

- **Niente systemd/PID1.** `jadx`/`apksigner` tirano `default-jre` → `dbus`/`gtk`/`systemd`, i cui
  postinst falliscono (`Protocol driver not attached`) e fanno abortire `apt` senza configurare
  nulla. Il bootstrap neutralizza quei postinst durante l'installazione e li ripristina dopo.
- **Nomi pacchetto che non esistono.** `apkid` e `smali` non sono nei repo Kali: in una riga
  `apt-get install` fanno fallire **tutta** la transazione. `apkid`/`drozer` vanno da `pip3`, i jar
  smali da `libsmali-java`.

Dopo l'arsenale ampio (recon, dir-busting, web, creds, AD, services, host, wireless, cloud,
wordlist, template nuclei) il tool-plane locale copre le stesse categorie del PC, tranne:
monitor-mode WiFi (firmware NIC), `tcpdump` raw (vuole root sul kernel Android) e i binari x86-only.
`chromium` (arm64) e `obscura` (asset `obscura-aarch64-linux-stealth.tar.gz`) restano i due backend
CDP per `node tools/dom-check.js` (`--backend chrome` o `--backend obscura`).
```

- [ ] **Step 2: Rigenera l'indice**

Run: `node tools/docs-index.js`
Expected: `docs-index: scritto docs/INDEX.md (… righe, …)`.

- [ ] **Step 3: Gate**

Run: `node tools/docs-index.js --check && node tools/test-repo-invariants.js`
Expected: entrambi exit 0.

- [ ] **Step 4: Commit**

```bash
git add docs/f3-client-runbook.md docs/INDEX.md
git commit -m "docs(f3): caveat proot e perimetro dell'arsenale locale"
```

---

### Task 3: Repo — voce di CHANGELOG

**Files:**
- Modify: `CHANGELOG.md` (sezione `## [Unreleased]` → `### Added`)

**Interfaces:** consuma: nulla. Produce: nulla.

- [ ] **Step 1: Aggiungi la voce** come primo bullet di `### Added`:

```markdown
- `tools/f3-client-setup.sh` — l'arsenale arm64 dentro il proot Kali ora include l'intera linea
  mobile (`apktool`, `jadx`, `apksigner`, `zipalign`, `androguard`, jar `libsmali-java`, `apkid` e
  `drozer`) e un installer proot-safe: due bug reali lo tenevano fuori dal telefono. `apkid` e
  `smali` non esistono nei repo Kali e un nome sconosciuto **aborta l'intera transazione apt**
  (nessun pacchetto installato, in silenzio); inoltre `jadx`/`apksigner` tirano `default-jre` e con
  esso `systemd`/`dbus`/`gtk`, i cui postinst falliscono sotto proot (niente PID1) lasciando `dpkg`
  mezzo-configurato. L'installer neutralizza quei postinst durante l'installazione, completa con
  `dpkg --configure -a`, riprova e li ripristina: `dpkg --audit` resta vuoto a fine run. Una nuova
  invariante in `tools/test-repo-invariants.js` impedisce il ritorno dei due bug.
```

- [ ] **Step 2: Gate + commit**

Run: `node tools/test-repo-invariants.js`
Expected: exit 0.

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): arsenale F3 proot-safe"
```

---

### Task 4: f3bot — stessa fix in `setup-official.sh` (fuori repo)

**Files:**
- Modify: `~/f3bot/setup-official.sh` (blocco "P2 — arsenale ANDROID", righe ~303–311)

**Interfaces:** consuma: la logica di Task 1. Produce: un bootstrap generato proot-safe.

> `~/f3bot` è **fuori** dalla project root: chiedi conferma all'operatore prima di modificarlo.

- [ ] **Step 1: Sostituisci il blocco rotto**. Il testo attuale è:

```bash
apt-get install -y --no-install-recommends $DPKG_OPTS \
  apktool jadx apksigner zipalign androguard apkid smali \
  >"$HOME/android-apt.log" 2>&1 \
  || apt-get install -y $DPKG_OPTS apktool jadx apksigner zipalign androguard apkid smali \
       >>"$HOME/android-apt.log" 2>&1 || true
apt-get install -y --no-install-recommends $DPKG_OPTS drozer >>"$HOME/android-apt.log" 2>&1 \
  || pip3 install --break-system-packages drozer >>"$HOME/android-apt.log" 2>&1 \
  || echo '[i] drozer non installato (vedi ~/android-apt.log)'
```

  Con (dentro l'heredoc del bootstrap, quindi niente `$DPKG_OPTS` host-side):

```bash
# proot: neutralizza i postinst che falliscono senza PID1, poi ripristina.
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
# apkid/smali NON sono nei repo Kali: fuori da apt (abortirebbe tutto).
proot_install apktool jadx apksigner zipalign androguard libsmali-java \
  >>"$HOME/android-apt.log" 2>&1 \
  || echo '[i] arsenale android incompleto (vedi ~/android-apt.log)'
proot_restore_postinst
pip3 install --break-system-packages apkid drozer >>"$HOME/android-apt.log" 2>&1 \
  || echo '[i] apkid/drozer non installati (vedi ~/android-apt.log)'
```

- [ ] **Step 2: Verifica statica**

Run: `bash -n ~/f3bot/setup-official.sh`
Expected: nessun output (exit 0).

- [ ] **Step 3: Diff review**

Run: `git -C ~/f3bot diff -- setup-official.sh`
Expected: solo il blocco sostituito; nessun'altra modifica.

- [ ] **Step 4: Commit** (repo f3bot)

```bash
git -C ~/f3bot add setup-official.sh
git -C ~/f3bot commit -m "fix(kali): bootstrap android proot-safe (no apkid/smali in apt)"
```

---

### Task 5: Telefono — riallineare il bootstrap e renderlo idempotente

**Files:**
- Modify (sul telefono): `~/stavros` (rsync dal PC), termux `$PREFIX/f3-kali-bootstrap.sh`

**Interfaces:** consuma: Task 1 + Task 4. Produce: un `f3-kali-bootstrap.sh` aggiornato sul device.

- [ ] **Step 1: Riporta lo script aggiornato sul telefono** (dentro Termux):

```bash
bash ~/stavros/tools/f3-client-setup.sh --pc-user <utente> --pc-host <ip-tailscale>
```
Expected: "Bootstrap F3 completato." senza errori; `~/stavros/tools/f3-client-setup.sh` ora contiene
`proot_install`.

- [ ] **Step 2: Verifica lo stato del proot**

Run (dentro Termux): `f3-kali bash -lc 'dpkg --audit; echo "---"; dpkg -l | grep -cE "^i[FU] "'`
Expected: `dpkg --audit` vuoto e conteggio `0`.

- [ ] **Step 3: Verifica l'arsenale mobile già installato**

Run: `f3-kali bash -lc 'for b in apktool jadx apksigner zipalign androguard apkid drozer; do printf "%s " $b; type -p $b || echo MISSING; done'`
Expected: tutti con path (nessun `MISSING`).

---

### Task 6: Telefono — arsenale ampio (per-package, proot-safe)

**Files:**
- Create (sul telefono): `~/stavros/tools/f3-arsenal.sh` — helper eseguibile dentro `f3-kali`

**Interfaces:**
- Consumes: un Kali arm64 con rete attiva (download via telefono, egress del F3).
- Produces: i binari delle categorie recon/scan/web/creds/AD/services/host/wireless/cloud.

> Precondizione: ≥3 GB liberi nel rootfs (`f3-kali bash -lc 'df -h /'`); `metasploit-framework`,
> `chromium` e `seclists` sono pesanti. Prerequisito: Task 5 verde.

- [ ] **Step 1: Crea `tools/f3-arsenal.sh`**

```bash
#!/usr/bin/env bash
# f3-arsenal.sh — arsenale ampio nel proot Kali del F3. Idempotente, per-package,
# proot-safe. Esegui DENTRO f3-kali:  bash /root/stavros/tools/f3-arsenal.sh
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive

neutralize() {
  local p f
  for p in $(dpkg -l 2>/dev/null | awk '$1=="iF"||$1=="iU"{print $2}'); do
    f="/var/lib/dpkg/info/$p.postinst"; [ -e "$f" ] || continue
    [ -e "$f.real" ] || mv "$f" "$f.real"; ln -sf /bin/true "$f"
  done
}
restore() {
  local f
  for f in /var/lib/dpkg/info/*.postinst.real; do
    [ -e "$f" ] || continue; rm -f "${f%.real}"; mv "$f" "${f%.real}"
  done
}
apt_one() {  # UN pacchetto per volta: un nome inesistente non aborta gli altri
  apt-get install -y --no-install-recommends "$@" && return 0
  neutralize; dpkg --configure -a || true
  apt-get install -y --no-install-recommends "$@" && return 0
  neutralize; dpkg --configure -a || true
  return 0
}

# runtime
apt_one golang-go pipx chromium

# apt (Kali arm64)
for p in masscan httpx-toolkit gobuster dirsearch feroxbuster wfuzz whatweb dalfox commix \
         xsser wpscan dirb arjun whois proxychains4 john hashcat medusa crunch \
         netexec impacket-scripts responder evil-winrm enum4linux-ng ldap-utils bloodhound.py \
         certipy-ad smbclient snmp chisel aircrack-ng reaver hcxdumptool hcxtools wifite \
         hostapd dnsmasq iw macchanger tcpdump tshark awscli; do
  apt_one "$p"
done
apt_one metasploit-framework   # pesante: separato

# go install (ultime release)
export PATH="$PATH:$(go env GOPATH 2>/dev/null)/bin"
for m in \
  github.com/projectdiscovery/httpx/cmd/httpx@latest \
  github.com/projectdiscovery/subfinder/v2/cmd/subfinder@latest \
  github.com/projectdiscovery/dnsx/cmd/dnsx@latest \
  github.com/projectdiscovery/katana/cmd/katana@latest \
  github.com/projectdiscovery/nuclei/v3/cmd/nuclei@latest \
  github.com/projectdiscovery/naabu/v2/cmd/naabu@latest \
  github.com/projectdiscovery/shuffledns/cmd/shuffledns@latest \
  github.com/projectdiscovery/mapcidr/cmd/mapcidr@latest \
  github.com/projectdiscovery/uncover/cmd/uncover@latest \
  github.com/projectdiscovery/interactsh/cmd/interactsh-client@latest \
  github.com/ffuf/ffuf/v2@latest github.com/hahwul/dalfox/v2@latest \
  github.com/lc/gau/v2/cmd/gau@latest github.com/tomnomnom/waybackurls@latest ; do
  go install "$m" 2>/dev/null || echo "[i] go: $m fallito"
done

# pipx
for t in h8mail ghauri xsstrike lfimap certipy-ad; do
  pipx install "$t" 2>/dev/null || pipx upgrade "$t" 2>/dev/null || echo "[i] pipx: $t fallito"
done

# wordlist + template nuclei (senza questi, nuclei/ffuf sono presenti ma inutili)
apt_one seclists
command -v nuclei >/dev/null 2>&1 && nuclei -update-templates || echo '[i] nuclei templates non aggiornati'

restore
echo '[+] arsenale ampio completato.'
```

- [ ] **Step 2: Copia e lancia dentro il proot**

```bash
adb push tools/f3-arsenal.sh /sdcard/Download/f3-arsenal.sh
# dentro f3-kali:
cp /sdcard/Download/f3-arsenal.sh /root/stavros/tools/f3-arsenal.sh && chmod +x /root/stavros/tools/f3-arsenal.sh
bash /root/stavros/tools/f3-arsenal.sh 2>&1 | tee /root/f3-arsenal.log
```
Expected: `[+] arsenale ampio completato.`; le righe `[i] … fallito` indicano solo i tool non
disponibili su questa release (da riportare, non da nascondere).

- [ ] **Step 3: Verifica lo stato di dpkg**

Run: `f3-kali bash -lc 'dpkg --audit; dpkg -l | grep -cE "^i[FU] "'`
Expected: audit vuoto, conteggio `0`.

- [ ] **Step 4: Verifica il tool-plane per categoria**

Run: `f3-kali bash -lc 'cd /root/stavros && node tools/tool-plane.js --require-bin nmap,ffuf,gobuster,feroxbuster,dirsearch,wfuzz,httpx,subfinder,katana,dnsx,gau,waybackurls,dalfox,whatweb,john,hashcat,netexec,enum4linux-ng,ldapsearch,certipy,msfconsole,chisel,aircrack-ng,tcpdump,tshark,aws,chromium,apktool,jadx,frida,objection,mitmproxy,drozer'`
Expected: `preflight OK`.

---

### Task 7: Telefono — obscura aarch64 + verifica dei backend CDP

**Files:**
- Create (sul telefono): `~/stavros/vendor/tools/obscura/obscura` (root vendor *legacy*, così
  `tools/vendor-dir.js` lo risolve senza variabili d'ambiente)

**Interfaces:**
- Consumes: `tools/obscura.js` (`resolveBin`, `status`), `tools/dom-check.js` (`--backend`).
- Produces: un endpoint CDP consumabile da `dom-check.js`.

- [ ] **Step 1: Scarica e installa obscura arm64** (dentro `f3-kali`)

```bash
OB=/root/stavros/vendor/tools/obscura
mkdir -p "$OB"
curl -fL --max-time 600 -o /tmp/obscura.tgz \
  https://github.com/h4ckf0r0day/obscura/releases/download/v0.2.3/obscura-aarch64-linux-stealth.tar.gz
echo "sha256: $(sha256sum /tmp/obscura.tgz | cut -d' ' -f1)  # registralo nel vendor-mirror"
tar xzf /tmp/obscura.tgz -C "$OB" && chmod +x "$OB"/obscura* && rm -f /tmp/obscura.tgz
```
Expected: `obscura --version` risponde.

- [ ] **Step 2: Verifica il wrapper**

Run: `f3-kali bash -lc 'cd /root/stavros && node tools/obscura.js status'`
Expected: `binary.source: "vendor"`, `version: "0.2.x"`, `server.up: false`.

- [ ] **Step 3: Verifica il backend Chrome**

Run: `f3-kali bash -lc 'chromium --headless=new --no-sandbox --remote-debugging-port=9222 about:blank & sleep 4; curl -s http://127.0.0.1:9222/json/version; kill %1'`
Expected: JSON con `Browser` (se assente, chromium manca: torna al Task 6).

- [ ] **Step 4: Verifica dom-check su un target in scope** (replace `<host-in-scope>`)

Run: `f3-kali bash -lc 'cd /root/stavros && node tools/dom-check.js https://<host-in-scope>/ --backend obscura'`
Expected: report DOM (form, sink, localStorage) — nessun errore di backend.

---

### Task 8: Root — Magisk sul Poco F3 (alioth)

**Files:** nessun file di repo; produce un `magisk_patched-*.img`.

**Interfaces:**
- Consumes: `adb`/`fastboot` dal PC; `payload-dumper-go`; app Magisk.
- Produces: `su` funzionante sul device (usato da `tools/mobile.js` e dagli script f3bot).

> **Operazione irreversibile.** Richiede conferma esplicita dell'operatore. Bootloader già
> sbloccato; recovery = Lineage Recovery (TWRP non più presente). Fai un nandroid prima.

- [ ] **Step 1: Estrai il `boot.img` della build installata**

```bash
# build esatta: adb shell getprop ro.lineage.version → 23.2-20260916-NIGHTLY-alioth
unzip lineage-23.2-20260916-NIGHTLY-alioth.zip payload.bin
payload-dumper-go -p boot payload.bin -o out/
test -f out/boot.img && echo "boot.img OK"
```
Expected: `boot.img OK`.

- [ ] **Step 2: Patch con Magisk**

```bash
adb push out/boot.img /sdcard/Download/
# sul telefono: apri Magisk → Install → Select and Patch a File → scegli boot.img
adb pull /sdcard/Download/magisk_patched-*.img .
```
Expected: un file `magisk_patched-*.img` scaricato sul PC.

- [ ] **Step 3 (opzionale, consigliato): test senza flashare**

```bash
adb reboot bootloader && fastboot boot magisk_patched-*.img
```
Expected: il telefono riparte; `adb shell su -c id` → `uid=0` solo per questa sessione.

- [ ] **Step 4: Flash permanente**

```bash
fastboot flash boot magisk_patched-*.img
fastboot reboot
```
Expected: boot normale; Magisk app mostra "Installed".

- [ ] **Step 5: Verifica**

```bash
adb shell su -c id
```
Expected: `uid=0(root) gid=0(root) …`.

---

### Task 9: Dopo il root — frida-server, CA di sistema, cattura raw

**Files:**
- Create (device): `/data/local/tmp/frida-server`
- Modify (device): trust store di sistema via bind-mount conscrypt

**Interfaces:**
- Consumes: `su` (Task 8), `tools/mobile.js frida-server`, `tools/mobile-physical-setup.sh`.
- Produces: `mobile.js frida` funzionante contro il F3 stesso.

- [ ] **Step 1: Consegna frida-server** (versione = client 17.18.0)

```bash
bash ~/f3bot/frida-server-fetch.sh bb83609b    # scarica arm64 e pusha in /data/local/tmp
```
Expected: `frida-server <ver> consegnato e verificato`.

- [ ] **Step 2: Avvia e verifica via mobile.js**

```bash
node tools/mobile.js frida-server up bb83609b --confirm "self-pentest F3"
node tools/mobile.js frida-server status bb83609b --confirm "verify"
```
Expected: `running: true`, forward `tcp:4747`.

- [ ] **Step 3: CA mitm di sistema**

```bash
bash ~/f3bot/f3-ca-install.sh                 # usa su 0 + bind-mount conscrypt
# oppure: node tools/mobile-physical-setup.sh
```
Expected: la CA mitm nel trust store di sistema; `mitmdump` intercetta HTTPS delle app.

- [ ] **Step 4: Cattura raw (lato kernel Android)**

```bash
adb shell su -c '/system/bin/tcpdump -i any -w /data/local/tmp/cap.pcap'
```
Expected: cattura avviata (il `tcpdump` del proot NON basta: serve il kernel).

---

### Task 10: Verifica finale (PC + telefono) e chiusura

**Files:** nessuno.

- [ ] **Step 1: Gate PC**

Run: `cd /home/stavros/Desktop/stavrosredteamer && npm test`
Expected: `PASS=103  FAIL=0`.

- [ ] **Step 2: Doctor PC**

Run: `node tools/doctor.js --check`
Expected: exit 0 (nessun core rotto; scope.json presente).

- [ ] **Step 3: Doctor sul telefono**

Run: `f3-kali bash -lc 'cd /root/stavros && node tools/doctor.js --check'`
Expected: nessun errore bloccante; i mancanti residui sono solo i non-arm64.

- [ ] **Step 4: mobile.js**

Run: `node tools/mobile.js status` (PC, con device USB) e `node tools/mobile.js frida-server status bb83609b --confirm "verify"`.
Expected: device in scope, `frida-server` running.

- [ ] **Step 5: Riepilogo e commit finale**

```bash
git status --short
git log --oneline -5
```
Expected: solo i file dei Task 1–3 modificati e committati; working tree pulito.

---

## Note di esecuzione

- **Task 1–3** sono repo (`npm test` verde obbligatorio). **Task 4** tocca `~/f3bot` (fuori repo:
  conferma prima). **Task 5–9** sono device: richiedono il telefono connesso; **Task 8–9** sono
  irreversibili e richiedono conferma esplicita.
- Nessun download deve uscire dal PC per i target: le installazioni avvengono **sul telefono**
  (`session-prompt-egress-f3.md`).
- Se un pacchetto non esiste su questa release Kali, l'installer per-package continua e lo registra:
  aggiungi il nome corretto all'elenco invece di raggruppare (la lezione di `apkid`).
