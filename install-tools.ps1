# Installer best-effort dei binari usati da Stavros (Windows).
# Non e obbligatorio: cio che manca, gli agent lo aggirano con curl/repeater.js.
# Richiede: Go (per i tool ProjectDiscovery) e Python+pipx (per sqlmap). Salta cio che non c'e.
#
# NOTA — modalita wireless / captive portal = SOLO Linux/Parrot. wifi.js, wifi-guard.js,
# portal.js e il rogue AP (hostapd+dnsmasq, monitor mode, sniff) non hanno equivalente nativo
# su Windows: usa WSL + ./install-tools.sh oppure una VM Linux con una NIC in monitor mode.
# Questo script NON installa tool wireless (i pacchetti apt aircrack-ng/hostapd/dnsmasq/...
# non esistono come tali su Windows).

Write-Host "== Stavros tool installer ==" -ForegroundColor Cyan

function Have($c) { return [bool](Get-Command $c -ErrorAction SilentlyContinue) }

if (Have go) {
  $pd = @(
    "github.com/projectdiscovery/httpx/cmd/httpx@latest",
    "github.com/projectdiscovery/subfinder/v2/cmd/subfinder@latest",
    "github.com/projectdiscovery/dnsx/cmd/dnsx@latest",
    "github.com/projectdiscovery/katana/cmd/katana@latest",
    "github.com/projectdiscovery/nuclei/v3/cmd/nuclei@latest",
    "github.com/ffuf/ffuf/v2@latest",
    "github.com/hahwul/dalfox/v2@latest",
    "github.com/lc/gau/v2/cmd/gau@latest",
    "github.com/tomnomnom/waybackurls@latest",
    "github.com/projectdiscovery/interactsh/cmd/interactsh-client@latest"
  )
  foreach ($p in $pd) { Write-Host "go install $p"; go install $p }
  Write-Host "Assicurati che $(go env GOPATH)\bin sia nel PATH." -ForegroundColor Yellow
} else {
  Write-Host "Go non trovato: salto httpx/subfinder/dnsx/katana/nuclei/ffuf/dalfox/gau/waybackurls." -ForegroundColor Yellow
}

if (Have pipx) {
  Write-Host "pipx install sqlmap"; pipx install sqlmap
} elseif (Have pip) {
  Write-Host "pip install --user sqlmap"; pip install --user sqlmap
} else {
  Write-Host "Python/pip non trovato: salto sqlmap." -ForegroundColor Yellow
}

if (Have nuclei) { Write-Host "nuclei -update-templates"; nuclei -update-templates }

if (Have interactsh-client) {
  Write-Host "interactsh-client disponibile: per OOB testing usa 'interactsh-client -o reports/oob/interactsh.jsonl -json -v' e inietta l'hostname .oast.fun nei parametri che fetchano URL." -ForegroundColor Yellow
} else {
  Write-Host "interactsh-client non trovato: per OOB (SSRF/XXE blind) usa il listener locale 'node tools/oob.js listen' (vedi knowledge.md)." -ForegroundColor Yellow
}
Write-Host "nmap: installalo a mano da https://nmap.org/download.html se ti serve." -ForegroundColor Yellow

# Obscura (headless browser CDP-compatibile, backend opzionale per dom-check.js).
# Su Windows l'archivio va scaricato ed estratto a mano (nessun package manager).
# I binari grossi vivono FUORI dal repo (root vendor esterna): %STAVROS_VENDOR_DIR% se
# impostata, altrimenti ~/.local/share/stavros/vendor (tools/vendor-dir.js) — copiare la
# workspace non trascina i binari.
$VendorRoot = if ($env:STAVROS_VENDOR_DIR) { $env:STAVROS_VENDOR_DIR }
             elseif ($env:XDG_DATA_HOME) { Join-Path $env:XDG_DATA_HOME "stavros\vendor" }
             else { Join-Path $HOME ".local\share\stavros\vendor" }
$ObscuraDir = Join-Path $VendorRoot "tools\obscura"
if (Test-Path (Join-Path $ObscuraDir "obscura.exe")) {
  Write-Host "Obscura gia presente in $ObscuraDir." -ForegroundColor Green
} elseif (Test-Path "vendor\tools\obscura\obscura.exe") {
  Write-Host "Obscura gia presente in vendor\tools\obscura (legacy in-workspace)." -ForegroundColor Green
} else {
  Write-Host "Obscura (opzionale): scarica obscura-x86_64-windows-stealth.zip da" -ForegroundColor Yellow
  Write-Host "  https://github.com/h4ckf0r0day/obscura/releases (versione pinnata: v0.2.0)" -ForegroundColor Yellow
  Write-Host "ed estrai obscura.exe + obscura-worker.exe in $ObscuraDir. Poi:" -ForegroundColor Yellow
  Write-Host "  node tools/obscura.js status ;  node tools/dom-check.js <url> --backend obscura" -ForegroundColor Yellow
}

Write-Host "Fatto (best-effort)." -ForegroundColor Green
