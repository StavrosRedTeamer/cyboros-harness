# JWT / JWS / JWE validation flaws (detection-only reference)

> **Detection-only.** Tokens come from accounts you own on an in-scope target. `jwt.js`
> decodes, verifies and mints locally; it never sends. Replay only through
> `tools/repeater.js`. Forge a token that logs you into your own second account, never a
> real third party's, and never brute-force a production signing key.

## 1. Decode and verify

```
node tools/jwt.js decode '<token>'      # header, payload, timestamps
node tools/jwt.js verify '<token>' --key <secret-or-public-key>   # is the signature valid?
```

Read `alg`, `kid`, `typ`, `crit`, `jku`/`x5u`, and the claims that gate authorization
(`iss`, `aud`, `sub`, `scope`, `role`). An unsigned token accepted by the API is a finding on
its own; a token whose signature you cannot verify is not evidence of forgery — it only
tells you which key retrieval path to test next.

## 2. Algorithm and key confusion

- **`alg: none`** — re-sign a copy with `alg:none` and an empty signature; if the API returns
  the same authenticated response, it is `CVE-2026-39413`-class. `jwt.js attack <url> --token`
  covers alg:none, HS256-with-leaked-secret and RS256→HS256 in one pass.
- **Shared-secret confusion** — an OIDC verifier that accepts the client secret as an HS256
  key (`CVE-2026-33322`): replay a token signed with the secret you already legitimately hold.
- **`crit` header** — add an unknown critical extension; a verifier that ignores `crit` instead
  of rejecting the token (`CVE-2026-32597`) will accept it. `jwt.js` has no flag for this;
  mint it by hand and replay.
- **`jku` / `x5u`** — point the header at a listener you control (`node tools/oob.js listen`,
  `oob.js marker`) and see whether the verifier fetches it. A hit is the proof.

## 3. Key retrieval

A `jku`/JWKS URL that accepts a non-HTTP(S) scheme, or a local-file/`file:` path, is
`CVE-2026-48522`-class. Separately, break the JWKS fetch (point the configured `jwksUri` at a
host you can make fail in staging) and replay a token signed with a well-known default key: a
verifier that fails open on JWKS errors is the Istio `CVE-2026-31837` pattern.

## 4. Encrypted tokens and oracles

JWE with `RSA1_5` leaks through distinguishable failures (`CVE-2026-28490`): compare a valid
token, a token with a corrupted padding block, and one with a corrupted auth tag. The finding
is *non-uniform externally observable failure*, not a decryption. Keep it to a handful of
requests per token — an oracle is proved by classification, not by volume; never run a
padding-oracle campaign against a production key.

## 5. Disclosures 2026 (dated)

| Technique | CVE / advisory | Date | Affected | Probe |
|---|---|---|---|---|
| `alg: none` accepted | CVE-2026-39413 | 2026-04 | LightRAG (`lightrag-hku`) <= 1.4.13, fixed 1.4.14 | unsigned token to a protected API |
| OIDC alg confusion via client secret | CVE-2026-33322 | 2026-03 | MinIO RELEASE.2022-11-08T05-27-07Z → final OSS release | HS256 token signed with the known secret |
| unknown `crit` extension accepted | CVE-2026-32597 | 2026-03 | PyJWT <= 2.11.0, fixed 2.12.0 | token listing an unsupported `crit` |
| non-HTTP(S) JWKS/`jku` scheme | CVE-2026-48522 | 2026-05 | PyJWT >= 2.0.0 <= 2.12.1, fixed 2.13.0 | `jku` to a non-HTTP scheme / your listener |
| JWKS failure falls back to default keys | CVE-2026-31837 | 2026-03 | Istio 1.29.0, 1.28.0–1.28.4, 1.27.0–1.27.7 | make `jwksUri` fail, replay default-key token |
| JWE RSA1_5 padding oracle | CVE-2026-28490 | 2026-03 | Authlib <= 1.6.8, fixed 1.6.9 | classify padding vs tag failures |

## 6. Record

`node tools/record-finding.js '{"severity":"High","title":"JWT alg:none accepted","host":"HOST","endpoint":"/api/me","class":"jwt","cwe":"CWE-347","verify_level":"exploited","poc":"<forged token + 200 body as the second test account>"}'`

`triggered` when the verifier merely processes the malformed token, `exploited` when it grants
access to a different principal, `proven_impact` when it reaches data that principal owns.
Key-retrieval SSRF records with the same class and CWE-918 in the evidence.
