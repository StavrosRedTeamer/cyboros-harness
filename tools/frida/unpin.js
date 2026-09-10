/*
 * unpin.js — generic Android SSL/TLS pinning bypass (Frida).
 *
 * Usage (authorized lab / engagement only):
 *   frida -U -n <package> -l tools/frida/unpin.js
 *   # or, in the harness: node tools/mobile.js frida <serial> <package> [--confirm "reason"]
 *
 * What it hooks:
 *   1. javax.net.ssl.SSLContext.init()        — swaps in a trust-all X509TrustManager (covers
 *      HttpURLConnection, okhttp's default path, WebView stacks that go through SSLContext).
 *   2. okhttp3.CertificatePinner.check()      — no-op (okhttp explicit certificate pinning).
 *   3. libssl SSL_CTX_set_custom_verify       — accept-all (native/rust TLS stacks).
 *
 * This makes TLS inspection (mitmproxy) possible by disabling pinning/verification; the app's
 * traffic then flows in plaintext to the proxy. It does NOT modify the app or the device —
 * the hook dies with the frida session. Keep in mind the harness tier model: this is the
 * confirm-tier "frida" action, and any data you observe goes through the sensitive-data
 * minimization rules (knowledge.md / references/verification-reporting.md).
 */
'use strict';

Java.perform(function () {
  // 1. Trust-all TrustManager installed via SSLContext.init
  try {
    var X509TrustManager = Java.use('javax.net.ssl.X509TrustManager');
    var TrustAll = Java.registerClass({
      name: 'dev.stavros.TrustAllX509',
      implements: [X509TrustManager],
      methods: {
        checkClientTrusted: function (chain, authType) {},
        checkServerTrusted: function (chain, authType) {},
        getAcceptedIssuers: function () { return []; },
      },
    });
    var SSLContext = Java.use('javax.net.ssl.SSLContext');
    SSLContext.init.overload(
      '[Ljavax.net.ssl.KeyManager;',
      '[Ljavax.net.ssl.TrustManager;',
      'java.security.SecureRandom'
    ).implementation = function (km, tm, sr) {
      this.init(km, [TrustAll.$new()], sr);
    };
    console.log('[unpin] SSLContext.init -> trust-all installed');
  } catch (e) {
    console.error('[unpin] SSLContext hook failed: ' + e);
  }

  // 2. okhttp CertificatePinner: no-op check (also covers the static 'check' overloads)
  try {
    var CertificatePinner = Java.use('okhttp3.CertificatePinner');
    try {
      CertificatePinner.check.overload('java.lang.String', 'java.util.List')
        .implementation = function (hostname, peerCerts) {};
    } catch (o1) {}
    try {
      CertificatePinner.check.overload('java.lang.String', '[Ljava.security.cert.Certificate;')
        .implementation = function (hostname, peerCerts) {};
    } catch (o2) {}
    console.log('[unpin] okhttp3.CertificatePinner disabled');
  } catch (e) {
    console.error('[unpin] okhttp hook failed: ' + e);
  }

  // 3. Native libssl custom-verify: accept everything (BoringSSL/OpenSSL variants)
  try {
    ['libssl.so', 'libboringssl.so'].forEach(function (lib) {
      var addr = Module.findExportByName(lib, 'SSL_CTX_set_custom_verify');
      if (addr) {
        Interceptor.replace(addr, new NativeCallback(function (ctx, mode, cb) {
          return 0; // X509_V_OK — accept
        }, 'int', ['pointer', 'int', 'pointer']));
        console.log('[unpin] ' + lib + ' SSL_CTX_set_custom_verify -> accept-all');
      }
    });
  } catch (e) {
    console.error('[unpin] native custom_verify hook failed: ' + e);
  }
});