/*
 * storage-triage.js — triage SOLAMENTE-LETTURA dello storage dell'app (Frida).
 *
 * Usage (authorized engagement only — confirm-tier in the harness):
 *   node tools/mobile.js frida <serial> <pkg> -l tools/frida/storage-triage.js --confirm "reason"
 *
 * Cosa fa: lista i file che l'apre/crea l'app (path + dimensione nota), e per i file
 * piccoli e "interessanti" (xml, db, prefs, json, token) ne mostra un estratto. NON tocca
 * i dati: nessun file viene modificato o cancellato. Utilità: capire in 30 secondi DOVE
 * l'app mette segreti (token, prefs non cifrati, sqlite non cifrati) prima di scrivere
 * un hook mirato.
 */
'use strict';

function snippet(bytes, max) {
  max = max || 200;
  var out = '';
  var n = bytes.length < max ? bytes.length : max;
  for (var i = 0; i < n; i++) {
    var b = bytes[i] & 0xff;
    out += (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : '.';
  }
  return out;
}

Java.perform(function () {
  var TAG = '[storage]';
  var JString = Java.use('java.lang.String');

  // file "interessanti" per un triage: piccoli, testuali, tipicamente con segreti dentro
  var INTEREST_RE = /\.(xml|json|properties|txt|cfg|conf|db|sqlite|sqlite3|realm|pem|key)$/i;
  var MAX_SNIPPET_BYTES = 64 * 1024;

  // 1. java.io.File apre/legge: logga i path dell'internal storage
  try {
    var FIS = Java.use('java.io.FileInputStream');
    FIS.$init.overload('java.io.File').implementation = function (f) {
      try {
        var p = f.getAbsolutePath();
        if (/^\/data\/(user\/0\/)?(data\/)?[a-z]/i.test(p) || /\/files\/|\/databases\/|\/shared_prefs\//.test(p)) {
          console.log(TAG + ' read  ' + p + ' (' + f.length() + 'B)');
        }
      } catch (e2) {}
      return this.$init(f);
    };
  } catch (e) { console.error(TAG + ' FileInputStream: ' + e); }

  // 2. SharedPreferences: le PUT (loggano chiave/valore in chiaro, SOLO log)
  try {
    var EditorImpl = Java.use('android.app.SharedPreferencesImpl$EditorImpl');
    EditorImpl.putString.implementation = function (k, v) {
      console.log(TAG + ' prefs.put "' + k + '" = "' + v + '"');
      return this.putString(k, v);
    };
  } catch (e) { /* best-effort */ }

  // 3. SQLite: le query (utile per capire lo schema senza aprire il db a mano)
  try {
    var SQLiteDB = Java.use('android.database.sqlite.SQLiteDatabase');
    SQLiteDB.rawQuery.overload('java.lang.String', '[Ljava.lang.String;').implementation = function (sql, args) {
      console.log(TAG + ' sqlite.rawQuery: ' + sql);
      return this.rawQuery(sql, args);
    };
  } catch (e) { /* best-effort */ }

  // 4. OpenFileInput helper: quando l'app si apre i suoi file, mostra un estratto
  try {
    var File = Java.use('java.io.File');
    File.listFiles.implementation = function () {
      var res = this.listFiles();
      try {
        var p = this.getAbsolutePath();
        if (/\/files$|\/databases$|\/shared_prefs$|\/cache$/.test(p)) {
          var n = res === null ? 0 : res.length;
          console.log(TAG + ' dir   ' + p + ' (' + n + ' file)');
          for (var i = 0; i < (res === null ? 0 : n) && i < 30; i++) {
            var f = res[i];
            var name = f.getName();
            var len = f.length();
            var tag2 = INTEREST_RE.test(name) ? ' *' : '';
            console.log(TAG + '   - ' + name + ' (' + len + 'B)' + tag2);
            // estratto SOLO di file piccoli e interessanti (mai binary grandi)
            if (INTEREST_RE.test(name) && len > 0 && len <= MAX_SNIPPET_BYTES) {
              try {
                var fis = Java.use('java.io.FileInputStream').$new(f);
                var buf = Java.array('byte', new Array(len).fill(0));
                var read = fis.read(buf);
                fis.close();
                if (read > 0) {
                  console.log(TAG + '     └ ' + snippet(buf, 240));
                }
              } catch (e3) { /* permessi/file sparito: non bloccare */ }
            }
          }
        }
      } catch (e2) {}
      return res;
    };
  } catch (e) { console.error(TAG + ' File.listFiles: ' + e); }

  console.log(TAG + ' pronto — triage storage (read-only)');
});
