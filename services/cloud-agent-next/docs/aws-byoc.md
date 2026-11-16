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

`deploy/aws/template.json` version 2 includes the authenticated proxy and DNS controls.
AWS remains enrolled for internal testing. Customer enablement still requires M2, M3, M4 and cross-account proof.

The customer role trusts one fixed Kilo role ARN and an owner-bound ExternalId. It does not trust an IAM user.
Compute operations target one MicroVM image. The role has no image mutation, connector mutation, shell-token or
`iam:PassRole` authority. Same-account live checks verified the configured connector permission and rejected other connectors,
public egress, an execution role and another image. Cross-account verification remains outstanding.
The trusted adapter always selects the configured VPC connector and `NO_INGRESS`, with no execution role or idle policy.
It verifies the networking and role fields returned by AWS before accepting an allocation.

Launch objects expire after one day. Prepared archives expire 30 days after upload.
Kilo stops selecting an archive 29 days after capture, so rebuild the prepared environment before then.
The launch and archive client cannot read proxy-private prefixes. Launch PUT uses `If-None-Match: *`. Admission deletes the launch object; expiration is a backstop.
Signed URLs cannot outlive the assumed role credentials. AWS responses and transport errors never enter logs verbatim.

The AWS API client reuses `aws4fetch`, an existing JavaScript dependency of worker-utils.

## AWS runtime bundle

Build the AWS image bootstrap ZIP with the repository script. It requires Node and the `zip` command.

```sh
node services/cloud-agent-next/deploy/aws/build-runtime-bundle.mjs \
  --base-image '<private-ECR-runtime-image>@sha256:<digest>' \
  --out /tmp/kilo-aws-runtime.zip
```

The base must be a private ECR image in us-east-1 pinned by digest. The generated Dockerfile selects AMD64
and installs Debian `python3` only in the AWS image. Other providers keep their current images.
The filesystem archive helper uses Python standard-library Linux metadata and directory-relative operations.
TypeScript retains provider access, authentication, lifecycle and archive orchestration. No pip packages are required.

Only the Dockerfile and two named Node loaders enter the ZIP. The script does not copy environment files or a worktree.
It fixes timestamps, permissions and member order, omits ZIP extra metadata, and refuses to replace an existing output file.
It returns the ZIP byte count and SHA256. Publish only to private storage after artifact checks.

These controls make ZIP bytes deterministic for the same input. Debian package updates can change resulting image contents.
Publish and retain the resulting immutable MicroVM image version; do not claim reproducible image builds.
Prepared-environment activation remains disabled until its authenticated builder and restore paths pass provider verification.

## Internal M1 verification

A local Worker used the encrypted connection and two chained STS roles to start the actual runtime on the test image.
The public `octocat/Hello-World` repository prepared successfully. Kilo completed a deterministic fake-model turn through
the model facade. A terminal accepted input in the repository. Preview ticket admission returned the fixture through
PreviewTunnel and the wrapper; the same preview refused a request without its cookie. This is same-account proof.
It does not verify a paid model, private repositories, forced production egress or a second customer account.


## Proxy boundary

Two Fargate tasks share one immutable deployment generation behind a private network load balancer.
The MVP places both tasks in one availability zone. It does not provide availability-zone resilience.
The sandbox security group reaches only the load balancer on port 3128. The proxy accepts HTTPS CONNECT on port 443.
It refuses plain HTTP, private destinations, nested CONNECT and upgrades on intercepted SCM connections.
Each raw connection uses a checked public IPv4 address. IPv6 is outside the MVP.
Only port 443 is permitted, including unrestricted mode. Tools that use plain `http://` or ignore the proxy cannot connect.
Ordinary tunnels check the CONNECT hostname, not inner SNI or HTTP Host; these can differ on a shared CDN.
Tunnel audit records carry `scope: connection`. Their `CONNECT` method describes the outer proxy operation, not an inner request.
Intercepted SCM requests carry `scope: request` and their actual method.
See [AWS network access](aws-network-access.md) for the user-facing contract.

VPC-wide DNS Firewall allows the proxy name and exact infrastructure bootstrap names for ECR, S3 and logs.
It blocks other names and fails closed. These bootstrap names also resolve in sandboxes; their security group still blocks access.
The proxy resolves public upstreams through verified HTTPS to fixed public resolver addresses.

The Worker verifies the allocation credential, deployment identity, current owner connection and pinned configuration.
It checks durable state again after external reads. A startup request requires a checkpointed launch, but no wrapper welcome.
Deployment metadata reads share one in-memory cache entry per admission owner, keyed by the exact source and pinned configuration.
The entry lasts at most 15 seconds, never beyond the policy TTL or certificate expiry. Concurrent readers share the same read.
Failed refreshes fail closed and leave no stale fallback. Every request still resolves current owner/connection authorization and checks durable allocation state.
A metadata-only change can remain unseen until cache expiry; a previously issued proxy policy keeps its existing 30-second maximum lifetime.
Normal deployment rotation must change the saved generation and drain old allocations as described below.

Cached STS sessions do not replace current connection authorization. A replacement configuration never silently takes over an active allocation.
The proxy holds a separate allocation credential. It cannot use that credential to connect a wrapper.
Real SCM credentials remain inside the Worker, where the existing broker owns repository authorization and credential exchange.

The shared native allowlist builder owns the policy content, including the pinned S3 bucket as a provider routing target.
The stored request pin stays unchanged. An unrestricted allocation still has no allowlist.

Policy refresh runs every 15 seconds. The last accepted policy expires within 30 seconds.
Existing connections close when policy expires, the destination becomes disallowed, or its SCM interception mode changes.
Every SCM CONNECT and intercepted request refreshes policy. A denied broker request never falls back to a raw tunnel.
Each task bounds sockets to 256, active connections per allocation to 32, and policy cache entries to 256.
Audit acknowledgment precedes forwarding. Tunnels record CONNECT, destination and decision. Intercepted SCM requests also record their actual HTTP method.
Raw tunnels do not expose inner SNI, Host, method, path or content. The allowlist checks the declared CONNECT hostname.

One constrained CA signs a static certificate for supported public SCM hosts. Its signing key is destroyed during initialization.
Only the leaf private key persists in the proxy-private S3 object. The customer role cannot read that object.
Managed custom GitLab hosts fail before capability issuance, including additional environment repositories.
Public roots remain in the runtime trust bundle. New allocations require certificate validity for their full eight-hour lifetime.
Existing allocations and replacement proxy tasks use the certificate until its actual expiry.

The proxy image is an immutable ECR digest supplied to the template. This exploratory stack has no automatic image or CA update.
A generation change requires draining old allocations, replacing deployment material, and saving the new connection pins.
The operator must perform this before certificate expiry. The onboarding preview checks these pins. Ready release updates require an operator.

Local tests cover actual CONNECT/TLS transport, constrained-CA rejection in Node, Bun, Git and gh, policy expiry,
allocation races, audit effects, and metadata admission through actual Sandbox DO RPC. A 1 MiB SCM stream stays in the Worker route.
They do not prove the final security groups, DNS Firewall, task replacement or private repository push on AWS.

## Customer onboarding preview

The Compute tab contains one AWS settings card for personal owners and organization admins.
The backend, not the browser, selects ownership, generates ExternalId, and validates the role.
Draft setup and runtime configuration use separate encrypted envelope purposes. Drafts also bind their generation.
The connection becomes ready only after live role, stack, release and proxy validation.
The browser receives public account, role, stack and version fields. It never receives encrypted credentials or proxy identity.

Operators must publish one immutable release before enabling setup. Set `AWS_BYOC_RELEASE` on the Worker
with this shape; replace the sample object hashes and repositories with the published release values:

```json
{
  "format": 1,
  "templateVersion": 2,
  "proxyProtocolVersion": 1,
  "template": {
    "bucket": "kilo-releases",
    "key": "aws/<sha256>/template.json",
    "sha256": "<sha256>"
  },
  "runtime": {
    "bucket": "kilo-releases",
    "key": "aws/<sha256>/runtime.zip",
    "sha256": "<sha256>",
    "repositoryArn": "arn:aws:ecr:us-east-1:123456789012:repository/runtime"
  },
  "proxy": {
    "imageUri": "123456789012.dkr.ecr.us-east-1.amazonaws.com/proxy@sha256:<sha256>",
    "repositoryArn": "arn:aws:ecr:us-east-1:123456789012:repository/proxy"
  },
  "customerAccounts": ["999999999999"]
}
```

The runtime and proxy repositories must belong to the configured Kilo role account.
Grant that role `s3:GetObject` on the exact template object. Before authorizing a customer account,
grant its `BuildRole` access to the runtime ZIP and runtime ECR repository.
Grant its `ProxyExecutionRole` access to the proxy ECR repository.
These grants require source bucket and repository policies. Customer IAM permissions alone cannot grant cross-account access.
Onboarding does not modify release policies. It refuses account IDs outside `customerAccounts`.
Keep published object keys and image digests immutable. A release variable change does not replace an existing draft's pins.

Also configure the existing `AWS_BYOC_CREDENTIALS`, `AWS_BYOC_KILO_ROLE_ARN`, `AGENT_ENV_VARS_PRIVATE_KEY`,
HTTPS root `WORKER_URL`, and `BYOC_AWS_IDS` cohort. The web service uses its existing public encryption key
and authenticated Worker connection. No new web AWS credentials are required.

The customer enters its account ID, prepares setup, and opens **Launch stack**.
The AWS identity that launches the stack needs permission to create IAM roles.
Kilo hash-checks the named template object before signing its download link. The link expires within 15 minutes.
After CloudFormation completes, the customer copies `RoleArn` from Outputs and selects **Validate connection**.
Validation requires correct-ExternalId success and omitted/wrong-ExternalId denial. It reads only the generated named stack.
It checks completed state, account, versions, exact release parameters, resource outputs and public proxy metadata.
Each failed step returns fixed recovery text. A failed check preserves the draft for another attempt.
Discarding a draft removes only its Kilo record. The customer must delete any unused AWS stack separately.

**Check connection** validates a ready connection without replacing its configuration or proxy pins.
The displayed check time records the last successful validation; it does not claim continuous availability.
A changed ready release requires an operator update. Self-service upgrades and automatic CA rotation remain outside this preview.
New allocation startup checks the live stack version and persisted resource pins before issuing launch credentials.
Transient reads retry within a bound. Known old versions fail immediately with a specific update reason.
Cleanup and existing allocation recovery retain their persisted configuration.

Local tests verify the shared parsers, encryption, HTTP boundary, database races and settings states.
The AWS read test confirms that the live version-1 stack fails the new startup gate after one read.
Final proxy deployment, prepared environment activation and two-account onboarding remain unverified.



## Operator repair of a ready connection

The preview has no ready-connection update or removal API. **Check connection** only validates the saved configuration.
Do not ask a customer to delete and reconnect. A new draft creates a different stack name and ExternalId.
Do not set a ready row back to pending to bypass this boundary.

An operator must obtain approval for the customer AWS changes and the connection record update before this procedure.
This repository has validation and encryption helpers, but no ready-connection repair command.
Prepare and review a maintenance script for the selected connection before changing its stack.

1. Identify the owner, provider, connection ID, generation, account, role and stack from the existing record.
   Retain a protected backup of its encrypted configuration and public metadata.
   Do not place decrypted configuration, ExternalId, proxy identity or signed URLs in logs or tickets.
2. Stop new allocation requests for this connection. Drain its sessions and builds, then confirm physical compute termination.
   Reconcile uncertain launches before continuing. Removing enrollment alone does not prove existing compute stopped.
   Keep the existing connection available for cleanup until termination is confirmed.
3. Plan the update against the existing stack and role. Preserve its account, connection ID, stack identity and ExternalId.
   Use the approved immutable release and retain its cross-account source permissions.
   Review replacement resources and certificate generation changes before applying the update.
   Do not delete the artifacts bucket or connection record as a repair step.
4. Validate the updated stack before saving new pins.
   Require correct-ExternalId role access and refusal with omitted or wrong ExternalId.
   Check completed stack state, approved release parameters, versions, resource outputs, and proxy metadata.
   Use the checks in `aws-stack-validation.ts` and `createAwsSetupService`.
   A repair script must retain the existing setup identities when it builds validation input; `prepare` creates new identities.
   Require sufficient certificate validity for a new allocation. Do not accept changed pins from an unverified read.
5. Encrypt the validated configuration with the existing configuration envelope scheme and owner/connection AAD.
   Follow the encryption and public projection in `apps/web/src/lib/byoc/aws-connection.ts`.
   Update `credentials_encrypted`, public `config`, and successful verification metadata together.
   Guard the write with the exact owner, provider, connection ID, generation, ready status and prior record version.
   Require exactly one updated row. Abort on a concurrent change; do not overwrite it.
   Preserve unrelated runtime metadata and retain the same connection ID.
6. Run ready-connection revalidation against the saved envelope, then start one disposable allocation through normal admission.
   Verify wrapper readiness, enforced egress and cleanup before restoring new requests.
   Check each configuration or proxy generation change against the saved pins.

If a check fails, keep new allocations disabled and retain the diagnostic reason without credential values.
Do not restore old pins against changed AWS resources. Rollback requires matching and revalidating both sides.
This procedure is a maintenance contract. A live repair and rollback have not been verified in this preview.


## Prepared archive restore failures

The bootstrap retries transport failures within its download deadline.
After those attempts fail, the authenticated startup report preserves `environment_restore_unavailable`.
The session asks the user to send a new message to retry the same selected archive.
Interrupted extraction or runtime handoff uses the same retry advice.

A missing object, checksum failure, oversized response, or invalid archive produces `environment_restore_failed`.
The session asks the user to rebuild the prepared environment.
Failed restoration never starts the fresh runtime. The callback records a fixed code and does not expose URLs or credentials.
`test/runtime-installer/aws-archive-bootstrap.test.ts` covers download retries, restore deadlines, integrity failures
and successful reuse of the same archive. These tests are opt-in and CI does not run them.
They need Linux, root (the local HTTPS server uses port 443), `/usr/local/bin/node`, `/usr/bin/python3`, `openssl`, and
`customer-artifacts.s3.us-east-1.amazonaws.com` mapped to `127.0.0.1`. Run them with
`KILO_AWS_ARCHIVE_BOOTSTRAP_TEST=1 pnpm --filter cloud-agent-next test:runtime-installer`.
They use a local HTTPS server; they do not prove live customer S3 or VPC behavior.

## SCM forwarding boundary

The Sandbox DO admits the allocation, target, method and presented authorization. Its RPC returns an authority or a denial.
The RPC carries no request or response body. The Worker route owns header cleanup, broker redemption and upstream streaming.
A denied request leaves the body unread. An ambiguous push failure never retries the upstream write.
The local proxy flow test connects real CONNECT/TLS handling and the control client to this route and admission implementation.
That test simulates AWS metadata and the broker; it does not prove customer VPC or live provider behavior.
