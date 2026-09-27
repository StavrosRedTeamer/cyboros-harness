# SAML / XML Signature Wrapping (detection-only reference)

Driven by `tools/saml.js`. Targets any SP (service provider) that consumes a `SAMLResponse` (SSO
login). SAML's signature model is fragile: if the SP validates the signature over the wrong element,
or doesn't enforce it at all, an attacker forges the asserted identity → full authentication bypass.

> **Scope discipline.** The SP is the target; scope-check its ACS URL. `saml.js` only DECODES and
> MINTS payloads — it never sends. Replay a minted `SAMLResponse` ONLY through `tools/repeater.js`
> against the in-scope ACS endpoint. A minted payload proves nothing until the SP ACCEPTS it.

## 1. Capture + decode

Intercept the `SAMLResponse` (POST binding = base64; Redirect binding = base64 + raw-deflate):

```
node tools/saml.js decode  '<SAMLResponse>'  [--redirect]
node tools/saml.js analyze '<SAMLResponse>'  [--redirect]
```

`analyze` flags: no signature at all, response-signed-but-assertion-unsigned (the prime XSW setup),
assertion-signed-but-response-unsigned, NameID whitespace (comment-truncation), missing
AudienceRestriction (cross-SP replay).

## 2. Attack families (mint → replay via repeater)

| Test | Command | What it proves |
|---|---|---|
| Signature not enforced | `saml.js forge '<r>' --strip` | SP accepts an assertion with NO signature |
| XML Signature Wrapping | `saml.js forge '<r>' --xsw 1..8 --set-nameid victim@corp` | signature validates over the original while the SP reads the forged assertion |
| Identity tamper | `saml.js forge '<r>' --set-nameid admin@corp` | SP trusts an unsigned/edited NameID |
| Comment truncation | `saml.js forge '<r>' --comment-nameid admin@corp` | parser differential returns the smuggled identity (CVE-2017-11427 class) |

Add `--encode [--redirect]` to emit a ready-to-replay base64. Then:

```
node tools/repeater.js --url "https://sp.target/acs" --data "SAMLResponse=<forged>" --show-body
```

## 3. Also check

- **Recipient / Audience / NotOnOrAfter** not enforced ⇒ token replay across SPs or after expiry.
- **RelayState** open redirect / XSS.
- **IdP metadata** exposure (certs, endpoints) enabling offline forgery.

## 4. Record

Record by what the SP DID: `verify_level: triggered` (SP returned an error but processed the forged
element) vs `proven_impact` (you logged in as the victim). `cwe`: CWE-347 (improper signature
verification) / CWE-287 (auth bypass). Never authenticate as a real third party beyond a minimal,
authorized proof account.
