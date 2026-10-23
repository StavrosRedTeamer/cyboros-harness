# SAML / XML Signature Wrapping (detection-only reference)

Driven by `tools/saml.js`. Targets any SP (service provider) that consumes a `SAMLResponse` (SSO
login). SAML's signature model is fragile: if the SP validates the signature over the wrong element,
or doesn't enforce it at all, an attacker forges the asserted identity → full authentication bypass.

> **Scope discipline.** The SP is the target; scope-check its ACS URL. `saml.js` only DECODES and
> MINTS payloads — it never sends. Replay a minted `SAMLResponse` ONLY through `tools/repeater.js`
> against the in-scope ACS endpoint. A minted payload proves nothing until the SP ACCEPTS it.
>
> **Detection-only.** Mint locally, replay once, and never authenticate as a real third party; the
> only accepted proof is a session on a minimal, authorized test account.

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

## 5. 2026: SAML and broker disclosures

Three of these are not wrapping bugs at all — the signature is **optional** or an error is treated
as success — so `saml.js analyze --strip` (does the SP accept an unsigned assertion?) remains the
first test, before `--xsw 1..8`. The wrapping rows below confirm that the class is alive; none of
them changes the mint→replay method.

| Bug shape | CVE / advisory | Date | Affected | Check |
|---|---|---|---|---|
| XSW at upstream ACS | CVE-2026-47201 / GHSA-c3m2-jqmq-pvp3 | 2026-05 | authentik < 2026.5.1, 2026.2.4, 2025.12.6 | `--xsw 1..8`; the identity consumed must be the assertion that was signed |
| HTTP-Artifact TLS-validator confusion | CVE-2026-49283 / GHSA-6929-8p9f-26jx | 2026-05 | simplesamlphp/saml2 <4.19.3, 4.20.0–<4.20.2, 5.0.0–<5.0.6, 6.0.0–<6.2.1 | an artifact from IdP A must not validate an unsigned embedded response claiming IdP B |
| SAML authentication bypass (signature-validation root cause per Bishop Fox analysis, not stated by the vendor) | CVE-2026-28323 | 2026-07 | SolarWinds Web Help Desk ≤2026.1 (fix 2026.2.1) | post an unsigned response; a session is the proof |
| SSO gate bypass (not wrapping) | CVE-2026-5343 (SA-CONTRIB-2026-031) | 2026-04 | Drupal `miniorange_saml` (SAML SSO – Service Provider) <3.1.4 | a protected route must stay closed without a validated login |
| Algorithm confusion (RSA key as HMAC secret) | CVE-2026-15013 / GHSA-p847-q8vx-c3fg | 2026-07 | miniOrange SAML SSO for WordPress ≤5.4.3 | re-sign with the known public key as HMAC secret; enforcement must be local, not response-chosen |
| Verification error treated as success | CVE-2026-15981 / GHSA-wgjx-q85h-87v2 | 2026-07 | miniOrange SAML SSO ≤5.4.4 | corrupt the signature: an accepted login is the bug |
| XSW by separating verification from extraction | CVE-2026-89043 / GHSA-8vr8-32m4-xw8q | 2026-09 | `passport-saml-encrypted` ≤0.1.13 | same assertion-extraction check as the first row |
| Disabled IdP still completes broker login | CVE-2026-2603 / GHSA-x4p7-7chp-64hq | 2026-03 | Keycloak <26.5.5 | IdP-initiated login from a disabled test IdP must be refused |
| Disabled SAML client as landing target | CVE-2026-3047 / GHSA-8cr3-vpxx-92cx | 2026-03 | Keycloak broker-saml ≤1.8.1.Final (fix 26.5.5) | a disabled client must not establish an SSO session |

Record with class `"saml"`, `cwe: "CWE-347"` (or CWE-287 for the two Keycloak rows). A version match
alone is `suspected`; an accepted forged assertion is `proven_impact`.
