# Runtime rollout and qualification

The catalog at runtime-targets.json owns startup mode and native image selection. Its default is
preinstalled on all-in-one. Named environments inherit that default unless the catalog names them.
Keep startup variables out of checked-in Wrangler vars. Deployment renders the Worker vars and native
images from the catalog. Manual mode, descriptor, cohort or image drift fails before Wrangler or its custom build.

| Mode | Native image | Deployment reference |
|---|---|---|
| preinstalled | all-in-one | Existing Dockerfile and pinned build variables |
| downloaded | all-in-one | Existing Dockerfile, exact-SHA runtime descriptor |
| downloaded | runtime-free | Separate `runtime-free` named image with verified immutable base digest, exact-SHA runtime descriptor |

The runtime-free/preinstalled pair is invalid in the shared configuration schema and the Worker.
Native Cloudflare Containers select downloaded startup through the catalog. BYOC Vercel always uses
downloaded startup and requires a published runtime release. SDK pins keep preinstalled startup.

BYOC Vercel uses its customer-owned snapshot as the base. The snapshot setup provides the fixed Node
path and Bun version required by the bootstrap. Downloaded startup installs the selected immutable CLI
and control release as root. The base digest covers the ABI, Node major, Bun, and base setup commands;
CLI and wrapper changes do not change that digest or require a new snapshot. Existing allocations keep
their installed release until a new allocation starts. Base dependency changes still require a snapshot
upgrade. BYOC base snapshots contain no CLI or wrapper. Native image selection and interactive runtime
cohorts do not affect Vercel startup.

A downloaded target can scope its startup to an `interactiveOrgIds` list. Production uses it for one test organization.
Deployment renders this list as `RUNTIME_INTERACTIVE_ORG_IDS`.
A new allocation selects it only when all its preparing routes belong to one listed organization and have
`createdOnPlatform: cloud-agent-web`. Native allocations must also be isolated. Other organizations,
personal sessions, non-web sessions, code reviews and
shared native sandboxes retain preinstalled startup on the unchanged `app` image. SDK pins always stay
preinstalled. A missing or mixed route identity stays on the baseline. These identity values are rollout
metadata, not an authorization boundary.

The renderer retains `app` alongside `runtime-free`; the allocation's selected startup mode and image
are used together, including snapshot fallback. Existing allocations keep their running image and mode.
An absent `interactiveOrgIds` means deployment-wide startup selection; an empty catalog list is
rejected. For a complete rollback, remove the production override so it inherits the preinstalled default.

Environment snapshot builders use downloaded startup over a runtime-free base. Snapshot enrollment
remains controlled by `ENVIRONMENT_SNAPSHOT_ORG_IDS`, independently of the interactive runtime cohort.
Native builds require a downloaded runtime-free deployment. Vercel builds use the saved allocation's
customer-owned base snapshot and require a published runtime release, not native container enrollment.
Vercel compatibility includes the credential, project and exact base snapshot; runtime-only updates do
not invalidate it. A failed restore retries once from the clean base. Existing
all-in-one environment snapshots are incompatible and trigger replacement builds. Sessions on `app`
start from the image instead of restoring split-image snapshots. Runtime-only updates retain snapshot
compatibility when the runtime-free base image and ABI stay unchanged.

## Approval and rollout order

Production uses downloaded runtime-free for its `interactiveOrgIds` cohort; every other target and session
uses preinstalled all-in-one. A downloaded catalog entry is the only
switch: it makes main CI publish a handoff for that SHA, and deployment waits for that handoff.
Real-provider qualification runs on the production test-organization cohort. Record the Worker name,
exact source SHA, bucket and instance type for each qualification deployment.

1. Provision publication through the process in [runtime-publication.md](runtime-publication.md).
   Verify that a main CI run with a downloaded catalog entry publishes the exact-SHA handoff, and that
   a preinstalled-only catalog skips publication. Failed CI, PR, fork and merge-group runs must not
   publish. Repeat successful publication and confirm identical retained objects.
2. Runtime-free relies on B1 ([PR #7914](https://github.com/Kilo-Org/cloud/pull/7914)): a running
   container captures under its start image. B1 is merged into main, and its regression test runs
   in CI.
3. Enroll one test organization through `interactiveOrgIds` on production runtime-free. Complete the
   checks below with web sessions in that organization.
4. Expanding the list or removing the cohort restriction requires that qualification evidence and a
   separate reviewed catalog change.

For a clean checkout, preview deployment preparation without running Wrangler:

    SOURCE_SHA=$(git rev-parse HEAD)
    pnpm exec tsx scripts/prepare-runtime-deploy.ts production "$SOURCE_SHA"

The generated wrangler.runtime-generated.json stays ignored. Preinstalled preparation requires no runtime
bucket or registry credentials. Downloaded preparation needs the approved read credentials and exact-SHA
handoff. Inspect the generated image reference and vars before an approved deployment. The existing
Worker workflow consumes that exact generated config.

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

Use the current compatible Worker build with a reviewed catalog change. Image rollback changes
runtime-free to all-in-one while mode stays downloaded. Mode rollback then selects preinstalled/all-in-one.
The renderer applies each change to new allocations. It does not rewrite existing allocations or their
deadlines. Do not deploy an older Worker that cannot read stored startup modes. A mode rollback also
removes the rendered `RUNTIME_RELEASE_BUCKET` binding. A downloaded allocation that is still
bootstrapping then gets 503 for artifact reads and restarts on the preinstalled path.

Keep earlier descriptors, payloads, handoffs and image digests. Do not delete snapshots or publication
objects during rollback. A mode change uses a separate repository snapshot namespace.

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

Publication is provisioned, and a manual publication created an exact-SHA handoff. Production enrolls
one test organization for qualification. Real-provider qualification evidence remains pending, and
no other organization is enrolled.
