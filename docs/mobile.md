# Mobile (Android) — methodology & tool detail

> Dettaglio della linea mobile (M.1–M.4). knowledge.md tiene solo le one-liner; questo file è il "come".
> Indicizzato da `node tools/kb-search.js "<query>"`. Scope e tier sono enforced in codice
> (`tools/mobile-guard.js` + `tools/mobile.js`); il target model è SEPARATO dal web/network
> (packages, adb serials, hash APK — non IP/BSSID).

## Scope e tier (fail-closed)

`mobile-scope.json` è l'unica autorizzazione: `allowed_packages`, `allowed_serials`,
`allowed_apk_sha256`, `mobile_ops.auto|confirm`, e (M.2) `apk_sources`. File assente, JSON invalido o
`allowed_packages` vuoto = **tutta** la modalità mobile blocca. I seriali ammettono solo loopback
(`127.0.0.1`, `localhost`) o un serial USB esplicitamente in allowlist (device fisico autorizzato).
Ogni azione passa da `node tools/mobile.js` (scope-check + tier-check + audit in
`reports/tmp/mobile-audit.jsonl`). `frida/unpin/repack/intercept_write/reset` sono **confirm**
(`--confirm "<reason>"`).

## M.1 — Frida framework-aware

`node tools/mobile.js frida <serial> <pkg> [--framework flutter|pairip] [--confirm "<reason>"]`

Senza `-l/--script`, l'hook è scelto dallo static già fatto (`reports/mobile/<pkg>-jadx|-apktool`):

| Segnale nello static | Hook di default |
|---|---|
| `libflutter.so` / `libapp.so` | `tools/frida/disable-flutter-tls.js` (hook BoringSSL) |
| `pairipcore` / `com/pairip` | `tools/frida/unpin.js` + **hint repack** (`tools/mobile-pairip-repack.sh`, sempre confirm) |
| nessun segnale | `tools/frida/unpin.js` (objection-style) |

Precedenza: `-l/--script` > env `CYBOROS_FRIDA_SCRIPT` > default framework. Il tier resta confirm.

## M.2 — Rinnovo APK autorizzato (`fetch-apk`)

`node tools/mobile.js fetch-apk <pkg> [--out <file>]`
`node tools/mobile.js fetch-apk <pkg> --verify-only <file>`

- La sorgente deve essere dichiarata in `mobile-scope.json` → `apk_sources: [{ "url": "...", "sha256": "...", "pkg": "..." }]`.
- L'URL della sorgente deve passare `scope-guard.js` contro `scope.json` (host autorizzato).
- Il payload scaricato deve combaciare con uno sha256 noto (`apk_sources[].sha256` o `allowed_apk_sha256`):
  un mismatch **rifiuta** e NON scrive il file (anti-tampering, fail-closed).
- `--verify-only <file>` non usa la rete: verifica solo l'hash di un APK fornito dall'operatore (caso store).
- Esiti e rifiuti in `reports/mobile-apk-log.jsonl`. Serve a ri-allineare static/dynamic quando l'app
  pubblica una nuova build. Senza `apk_sources` dichiarate l'op rifiuta.

## M.3 — Firebase config & superficie (detection-only)

`node tools/mobile.js firebase-audit <pkg> [--record]` (post-pass di `static --package <pkg> --firebase`)

1. Estrae il config dallo static: `google-services.json` e `res/values/strings.xml`
   (`google_api_key`, `firebase_database_url`, `project_id`, `google_storage_bucket`).
2. Per ogni asset fa **una sola** probe di ESISTENZA (non legge dati):
   RTDB `GET https://<project>.firebaseio.com/.json?shallow=true`,
   Storage `GET https://firebasestorage.googleapis.com/v0/b/<bucket>/o?maxResults=1`.
3. Solo **HTTP 200** è un finding `cloud` (`verify_level: triggered`, severity Medium max);
   401/403 = protetto, 404 = assente. Le probe riusano `cloud-enum.js` (`probeUrl`: scope-guard +
   resolveAndGuard + fail-closed), quindi l'host Firebase dev'essere in `scope.json`.
4. Report in `reports/mobile-firebase-<pkg>.json` (API key mascherata). `--record` registra i finding.

## M.4 — Superficie exported/deeplink nel coverage

`node tools/mobile.js surface <pkg>` (post-pass di `static --package <pkg> --surface`)

- Parsa `AndroidManifest.xml` dallo static e prende SOLO i componenti `android:exported="true"`
  (activity/service/receiver/provider) e i loro deeplink (`<data android:scheme/host/pathPrefix>`).
- Scrive le righe candidate in `reports/<pkg>-map.json` (`method: ANDROID|DEEPLINK`, `candidates.mobile`).
- Registra la classe **`mobile`** nella matrice di copertura: una superficie exported non testata
  resta un gap (`missed`), non una copertura presunta. Un finding mobile (classe `mobile`) la porta a
  `confirmed`. `chain.js` collega `deeplink_exported + noauth_api` (classe authz) quando il finding
  ha `url` valorizzato.

## Flusso tipico

```
node tools/mobile-guard.js check <pkg>                 # exit 0 = in scope
node tools/mobile.js static app.apk --package <pkg> --surface   # M.4 (offline)
node tools/mobile.js firebase-audit <pkg>              # M.3 (read-only, host in scope.json)
node tools/mobile.js fetch-apk <pkg>                   # M.2 (solo se apk_sources dichiarate)
node tools/mobile.js frida <serial> <pkg> --confirm "..."       # M.1 (confirm)
```

## Invarianti

- Mai scrivere/mai leggere dati Firebase: solo probe di esistenza single-request.
- Mai repack/resign senza una seconda conferma esplicita dell'operatore.
- Mai un package fuori da `allowed_packages`, mai un serial non-loopback/non-in-allowlist.
- Nessun exploit code nel repo: si orchestrano tool standard (frida, mitmproxy, jadx).
