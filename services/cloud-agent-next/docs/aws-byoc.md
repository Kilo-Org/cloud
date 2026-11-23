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

A request checkpoint records whether submission has started. Stop can retire an unsubmitted request without launching compute.
A definite refusal of the first submission retires the operation, so the next message can allocate again.
A refusal after an uncertain or concurrent submission cannot prove that no compute exists.
Legacy records without submission evidence remain uncertain.
Confirmed compute termination is saved before launch document cleanup. An S3 cleanup failure does not block the next allocation.

One phase-transition table and pure operation reducer own durable state changes.
The recovery decision distinguishes retired, identified, absent, unsubmitted, replayable and blocked operations without provider I/O.
The adapter performs storage and AWS calls around those decisions. It claims submission atomically and rechecks current state after remote calls.
The provider registry constructs AWS operation storage; the Sandbox DO supplies storage without AWS lifecycle logic.

Recovery without a physical ID replays only within five minutes. AWS does not document permanent client-token retention.
After that bound, `provider_cleanup_required` fails affected work promptly. The Worker retains the exact request
and blocks replacement allocations. An operator must identify
and terminate the MicroVM before repairing that allocation. Automatic recovery after this bound remains unsupported.
A known physical ID can still be stopped after the replay window.

Lambda limits total lifetime to eight hours. The shared control plane stops active work two minutes before that limit
with `provider_lifetime_exhausted`. Renewable leases cannot extend the deadline. Suspend and resume are unused.

## Template and permission boundary

`deploy/aws/template.json` is the internal M1 foundation. It currently permits HTTPS through the customer NAT.
Customer enablement requires the forced proxy, DNS controls and reviewed admission from P4.

The customer role trusts one fixed Kilo role ARN and an owner-bound ExternalId. It does not trust an IAM user.
Compute operations target one MicroVM image. The role has no image mutation, connector mutation, shell-token or
`iam:PassRole` authority. Same-account live checks verified the configured connector permission and rejected other connectors,
public egress, an execution role and another image. Cross-account verification remains outstanding.
The trusted adapter always selects the configured VPC connector and `NO_INGRESS`, with no execution role or idle policy.
It verifies the networking and role fields returned by AWS before accepting an allocation.

The bucket keeps prepared archives. Only launch objects expire after one day. The launch and archive client cannot
read proxy-private prefixes. Launch PUT uses `If-None-Match: *`. Admission deletes the launch object; expiration is a backstop.
Signed URLs cannot outlive the assumed role credentials. AWS responses and transport errors never enter logs verbatim.

The foundation reuses `aws4fetch`, already a production dependency of worker-utils. It adds no production dependency.

## Internal M1 verification

A local Worker used the encrypted connection and two chained STS roles to start the actual runtime on the test image.
The public `octocat/Hello-World` repository prepared successfully. Kilo completed a deterministic fake-model turn through
the model facade. A terminal accepted input in the repository. Preview ticket admission returned the fixture through
PreviewTunnel and the wrapper; the same preview refused a request without its cookie. This is same-account proof.
It does not verify a paid model, private repositories, forced production egress or a second customer account.
