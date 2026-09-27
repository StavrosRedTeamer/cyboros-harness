# Piano di ottimizzazione workspace Stavros (Red Teamer harness)

**Data:** 10 settembre 2026 · **Repo:** stavrosredteamer (Freebuff) · **Branch:** `command-center-redesign`
**Stato:** SOLO PIANO — nessuna modifica applicata al codebase.

## Diagnostica di partenza (misurata)

| Area | Valore | Nota |
|---|---|---|
| Dimensione workspace | 326 MB | di cui `vendor/` 301 MB (92%), `reports/` 19 MB |
| `vendor/tools/obscura` | 185 MB | binari gitignored (obscura + obscura-worker) |
| `vendor/tools/frida-server` | 107 MB | binario gitignored (android-x86_64) |
| `reports/tmp` | 15 MB | output probe, `main.dart.js` 8,5 MB |
| Repo git | 3,2 MB | sano, `vendor/` e `reports/` già ignorati |
| `npm test` | 65 s sequenziale → **23 s con `--jobs 4`** | runner supporta già il flag, default `jobs:1` |
| `knowledge.md` | 41,8 KB (~10k token) | letto da tutti i 28 agenti a ogni avvio |
| `skills/pentest-playbook/SKILL.md` | 56,4 KB | frontmatter description ~900 B sempre in contesto |
| GUI `.bak`/`.v1-forensic` | ~92 KB | **committati in git**, inutili |

Il motore è già lean: zero dipendenze npm, registry-driven tools, scope-guard e pacing in-process.

---

## Fase A — Ristrutturazione knowledge.md + skills

### A.0 Vincoli (determinano il design)

| Vincolo | Origine | Conseguenza |
|---|---|---|
| `knowledge.md rule 2` referenziato in codice | `tools/spray.js:4`, `tools/payloads/README.md:32`, `tools/payloads/llm-agentic.md:8`, `tools/payloads/mcp.md:7` | La numerazione ROE 1–5 **non si tocca** |
| `ops/harness.md` cita le sezioni per nome | "Verification levels", "False-positive duty", "WAF awareness", "Install valve", "Adversarial content discipline", "POC delivery" | Quei 6 nomi-sezione restano in knowledge.md |
| 28 agenti dicono "Read knowledge.md" | tutti i `.agents/stavros-*.ts` | Il file resta il primo read; il taglio è il risparmio reale |
| `kb-search.js` indicizza `knowledge.md` sempre + `docs/**/*.md` | `tools/kb-search.js:17-38` | I dettagli spostati in `docs/` restano ricercabili a costo zero |
| `doctor.js:101` verifica l'esistenza di `knowledge.md` | healthcheck | Nessun rename possibile |
| `loop-watch.js:72` cita "pentest-playbook" | advice | Solo label, nessun vincolo strutturale |

### A.1 knowledge.md: 41,8 KB → target ≤ 12 KB

**Resta inline (il "contratto"):**
1. **Compliance/authorization** — oggi DUE sezioni sovrapposte (~40 righe: "Compliance mode" + "Authorized engagement") → fusione in una sola sezione ~15 righe
2. **Rules of engagement 1–5 verbatim** (numerazione intoccabile)
3. **Toolbox trasformato in tabella compatta** (~200 righe → ~35): `tool | one-liner scopo | invocazione`. I flag dettagliati (es. tutta la doc `--vary`/`FUZZ`/`--extract`/`--race` di repeater.js) migrano in docs/
4. **Pipeline deterministica** — blocco comandi stavros.js (~20 righe, già compatto)
5. **Verify blocks** — compresso a ~10 righe (esempio JSON + 3 regole)
6. **Placeholders privacy** — 5 righe
7. **Verification levels** (tabella 4 righe), **False-positive duty**, **WAF awareness**, **Install valve**, **Adversarial content**, **POC delivery** — nomi-sezione preservati, testo già compatto
8. **Working style / Stage gates** — invariati
9. **NUOVA sezione map** ("dove sta il dettaglio"): elenco `docs/*.md` + invito a `kb-search.js` invece del re-read

**Trasferisce verbatim (relocation, nessuna perdita) in `docs/`:**

| Nuovo file | Contenuto (da knowledge.md) | ~KB |
|---|---|---|
| `docs/toolbox.md` | Flag completi per-tool: repeater (--vary/--diff/--extract/--session/--race/--upload/--timeout), jwt.js attack modes, cors/csp/header-check/desync, oob.js listen/hits, dom-check + obscura (tutti i caveat engine), analyze-bundle, graphql, map/chain/cvss/epss/threatintel, searchsploit + poc-archive, wp-check, upload-bypass, h8mail/breach, record-finding dettagli, report-html | ~9 |
| `docs/host-exploitation.md` | Sezione "Host exploitation" completa (sessions/c2-guard/msf/sliver/sshx/privesc/hardware) + "Threat intel & case studies" (repo-vet, caso Nethsecurity, SKELETONKEY/chimera, watchlist Nightmare_Eclipse/EXPLOITARIUM, Havoc CDN + OPSEC host-level) | ~7 |
| `docs/egress-opsec.md` | Egress gateway, chained SOCKS5 mode (5 bullet), `check`, OPSEC posture (proxychains/macchanger/IPv6) | ~4 |
| `docs/wireless.md` | Modalità wireless completa (wifi-guard, wifi.js comandi, tier model, findings) | ~3 |
| `docs/methodology-classes.md` | "Testing by class" dettagliato (BOLA/BFLA, SSRF/XXE, SSTI/deser, upload, race, JWT, CORS, GraphQL, CSP, WS, authn, csrf, cloud, LLM/ASI) — knowledge.md tiene solo l'elenco classi one-line | ~6 |

Risultato atteso: **~70% di token in meno** su ogni turno agente che legge knowledge.md; il dettaglio resta a grep/`kb-search.js` (pattern già dichiarato in ops/harness.md: "grep su richiesta").

### A.2 skills/pentest-playbook/SKILL.md: 56,4 KB → target ≤ 20 KB

Problema aggiuntivo: la frontmatter `description` (~900 byte) è **sempre in contesto** quando la skill è disponibile.

**Resta in SKILL.md** (il "quando/cosa"): frontmatter con description accorciata (~200 B); termini autorizzazione; baseline asset; **timeline fasi** (0–6 + tabella canali per fase); blackboard machine-readable; **regole complete gate P1–P3**; **sub-agent orchestration** (ruoli, dispatch-completeness gate, blackboard, gate matrix, conflitti); dialetto workflow (C1w/E7).

**Trasferisce in `references/`** (il "come", letto su richiesta — le skill caricano solo SKILL.md):

| Nuovo file | Contenuto | ~KB |
|---|---|---|
| `references/tool-manual.md` | Strategia canali (3 principi + scala 5 livelli), unloading valve, tabelle fasi, appendici A/B/C/C-2/D (incl. D.1 mappa refs/ e D.3 rate) | ~18 |
| `references/hunting-surface.md` | 12 dimensioni, tabella per-faccia, red lines, trigger tripli, noise levels, segnali deterministici (tabella per classe) | ~10 |
| `references/client-side.md` | Linea client completa (miniapp/app/desktop: canali, unpacking wxapkg/apk/asar, frida, superfici specifiche, handoff) | ~8 |
| `references/verification-reporting.md` | Verifica + triple di confronto, registrazione findings, template report, retest loop, minimizzazione dati sensibili, timeline/residui | ~6 |

Nota path: D.1 risolve `refs/` come `../../refs/` da SKILL.md — da `references/` diventa `../../../refs/`; aggiornare il testo.

**Duplicato autostavros:** `skills/autostavros/SKILL.md` e `.agents/skills/autostavros/SKILL.md` sono identici (4.400 B). Verificare quale percorso Freebuff carica davvero; una copia canonica, l'altra rimossa o resa riferimento. **DECISION POINT 1.**

### A.3 Aggiornamenti collegati
- `ops/harness.md` riga "read skills/pentest-playbook/SKILL.md once at start" → "read SKILL.md skeleton; grep `references/<file>.md` per il dettaglio" (coerente col pattern refs già adottato: mai stream di file interi)
- README sezione Struttura: menzionare nuovo layout docs/ + references/

### A.4 Verifica Fase A
1. `wc -c`: knowledge.md ≤ 12 KB, SKILL.md ≤ 20 KB
2. Diff semantico: ogni sezione spostata esiste nel file di destinazione (estratto titoli prima/dopo e confronto)
3. `node tools/kb-search.js index && node tools/kb-search.js "repeater vary FUZZ"` → hit da docs/
4. `grep -rn "rule 2" tools/ payloads/` → riferimenti ancora validi
5. `node tools/doctor.js` → knowledge.md OK
6. `npm test` → 72 PASS

---

## Fase B — Stop vendoring binaries

### B.0 Stato attuale
- `vendor/tools/obscura/` 185 MB + `vendor/tools/frida/frida-server` 107 MB = **~290 MB** (gitignored; peso solo disco/sync)
- `install-tools.sh` **già scarica** i binari con sha256 pinning nella workspace → il vendor è ridondante rispetto all'installer
- Risoluzione binaria già a fallback: `$STAVROS_OBSCURA_BIN > vendor/ > $PATH` (obscura.js), `env > vendor/` (stavros.js per noauth_finder/aptpp)
- `vendor/tools/{aptpp,noauth_finder}` (script python piccoli, operator-vetted) → **restano**
- `vendor/mirror/` 11 MB + `vendor/poc-archive/index.json` → usati da `vendor-mirror.js`/`searchsploit.js` → **restano in questa fase** (11 MB, 4 consumatori da toccare per poco guadagno)
- **Bug pre-esistente:** `tools/mobile.js:128` referenzia `vendor/tools/frida/unpin.js` che **non esiste** (la dir contiene solo il binario)

### B.1 Nuova regola di risoluzione (un solo helper)
- Nuovo `tools/vendor-dir.js`: `vendorRoot()` = `$STAVROS_VENDOR_DIR` → `~/.local/share/stavros/vendor` (XDG) → workspace `vendor/` (fallback legacy)
- Adottato da: `obscura.js` (VENDOR_BIN), `stavros.js` (resolveVendorRel di noauth_finder/aptpp), `mobile.js`, `doctor.js` (checkVendor), `vendor-mirror.js` (solo se B.5)

### B.2 Modifiche per file

| File | Azione |
|---|---|
| `tools/vendor-dir.js` | NUOVO, ~30 righe zero-dipendenze |
| `tools/obscura.js` | `VENDOR_BIN()` usa `vendorRoot()`; commento header aggiornato |
| `tools/stavros.js` | resolveVendorRel aggiunge la root esterna dopo env e prima del legacy |
| `tools/mobile.js` | fix path unpin.js: `tools/frida/unpin.js` in-repo + env `STAVROS_FRIDA_SCRIPT` (**DECISION POINT 2**: creare lo script unpin reale, oggi mancante — alternativa: richiedere `--script` esplicito) |
| `tools/doctor.js` | checkVendor lista le path nelle root esterne; messaggi fix aggiornati ("./install-tools.sh — installa fuori dalla workspace") |
| `install-tools.sh` | `OBSCURA_DIR`/frida dir → `vendorRoot()` (crea dir fuori repo, rispetta STAVROS_VENDOR_DIR); sha256 pinning invariato; blocco summary finale (~r.323) aggiornato |
| `install-tools.ps1` | messaggi aggiornati (oggi dicono "estrai in vendor\tools\obscura\") |
| `README.md` | Struttura: vendor/ = "script vetted piccoli; i binari grossi vivono fuori dalla workspace, li installa install-tools.sh" |
| `.gitignore` | invariato (`vendor/` resta ignorato) |

### B.3 Rimozione binari (dopo B.1/B.2)
```bash
rm vendor/tools/obscura/obscura vendor/tools/obscura/obscura-worker
rm vendor/tools/frida/frida-server
```
→ workspace 326 MB → **~36 MB**. Fresh-clone: `./install-tools.sh` scarica i binari pinnati fuori dal repo; spostare/copiare la cartella non porta più 290 MB.

### B.4 Verifica Fase B
1. `node tools/vendor-dir.js` (print root) → rispetta env/XDG
2. `STAVROS_OBSCURA_BIN=... node tools/obscura.js status` + senza env → risoluzione corretta, fallback PATH
3. `node tools/doctor.js` → sezione vendor coerente con le nuove path
4. `node tools/test-obscura.js` offline passa (mock, non il binario)
5. `npm test` → 72 PASS (nessun test dipende dai binari: verificato, test-obscura è "No binary, no network")
6. `du -sh vendor/` → < 15 MB

### B.5 Opzionale (fuori scope, solo se si vuole spingere)
- Spostare anche `vendor/mirror/` (11 MB) nella root esterna → tocca `vendor-mirror.js`, `doctor.js`, `searchsploit.js` (poc_archive), docs: sconsigliato ora, rapporto effort/guadagno basso
- Quick win separati (non inclusi in questo piano): rimozione `.bak` GUI da git, default `--jobs` in run-tests.js, rotazione `reports/tmp` in daily-maintenance.js

---

## Ordine di esecuzione proposto
1. A.1 + A.3 (knowledge.md + pointer) → verifica A.4
2. A.2 (SKILL.md split + harness.md) → verifica
3. B.1 + B.2 (helper + wiring) → verifica B.4 punti 1–4
4. B.3 (rm binari; recuperabile rilanciando install-tools.sh) → verifica completa
5. Commit separati per Fase A e Fase B

## Decision points (da chiudere prima di eseguire)
1. **Skill autostavros duplicata** (`skills/` vs `.agents/skills/`): quale percorso è quello caricato da Freebuff? L'altra copia si rimuove o si lascia?
2. **Bug `unpin.js`** (`tools/mobile.js:128` punta a un file inesistente): creare lo script unpin reale in-repo oppure imporre `--script` esplicito?
