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
Downloaded startup supports native Cloudflare Containers and BYOC Vercel. SDK pins keep preinstalled startup.

BYOC Vercel uses its customer-owned snapshot as the base. The snapshot setup provides the fixed Node
path and Bun version required by the bootstrap. Downloaded startup installs the selected immutable CLI
and control release as root. The base digest covers the ABI, Node major, Bun, and base setup commands;
CLI and wrapper changes do not change that digest or require a new snapshot. Existing allocations keep
their installed release until a new allocation starts. Base dependency changes still require a snapshot
upgrade. Upgrade older BYOC snapshots once before enabling downloaded mode, so they have the required
fixed Node path. Native image selection does not change the Vercel snapshot.

A downloaded target can scope its startup to an `interactiveOrgIds` list. Production uses it for one test organization.
Deployment renders this list as `RUNTIME_INTERACTIVE_ORG_IDS`.
A new allocation selects it only when all its preparing routes belong to one listed organization and have
`createdOnPlatform: cloud-agent-web`. Native allocations must also be isolated; Vercel allocations use
the same organization rule. Other organizations, personal sessions, non-web sessions, code reviews and
shared native sandboxes retain preinstalled startup on the unchanged `app` image. SDK pins always stay
preinstalled. A missing or mixed route identity stays on the baseline. These identity values are rollout
metadata, not an authorization boundary.

The renderer retains `app` alongside `runtime-free`; the allocation's selected startup mode and image
are used together, including snapshot fallback. Existing allocations keep their running image and mode.
An absent `interactiveOrgIds` means deployment-wide startup selection; an empty catalog list is
rejected. For a complete rollback, remove the production override so it inherits the preinstalled default.

Known limitation: the environment builder always starts the `app` image, so its snapshots never match
a `runtime-free` allocation. Enrolled organizations cold-start from the image instead of restoring
builder-produced environment snapshots. Repository snapshots captured by a `runtime-free` container
still restore. The `Stable base` row covers repository snapshots only.

## Approval and rollout order

Production uses downloaded runtime-free for its `interactiveOrgIds` cohort; every other target and session
uses preinstalled all-in-one. A downloaded catalog entry is the only
switch: it makes main CI publish a handoff for that SHA, and deployment waits for that handoff. Real-provider
qualification remains required. Use an isolated named environment first. Record its account,
Worker name, exact source SHA, bucket and instance type before deployment.

1. Provision publication through the process in [runtime-publication.md](runtime-publication.md).
   Verify one manual publication creates the exact-SHA handoff. Failed CI, PR, fork and merge-group
   runs must not publish. Repeat successful publication and confirm identical retained objects.
2. Approve one isolated target using downloaded startup on the all-in-one image. Add only that environment
   to the catalog. Deploy its verified handoff and complete the checks below.
3. Runtime-free relies on B1 ([PR #7914](https://github.com/Kilo-Org/cloud/pull/7914)): a running
   container captures under its start image. B1 is merged into main, and its regression test runs
   in CI.
4. Approve runtime-free on the same isolated target. Change its catalog image only. Repeat qualification.
5. Enroll production organizations through `interactiveOrgIds` in a separate reviewed catalog change.
   Expanding the list or removing the cohort restriction requires qualification evidence.

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

No CI bucket or credentials were provisioned. No remote release or registry image was published.
No Worker was deployed. Real-provider qualification and production rollout remain pending.
