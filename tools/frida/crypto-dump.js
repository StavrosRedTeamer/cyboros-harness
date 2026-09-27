/*
 * crypto-dump.js — dump di crypto/keystore dall'heap del processo (Frida).
 *
 * Usage (authorized engagement only — confirm-tier in the harness):
 *   node tools/mobile.js frida <serial> <pkg> -l tools/frida/crypto-dump.js --confirm "reason"
 *
 * Cosa fa (solo lettura: intercetta i materiali CIÒ che l'app stessa usa in memoria):
 *   1. javax.crypto.spec.SecretKeySpec   — chiavi simmetriche costruite a runtime (algoritmo + bytes hex).
 *   2. javax.crypto.spec.IvParameterSpec — IV.
 *   3. javax.crypto.Cipher.doFinal       — input/output di ogni operazione (plaintext↔ciphertext).
 *   4. java.security.KeyStore.getCertificate / getKey — alias letti dal keystore.
 *   5. java.security.MessageDigest.digest — hash calcolati (utile per pin custom / firma request).
 *   6. Base64 decode di stringhe con entropy alta (euristica, primi 40 match).
 *
 * Gli hook sono passivi: non cambiano alcun valore, loggano soltanto. Il segreto osservato
 * resta soggetto alle regole di minimizzazione dati del knowledge.md.
 */
'use strict';

function hex(bytes, max) {
  max = max || 64;
  var out = [];
  var b = bytes.length > max ? bytes.slice(0, max) : bytes; // tronca il log, non la chiave
  for (var i = 0; i < b.length; i++) out.push(('0' + (b[i] & 0xff).toString(16)).slice(-2));
  return out.join('') + (bytes.length > max ? ('…(+' + (bytes.length - max) + 'B)') : '');
}

Java.perform(function () {
  var TAG = '[crypto]';

  // 1. SecretKeySpec — ogni costruzione di chiave simmetrica
  try {
    var SKS = Java.use('javax.crypto.spec.SecretKeySpec');
    SKS.$init.overload('[B', 'java.lang.String').implementation = function (key, alg) {
      console.log(TAG + ' SecretKeySpec alg=' + alg + ' len=' + key.length + ' key=' + hex(key));
      return this.$init(key, alg);
    };
    console.log(TAG + ' hook SecretKeySpec');
  } catch (e) { console.error(TAG + ' SecretKeySpec: ' + e); }

  // 2. IV
  try {
    var IV = Java.use('javax.crypto.spec.IvParameterSpec');
    IV.$init.overload('[B').implementation = function (iv) {
      console.log(TAG + ' IvParameterSpec iv=' + hex(iv));
      return this.$init(iv);
    };
    console.log(TAG + ' hook IvParameterSpec');
  } catch (e) { console.error(TAG + ' IvParameterSpec: ' + e); }

  // 3. Cipher.doFinal — testo in chiaro e cifrato di ogni operazione
  try {
    var Cipher = Java.use('javax.crypto.Cipher');
    Cipher.doFinal.overload('[B').implementation = function (input) {
      var alg = '';
      try { alg = this.getAlgorithm(); } catch (e2) {}
      var out = this.doFinal(input);
      console.log(TAG + ' Cipher.doFinal[' + alg + '] in=' + hex(input, 48) + ' out=' + hex(out, 48));
      return out;
    };
    console.log(TAG + ' hook Cipher.doFinal([B)');
  } catch (e) { console.error(TAG + ' Cipher.doFinal: ' + e); }

  // 4. KeyStore: chiavi e certificati richiesti per alias
  try {
    var KS = Java.use('java.security.KeyStore');
    KS.getCertificate.overload('java.lang.String').implementation = function (alias) {
      var c = this.getCertificate(alias);
      console.log(TAG + ' KeyStore[' + this.getType() + '].getCertificate("' + alias + '") -> ' + (c ? 'presente' : 'assente'));
      return c;
    };
    KS.getKey.overload('java.lang.String', '[C').implementation = function (alias, pw) {
      var k = this.getKey(alias, pw);
      if (k) {
        var enc = null;
        try { enc = k.getEncoded(); } catch (e2) { /* AndroidKeyStore: non esportabile */ }
        console.log(TAG + ' KeyStore[' + this.getType() + '].getKey("' + alias + '") -> ' +
          (enc ? 'key=' + hex(enc) : 'hardware-backed (getEncoded() = null)'));
      }
      return k;
    };
    console.log(TAG + ' hook KeyStore');
  } catch (e) { console.error(TAG + ' KeyStore: ' + e); }

  // 5. MessageDigest — hash delle request (firma custom / pin applicativi)
  try {
    var MD = Java.use('java.security.MessageDigest');
    MD.digest.overload('[B').implementation = function (input) {
      var d = this.digest(input);
      var alg = '';
      try { alg = this.getAlgorithm(); } catch (e2) {}
      console.log(TAG + ' MessageDigest[' + alg + '] in=' + hex(input, 32) + ' -> ' + hex(d));
      return d;
    };
  } catch (e) { /* best-effort */ }

  // 6. euristica Base64 (stringhe lunghe decodificate a runtime)
  try {
    var B64 = Java.use('android.util.Base64');
    var ENTROPY = /^[A-Za-z0-9+/=]{40,}$/;
    B64.decode.overload('java.lang.String', 'int').implementation = function (s, flags) {
      var out = this.decode(s, flags);
      try {
        if (ENTROPY.test(s)) console.log(TAG + ' Base64.decode len=' + s.length + ' data=' + hex(out, 48));
      } catch (e2) {}
      return out;
    };
  } catch (e) { /* best-effort */ }

  console.log(TAG + ' pronto — crypto/keystore in chiaro nel log della sessione');
});
