# AWS BYOC MVP

The MVP uses AMD64 Lambda MicroVMs. The customer owns the VPC, compute and archive bucket.
The Worker owns session admission, lifecycle and credential exchange. Real SCM tokens stay in the Worker.
Workspace disk persistence is outside the MVP.

## Compute decision

The November 2026 spike tested the runtime-free image on Lambda MicroVMs. An ECS Managed Instances
Graviton task failed before host creation with AWS `PendingVerification`. No ECS performance comparison is available.
Lambda is the available MVP path. ARM64 tool execution passed locally; full ARM64 Kilo execution remains unverified.

The Lambda spike used an 8 GiB baseline and a 32 GiB disk. The guest reported 30.8 GB free before archive tests.
Guest memory reported burst capacity, so it does not measure baseline memory overhead.

A closed sandbox security group permitted only the temporary proxy. Direct HTTPS failed. Both actual wrapper
WebSockets connected after the shared wrapper passed Bun's explicit proxy option. A 16 MiB preview returned
the expected SHA256 in 8.728 seconds. A fresh request reached wrapper hello in 28.73 seconds, including probes
but excluding Kilo installation. AWS cache state was not controlled; this is not a cold-start guarantee.

Git, Node and Bun reached GitHub through a constrained custom CA. npm and pnpm queried the public registry.
The `gh` request reached HTTP 401 with a deliberately invalid token. This proves TLS transport only.
The temporary proxy required a proper `Proxy-Authenticate` header for Git's authentication negotiation.
Private clone, push and model facade behavior require the full provider milestones.

The forced-proxy archive test used incompressible payloads in uncompressed tar files:

| Payload | Upload | Download | Extract | Integrity |
|---|---|---|---|---|
| 1 GB | 11.164 s | 10.023 s | 0.633 s | SHA256 matched |
| 5 GB | 44.432 s | 55.971 s | 4.779 s | SHA256 matched |

The 5 GB extraction left 20.8 GB free. These are single-run spike measurements, not service guarantees.

No AWS credential variables appeared in readable process environments. The MicroVM had no execution role.
Metadata's role path returned 404 before the security group closed; metadata was unreachable after closure.

## Launch contract

The shared startup exceeds ECS and Lambda launch limits: approximately 42.5 KB before session environment values.
An immutable S3 launch document carries typed argv and environment values. The provider API carries its short-lived
URL, SHA256 and deadline. The loader rejects redirects, oversized documents, changed content and expired launches.
The initial loader receives proxy configuration before it fetches the full environment.

`create` returns a stable allocation intent reference. `launch` owns provisioning after the Sandbox DO persists that
reference. One durable operation record holds the exact provider request before submission. Recovery replays the same
request and client token. It must not regenerate the launch URL or credential.

Observed AWS behavior: replay after termination returned the original MicroVM ID and the cached initial `PENDING`
response. A separate `GetMicrovm` returned `TERMINATED`. Replay recovers identity; only a fresh read supplies state.
`observe` remains read-only. Stop reconciles an ambiguous launch before confirming termination.

Lambda limits total lifetime to eight hours. A provider-neutral absolute deadline must fail active work with a specific
reason before AWS terminates the VM. Renewable leases cannot extend that deadline. Suspend and resume are unused.

## Template and permission boundary

`deploy/aws/template.json` is the internal M1 foundation. It currently permits HTTPS through the customer NAT.
Customer enablement requires the forced proxy, DNS controls and reviewed admission from P4.

The customer role trusts one fixed Kilo role ARN and an owner-bound ExternalId. It does not trust an IAM user.
Compute operations target one MicroVM image. The role has no image mutation, connector mutation, shell-token or
`iam:PassRole` authority. Connector permission scoping requires live verification because AWS documentation differs.
The trusted adapter always selects the configured VPC connector and `NO_INGRESS`, with no execution role or idle policy.
It verifies the networking and role fields returned by AWS before accepting an allocation.

The bucket keeps prepared archives. Only launch objects expire after one day. The launch and archive client cannot
read proxy-private prefixes. Launch PUT uses `If-None-Match: *`. Admission deletes the launch object; expiration is a backstop.
Signed URLs cannot outlive the assumed role credentials. AWS responses and transport errors never enter logs verbatim.

The foundation reuses `aws4fetch`, already a production dependency of worker-utils. It adds no production dependency.
