# Wireless (modalità separata)

> Dettaglio completo della modalità wireless; knowledge.md tiene solo la riga one-liner.
> Cerchiabile con `node tools/kb-search.js "wifi wps tier"`.

WiFi is a SEPARATE mode from the web/network pipeline: targets are BSSIDs/ESSIDs/stations/channels,
not IPs, and its scope lives in `wifi-scope.json` (copy the tracked template:
`cp wifi-scope.example.json wifi-scope.json`). `scope.json` (IP/host) does NOT cover wireless.
Rules 1–3 and 5 above apply unchanged.

- **Scope guard:** `node tools/wifi-guard.js check <bssid|essid|station|channel>` — exit 0 = in scope.
  Empty wifi-scope.json blocks everything (fail-closed). A MAC is in scope if it's an allowed BSSID
  OR an allowed station.
- **Runner (always via wifi.js, never direct binaries):**
  - `node tools/wifi.js scan <iface>` — monitor mode + passive airodump-ng (auto tier).
  - `node tools/wifi.js open <iface>` — passive recon filtered to **open (OPN) APs**, with their client
    stations correlated from the airodump CSV (auto). `open` = `scan` + the open-network view.
  - `node tools/wifi.js capture <bssid> --channel N [--pmkid] [--confirm "<reason>"]` — handshake (deauth)
    or PMKID (hcxdumptool); confirm-tier.
  - `node tools/wifi.js crack <cap> [--wordlist <w>]` — offline aircrack-ng (auto).
  - `node tools/wifi.js wps <bssid> --channel N [--confirm "<reason>"]` — reaver; confirm-tier.
  - `node tools/wifi.js join <essid> [--bssid <mac>] [--confirm "<reason>"]` — associate to an open /
    captive-portal SSID via nmcli (DHCP included); confirm-tier.
  - `node tools/wifi.js mac <random|clone|reset> <iface> [--mac <m>] [--confirm "<reason>"]` —
    macchanger, e.g. to defeat MAC-based portal authorization; confirm-tier.
  - `node tools/wifi.js sniff <iface> [--write <prefix>]` — passive tcpdump capture to
    reports/wifi/*.pcap (auto).
  - `node tools/wifi.js rogue <essid> --channel N [--iface wlan0] [--gw 10.0.0.1] [--portal <dir>]
    [--collect] [--confirm "<reason>"]` — **rogue / evil-twin AP** (hostapd open AP + dnsmasq with a
    wildcard `address=/#/<gw>` so every lookup lands on the portal); confirm-tier `rogue_ap`. Configs
    are written to `reports/wifi/rogue/` (and are the audit trail of what was stood up); the daemons
    are spawned detached with PIDs + logs recorded.
  - `node tools/wifi.js rogue-stop [--iface wlan0] [--gw 10.0.0.1]` — kills the recorded PIDs and
    undoes the local changes (`ip addr del`, `ip_forward=0`); class `cleanup`, auto (rollback must
    always work).
  - `node tools/wifi.js status` — discovered APs (reports/wifi-aps.jsonl).
- **Tier model:** passive scan / `open` / `sniff` / offline crack / `cleanup` = auto. Anything that
  transmits toward a target (deauth, PMKID capture, WPS, wifite2 automation) **or** changes the local
  identity/state (join, MAC spoof, `rogue_ap`, `portal_serve`) = confirm: refused without
  `--confirm "<reason>"` plus explicit in-session approval. Unknown commands fail closed to confirm. An
  interface (`-i wlanX`) satisfies the target requirement only for mac/sniff/cleanup; AP-touching actions
  still need an in-scope BSSID/ESSID/channel (rogue requires the ESSID plus the channel in scope).
- **Findings:** record via `record-finding.js` with `host` = BSSID, `endpoint` = ESSID (cracked PSK/PIN,
  open network — CWE-311/CWE-319, weak cipher WEP/TKIP, WPS bypass).
- Requires a monitor-mode NIC. If it's absent or the driver fails, STOP and report it — never invent output.

## Captive portal (lato HTTP — tool separato)

Il captive portal è HTTP, quindi **NON** usa il modello BSSID/ESSID di `wifi-scope.json`: lo scope
è quello ordinario di `scope.json` (IP/host) via `scope-guard.js`. Ogni richiesta è scope-checkata e
DNS-pinnata (`net.js resolveAndGuard`, anti-rebinding), e ogni hop di redirect è ri-verificato.

> **Gateway privato = allowlist esplicita.** Il caso d'uso tipico (il portale vive sul gateway, es.
> `http://192.168.1.1/`) è **bloccato** finché non aggiungi quella rete a `scope.json → allowed_ips`
> (es. `"192.168.1.0/24"`, CIDR supportato): il fail-closed di `scope-guard.js` autorizza solo ciò
> che è elencato. Non c'è un bypass dedicato: aggiungi la subnet autorizzata e riprova. Senza,
> `node tools/portal.js probe http://192.168.1.1/` esce 1 e il `next_step` te lo ricorda.

`tools/portal.js` (READ-ONLY, zero-dep):

- `node tools/portal.js probe <url> [--json] [--no-follow]` — fino a 4 redirect seguiti; fingerprint
  del controller (Cisco WLC/Meraki, Aruba, UniFi, MikroTik, openNDS, pfSense, CoovaChilli, Fortinet,
  Ruckus, ...) e verdetto `portal_likely` con i segnali (WWW-Authenticate, form con password, marker
  captive, redirect verso path da portale). **auto** (solo lettura).
- `node tools/portal.js analyze <url> [--json] [--record]` — estrae form/campi e classifica i parametri;
  elenca le `surfaces` di bypass: parametro di redirect (CWE-601 open-redirect / post-auth redirect),
  **MAC/identità fornito dal client** (CWE-639 — candidato bypass di autorizzazione MAC-based),
  credenziali in chiaro su HTTP (CWE-319), form action verso host diverso, token replayabile (CWE-294).
  **auto** (solo lettura). Con `--record` emette il candidato `record-finding.js` della surface peggiore.
- Le `surfaces` sono **candidati da riprodurre**, non finding: provale con `repeater.js` (stesso
  scope-guard) e registra con `verify_level: suspected` finché non riprodotte. Il cambio MAC lato client
  è `node tools/wifi.js mac ...` (confirm-tier, `wifi-scope.json`), non portal.js.
- **Hosting del portale (awareness/lab):** `node tools/portal.js serve [<dir>] [--port 80] [--collect]
  --confirm "<reason>"` — confirm-tier `portal_serve` (rifiuta senza `--confirm`). Serve `index.html`
  dalla dir (o una pagina built-in) e registra ogni POST in `reports/tmp/portal-captures.jsonl`.
  La raccolta è un **secondo opt-in** (`--collect`): senza, i campi segreti (`password`/`pin`/`code`/…)
  vengono redatti e si contano solo i tentativi; con `--collect` i valori sono salvati in chiaro — vanno
  trattati secondo le regole di engagement e distrutti a fine test. Flusso completo: `wifi.js rogue` →
  `portal.js serve` → `wifi.js rogue-stop`, con l'audit in `reports/tmp/wifi-audit.jsonl`.