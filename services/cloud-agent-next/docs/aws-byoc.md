# AWS BYOC MVP

The AWS MVP keeps Lambda MicroVMs and adds EC2-backed ECS isolated tasks as separate providers.
The customer owns the VPC, compute and archive bucket. ECS integration remains in progress and is not selectable.
The Worker owns session admission, lifecycle and credential exchange. Real SCM tokens stay in the Worker.
Workspace disk persistence is outside the MVP.

## Compute decision

The November 2026 spike tested the runtime-free image on Lambda MicroVMs. A later private EC2 launch
reached `RUNNING`, then confirmed `TERMINATED`. An ECS Managed Instances Graviton task with
`ISOLATED_SANDBOX` reached `RUNNING` and exited with code zero. Its task stopped and its managed host terminated.
The initial `PendingVerification` account restriction no longer blocks these probes.

The ECS probe proves isolated task launch, not Cloud Agent runtime, preview or credential isolation.
Its CloudWatch stream had no persisted result events. Full ECS runtime acceptance remains required.
The initial product allocation uses AMD64, two vCPUs, 8 GiB memory and the fixed 20 GiB task disk.
ARM64 tool execution passed locally; full ARM64 Kilo execution remains unverified.

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
and terminate the physical allocation before repairing that allocation. MicroVM automatic recovery after this bound remains unsupported; ECS uses the exact intent lookup described below.
A known physical ID can still be stopped after the replay window.

Lambda limits total lifetime to eight hours. The shared control plane stops active work two minutes before that limit
with `provider_lifetime_exhausted`. Renewable leases cannot extend the deadline. Suspend and resume are unused.

## Bootstrap credential access

The MVP permits the allocation-scoped proxy token in the ECS `RunTask` request.
The token appears in the launch envelope command and in `HTTP_PROXY` and `HTTPS_PROXY`.
The sandbox needs it to reach S3 before downloading the full startup environment.

Customer principals with `ecs:DescribeTasks` access can read the task command and environment overrides.
Principals with access to CloudTrail records can read recorded `RunTask` request data.
Treat these records as sensitive bootstrap data. Restrict access to trusted operators.
Do not copy task overrides or complete request records into support tickets or application logs.

A holder with network access to the customer proxy can use that allocation's permitted egress destinations.
Traffic uses that allocation's audit identity and policy.
Access depends on current allocation admission and policy refresh, and ends no later than token expiry.
ECS proxy tokens expire with the verified proxy deployment certificate.
The proxy token alone cannot authenticate a wrapper WebSocket connection.
Managed Git and SCM API requests also need a current repository alias and grant.
Kilo resolves managed SCM credentials through Cloudflare; the proxy token contains no SCM token.

The launch envelope also contains a short-lived S3 download URL.
That URL grants temporary read access to the startup environment, including the separate wrapper launch credential.
A principal that obtains the document while it remains accessible can obtain those startup credentials.
Kilo deletes the document after wrapper admission or confirmed compute termination; deletion can require a retry.
The signed URL also has a bounded lifetime. Its authority is separate from the proxy token's authority.

## Shared AWS components

`aws-compute-lifecycle.ts` owns reservation, exact-request checkpoints, recovery, stop fences and cleanup.
`aws-launch-document.ts` owns the immutable S3 launch document used by both engines.
Engine adapters own request construction, API state mapping and runtime identity checks.
MicroVM records retain their original schema, storage prefix and `microvmId`. ECS records use a separate schema and `taskArn`.

Both engines share two-hop role assumption, S3 and proxy metadata access, role-session caching, and proxy startup.
Connections and envelope purposes stay separate. An ECS lookup never falls back to a MicroVM connection.
The internal connection endpoint selects the exact provider, owner and credential ID.

ECS has no eight-hour compute deadline. Its proxy credential expires at the verified certificate deadline.
The Sandbox DO reads that expiry from its saved RunTask request and schedules its existing alarm.
It does not poll AWS for this deadline or persist a second expiry value.
At expiry, preparing and active work fail with `byoc_aws_proxy_expired`, and compute cleanup starts.
The failure does not wait for wrapper heartbeat loss or confirmed physical termination.
MicroVM allocations retain their compute lifetime and `provider_lifetime_exhausted` reason.
Both engines require eight hours of certificate validity before a new allocation starts.
This reserve checks certificate health; it does not set an ECS compute deadline.
Proxy policy refresh still checks current allocation, owner, connection, generation and lifecycle authority.
Policy admission and durable storage now support both engines through shared components.
ECS onboarding, public selection and full runtime acceptance remain in progress.

Certificate renewal and allocation draining remain operator tasks. This MVP does not promise uninterrupted sessions across certificate rotation.
A session's practical remaining lifetime depends on the current deployment certificate expiry and managed-host maintenance.
AWS starts host draining at day 14 and terminates hosts no later than day 21. Earlier maintenance can occur.
See [ECS managed-instance patching](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/managed-instances-patching.html).
Standalone tasks do not receive automatic replacement.

ECS adds three private endpoints for API, agent and telemetry traffic. Private discovery uses exact DNS names.
Two fresh ARM64 managed hosts reached `RUNNING`, exited with code zero, and terminated under the closed DNS policy.
Resolver logs confirmed fixed private endpoint names and a `BLOCK` decision for a task DNS query.
Runtime probe stdout remained unavailable. These checks do not establish complete Cloud Agent acceptance.

## Template and permission boundary

`deploy/aws/template.json` version 2 includes the authenticated proxy and DNS controls.
`build:aws-ecs-template` generates `deploy/aws/template.ecs.json` from that shared infrastructure and replaces compute resources.
`test:aws-templates` checks generated output, compute isolation and shared resource contracts.
DNS associations use priority 101 because AWS reserves priority 100.
Both templates use AWS's default fail-closed DNS behavior. CloudFormation rejects a resource that explicitly sets that unmanaged default.
AWS remains enrolled for internal testing. Same-account runtime and security acceptance remains required.
Cross-account proof is deferred because the MVP test setup has one AWS account.

The customer role trusts one fixed Kilo role ARN and an owner-bound ExternalId. It does not trust an IAM user.
Compute operations target one MicroVM image. The role has no image mutation, connector mutation, shell-token or
`iam:PassRole` authority for MicroVM compute. Same-account live checks verified the configured connector permission and rejected other connectors,
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

## Build preparation and repository denial

The coordinator uses neutral `prepareInput` and `confirmArtifact` steps.
AWS build callbacks have a separate module; the compute provider does not own egress transport.
A broker refusal after initial admission preserves `repository_unauthorized` and starts cleanup immediately.
Service, transport and unknown broker failures return `unavailable`. The builder can retry within the existing build deadline.
Initial repository authorization and later capability issuance use the same failure classification.
These rules do not enable MicroVM prepared environments or change the provider acceptance requirements.

## Build SCM retirement

Build progress reports do not change SCM authority. The filesystem baseline may report `archive` before cloning starts.
After setup, the builder stops setup descendants and calls the authenticated `retire-scm` endpoint.
It waits for acknowledgement before credential cleanup and final archive capture.
The environment build DO stores `scm: retired` before acknowledgement. Retries are idempotent.
Late input and renewal requests cannot restore retired grants. Archive upload and publication require retirement.
Cancellation and terminal build states still deny SCM access, even if the builder never sends the transition.

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
Public roots remain in the runtime trust bundle. New allocations require at least eight hours of certificate validity.
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
Onboarding does not modify release policies. It refuses new drafts for account IDs outside `customerAccounts`.
An existing draft keeps its sealed release pins, so removing an account from `customerAccounts` does not stop that draft.
To revoke an account, discard its drafts, or remove its access in the release bucket and repository policies.
Keep published object keys and image digests immutable. A release variable change does not replace an existing draft's pins.

Also configure the existing `AWS_BYOC_CREDENTIALS`, `AWS_BYOC_KILO_ROLE_ARN`, `AGENT_ENV_VARS_PRIVATE_KEY`,
HTTPS root `WORKER_URL`, and `BYOC_AWS_IDS` cohort. The web service uses its existing public encryption key
and authenticated Worker connection. No new web AWS credentials are required.

The customer enters its account ID, prepares setup, and opens **Launch stack**.
The AWS identity that launches the stack needs permission to create every resource in the template, including IAM roles.
It must also acknowledge the CloudFormation IAM capabilities.
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

## Shared compute recovery and failure handling

MicroVM and ECS use the same durable lifecycle rules. Each engine retains its own stored reference and request codec.
A new request records whether submission is prepared, pending or uncertain. Legacy records without this field remain uncertain.
The first Run request claims the prepared record atomically, after runtime access resolves.
A concurrent claim makes rejection uncertain. A late refusal cannot retire a concurrent successful launch.

A definite first refusal can retire its own uncontested pending request without physical cleanup.
For ECS, this requires HTTP 403 or HTTP 400 with an `AccessDeniedException` or `InvalidParameterException` typed header.
An untyped response, transport failure, server failure or token conflict does not establish this result.
The same error from a later inspection does not prove that Run failed.
Known physical identities remain available for cleanup after the replay bound.
After five minutes, ECS calls `ListTasks` with the pinned cluster and saved `startedBy` value, without replaying `RunTask`.
One complete result must match the task ARN, cluster and `startedBy` returned by `DescribeTasks`.
The lifecycle saves that identity before checking mutable runtime metadata. Stop can then terminate a task that fails admission.
The customer role grants read-only `ecs:ListTasks` access restricted to the stack cluster and region.
Existing customer stacks need the updated role policy before using this recovery path.

Discovery reads one bounded page. Partial, ambiguous or temporarily missing results never prove termination.
They retain `provider_cleanup_required` and block replacement. A later attempt can recover when exact identity becomes available.
`ListTasks` returns only tasks whose desired status is `RUNNING`. A complete empty page therefore means that no live task exists.
No replay starts after five minutes. One more minute lets a replay that started inside the bound settle.
After that, an empty page retires the operation, so a task that stopped after a lost reply does not block the sandbox.
ECS keeps stopped tasks for about an hour. After that, `DescribeTasks` reports the stored ARN as missing and `StopTask` rejects it with HTTP 400.
When both happen after the same settle period, Stop confirms termination. A recently launched task that reads missing stays retryable.
MicroVM has no corresponding intent lookup; unidentified requests still require operator repair after five minutes.
See [ListTasks](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_ListTasks.html)
and [ECS IAM actions](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ecs.html).

The lifecycle persists confirmed compute termination before deleting the launch document.
If S3 cleanup fails, a recreated adapter retries that deletion without repeating the compute launch or stop.
Task identity and configuration failures preserve their specific reason through provider coordination.
Wrapper admission performs provider reads outside the Sandbox DO queue, then checks the allocation and connection again before binding.
ECS retains its issued proxy-token deadline and snapshot startup path. It does not inherit the MicroVM lifetime cap.

Local regressions verify both engines, concurrent refusal/success, interrupted cleanup, hello races and deadline handling.
AWS responses are simulated. Live uncertain recovery and customer deployment acceptance remain unverified.



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
