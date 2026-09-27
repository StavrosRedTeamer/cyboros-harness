/*
 * disable-flutter-tls.js — TLS verification bypass for Flutter apps (Frida).
 *
 * Why a dedicated script (vs. frida/unpin.js): Flutter does NOT use the Java/OkHttp TLS stack,
 * so hooking SSLContext.init / okhttp3.CertificatePinner does NOTHING for it. Dart's `dart:io`
 * HttpClient talks to a STATICALLY-LINKED BoringSSL compiled into libflutter.so, and it ignores
 * both the Android system trust store AND the global http_proxy. To MITM Flutter traffic you
 * must (1) hook BoringSSL's certificate verification inside libflutter.so and (2) force traffic
 * to the proxy (dart:io honours no proxy setting -> use `adb reverse` + iptables/redirect, see
 * tools/mobile-physical-setup.sh).
 *
 * Usage (authorized engagement only — confirm-tier in the harness):
 *   node tools/mobile.js frida <serial> com.example.fest \
 *        -l tools/frida/disable-flutter-tls.js --confirm "flutter tls mitm, engagement acme"
 *   # or directly: frida -U -n com.example.fest -l tools/frida/disable-flutter-tls.js
 *
 * NOTE on PairIP: this app blocks Frida *spawn* (anti-instrument at init). Attach to the already
 * running process (-n / -p), do NOT use -f/spawn. The static PairIP license patch
 * (tools/mobile-pairip-repack.sh) is orthogonal and must already be applied so the app runs.
 *
 * Approach: find ssl_crypto_x509_session_verify_cert_chain / SSL_get_verify_result style symbols
 * in libflutter.so and force success. Symbols are usually stripped, so we (a) try exported names
 * first, then (b) fall back to scanning for the well-known "ssl_client" / session_verify pattern
 * via a hook on ssl_verify_peer_cert if exported. Keep it defensive: every hook is best-effort.
 */
'use strict';

function log(m) { console.log('[flutter-tls] ' + m); }
function err(m) { console.error('[flutter-tls] ' + m); }

function hookBoringSSLIn(libName) {
  var base = Module.findBaseAddress(libName);
  if (!base) return false;
  log('found ' + libName + ' @ ' + base);
  var hooked = 0;

  // 1) Exported BoringSSL verify entrypoints, when not fully stripped.
  ['SSL_CTX_set_custom_verify', 'SSL_set_custom_verify'].forEach(function (sym) {
    var addr = Module.findExportByName(libName, sym);
    if (!addr) return;
    try {
      // signature: void set_custom_verify(SSL(_CTX)* , int mode, enum ssl_verify_result (*cb)(SSL*, uint8_t*))
      var orig = new NativeFunction(addr, 'void', ['pointer', 'int', 'pointer']);
      Interceptor.replace(addr, new NativeCallback(function (ssl, mode, cb) {
        // replace the app callback with one that always returns ssl_verify_ok (0)
        var okCb = new NativeCallback(function (/* ssl, out_alert */) { return 0; }, 'int', ['pointer', 'pointer']);
        orig(ssl, 0 /* SSL_VERIFY_NONE */, okCb);
      }, 'void', ['pointer', 'int', 'pointer']));
      log(sym + ' -> force ssl_verify_ok');
      hooked++;
    } catch (e) { err(sym + ' hook failed: ' + e); }
  });

  // 2) Some builds export SSL_get_verify_result: pin to X509_V_OK (0).
  var gvr = Module.findExportByName(libName, 'SSL_get_verify_result');
  if (gvr) {
    try {
      Interceptor.attach(gvr, { onLeave: function (ret) { ret.replace(ptr(0)); } });
      log('SSL_get_verify_result -> X509_V_OK');
      hooked++;
    } catch (e) { err('SSL_get_verify_result hook failed: ' + e); }
  }

  if (!hooked) {
    err('no exported BoringSSL verify symbols in ' + libName + ' (stripped build). '
      + 'Fall back to a pattern-scan script (e.g. reflutter or NVISO disable-flutter-tls) '
      + 'built for this libflutter.so version/arch.');
  }
  return hooked > 0;
}

function run() {
  var libs = ['libflutter.so'];
  var done = false;
  libs.forEach(function (l) { if (hookBoringSSLIn(l)) done = true; });
  if (!done) {
    // libflutter.so may not be loaded yet: retry as modules get mapped.
    var tries = 0;
    var iv = setInterval(function () {
      tries++;
      if (hookBoringSSLIn('libflutter.so') || tries > 20) clearInterval(iv);
    }, 500);
  }
}

// Native-level: no Java.perform needed, but guard in case Java VM is present.
try { run(); } catch (e) { err('fatal: ' + e); }
