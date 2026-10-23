# Anonymous operations — runbook (operator-facing)

> Companion to [`egress-opsec.md`](egress-opsec.md) (mechanics of the chain) and
> [`THREAT-MODEL.md`](THREAT-MODEL.md) (what the guards do and do not cover).
> This file answers one question: **what actually makes a run unattributable, and what
> only feels like it.**
> Audience: operator with written authorization. Nothing here relaxes `scope.json`.

## 1. The three layers, kept separate

"Anonymous" is not one property. There are three independent ones, and a run is only
unattributable when all three hold.

| Layer | What identifies you | What actually fixes it | What does not |
|---|---|---|---|
| **Path** (source IP) | The public IP the target logs | SOCKS5 chain over Tor/VPS (`egress-proxy.js --socks5`), or the whole box under a VPN | Someone else's WiFi: the IP becomes *theirs*, not *nobody's*. The household line, the ISP contract and the AP owner's logs still point at one address |
| **Link identity** (L2/L3 on the joined network) | MAC, DHCP hostname ("parrot" = pentester), DHCP option fingerprint, probe/SSID history, NTP/mDNS chatter | `macchanger` before association, generic DHCP hostname, v6 off, no personal traffic on the box | A VPN: it starts *after* association. The AP owner sees the MAC and the hostname regardless |
| **Metadata** (payload, model, callback) | DNS/SNI in cleartext to the AP, `User-Agent`, TLS/JA3 and H2 fingerprint, cloud LLM prompts, OOB callback URL | Chained mode (remote DNS + UA rotation + header scrub), local model or `CYBOROS_PRIVACY=1`, OOB via a public tunnel | Rotating UA alone: the Node TLS stack still has its own JA3 |

The two goals are also in tension: **Tor** hides attribution but exit nodes are public and
often captcha-blocked by WAFs; a **residential WiFi** is what a defender expects to see and
rarely blocks. Serious work: WiFi altrui **+** VPN/Tor on top, never WiFi alone.

## 2. Hard limit that decides the whole plan: LAN targets

A Tor exit node has no route into RFC1918. So a target that lives on the network you joined
(the router, a NAS, a printer, another client) **cannot** be reached through the chain.
Measured, this box, same URL:

```
$ curl -s -m 6 -o /dev/null -w '%{http_code}\n' http://192.168.1.1/                     # direct
200
$ curl -s -m 25 --socks5-hostname 127.0.0.1:9050 -o /dev/null -w '%{http_code}\n' http://192.168.1.1/
000
```

Consequence, and it is not optional:

- **Public target** → chain ON. Everything HTTP(S) rides Tor, DNS remote, exit IP foreign.
- **LAN target** → chain OFF. You are visible to the AP owner's DHCP/flow table; anonymity
  comes only from layer 2 (MAC + hostname) and from the fact the line is not yours.
- A SOCKS5 upstream that *does* route RFC1918 (VPN gateway on the phone, WireGuard into the
  LAN) removes the contradiction — then chain ON for LAN too.

`run.js` injects `HTTP_PROXY` into every spawned binary while the proxy state file exists
([`run.js`](../tools/run.js#L575-L578)), so leaving the chain up during a LAN scan makes
tools fail on private IPs instead of falling back.

## 3. Known-false "anonymous" postures

| Posture | Why it fails |
|---|---|
| "I'm on the neighbour's WiFi, so I'm anonymous" | MAC `18:93:41:…` (Intel OUI), DHCP hostname `parrot`, mDNS/SSDP chatter, cleartext DNS to the AP, your whole flow history in the router's admin panel, correlatable by time. And the neighbour is a witness who can be asked |
| `wifi.js mac random` alone | It is confirm-tier and needs `CAP_NET_ADMIN`; it is **not** in `cap-manifest.json`, so without `setcap`/root it exits 1 *after* printing the unchanged MAC (see §5) |
| IPv6 left on | Dual-stack APs route v6 outside the chain for direct tools; the proxy refuses literal IPv6 targets on purpose ([`egress-proxy.js`](../tools/egress-proxy.js#L63-L73)), so v6 is pure leak surface |
| Cloud LLM + Tor | `local/llm.js` uses bare global `fetch` ([`llm.js`](../local/llm.js#L107)) which ignores `HTTP_PROXY`/`HTTPS_PROXY` — the provider sees your **real** IP plus the full prompt |
| OOB listener with the LAN IP as `--public-url` | The target calls back to your address directly; that is a beacon pointing at the engagement box ([`oob.js`](../tools/oob.js#L1-L20)) |
| Tools run outside `run.js` | No scope, no audit, no chain: `nmap`/`masscan`/`curl` from a bare shell are outside every guard (third route in the threat model) |
| Shipping `reports/` as-is | Real hostnames, real IPs, credentials. The repo is clean; the report is not |

## 4. Procedure — profile A: public target

```bash
# 0. box prep (root, outside this sandbox: sudo + no_new_privs are broken in it)
sudo ./grant-tool-caps.sh
sudo setcap cap_net_admin+ep /usr/bin/macchanger          # not in the manifest by design gap
sudo sysctl -w net.ipv6.conf.all.disable_ipv6=1
nmcli con mod "<SSID>" ipv4.dhcp-hostname DESKTOP-4F2A1C
sudo macchanger -r wlo1 && nmcli con up "<SSID>"          # MAC before association
node tools/wifi.js mac random wlo1 --confirm "opsec"      # or via the harness, once capped

# 1. chain + external verification (fail-closed: no green check, no scan)
node tools/egress-proxy.js listen --socks5 127.0.0.1:9050 --foreground
node tools/egress-proxy.js check        # exit_ips must be ONE address, different from your real one

# 2. authorization
node tools/scope-guard.js check https://target.example     # exit 0 or stop

# 3. execution — only through the harness
node tools/run.js nuclei -u https://target.example -severity high,critical
node tools/repeater.js --url https://target.example/ --vary 'x:1,2'
```

Notes:
- `--foreground` in a persistent terminal (or a systemd `--user` unit): the daemonized form
  dies with the shell in this environment.
- `repeater.js` rides the chain by itself and logs `[egress] chained …` on stderr
  ([`repeater.js`](../tools/repeater.js#L489-L496)) — if that line is missing, the mask is off.
- Raw-socket tools ignore `HTTP_PROXY`: run them under `proxychains` (`/etc/proxychains.conf`
  is already `socks4 127.0.0.1 9050` with `proxy_dns`) or they leave from the AP address.

Verification during the run, all three:

```bash
jq -r 'select(.chain==null) | .host' reports/tmp/egress-audit.jsonl | sort -u   # must be empty
sudo tcpdump -ni wlo1 'udp port 53 and not host 127.0.0.1'                      # must stay quiet
node tools/egress-proxy.js check                                                # re-run mid-engagement
```

## 5. Procedure — profile B: target on the joined LAN

```bash
node tools/egress-proxy.js stop                 # chain off: Tor cannot reach 192.168.x
node tools/wifi.js join "<SSID>" --confirm "path"    # ensures DHCP; carries dhcp-hostname above
node tools/scope-guard.js check http://192.168.1.1   # the CIDR must be in allowed_ips
node tools/run.js nmap -sT -Pn -p 1-1024 192.168.1.1 # -sT works as user; SYN needs caps
```

On this hardware, measured, these fail *before* the network is at fault:
`macchanger` (`Operation not permitted`), `masscan` and `arping` (`permission denied`),
`nmap -sS/-sU` (nmap's own `geteuid()` check), `iw … set monitor`
(`Operation not permitted`). All of them are the same root cause: no effective
`CAP_NET_ADMIN` while `no_new_privs` blocks `sudo` and file capabilities.

## 6. Procedure — profile C: the AP itself

`wlo1` advertises only `managed` + `IBSS`, no `monitor`, so `airodump-ng`/`reaver` cannot
run on this NIC: handshake capture and WPS need a monitor-capable adapter (a second one,
kept out of the path). Passive association via `nmcli` still works.

```bash
node tools/wifi.js scan wlan0                 # monitor NIC: airodump, in scope or it refuses
# add BSSIDs/ESSIDs/channels to wifi-scope.json, then:
node tools/wifi.js open wlan0
node tools/wifi.js capture <BSSID> --channel N --confirm "authorized"
node tools/wifi.js crack reports/wifi/capture-*.cap
```

## 7. Gate: before the words "completely anonymous"

- [ ] `scope.json` / `wifi-scope.json` contain the target, and `scope-guard` exits 0
- [ ] `egress-proxy.js check` → one exit IP, not the AP's
- [ ] `reports/tmp/egress-audit.jsonl` has no line with `chain: null`
- [ ] no cleartext DNS from the local resolver during the run
- [ ] IPv6 disabled, or the AP has none
- [ ] MAC ≠ permanent, DHCP hostname ≠ `parrot`
- [ ] LLM: local model, or `CYBOROS_PRIVACY=1`, or the whole box under VPN/proxychains
- [ ] OOB `--public-url` points somewhere that is not your address
- [ ] no personal traffic on the engagement box (browser sync, mail, apt, cloud IDE)

## 8. Gaps worth closing in code

1. `macchanger` and `iw` missing from `cap-manifest.json`; `mac` also returns exit 1 without
   surfacing macchanger's stderr, so the failure is silent ([`wifi.js`](../tools/wifi.js#L416-L422)).
2. `egress-proxy.js` has no direct path for RFC1918 targets (§2): a `--direct-cidr` allowlist
   (chain for everything except listed private ranges) would remove the ON/OFF toggle.
3. `local/llm.js` does not honor the proxy env: install an undici `EnvHttpProxyAgent` as the
   global dispatcher when `HTTPS_PROXY` is set.
4. `run.js` refuses non-target binaries: `node tools/run.js macchanger -r wlo1` →
   `no target host found in args (fail closed)`.
5. `oob.js` defaults `--public-url` to `127.0.0.1`; it should refuse to start an engagement
   listener without an explicit publically reachable URL.
6. No v6 kill switch: an `nft` rule dropping `meta nfproto ipv6` outside `lo` would make the
   "v6 is a leak" line enforceable instead of procedural.
