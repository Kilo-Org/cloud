# Runtime rollout and qualification

The catalog at runtime-targets.json owns startup mode and native image selection. Its default is
downloaded on runtime-free, with no named overrides or organization restriction. Named environments
inherit that default unless the catalog names them.
Keep startup variables out of checked-in Wrangler vars. Deployment renders the Worker vars and native
images from the catalog. Manual mode, descriptor, cohort or image drift fails before Wrangler or its custom build.

| Mode | Native image | Deployment reference |
|---|---|---|
| downloaded | runtime-free | Separate `runtime-free` named image with verified immutable base digest, exact-SHA runtime descriptor |

New allocations support only downloaded startup on the runtime-free image, on native Cloudflare
Containers and BYOC Vercel. Preinstalled and all-in-one deployment selections are rejected. Missing
runtime descriptors fail configuration preflight instead of falling back to a baked runtime.
Persisted allocation readers still recognize historical startup modes and image identities; running
allocations are not rewritten. Retired SDK provider pins cannot create a new allocation.

BYOC Vercel uses its customer-owned snapshot as the base. The snapshot setup provides the fixed Node
path and Bun version required by the bootstrap. `src/shared/runtime-toolchain.ts` pins every base tool
(`bun`, `rg`, `gh`, `glab`, `pnpm`, `kilo`) to a release archive or registry tarball whose SHA-256 sits
next to `RUNTIME_DISTRIBUTION`. The Durable Object build installs `bun` and the Kilo CLI from those pins,
checks the downloaded bytes before unpacking or installing, and re-checks the tools it installed by exact
version and digest before the snapshot is created or accepted.
Downloaded startup installs the selected immutable CLI
and control release as root. The base digest covers the ABI, Node major, Bun, and base setup commands;
CLI and wrapper changes do not change that digest or require a new snapshot. Existing allocations keep
their installed release until a new allocation starts. Base dependency changes still require a snapshot
upgrade. Upgrade older BYOC snapshots once before enabling downloaded mode, so they have the required
fixed Node path. Native image selection does not change the Vercel snapshot.

### BYOC snapshot upgrade timing

The pinned-toolchain installation change keeps the tool versions and base ABI unchanged; it has no
premerge production prerequisite. Deploy the Worker code first; each enrolled BYOC owner can then
choose **Upgrade runtime** in Vercel Compute settings
to build the new snapshot in that owner's Vercel team/project. The authenticated procedures are
`organizations.vercelCompute.upgradeRuntime` (organization admin, with `organizationId`) and
`vercelCompute.upgradeRuntime` (the signed-in personal owner). They use the owner's existing encrypted
Vercel credential and invoke the deployed `VercelSnapshotBuild`; no new global token or snapshot
environment variable is needed.

A stored runtime digest differing from the deployed identity sets `upgradeAvailable` in the settings
status. It does not invalidate a ready connection or reject new sessions: provider selection checks
setup readiness, and the BYOC runtime resolver uses the stored snapshot ID. During an upgrade, the
old ready snapshot remains selected until the validated replacement is projected as ready. A failed
upgrade retains the old ready snapshot. New allocations use the replacement after activation;
already-running allocations are not restarted. This does not waive the fixed-Node-path requirement
above when deliberately enabling downloaded startup on an older base.

The lifecycle is implemented by the
[settings router](../../../apps/web/src/routers/organizations/organization-vercel-compute-router.ts),
[runtime resolver](../src/byoc/vercel-credential-resolver.ts) and
[upgrade status projection](../../../apps/web/src/lib/cloud-agent-next/vercel-compute-status.ts).
Check these consumers when deciding whether a future base change requires a coordinated cutover.

The old `snapshot:vercel` operator harness and its baked-runtime manifest helpers are retired. Use the
owner's authenticated in-app upgrade for base snapshot creation and validation. Before any authorized
live qualification, verify the credential's account, team/project and billing scope. Local unit/provider
fixtures do not prove acceptance by Vercel or activation for a real owner.

All new native and BYOC Vercel allocations download the runtime, including organization and personal
accounts and code reviews. The old `interactiveOrgIds` / `RUNTIME_INTERACTIVE_ORG_IDS` rollout gate
is rejected, not a path back to preinstalled startup. The renderer emits only the `runtime-free` image.

### Kilo v2 harness

A downloaded target can also name `kilo2: { orgIds }`. Without it, new sandboxes select v1.
A sandbox's first allocation selects v2 only when every preparing route has the
worker-owned `billingOrigin: cloud-agent-web`. Its downloaded start must also pass the organization
rule for the `kilo2.orgIds` list: all preparing routes belong to one listed organization, and native
allocations are isolated. Code reviews, desktop, Agent Manager and other origins stay on v1, including
routes with a missing origin and sandboxes with mixed origins. This origin restriction applies only
to v2 selection; downloaded v1 startup is available to every account. A client-supplied
`createdOnPlatform` cannot select v2. Existing routes without a stored `billingOrigin` select v1.
The checked-in catalog enables this rule only for organization
`9d278969-5453-4ae3-a51f-a8d2274a7b56` after deployment.
The Sandbox DO stores that harness, and every later allocation of the
sandbox uses it, because native history does not move between v1 and v2. A sandbox that allocated
before this record existed stays on v1. The harness is stored after startup preflight and capacity
checks, before provider creation. A failed preflight does not fix the harness for later attempts.
Changing the v2 organization list affects only sandboxes without a stored harness.

Existing v2 sandboxes cannot move back to v1. Removing the v2 release prevents their next allocation
with `invalid_configuration`. To keep existing v2 sessions recoverable, retain the v2 release.
Changing the organization scope only affects new sandbox harness selection.

Each publication packages the pinned v1 and v2 CLIs (`PINNED_CLIS` in
`scripts/runtime-cli-artifact.ts`) with the same control payload. It verifies both on the base and
records the v2 descriptor in the exact-SHA handoff. Deployment renders `RUNTIME_KILO2_ORG_IDS` and
`RUNTIME_RELEASE_DESCRIPTOR_KILO2` from the catalog and that handoff, and fails when a `kilo2` target
has no v2 release. The release names its harness through its CLI executable (`package/bin/kilo2`).
A start whose release harness differs from the sandbox's stored harness fails as
`invalid_configuration`. Session snapshots are keyed by the selected descriptor, and environment
snapshots do not depend on the runtime release, so neither needs a harness namespace.

Environment snapshot builders use only `runtime-free` with downloaded startup. Snapshots are
available to every organization and personal account, independently of startup selection. Repository
authorization is still required. Personal-owned Bitbucket environments cannot build snapshots because
managed Bitbucket repository access requires an organization. Personal GitHub and GitLab environments
are supported.
Builds require a downloaded runtime-free deployment and a published runtime release. Existing
all-in-one environment snapshots are incompatible and trigger replacement builds. Runtime-only updates retain snapshot
compatibility when the runtime-free base image and ABI stay unchanged.

## Deployment and qualification

The checked-in catalog selects downloaded runtime-free deployment-wide for all targets. A downloaded
default or named target makes eligible successful main CI publish a handoff for that SHA, and downloaded
deployment waits for that handoff. Use a dedicated test organization for real-provider qualification;
the current catalog does not limit downloaded startup to that organization. Record the Worker name,
exact source SHA, bucket and instance type for each qualification deployment. Broad enrollment does
not itself establish that the provider checks below passed.

Before deploying a release that removes SDK sandbox bindings, drain every session
still running on a retired sandbox class. The new Worker cannot stop, inspect or
reclaim an instance through a binding it no longer has.

1. Provision publication through the process in [runtime-publication.md](runtime-publication.md).
   Verify that a main CI run publishes the exact-SHA handoff and rejects retired catalog selections.
   Failed CI, PR, fork and merge-group runs must not
   publish. Repeat successful publication and confirm identical retained objects.
2. Runtime-free relies on B1 ([PR #7914](https://github.com/Kilo-Org/cloud/pull/7914)): a running
   container captures under its start image. B1 is merged into main, and its regression test runs
   in CI.
3. Complete the checks below with sessions in the test organization, including at least one web
   session and one non-web session (for example a webhook trigger). Also verify a personal session
   uses the deployment-wide downloaded default.
4. Record qualification evidence separately from catalog configuration. Further mode, image or cohort
   changes require a reviewed catalog change and the relevant provider evidence.

From the service directory in a clean checkout, prepare the generated configuration without running
Wrangler deployment:

    SOURCE_SHA=$(git rev-parse HEAD)
    pnpm exec tsx scripts/prepare-runtime-deploy.ts production "$SOURCE_SHA"

The generated wrangler.runtime-generated.json stays ignored. Preparation needs the approved read credentials and exact-SHA
handoff. Inspect the generated image reference and vars before an approved deployment. The existing
Worker workflow consumes that exact generated config.

The package no longer exposes a raw `deploy` script. Use the prepared deployment command from the
approved workflow; raw `wrangler deploy` does not load the verified generated configuration.

## Required provider evidence

Use the minimum approved instance type and the target's normal first-connect budget. Do not shorten
timers for timing qualification. Save source and artifact hashes, session/allocation/container IDs,
image digest, snapshot ID and elapsed times. Keep credentials and raw bootstrap argv out of evidence.

| Check | Required observation |
|---|---|
| Supplied PID1 on restore | Snapshot A has a startup sentinel. Selecting B starts the bootstrap first. A's sentinel count stays one and A never reaches hello. |
| User data | A user file, user configuration and an executable project dependency survive A-to-B restore. |
| Uncached minimum instance | Cold and uncached restored starts finish inside the first-connect budget, including HTTPS, CA handling, transfer, extraction and CLI probe. |
| Runtime replacement | B's active CLI/control hashes match the selected descriptor. Captured A cannot substitute for B. |
| Failure report | An unauthorized download and a failed CLI probe produce their specific permanent route errors before first-connect expiry. |
| Lost report | Dropping the report preserves the existing first-connect stop/retry and preparation timeout. No new readiness poll exists. |
| Restricted egress | The Worker artifact/report host works through HTTPS allowlist policy; an unrelated denied host remains denied. |
| Grant cleanup | After handoff, container process argv/env and runtime files contain no artifact-read grant. |
| Provider metadata retention | Record whether provider start metadata retains the grant after handoff and until expiry. Record field names and times, never grant bytes. |
| Stable base | A runtime-only deployment keeps the exact runtime-free registry digest and restores the existing repository snapshot naturally. |
| Existing allocations | A preinstalled allocation active during deployment keeps its stored mode and deadlines. |
| B1 regression | A container running across an image change captures under its start image, even after DO reconstruction. |

A snapshot trusts host tools like the owner's own container. This rollout does not change that trust model.
During bootstrap, the short-lived two-object grant is present in PID1 argv and provider start metadata.
Provider metadata retention remains unmeasured until the approved real-provider check.

## Rollback

Roll back by selecting a previously verified source SHA and its retained runtime handoff/base digest.
Do not change the catalog to preinstalled or all-in-one; those selections are no longer accepted.
Keep earlier descriptors, payloads, handoffs and image digests. Do not delete snapshots or publication
objects during rollback. Existing allocations retain their mode, image and deadlines. Keep the runtime
bucket binding available for allocations that are still bootstrapping, and do not deploy a Worker that
cannot read historical allocation state.

## Local development

`pnpm dev` and `pnpm start` publish the freshly built wrapper and pinned CLIs into local Wrangler R2,
then pass their descriptor hashes to Wrangler. The local Worker uses `.wrangler/state` persistence and
the same runtime-free image/download bootstrap as production. No remote publication credentials or
deployment are required. CLI tarballs are cached in that local bucket; wrapper changes publish new
content-addressed payloads on restart. The first start requires npm registry access, Bun and Docker.
The pinned runtime is linux/amd64; ARM Docker hosts require amd64 emulation.
The launcher defaults to `--env dev` and rejects other environments, so execution and publication
always select the same local bucket configuration.

The local HTTP E2E profile uses the same startup script and R2 persistence. Deployed E2E rendering
requires `wrangler.runtime-generated.json` from exact-SHA preparation, including its verified image,
runtime bucket and descriptor. It never falls back to building a baked runtime image.

## Evidence available before approval

Local native preinstalled/downloaded cold starts and warm messages passed. Native HTTPS allowlist downloads,
a denied-host control and a specific CLI-probe failure passed. The unauthorized-download test used private HTTP.
A dropped report retained the original five-minute first-connect retry and 12-minute preparation timeout.

Local native A-to-B snapshot restore passed with user file/configuration/dependency preservation and an
unchanged A sentinel count. Wrangler changes image tags on restart, so this test used a controlled local
snapshot-index fixture after verifying the unchanged underlying image digest. It does not prove natural
snapshot reuse across deployed image changes.

The locally built runtime-free image passed the actual packaged CLI version probe and control-wrapper
hello/shutdown. A real CLI version mismatch failed the compatibility gate. This proves local payload/base
execution, not provider restore semantics, minimum-instance timing or metadata retention.

Publication is provisioned, and a manual publication created an exact-SHA handoff. The checked-in
catalog now selects downloaded runtime-free for all targets without an organization restriction.
Real-provider qualification evidence remains pending; the broader configuration is not evidence that
those checks passed.
