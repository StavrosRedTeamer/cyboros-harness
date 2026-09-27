/*
 * component-fuzz.js — fuzzing di componenti esportate e deeplink (Frida, lato device).
 *
 * Usage (authorized engagement only — confirm-tier in the harness):
 *   node tools/mobile.js frida <serial> <pkg> -l tools/frida/component-fuzz.js --confirm "reason"
 *
 * Diversamente da un fuzz `am start` dal PC (che resta la via principale, vedi P3),
 * questo script vive DENTRO il processo target e intercetta cosa arrivano le entrypoint
 * esportate: Activity.onCreate/onNewIntent (deeplink ricevuti), Service.onStartCommand,
 * BroadcastReceiver.onReceive — con URI/extra in chiaro nel log. Utile quando i deeplink
 * non sono nel manifest (registrati a runtime) o per confermare CHE cosa processa davvero
 * la componente prima di provare payload via adb.
 *
 * Non modifica nulla: logga i passaggi. I payload vanno inviati con adb/am dal PC.
 */
'use strict';

Java.perform(function () {
  var TAG = '[cmpfuzz]';

  function intentInfo(intent) {
    if (intent === null) return 'null';
    var out = [];
    try {
      out.push('action=' + intent.getAction());
      out.push('data=' + intent.getDataString());
      var cats = intent.getCategories();
      if (cats !== null) out.push('cats=' + cats.toString());
      var extras = intent.getExtras();
      if (extras !== null) {
        var keys = extras.keySet().toArray();
        for (var i = 0; i < keys.length; i++) {
          var k = keys[i];
          var v = extras.get(k);
          out.push('extra[' + k + ']=' + (v === null ? 'null' : v.toString()));
        }
      }
    } catch (e) { out.push('(intent non leggibile: ' + e + ')'); }
    return out.join(' ');
  }

  // 1. Activity: onCreate + onNewIntent (deeplink a app già aperta)
  try {
    var Activity = Java.use('android.app.Activity');
    Activity.onCreate.overload('android.os.Bundle').implementation = function (b) {
      console.log(TAG + ' Activity.onCreate ' + this.getComponentName().getClassName() + ' ' + intentInfo(this.getIntent()));
      return this.onCreate(b);
    };
    Activity.onNewIntent.implementation = function (intent) {
      console.log(TAG + ' Activity.onNewIntent ' + this.getComponentName().getClassName() + ' ' + intentInfo(intent));
      return this.onNewIntent(intent);
    };
    console.log(TAG + ' hook Activity (onCreate/onNewIntent)');
  } catch (e) { console.error(TAG + ' Activity: ' + e); }

  // 2. Service
  try {
    var Service = Java.use('android.app.Service');
    Service.onStartCommand.implementation = function (intent, flags, startId) {
      console.log(TAG + ' Service.onStartCommand ' + this.getComponentName().getClassName() + ' ' + intentInfo(intent));
      return this.onStartCommand(intent, flags, startId);
    };
    console.log(TAG + ' hook Service');
  } catch (e) { console.error(TAG + ' Service: ' + e); }

  // 3. BroadcastReceiver
  try {
    var BR = Java.use('android.content.BroadcastReceiver');
    BR.onReceive.implementation = function (ctx, intent) {
      console.log(TAG + ' Receiver.onReceive ' + this.getClass().getName() + ' ' + intentInfo(intent));
      return this.onReceive(ctx, intent);
    };
    console.log(TAG + ' hook BroadcastReceiver');
  } catch (e) { console.error(TAG + ' BroadcastReceiver: ' + e); }

  // 4. ContentProvider query (URI grant / path traversal sui provider esportati)
  try {
    var CP = Java.use('android.content.ContentProvider');
    CP.query.overloads.forEach(function (ov) {
      ov.implementation = function () {
        var uri = arguments[0];
        console.log(TAG + ' Provider.query ' + (uri === null ? 'null' : uri.toString()));
        return ov.apply(this, arguments);
      };
    });
    console.log(TAG + ' hook ContentProvider');
  } catch (e) { /* overload firma varia tra API: best-effort */ }

  console.log(TAG + ' pronto — ora invia i payload con: adb -s <serial> shell am start -a android.intent.action.VIEW -d "<uri>"');
});
