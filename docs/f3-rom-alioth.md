# docs/f3-rom-alioth.md — Poco F3 (alioth): ROM dedicata per il client harness

> Decisione 2026-09-21: il F3 è telefono secondario, bootloader già sbloccato, root+TWRP presenti.
> Obiettivo: ROM pulita, minimale, ufficiale e aggiornata → **LineageOS 23.2 vanilla (no GApps)**.
> Il client harness (Termux + proot, `tools/f3-client-setup.sh`) NON dipende dalla ROM: questa
> procedura si fa prima, poi si rilancia il bootstrap Termux.

## Perché LineageOS ufficiale

- Ufficiale per alioth, build correnti (23.2 = Android 16 QPR2), aggiornamenti OTA regolari.
- Vanilla = zero GApps, zero egress verso Google: coerente con l'opsec dell'harness
  (`docs/egress-opsec.md`). Le uniche app extra: Termux (F-Droid) e nulla altro.
- Niente bloat MIUI/HyperOS: più RAM libera (il telefono resta comunque solo client),
  Android aggiornato = phantom-killer gestibile e SELinux sano.

## 0. Prerequisiti e stato di partenza

| Cosa | Stato | Azione |
|---|---|---|
| Bootloader | già sbloccato | nulla (MA: dopo il flash di firmware stock si ri-sblocca in 30 s con Mi Unlock, senza attesa — l'attesa 30 giorni vale solo per il PRIMO sblocco) |
| TWRP | installato | verrà SOSTITUITO da Lineage Recovery (serve: TWRP non gestisce gli update OTA di LOS) |
| Root | presente (Magisk?) | verrà perso col flash; si ri-roota dopo con Magisk su boot.img di LOS, SOLO se serve |
| PC | adb + fastboot | già presenti su Parrot |
| **Firmware** | ??? da verificare | **passo 1, obbligatorio** |

Backups: fai comunque un **nandroid TWRP** su SD/USB-OTG prima di iniziare. Se qualcosa va storto,
ripristini e riparti (TWRP resta bootabile finché non flashi vendor_boot di LOS).

## 1. Firmware: il requisito critico (da NON saltare)

LOS 23.2 richiede **firmware HyperOS specifico per regione**, a prescindere dalla ROM attuale
(da custom ROM non c'è garanzia che le partizioni firmware siano a quel livello):

| Regione | Versione richiesta |
|---|---|
| POCO F3 Global | **OS1.0.2.0.TKHMIXM** |
| POCO F3 EEA | OS1.0.1.0.TKHEUXM |
| POCO F3 Indonesia | OS1.0.1.0.TKHIDXM |
| POCO F3 Russia | OS1.0.2.0.TKHRUXM |
| POCO F3 Taiwan | OS1.0.1.0.TKHTWXM |
| POCO F3 Turkey | OS1.0.2.0.TKHTRXM |

Se non sai che firmware c'è ora (normale da custom ROM): flasha direttamente la fastboot ROM
stock della versione richiesta — è l'operazione più sicura e ti rimette su una base nota.

1. Scarica la **Fastboot ROM** della versione richiesta per la TUA regione
   (xiaomifirmwareupdater.com/firmware/alioth/ o mirror; file `.tgz` da 3-4 GB).
2. Estrai e lancia (in realtà NON lancia nulla: estrai solo gli script `flash_all*.sh`
   e usa SOLO le parti firmware, oppure flasha tutto e rifai unlock+twrp — vedi nota):

```bash
# piano consigliato: flash completo stock + ri-sblocco + TWRP di nuovo
unzip/tar -xzf alioth_*.tgz
cd alioth_*/
./flash_all.sh          # NB: script pensato per Windows .bat: su linux verifica i fastboot dentro
```

3. Ri-sblocco bootloader (rapido, senza attesa: il dispositivo è già nella whitelist del tuo
   account Mi): `Mi Unlock Tool` su Windows, o direttamente se lo strumento lo permette.
4. TWRP di nuovo: `fastboot boot twrp-alioth.img` → poi `Install` del TWRP installer zip,
   così torna persistente.

> **Alternativa più rapida** (se ti fidi dello slot inattivo): flasha SOLO le partizioni firmware
> dalla fastboot ROM (firmware-update, dsp, modem, bluetooth, tz, hyp, keymaster, xbl...),
> senza userdata. È ciò che fa `flash_all.sh` meno `userdata`. MA su slot A/B sbagliare l'insieme
> è il modo classico di semi-brickare: se non riconosci le partizioni a occhio, fai il flash
> completo — su un telefono secondario non hai nulla da salvare.

## 2. Installazione LineageOS 23.2 (procedura ufficiale wiki, adattata)

Dalla pagina ufficiale (wiki.lineageos.org/devices/alioth — verifica lì le URL dei file):

```bash
# dal PC, in ~/Downloads/alioth/
# file necessari:
#   boot.img, dtbo.img, vendor_boot.img (recovery), copy-partitions-*.zip,
#   lineage-23.2-*-alioth.zip  (build vanilla: NO il file "gapps")
wget <link dal wiki>...

# 1. bootloader mode
adb -s bb83609b reboot bootloader
fastboot flash boot boot.img
fastboot flash dtbo dtbo.img
fastboot reboot bootloader
fastboot flash vendor_boot vendor_boot.img
fastboot reboot recovery          # deve comparire il LOGO LineageOS Recovery
```

> Il tuo TWRP viene sovrascritto dal flash di vendor_boot: è voluto. TWRP non è più compatibile
> con gli update OTA di LOS (usa recovery di LOS per gli OTA; se vuoi root dopo, Magisk si
> patcha su boot.img con `fastboot boot magisk.img` senza toccare vendor_boot).

```bash
# 2. slot consistenti (once-per-device): sideload copy-partitions
#    sul telefono: Apply update → Apply from ADB
adb -d sideload copy-partitions-20220613-signed.zip
#    poi: Advanced → Reboot to recovery

# 3. Factory reset (Format data/factory reset) — cancella TUTTO l'internal storage

# 4. sideload della ROM
adb -d sideload lineage-23.2-*-alioth.zip

# 5. NIENTE add-ons (vanilla, no GApps) → Reboot system now
```

Primo boot: fino a 15 minuti.

## 3. Post-install: hardening del client

1. **Niente account Google, niente SIM** (se non serve), WiFi della lab-net o hotspot dedicato.
2. **Developer options** → USB debugging ON; `adb` dal PC si ricollega come prima
   (serial `bb83609b` — mobile-scope.json resta valido: stesso serial fisico).
3. **Termux da F-Droid** (NON Play Store: è fork vecchio). Poi:
   ```bash
   pkg update && pkg upgrade
   # transport dal PC (come runbook §2):
   bash f3-client-setup.sh --pc-user stavros --pc-host 100.83.109.28
   ```
4. **Phantom process killer** (Android 16 lo ha ancora; con LOS la cosa pulita è da adb, PC):
   ```bash
   adb shell device_config put activity_manager max_phantom_processes 2147483647
   ```
   In LOS puoi anche montare l'override persistente in `/data/adb/...` SOLO se ri-rooti con Magisk;
   senza root: ripeti il comando `device_config` dopo ogni boot (o cron da Termux stesso).
5. **Tailscale**: niente Play Store → APK da F-Droid o tailscale.com/download e login
   col tuo account (host `poco-f3` nella tailnet).
6. **Magisk (opzionale, SOLO se serve root sul client)**: estrai boot.img dal build LOS
   (payload.bin → boot.img), patcha con l'app Magisk, `fastboot flash boot magisk_patched.img`.
   Ricorda che root sul telefono CLIENT non serve per l'harness; serve solo se vuoi eseguire
   self-pentest mobile direttamente da lui (in quel caso: frida-server arm64 come runbook §4).

## 4. Rollback / ripristino

- **Nandroid TWRP** fatto al passo 0: se TWRP è stato sovrascritto da LOS recovery, ripristinalo
  con `fastboot boot twrp-alioth.img` (boot temporaneo senza installare) → Restore dal backup.
- Tornare stock completo: reflash della fastboot ROM stock (`flash_all.sh`) come passo 1.

## 5. Checklist finale (client operativo su LOS)

```
[ ] LOS 23.2 vanilla bootata, OTA in Impostazioni funzionanti
[ ] Termux (F-Droid) + f3-client-setup.sh completato senza errori
[ ] f3-tunnel && hermes-f3 -z "scope-guard check example.com" → verdetto reale
[ ] f3-kali → node tools/doctor.js → nessun errore bloccante
[ ] adb dal PC vede ancora bb83609b (mobile-scope.json coerente)
[ ] phantom killer disattivato (device_config, post-boot)
[ ] Tailscale attivo e reachable dalla tailnet
```

## Note

- La regione del firmware la leggi dal nome del build stock attuale o da `fastboot getvar product`
  + valore `ro.boot.hwc` (CN/GL/EEA/ID/RU/TW/TU) prima di cancellare tutto: salvalo.
- Se il bootloader venisse ri-bloccato per errore durante il flash stock: ri-sbloccalo SUBITO
  con Mi Unlock (stesso account, senza attesa perché dispositivo già noto).
- LOS recovery non permette touch su alioth? Usa i tasti volume/power come da wiki.
