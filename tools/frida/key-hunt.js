/*
 * key-hunt.js — harvest the MECCANISMI-API-KEY value from the running app's heap.
 *
 * The key header name ("MECCANISMI-API-KEY") is a Dart string → stored as UTF-16LE in the
 * AOT heap/snapshot at runtime. We locate it, then dump surrounding memory for the key
 * value (also a Dart string, so UTF-16LE). Pure read-only inspection; no hooks, no tampering.
 */
'use strict';

function utf16(pattern) {
  // ASCII -> UTF-16LE hex pattern
  let hex = '';
  for (let i = 0; i < pattern.length; i++) {
    hex += pattern.charCodeAt(i).toString(16).padStart(2, '0') + ' 00 ';
  }
  return hex.trim();
}

function printable(ab, off, len) {
  let out = '';
  for (let i = 0; i < len; i++) {
    const b = ab[off + i];
    if (b >= 0x20 && b < 0x7f) out += String.fromCharCode(b);
    else out += '.';
  }
  return out;
}

function extractUtf16(ab, off, max) {
  let out = '';
  for (let i = off; i < off + max && i + 1 < ab.length; i += 2) {
    const code = ab[i] | (ab[i + 1] << 8);
    if (code === 0) break;
    if (code >= 0x20 && code < 0x7f) out += String.fromCharCode(code);
    else break;
  }
  return out;
}

function scanFor(needle, label) {
  const pattern = utf16(needle);
  const results = [];
  const ranges = Process.enumerateRanges('r--');
  ranges.forEach((r) => {
    try {
      Memory.scanSync(r.base, r.size, pattern).forEach((m) => {
        results.push({ addr: m.address, range: r });
      });
    } catch (e) {}
  });
  console.log(`[keyhunt] "${needle}" (UTF-16LE): ${results.length} hits`);
  const keys = new Set();
  results.slice(0, 40).forEach((hit) => {
    const ab = hit.range.base.readByteArray(hit.range.size) || new ArrayBuffer(0);
    const bytes = new Uint8Array(ab);
    const local = hit.addr.sub(hit.range.base);
    const start = Math.max(0, local - 512);
    const window = new Uint8Array(bytes.buffer, start, 1536);
    // pull UTF-16 strings within the window
    const strs = [];
    for (let i = 0; i < window.length - 2; i += 2) {
      const s = extractUtf16(window, i, 256);
      if (s.length >= 6 && /^[A-Za-z0-9._:@\/\-=+]{6,}$/.test(s)) {
        strs.push(s);
        i += s.length * 2;
      }
    }
    // also ascii strings
    const ascii = [];
    let cur = '';
    for (let i = 0; i < window.length; i++) {
      const b = window[i];
      if (b >= 0x20 && b < 0x7f) cur += String.fromCharCode(b);
      else { if (cur.length >= 6) ascii.push(cur); cur = ''; }
    }
    console.log(`[keyhunt]   @${hit.addr}`);
    strs.forEach((s) => { if (s !== needle) keys.add(s); });
    ascii.forEach((s) => { if (s !== needle) keys.add(s); });
    console.log(`[keyhunt]     utf16: ${strs.filter((s) => s !== needle).slice(0, 12).join(' | ')}`);
    console.log(`[keyhunt]     ascii: ${ascii.filter((s) => s !== needle).slice(0, 12).join(' | ')}`);
  });
  return keys;
}

setTimeout(() => {
  try {
    const keys = scanFor('MECCANISMI-API-KEY', 'header');
    scanFor('MECCANISMI', 'domain');
    console.log('[keyhunt] candidate values:', JSON.stringify([...keys].slice(0, 50)));
  } catch (e) {
    console.error('[keyhunt] error: ' + e);
  }
}, 4000);