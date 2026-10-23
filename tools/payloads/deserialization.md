# Deserialization — detection payloads (detection-only by default)

Serialized-object endpoints are usually spotted by their content type / body shape:
`application/x-java-serialized-object`, `application/octet-stream` with a Java stream
header, PHP `O:8:"Class":...`, .NET `AAEAAAD/////` (BinaryFormatter), Python pickle
`\x80\x04` (protocol 4) or `\x80\x03`.

> **Detection-only.** A detection gadget (URLDNS or a DNS marker) is the default; command-execution
> gadgets are confirm-tier and need explicit per-action approval.

## Fingerprint the format

| Stack | Magic / marker |
|---|---|
| Java native | `AC ED 00 05` hex header |
| .NET BinaryFormatter | base64 `AAEAAAD/////` |
| .NET JSON.NET | `{"$type":"System.Windows.Data.ObjectDataProvider, ..."}` |
| PHP `serialize()` | `O:<len>:"<class>":<n>:{...}` |
| Python pickle | `\x80\x04` / `\x80\x03` (bytes) |
| Ruby Marshal | `\x04\x08` |
| YAML (PyYAML/ruamel) | `!!python/object/apply:` tags |

## Detection (no gadget chain yet)

1. **Truncate / corrupt** the serialized blob and diff the response: a distinct
   stack trace / deserialization error (vs a generic 400) confirms the endpoint unserializes.
2. **Class not found:** replace the class name with `MARKER` — an error echoing the class
   name confirms the object is being resolved.
3. **Java `ysoserial` URLDNS gadget** is the classic *safe* detection: it makes the server
   resolve a DNS name (use `oob.js` DNS/HTTP marker) without executing code.

## Escalation (requires explicit approval)

- Java: `ysoserial` gadget chains (CommonsCollections4/6, Spring, etc.) — **only for PoC,
  never for persistence**.
- .NET: `ysoserial.net` (ObjectDataProvider / TypeConfuseDelegate).
- PHP: `phpggc` chains (Symfony/Laravel/Guzzle).
- Python: `pickle` `__reduce__` → `os.system` (sleep/`id` only with approval).

Rule: prove "the server unserializes untrusted input" with URLDNS/error evidence; do not
fire a command-execution gadget without the user's explicit go-ahead for that action.

## 2026 disclosures

Seven rows across the runtimes this harness meets most, including the first Node.js entries in this
reference. Node's revived-JSON sinks (`fromJSON`, `server$` RPC) deserialize *values*, so the
marker test is a type confusion (a function or class where a string was sent), not a gadget chain.

| Bug shape | CVE / advisory | Date | Affected | Check |
|---|---|---|---|---|
| `SerializingHttpMessageConverter` accepts untrusted Java serialization | CVE-2026-47864 | 2026-08 | Spring Integration 7.1.0, 7.0.0–7.0.5, 6.5.0–6.5.10, 6.4.0–6.4.12, ≤5.5.21 | is the converter registered and reachable? send the Java stream header (AC ED 00 05) and read the error class |
| Untrusted data into a subprocess wrapper's deserialization | CVE-2026-0763 / GHSA-hfvx-hcmp-m6j3 | 2026-01 | GPT Academic, versions not stated | unauthenticated request data reaches `run_in_subprocess_wrapper_func`; watch for the deserializer's error signature |
| .NET XAML parsing (WPF) | CVE-2026-50649 | 2026-07 | .NET 8.0.0–8.0.28, 9.0.0–9.0.17, 10.0.0–10.0.9 | WPF deserialization of untrusted XAML; error class + no execution (advisory does not name a gadget class) |
| PHP object injection | CVE-2026-49763 / GHSA-6f45-2725-f94r | 2026-06 | Contact Form 7 HubSpot ≤1.3.7 | submitted value reaches `unserialize()`; a class-not-found error is the fingerprint |
| Python pickle load | CVE-2026-78683 / GHSA-rhp5-r9x4-f5g2 | 2026-08 | NLTK ≤3.9.4 (fix 3.10.0) | crafted model file → `pickle.load`; detection = `\x80\x04` magic in an upload, never a live gadget |
| Revived JSON reaches `eval` (fromJSON/fromCrossJSON) | CVE-2026-23737 / GHSA-3rxj-6cgf-8cfw | 2026-01 | seroval ≤1.4.0 (fix 1.4.1) | client→server serialized payload with an overridden constant/error node; needs 4 requests on one function |
| `server$` RPC unsafe deserialization | CVE-2026-27971 / GHSA-p9x5-jp3h-96mm | 2026-03 | `@builder.io/qwik` ≤1.19.0 (fix 1.19.1) | version check first: unauthenticated RCE where `require()` exists, so do not send a crafted body |

PHP2Shell (CVE-2026-109618/109619, 2026-10-21) is **not** this class even though one path is called
the upload-progress unserializer: it is a use-after-free in the PHP engine, found by version, and the
trigger is an availability-destroying multipart request. See `tools/payloads/runtime-server.md`.

Version match alone is `suspected`. A distinct deserialization error (not a generic 400) is
`triggered`; URLDNS/OOB resolution is still the safest `triggered` proof on the Java ones.
