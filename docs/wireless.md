# Wireless (modalità separata)

> Dettaglio completo della modalità wireless; knowledge.md tiene solo la riga one-liner.
> Cerchiabile con `node tools/kb-search.js "wifi wps tier"`.

WiFi is a SEPARATE mode from the web/network pipeline: targets are BSSIDs/ESSIDs/stations/channels,
not IPs, and its scope lives in `wifi-scope.json` (copy `wifi-scope.example.json`). `scope.json`
(IP/host) does NOT cover wireless. Rules 1–3 and 5 above apply unchanged.

- **Scope guard:** `node tools/wifi-guard.js check <bssid|essid|station|channel>` — exit 0 = in scope.
  Empty wifi-scope.json blocks everything (fail-closed). A MAC is in scope if it's an allowed BSSID
  OR an allowed station.
- **Runner (always via wifi.js, never direct binaries):**
  - `node tools/wifi.js scan <iface>` — monitor mode + passive airodump-ng (auto tier).
  - `node tools/wifi.js capture <bssid> --channel N [--pmkid] [--confirm "<reason>"]` — handshake (deauth)
    or PMKID (hcxdumptool); confirm-tier.
  - `node tools/wifi.js crack <cap> [--wordlist <w>]` — offline aircrack-ng (auto).
  - `node tools/wifi.js wps <bssid> --channel N [--confirm "<reason>"]` — reaver; confirm-tier.
  - `node tools/wifi.js status` — discovered APs (reports/wifi-aps.jsonl).
- **Tier model:** passive scan + offline crack = auto. Anything that transmits toward a target
  (deauth, PMKID capture, WPS, wifite2 automation) = confirm: refused without `--confirm "<reason>"`
  plus explicit in-session approval. Unknown commands fail closed to confirm.
- **Findings:** record via `record-finding.js` with `host` = BSSID, `endpoint` = ESSID (cracked PSK/PIN,
  open network, weak cipher WEP/TKIP, WPS bypass).
- Requires a monitor-mode NIC. If it's absent or the driver fails, STOP and report it — never invent output.