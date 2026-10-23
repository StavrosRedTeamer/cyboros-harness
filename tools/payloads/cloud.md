# Cloud and edge surfaces reachable from the web (detection-only reference)

Targets: cloud storage and streams the web app points at, and the proxy/edge layer that decides
who reaches what. Classes `cloud` / `config` / `authz` depending on the flaw.

> **Detection-only.** Read the smallest proof — a bucket's listing count, an object key prefix, a
> role NAME. Never download customer objects, never write to a bucket, never touch a data stream.
> Deleting or reclaiming a namespace is destructive and confirm-tier at best; the finding is the
> *ownership check that is missing*, provable by reading metadata you are authorized to read.

## 1. Bucket ownership and squatting

The bug class: a product creates or references a storage bucket by a **predictable name** and never
verifies who owns it, so whoever holds that name receives what the product writes.

- **Predictable staging bucket, Vertex AI Experiments** (CVE-2026-2473, 2026-02,
  `google-cloud-aiplatform >=1.21.0 <1.133.0`): check SDK version from the app's requirements and
  whether a staging bucket name is derived from project/experiment identifiers.
- **Model-upload staging bucket** (no CVE — Unit 42, "Pickle in the Middle", 2026-06; tested
  affected `google-cloud-aiplatform` 1.139.0 and 1.140.0, fix reported in 1.148.0): the SDK
  uploads model artifacts to a bucket it assumes it owns. Probe: identify the bucket name from
  requests/logs, then check ownership metadata (not contents).
- **Reclaimed bucket redirects live streams** (no CVE — Unit 42, 2026-06; GCP Cloud Logging,
  Pub/Sub, Storage Transfer; AWS S3 replication and Data Firehose; Azure Monitor cross-subscription):
  a deleted destination bucket whose stream/router still references it. Detection is inventory, not
  exploitation: does the stream destination still exist and who owns it now?

```
node tools/analyze-bundle.js <url>          # bucket names / storage hostnames embedded in the app
node tools/repeater.js --url "https://<bucket-host>/" --show-body   # listing count or AccessDenied
```

`AccessDenied` on the listing is the healthy answer. A listing that returns objects you did not
create is `exploited` — stop there, do not read them.

## 2. Object authorization

- **User-controlled key bypasses S3 object authorization in a Lambda hook** (CVE-2026-105811,
  2026-10; QnABot on AWS 7.0.0–7.4.5, fixed 7.4.6, requires redeploying the hook stack): an
  authenticated caller selects an S3 key outside their authorized scope. Probe with a key prefix
  from your own test account only; a `200` for a foreign prefix is the finding.

## 3. Edge and proxy routing

The edge decides auth and routing from the same request it forwards — so any disagreement about the
Host, port or request-target is an authorization question.

- **Malformed Host port bypasses Traefik annotation middleware** (CVE-2026-88877, 2026-09, Traefik
  3.7.0–3.7.11, fixed 3.7.12; ingress-nginx redirect + auth annotations): compare the protected path
  with `--header "Host: target"` and with a non-numeric/empty port.
- **Rootless request-target desync** (CVE-2026-88009, 2026-09, Traefik v2 `<2.11.57`, v3
  `>=3.0.0 <3.7.13`): routing/auth/logs see `/` while the backend receives a different target. Send a
  raw request-target through `repeater.js` and compare the backend's answer with the access-log view.
- **Spoofed Host port reaches the management port** (CVE-2026-50194, 2026-05,
  `Steeltoe.Management.Endpoint <=4.1.0` fixed 4.2.0; `EndpointCore >=3.2.2 <=3.3.0` fixed 3.4.0):
  only relevant when a management port is configured — request actuator paths on the public listener
  with the management port in `Host`.
- **Host-header parsing misroutes LiteLLM management routes past auth** (CVE-2026-49468, 2026-05,
  LiteLLM `<1.84.0`): check whether `/management`-style routes answer on the public hostname, and
  whether an upstream CDN/proxy normalizes Host before it arrives.

## 4. Disclosures 2026 (dated)

| Technique | CVE / advisory | Date | Affected | Probe |
|---|---|---|---|---|
| Predictable staging-bucket squatting | CVE-2026-2473 | 2026-02 | `google-cloud-aiplatform >=1.21.0 <1.133.0` | bucket name + ownership metadata |
| Model-upload staging bucket | no CVE (Unit 42) | 2026-06 | `google-cloud-aiplatform` 1.139.0/1.140.0, fix 1.148.0 | who owns the upload target |
| Reclaimed bucket, live stream | no CVE (Unit 42) | 2026-06 | GCP Logging/PubSub/Transfer, S3 replication/Firehose, Azure Monitor | stream destination inventory |
| S3 key scope in Lambda hook | CVE-2026-105811 | 2026-10 | QnABot on AWS 7.0.0–7.4.5 (fix 7.4.6) | foreign-prefix read as a test account |
| Malformed Host port vs annotation auth | CVE-2026-88877 | 2026-09 | Traefik 3.7.0–3.7.11 (fix 3.7.12) | `Host: target:<port>` variants |
| Rootless request-target routing | CVE-2026-88009 | 2026-09 | Traefik v2 `<2.11.57`, v3 `<3.7.13` | raw request-target vs backend answer |
| Management-port Host spoof | CVE-2026-50194 | 2026-05 | Steeltoe `<=4.1.0`, `EndpointCore 3.2.2–3.3.0` | actuator path + management port in Host |
| Host-based auth misroute | CVE-2026-49468 | 2026-05 | LiteLLM `<1.84.0` | management routes on the public host |

## 5. Record

`class: "cloud"` for storage/edge exposure, `"authz"` when the flaw is a missing check on an object
(`cwe`: CWE-284 / CWE-639 / CWE-200; `owasp_api`: API1/API3/API8). `triggered` = the misconfiguration
is reachable and returns metadata; `exploited` = you read a value belonging to another principal
(a test principal, minimal). Never record a bucket finding without naming the bucket, the owner
check that failed, and the response proving it.
