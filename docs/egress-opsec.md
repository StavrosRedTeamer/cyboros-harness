# Egress gateway & anonymized egress (red-team OPSEC)

> Dettaglio completo della modalità egress; knowledge.md tiene solo la riga della tabella toolbox.
> Cerchiabile con `node tools/kb-search.js "egress socks5"`.

To force third-party HTTP(S) binaries through the scope allowlist, start the proxy first:
`node tools/egress-proxy.js listen` (stop with `... stop`). While it runs, run.js sets HTTP_PROXY
for spawned binaries (nuclei/sqlmap/ffuf/httpx/curl) so every host is scope-checked + DNS-pinned;
if the proxy is down those connections simply fail (fail-closed). raw-socket tools (nmap/masscan)
ignore HTTP_PROXY and stay guarded by run.js's argv host extraction. repeater.js is never re-routed.

**Anonymized (chained) mode** — mask the source IP and everything that could identify us:
`node tools/egress-proxy.js listen --socks5 <host:port>` (Tor `127.0.0.1:9050`, VPN gateway, commercial
SOCKS5). While active:

- Every HTTP forward AND every CONNECT tunnel rides the SOCKS5 upstream — the target sees the upstream's
  exit IP, not ours. Raw DNS is sent to the upstream as a DOMAIN (socks5.js), so the LOCAL resolver never
  sees the destination hostnames (no DNS leak).
- User-Agent is rotated to a fresh realistic browser per request; identifying headers (X-Forwarded-For,
  X-Real-IP, Via, ...) are stripped before forwarding. Literal IPv6 destinations are refused (a v6 path
  that bypasses the chain is a leak).
- Scope-guard stays on: hostname/prefix/IP-CIDR rules still apply, but WITHOUT local DNS resolution — the
  DNS-rebinding pin is replaced by remote resolution at the upstream (the trade-off of chained mode).
- **repeater.js (the shell itself) auto-rides the chain**: when the egress daemon is running with --socks5,
  every repeater request goes through it (stderr logs `[egress] chained ...`).
- **Verify the mask from the outside:** `node tools/egress-proxy.js check [--socks5 host:port]` connects
  through the chain to public IP-echo endpoints and reports the exit IP (all echoes must agree) + confirms
  remote DNS. Set `EGRESS_ECHO_URL` to point check at your own endpoint.

OPSEC posture beyond the chain (what a serious red teamer does): run the WHOLE harness under proxychains or
an OS-level VPN so raw-socket tools (nmap/masscan/responder) and system DNS are covered too; disable IPv6
egress; `macchanger -r` before wireless monitor mode; use interactsh for OOB callbacks instead of the LAN IP;
no personal traffic from the engagement box.