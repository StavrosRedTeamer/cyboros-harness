# Setup GMKtec EVO-X2 — playbook operativo

Riferimento hardware: AMD Ryzen AI Max+ 395 (16C/32T), 128 GB LPDDR5X-8000
8-canale (~256 GB/s — l'APU è *bandwidth-bound* per l'inferenza), Radeon 8060S
(gfx1151, RDNA 3.5, 40 CU), memoria GPU assegnabile fino a 96 GB via GTT,
dual 2.5GbE, Wi-Fi 7, 2× USB4.

Valgono su **entrambe** le macchine; le differenze di ruolo (PC1 brain,
PC2 worker pool) sono alla fine di questo documento.

## 1. BIOS

- **UMA / GFX Frame Buffer**: impostare al massimo (fino a 96 GB). La memoria
  GPU su questa piattaforma è GTT condivisa: più si assegna, più KV cache e
  modelli grandi stanno senza swap.
- **Power limits**: se disponibili nel BIOS del vendor, fissare PL sostenuto
  (non solo boost) — il throughput LLM è costante per minuti, non secondi.
- **Secure Boot**: se si usa un kernel HWE custom o moduli ROCm fuori albero,
  valutare disabilitazione o gestione delle chiavi MOK.
- **Thermal**: verificare sotto carico sostenuto (`sensors` durante un
  benchmark di 10 minuti); il thermal throttling si vede subito sui tok/s.

## 2. Sistema operativo

- **Ubuntu 24.04 LTS o 25.x**, installazione minimale + `openssh-server`.
- **Kernel ≥ 6.16.9** obbligatorio per l'accesso completo alla memoria unificata.
  Con kernel **6.17+** serve ROCm 7.2 **nativo** (vedi sotto): le build ROCm in
  container (distrobox) si rompono contro il KFD ABI del kernel 6.17+
  (sintomo: `llama-server` crasha all'avvio).
- Aggiornare firmware (`fwupd`) prima di tutto il resto.

```bash
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y build-essential cmake git curl jq lm-sensors \
  python3-venv python3-pip linux-tools-common
uname -r   # deve essere >= 6.16.9
```

## 3. ROCm 7.2 nativo

```bash
# Installer ROCm ufficiale (versione 7.2.x), poi:
rocminfo | grep -i gfx   # deve mostrare gfx1151
```

- Installare ROCm **sull'host**, non in distrobox/container.
- Permessi GPU: aggiungere l'utente ai gruppi `render` e `video`, poi re-login.

```bash
sudo usermod -aG render,video $USER
```

- Se i toolchain del distro non trovano le librerie:

```bash
export LD_LIBRARY_PATH="/opt/rocm-7.2.4/lib:$LD_LIBRARY_PATH"
```

## 4. llama.cpp — build e validazione

```bash
cd ~ && git clone https://github.com/ggml-org/llama.cpp.git
cd llama.cpp && cmake -B build -DGGML_HIP=ON -DAMDGPU_TARGETS=gfx1151
cmake --build build -j$(nproc)
```

**Attenzione: le build vanno validate prima di fidarsi.** Su questo hardware
sono state osservate build che davano output corrotto *silenziosamente*
(es. un commit che dava +22% di velocità corrompeva i token). Procedura:

```bash
# 1. Backup della build corrente nota-buona
cp -r ~/llama.cpp/build/bin ~/llama.cpp/build/bin-backup-$(git -C ~/llama.cpp rev-parse --short HEAD)

# 2. Validazione: generazione deterministica + confronto con baseline
../evo-x2-lab/scripts/validate-llamacpp-build.sh \
  --bin ~/llama.cpp/build/bin \
  --model ~/models/<modello>.gguf

# 3. Solo se la validazione passa: promuovere la build (aggiornare i wrapper systemd)
```

Flag **obbligatori** su Strix Halo (tutti i servizi, nessuna eccezione):

```
--no-mmap      # GPU backend: mmap instabile
-ngl 99        # tutti i layer sulla GPU
-fa 1          # flash attention: senza, crash o corruzione
```

**MTP (Multi-Token Prediction) speculative decoding**: dove il modello lo
supporta, abilitarlo nei wrapper dà un guadagno netto di tok/s su questo
hardware. Verificare con `scripts/benchmark.sh` prima/dopo.

## 5. Servizio llama-server (systemd)

Un servizio per modello, porta dedicata, come da [deploy/models.yaml](../deploy/models.yaml).

`/etc/systemd/system/llama-server@.service`:

```ini
[Unit]
Description=llama-server (%i)
After=network.target

[Service]
Type=simple
User=llm
Environment=LD_LIBRARY_PATH=/opt/rocm-7.2.4/lib
ExecStart=/opt/evo-x2-lab/wrappers/%i.sh
Restart=on-failure
RestartSec=5
Nice=-5

[Install]
WantedBy=multi-user.target
```

Wrapper tipo `/opt/evo-x2-lab/wrappers/brain.sh` (parametri reali in models.yaml):

```bash
#!/usr/bin/env bash
exec ~/llama.cpp/build/bin/llama-server \
  -m ~/models/qwen3.8-flash-next-heretic.gguf \
  --host 0.0.0.0 --port 8081 \
  -ngl 99 -fa 1 --no-mmap \
  --ctx-size 131072 --parallel 2
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now llama-server@brain
```

## 6. Rete tra le due macchine

- **Direct-attach sulla porta 2.5GbE dedicata**: PC1 `10.0.0.1/24`, PC2
  `10.0.0.2/24` (interfaccia dedicata, es. `enp2s0`). La seconda porta va
  verso la LAN/switch del laboratorio.
- Il traffico tra i nodi è solo API JSON: 2.5GbE è più che sufficiente.
  **Non** serve 10GbE; se mai servirà banda (sync modelli), un adapter
  10GbE su USB4 è l'opzione senza aprire il case.
- Firewall: le porte dei `llama-server` **solo sulla rete 10.0.0.0/24**;
  il gateway 8080 è l'unico punto esposto verso la LAN operativa.

```bash
sudo ufw allow from 10.0.0.0/24 to any port 8081:8199
sudo ufw allow from 192.168.0.0/16 to any port 8080
sudo ufw enable
```

- NTP sincronizzato su entrambi i nodi (servirà per correlare gli audit log).

## 7. Modelli: download e provenienza

- Layout: `~/models/<modello>/<file>.gguf`, NVMe dedicato (il brain pesa
  45-85 GB; l'intero pool PC2 ~90 GB).
- **Pinnare gli hash** dei quant in un `models.lock` e verificarli al download.
  Solo builder fidati: Unsloth, Atomic, Qwen/Alibaba ufficiali, Kindo (Deep Hat).
  Motivo: incidente di supply chain su HuggingFace (luglio 2026) — un modello
  può contenere payload, non solo pesi.
- Brain: Qwen3.8-Flash-Next **Heretic/abliterated** (metodo HERETIC — build
  community: orcarouter, Atomic, DavidAU). Quant dinamico: il più piccolo
  richiede ~75 GB, la maggior parte ~85 GB — stanno in 128 GB con KV cache.
- Worker pool: vedi [deploy/models.yaml](../deploy/models.yaml).

## 8. Differenze per ruolo

### PC1 — Brain (10.0.0.1)
- Solo `llama-server@brain` (Qwen3.8-Flash-Next-Heretic).
- `--ctx-size` alto (131072+; il modello supporta 262K — alzare solo dopo
  aver misurato il KV cache a regime).
- `--parallel 2`: il brain risponde a piani e arbitraggi, non a fan-out.

### PC2 — Worker pool (10.0.0.2)
- Tutti i servizi worker (`llama-server@coder`, `@toolcaller`, `@parser`,
  `@cyber`, `@triage`, `@embed`, `@rerank`).
- `--parallel 3-4` sui modelli piccoli: qui arriva il fan-out best-of-k.
- Memoria: ~88-90 GB di pesi caricati → ~30 GB liberi per KV cache e OS.
  Se serve margine, `@cyber` (Deep Hat V2) si carica on-demand.
- Se in Fase 4 servirà concorrenza superiore, valutare vLLM 0.26 + ROCm 7.14
  al posto di llama.cpp per i worker (meglio su first-token e richieste
  parallele); llama.cpp resta la scelta giusta per il brain single-stream.

## 9. Checklist di accettazione della macchina

- [ ] `rocminfo` mostra gfx1151 senza errori
- [ ] `validate-llamacpp-build.sh` in verde sulla build corrente
- [ ] Benchmark atteso: pp ~800+ t/s, tg dipende dal modello (vedi report
      `scripts/benchmark.sh`); nessun crollo dopo 10 min di carico (thermal)
- [ ] `llama-server` sopravvive al reboot (systemd enable)
- [ ] Firewall: porte modello irraggiungibili dalla LAN, gateway 8080 raggiungibile
- [ ] Hash dei modelli verificati contro `models.lock`
