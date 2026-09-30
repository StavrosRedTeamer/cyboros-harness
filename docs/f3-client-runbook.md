# docs/f3-client-runbook.md — Poco F3 come client dell'harness stavros

> Obiettivo (decisione 2026-09-21): **tutta l'harness gira sul telefono** (Termux + proot Kali),
> l'inferenza resta remota (llama di casa via tunnel, o cloud). Il telefono decide ed esegue,
> il cervello no. Regole, scope-guard e tier model dell'harness NON cambiano: vedi `ops/harness.md`.

## 1. Architettura

```
┌─────────────────────── Poco F3 (client) ───────────────────────┐
│ Termux: hermes-f3 (TUI, 15 tool)  ·  f3-tunnel (llama)         │
│         MCP stavros (mcp-bridge.js, node Termux, read-only)    │
│ proot Kali: node/adb/frida-tools/nmap/sqlmap/… (arm64)         │
│ workspace: ~/stavros (rsync dal PC, scope.json incluso)        │
└───────────────┬────────────────────────────────────────────────┘
                │ Tailscale (ssh, chiave ed25519 del telefono)
┌───────────────▼────────────── Parrot PC ───────────────────────┐
│ llama-server 127.0.0.1:8080 (RTX 4050)  ← tunnel -L del F3     │
│ sshd (tailscale only) · backend SSH di hermes-f3 per exec     │
│ workspace master: ~/Desktop/stavrosredteamer                   │
└────────────────────────────────────────────────────────────────┘
```

- **File/patch/read**: locali al telefono (toolset `file`, MCP read-only).
- **Exec pesante**: `terminal` → backend SSH → Parrot. Oppure in proot Kali sul telefono.
- **Inferenza**: tunnel `f3-tunnel` → llama di casa. Alternativa cloud: cambia `model.provider`
  in `~/.hermes-f3-home/config.yaml` (egress → viola l'AGENTS.md; scelta tua, esplicita).

## 2. Setup una-tantum

**PC (Parrot):**
```bash
bash tools/f3-client-parrot.sh
```
**Telefono (Termux, da F-Droid — NON Play Store):**
```bash
pkg install -y curl git openssh rsync
bash f3-client-setup.sh --pc-user <utente> --pc-host <ip-tailscale-del-pc>
```
(`--pc-user` e `--pc-host` sono obbligatori e non hanno default: l'IP tailscale del PC si
trova con `tailscale ip -4 | head -1`.)
Poi verifica:
```bash
f3-tunnel &                        # llama di casa su 127.0.0.1:8080 del telefono
hermes-f3 -z "che verdetto dà lo scope-guard per https://example.com?"
f3-kali -c "cd /root/stavros && node tools/doctor.js"
```
Il one-shot deve restituire il verdetto REALE dello scope-guard (esito hard-coded:
`example.com` fuori scope ⇒ `{"ok":false,...}`, exit 1).

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

## 3. Hardening Android (root/TWRP)

Il ROM custom serve a QUESTO, non al client in sé:

1. **Nandroid da TWRP** prima di toccare qualsiasi cosa.
2. **Phantom process killer** (se il passo 1 dello script da Termux è fallito), da PC:
   ```bash
   adb -s <serial> shell device_config put activity_manager max_phantom_processes 2147483647
   ```
   Persistente finché non si svuota `device_config` (alcuni ROM lo azzerano a boot: ripetere).
3. **Batteria**: Impostazioni → App → Termux → Batteria → *Nessuna restrizione*.
4. **Termux:BOOT** (F-Droid): rilancia `termux-wake-lock` e il tunnel al boot.
5. Aggiornamento ROM/TWRP: rifai il nandroid, ri-rilancia `f3-client-setup.sh` (idempotente).

## 4. Mobile: il F3 come target di se stesso

Root + TWRP rendono il telefono anche **device mobile in scope** (`mobile-scope.json`,
serial del tuo device già autorizzato):

```bash
# dentro proot Kali (o Termux: adb c'è in entrambi)
node tools/mobile.js check <serial>          # fail-closed come sempre
adb -s <serial> shell getprop ro.product.device   # shell_read, auto-tier
```

**frida-server arm64** (il vendor è x86_64 ReDroid — qui serve quello giusto, pushato sul device):
```bash
VER=$(frida --version)
curl -fsSL "https://github.com/frida/frida/releases/download/$VER/frida-server-$VER-android-arm64.xz" -o /tmp/fs.xz
unxz /tmp/fs.xz && adb -s <serial> push /tmp/fs /data/local/tmp/frida-server-arm64
adb -s <serial> shell su -c 'chmod 755 /data/local/tmp/frida-server-arm64'
adb -s <serial> shell su -c '/data/local/tmp/frida-server-arm64 &'   # root: solo sul TUO device
# attach (confirm-tier, serve --confirm):
node tools/mobile.js frida <serial> <pkg> --confirm "motivo"
```

**CA mitm nello store di sistema**: `tools/mobile-physical-setup.sh` è già pensato per il device
fisico (usa `~/bin/android-ca-install`, bind-mount conscrypt, SELinux enforcing) — sul F3 funziona
così com'è, con il telefono sia client sia target.

## 5. Limiti fisici (non aggirabili dal telefono)

| Limite | Perché | Dove sta la funzione |
|---|---|---|
| Monitor mode WiFi | firmware della NIC del F3 | PC (`tools/wifi.js`) o adapter USB esterno con chipset supportato |
| llama locale | 8-12 GB RAM, niente CUDA | PC o cloud (questo runbook) |
| binari x86 (alcuni exploit vendored) | arch arm64 | via backend SSH sul PC (tool-plane li marca mancanti, install valve gestisce) |
| `adb` contemporaneo PC+telefono | un host adb per porta 5037 | usane uno per volta, oppure `ANDROID_ADB_SERVER_ADDRESS` |

## 6. Uso quotidiano

```bash
termux-wake-lock
f3-tunnel &                 # se llama locale
hermes-f3                   # TUI: 15 tool come sul PC, cwd ~/stavros
```

Pattern utili:
- **Da telefono, exec su PC**: il modello usa `terminal` normalmente (backend ssh). Il cwd remoto
  è `/home/stavros/Desktop/stavrosredteamer`.
- **Da telefono, exec nel Kali del telefono**: `f3-kali` in un'altra sessione Termux, oppure il
  modello usa il tool `terminal` locale? No: il backend è UNO (ssh). Per exec locale usa
  `f3-kali` a mano o cambia `terminal.backend` (solo `local`/`ssh` alternati via env `TERMINAL_ENV`).
- **Off-network**: senza Tailscale/PC, il telefono può ancora ragionare su provider cloud (se
  configurato) ed eseguire con proot Kali: cambia `terminal.backend: local`.

## 7. Sync e update

```bash
# PC → telefono (workspace): dentro Termux
bash ~/stavros/tools/f3-client-setup.sh --pc-user <utente> --pc-host <ip-tailscale>   # idempotente, ri-rsync

# Aggiornare il fork hermes-stavros: SI FA DAL PC (rsync upstream + riapplica patch, vedi
# STAVROS-PATCHES.md), poi ri-rsync PC → telefono (passo 5 dello script di setup).

# Evidence produce sul telefono? riportale al PC (il report vive nel PC master):
rsync -az ~/stavros/reports/ <utente>@<ip-tailscale>:Desktop/stavrosredteamer/reports/
```

## 8. Sicurezza

- Chiave ed25519 senza passphrase **sul telefono cifrato** (FBE: la home Termux è dentro lo
  storage cifrato del profilo). Se vuoi di più: passphrase + `ssh-agent` in Termux.
- sshd sul PC raggiungibile **solo su tailscale0** (f3-client-parrot.sh §3).
- llama-server resta su `127.0.0.1` del PC: mai esposto, mai bindato su 0.0.0.0.
- scope/mobile-scope/wifi-scope restano **fail-closed** e viaggiano con la workspace: un clone
  del telefono è un clone dell'autorizzazione — attento a chi ci mette le mani sopra.

## 9. Il Command Center come client desktop di un backend tunnelato

Il backend ha **un solo processo** (`tools/gui-server.js`) e un lockfile in `reports/app/server.lock`:
qualunque superficie (shell PyQt6 sul PC, browser del telefono, TUI) si aggancia alla stessa istanza
e non spawna un secondo backend sui PTY. Sul PC:

```bash
./stavros-cc                 # finestra nativa; se PyQt6 manca → Chromium → browser
node tools/cc-instance.js url   # l'URL tokenizzato dell'istanza viva (per il telefono)
```

Dal telefono, via tunnel (il backend resta su loopback del PC):

```bash
# PC
ssh -L 8787:127.0.0.1:8787 <utente>@<ip-tailscale>   # dal telefono verso il PC
# telefono
node tools/cc-instance.js status    # dal PC: porta registrata
# nel browser del telefono apri l'URL tokenizzato stampato da: node tools/cc-instance.js url
```

Note:
- Il token di sessione **non** esce dalla loopback del PC: viaggia nell'URL (frammento `?token=`) —
  trattalo come una credenziale e non condividerlo; per una sessione di sola lettura usa
  `--read-only`, che rifiuta ogni write (403) e lascia la dashboard navigabile.
- Nessuna nuova egress: il client parla solo con il tunnel. I pannelli che escono davvero (Radar →
  GitHub) mostrano il badge egress.
- `--web` evita del tutto la shell nativa (utile da telefono): `./stavros-cc --web` apre l'URL già
  tokenizzato nel browser predefinito.
