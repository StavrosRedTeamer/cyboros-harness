#!/usr/bin/env node
// Offline self-check for the SAML/XSW tool (saml.js). No network: it operates on a token string.
// Run: node tools/test-saml.js
'use strict';
const assert = require('assert');
const saml = require('./saml');
let pass = 0, fail = 0;
function ok(name, fn) { try { fn(); pass++; console.log(`  PASS ${name}`); } catch (e) { fail++; console.log(`  FAIL ${name}: ${e.message}`); } }

const RESP_SIGNED_RESP_ONLY = `<samlp:Response xmlns:samlp="urn:s" ID="R1">
<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><SignedInfo><Reference URI="#R1"/></SignedInfo></Signature>
<saml:Assertion xmlns:saml="urn:a" ID="A1"><saml:Issuer>https://idp.example</saml:Issuer>
<saml:Subject><saml:NameID>marco@corp.example</saml:NameID></saml:Subject>
<saml:Conditions><saml:AudienceRestriction><saml:Audience>https://sp.example</saml:Audience></saml:AudienceRestriction></saml:Conditions>
</saml:Assertion></samlp:Response>`;

const RESP_UNSIGNED = RESP_SIGNED_RESP_ONLY.replace(/<Signature[\s\S]*?<\/Signature>/, '');

// ---- codec round-trip -------------------------------------------------------
ok('POST-binding base64 round-trip', () => {
  const enc = saml.encodeSaml(RESP_UNSIGNED, {});
  assert.strictEqual(saml.decodeSaml(enc, {}), RESP_UNSIGNED);
});
ok('redirect-binding deflate round-trip', () => {
  const enc = saml.encodeSaml(RESP_UNSIGNED, { redirect: true });
  assert.strictEqual(saml.decodeSaml(enc, { redirect: true }), RESP_UNSIGNED);
});

// ---- parse ------------------------------------------------------------------
ok('parse extracts issuer/nameId/audience', () => {
  const p = saml.parse(RESP_SIGNED_RESP_ONLY);
  assert.strictEqual(p.issuer, 'https://idp.example');
  assert.strictEqual(p.nameId, 'marco@corp.example');
  assert.strictEqual(p.audience, 'https://sp.example');
  assert.strictEqual(p.assertionId, 'A1');
});
ok('parse detects response-signed but assertion-unsigned', () => {
  const p = saml.parse(RESP_SIGNED_RESP_ONLY);
  assert.strictEqual(p.hasResponseSignature, true);
  assert.strictEqual(p.hasAssertionSignature, false);
});

// ---- analyze ----------------------------------------------------------------
ok('analyze flags no-signature High on unsigned response', () => {
  const a = saml.analyze(RESP_UNSIGNED);
  assert.ok(a.risks.find((r) => r.id === 'no-signature' && r.severity === 'High'));
});
ok('analyze flags XSW candidate when only response signed', () => {
  const a = saml.analyze(RESP_SIGNED_RESP_ONLY);
  assert.ok(a.risks.find((r) => r.id === 'response-signed-assertion-unsigned'));
});

// ---- payload minting --------------------------------------------------------
ok('stripSignature removes Signature block', () => {
  assert.ok(!/Signature/.test(saml.stripSignature(RESP_SIGNED_RESP_ONLY)));
});
ok('setNameId tampers identity', () => {
  const t = saml.setNameId(RESP_UNSIGNED, 'admin@corp.example');
  assert.strictEqual(saml.parse(t).nameId, 'admin@corp.example');
});
ok('commentNameId injects a comment for truncation', () => {
  const t = saml.commentNameId(RESP_UNSIGNED, 'admin@corp.example');
  assert.ok(/admin@corp\.example<!---->/.test(t));
});
ok('xsw variant 1 duplicates assertion with evil id, keeps signed original', () => {
  const r = saml.xsw(RESP_SIGNED_RESP_ONLY, 1, 'admin@corp.example');
  assert.strictEqual(r.ok, true);
  // original signed assertion (A1) still present; a forged one with the evil ID added
  assert.ok(r.xml.includes('ID="A1"'));
  assert.ok(r.xml.includes(r.evilId));
  assert.ok(r.xml.includes('admin@corp.example'));
});
ok('xsw fails cleanly when no assertion', () => {
  assert.strictEqual(saml.xsw('<samlp:Response/>', 1).ok, false);
});

console.log(`\nsaml: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
