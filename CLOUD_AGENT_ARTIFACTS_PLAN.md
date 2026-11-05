# Cloud Agent Artifacts Plan

## Goal

Add a normal `/artifacts` folder for agents, automatically synchronized to private
R2 storage. Users browse and download its contents from an Artifacts view,
including when the sandbox is offline.

## V1 Scope

- Near-real-time synchronization through wrapper polling, plus a flush at turn end.
- Create, update, and delete files using normal filesystem operations.
- Shared artifacts across sibling chats in the same workspace. Access stays
  owner-only, matching Changes and session history.
- Offline listing and downloads.
- Restore artifacts when replacing a sandbox.
- No publish tool, filesystem watcher, browser editing, version-history UI, or
  native mobile UI.

Naming: "runtime artifacts" already exists (`runtime-artifact-routes.ts`). Use
`workspace artifacts` / `workspaceArtifact*` in code.

## 1. Generalize The Existing Sandbox Upload Channel

The wrapper already sends data to the Worker over HTTP without exposing storage
credentials:

- `wrapper-launch-env.ts` mints an HS256 grant scoped to
  `{sandboxId, allocationId, wrapperInstanceId}` and passes
  `CONTROL_LOG_UPLOAD_URL` / `CONTROL_LOG_UPLOAD_GRANT` to the wrapper.
- `log-routes.ts` validates the grant against the path identity, enforces media
  type, `Content-Length`, and a byte cap, then writes through an R2 binding with
  `onlyIf: { etagDoesNotMatch: '*' }` for idempotency.
- `file-log-uploader.ts` / `diagnostics.ts` PUT with `redirect: 'error'` and an
  abort signal.

The upload host is `WORKER_URL`, which is already on the native egress allowlist
(`sandbox-control/egress-policy.ts`), so this works in restricted-egress
containers. Direct presigned uploads to `*.r2.cloudflarestorage.com` do not, and
`r2-client.ts` cannot presign PUT anyway. Reuse this channel instead of adding a
second one.

Refactor it into a generic sandbox transfer channel, keeping log behavior
unchanged:

1. **Grant.** Rename `log-upload-grant.ts` to a sandbox transfer grant with a
   `scopes` claim (`logs`, `workspace_artifacts`). Keep the audience/identity
   validation. Mint it whenever the wrapper launches, not only when diagnostics
   are enabled. Rename the env pair to `SANDBOX_TRANSFER_URL` /
   `SANDBOX_TRANSFER_GRANT`, keeping the old names during rollout for older
   wrapper releases.
2. **Identity.** Use one wrapper identity. Today `CONTROL_WRAPPER_INSTANCE_ID` is
   deleted unused while the control connection generates its own random
   `wrapperId`. Pass the launch identity into `createControlPlaneConnection` so
   the grant and the `hello` frame name the same wrapper, and the Sandbox DO can
   match transfers against the current allocation and connected wrapper.
3. **Worker route helpers.** Extract `authorizeIdentity`, `declaredLength`,
   `mediaType`, and bounded body handling from `log-routes.ts` into a shared
   module. Add a streaming variant that passes `request.body` straight to
   `R2Bucket.put` with a required `Content-Length` (and the binding's `sha256`
   option for integrity) instead of buffering the whole body in memory.
   Log routes keep their buffered, JSON-validated path.
4. **Wrapper client.** Extract a small transfer client (base URL, grant header,
   `redirect: 'error'`, abort, bounded retry with backoff, status classification)
   used by the log uploader, diagnostics, and artifact sync.
5. **Grant lifetime.** `CONTROL_LOG_GRANT_SECONDS` is four hours and the grant is
   fixed at launch. Confirm whether a wrapper can outlive it. If so, renew it in
   the `hello` acknowledgement over the existing control connection rather than
   adding a new credential path.

Routes become `/sandbox-transfer/:sandboxId/:allocationId/:wrapperInstanceId/...`
with `logs/...` and `artifacts/...` subtrees. Keep `/sandbox-logs/...` as an alias
until older wrappers have aged out.

Main integration:

- `services/cloud-agent-next/src/sandbox-control/log-upload-grant.ts`
- `services/cloud-agent-next/src/sandbox-control/log-routes.ts`
- `services/cloud-agent-next/src/sandbox-control/wrapper-launch-env.ts`
- `services/cloud-agent-next/src/sandbox-control/runtime-bootstrap.ts`
- `services/cloud-agent-next/src/shared/runtime-environment.ts`
- `services/cloud-agent-next/src/shared/control-diagnostics.ts`
- `services/cloud-agent-next/wrapper/src/control/file-log-uploader.ts`
- `services/cloud-agent-next/wrapper/src/control/diagnostics.ts`
- `services/cloud-agent-next/wrapper/src/control-plane/connection.ts`
- `services/cloud-agent-next/wrapper/src/control-plane/main.ts`

## 2. Define Storage And Ownership

Use the existing Sandbox DO to own the durable artifact index. It is addressed by
the workspace's stable `sandboxId`, which sibling chats share and which survives
allocation replacement. Confirm that one sandbox serves exactly one workspace:
`docs/control-plane.md` states this in its model section, but its test scenario 5
describes two worktrees in one sandbox.

Store one current entry per relative path:

```text
relativePath
objectKey
contentHash
sizeBytes
contentType
updatedAt
```

Keep an index `revision` that increments on each commit or delete.

Add a dedicated private bucket binding (production and dev) for workspace
artifacts; production currently binds only `R2_BUCKET` (`kilocode-sessions`).
Object keys are server-generated (`<sandboxId>/<uuid>`). Each replacement upload
gets a new key, so a failed upload cannot damage the currently available file.

Add the index with the existing DO SQLite/Drizzle conventions
(`drizzle-kit generate --config drizzle.sandbox.config.ts`). Never bump
`GENERATION`; that wipes DO storage.

Before rollout, define:

- Limits, as named constants. Proposed V1 values:
  - 50 MiB per file. Bytes never pass through the DO; the cap comes from
    Cloudflare's Worker ingress limit (100 MB on the lowest plan, and an edge 413
    can happen before the handler runs), the turn-end flush budget, and
    `docs/control-plane.md` noting that Vercel forwarding is only verified for
    8 MiB transfers.
  - 500 MiB total per workspace, which bounds restore time during preparation.
  - 1,000 files, 1,024-byte relative paths, depth 16.
  Larger files can follow with Worker-proxied R2 multipart uploads, where each
  part request stays under the ingress limit.
- Retention and asynchronous cleanup of replaced, deleted, and abandoned objects
  (an object written but never committed).
- Deletion with the workspace, through the existing worktree-deletion flow, and
  with the account.

Main integration:

- `services/cloud-agent-next/src/control-plane/sandbox/sqlite-schema.ts`
- `services/cloud-agent-next/src/control-plane/sandbox/sandbox-do.ts`
- `services/cloud-agent-next/src/control-plane/sandbox/worktree-deletion.ts`
- `services/cloud-agent-next/drizzle.sandbox.config.ts`
- `services/cloud-agent-next/wrangler.jsonc`
- `docs/do-sqlite-drizzle.md`

## 3. Add Artifact Transfer Routes

All artifact operations run over the generalized transfer channel. No file bytes
and no new frame types go over the control WebSocket, so no `hello` capability
negotiation is needed: a wrapper without the transfer URL simply does not sync.

- `GET  .../artifacts/index` returns entries and the revision.
- `GET  .../artifacts/objects/:entryId` streams one current object for restore.
- `PUT  .../artifacts/objects?path=...` streams the body to a fresh object key,
  verified by `Content-Length` and `sha256`, then commits it to the index.
- `DELETE .../artifacts/objects?path=...&hash=...` removes an index entry.

Each route calls a Sandbox DO RPC that checks the grant's `allocationId` and
`wrapperInstanceId` against the current allocation and connected wrapper
(`connectionMatches`). The upload is stateless, so the Sandbox DO must repeat
this check at commit time. Reject stale or replaced wrappers there.

Make commits idempotent: committing the same path and hash twice is a no-op, and
deletes carry the expected hash so a late delete cannot remove a newer file. A
rejected commit leaves an orphaned object for cleanup.

Main integration:

- A new `services/cloud-agent-next/src/sandbox-control/workspace-artifact-routes.ts`
- `services/cloud-agent-next/src/server.ts`
- `services/cloud-agent-next/src/control-plane/sandbox/sandbox-do.ts`

## 4. Implement One Polling Loop

Create one artifact synchronizer per sandbox in the wrapper. There is one wrapper
per sandbox, serving all sibling chats. Start it lazily after the first route's
preparation (including restore) finishes; stop it in `lifecycle.stop`. Follow
the `file-log-uploader.ts` loop shape.

Run a scan approximately every four seconds, without overlapping passes:

1. Enumerate regular files under `/artifacts`.
2. Compare relative paths, sizes, nanosecond modification times, and inode/ctime.
3. Consider a file eligible after it is unchanged across two successful scans.
4. Hash eligible candidates and skip content already uploaded.
5. Upload changed content, re-checking size and mtime after hashing and after
   upload to detect concurrent modification.
6. Rely on the PUT route to commit successful uploads to the index.
7. Delete remote entries for paths absent across two complete scans.

Keep the previous published version until its replacement succeeds. Missing or
unreadable roots and incomplete scans are errors, not empty folders, and must not
trigger deletion. Do not treat rejected or unstable files as absent. Reset
stability observations after a scan failure. Never run the deletion pass until
restore for this allocation has succeeded.

Bound file count, file size, total storage, path length/depth, and transfer time.
Reject symlinks and special files. Start with one transfer at a time.

Idle behavior: background polling must never set the heartbeat's `active` flag.
That flag is what renews the provider lease and moves `lastActivityAt`. The
exception is the turn-end flush (see Section 5).

Main integration: a focused `wrapper/src/control-plane/workspace-artifacts.ts`
module, composed through `wrapper/src/control-plane/main.ts`.

## 5. Handle Sandbox Lifecycle

Provision writable `/artifacts` on both native Cloudflare Containers and BYOC
Vercel sandboxes. It sits outside every git root, so auto-commit and worktree
diffs ignore it. On Vercel, create it with the same ownership as `/workspace`.

- **Turn-end flush.** Idle stop calls `container.destroy()` / `stopSession`
  directly and never sends `shutdown`, so wrapper shutdown hooks do not run.
  Unattended sessions can stop one minute after activity. When a turn ends, run
  one stability-bypassing scan and upload while still reporting `active`, bounded
  to a short budget (for example 30 seconds). This is the only reliable flush.
- **Replacement sandbox.** Restore the remote folder before setup commands,
  agent execution, or synchronization begins. Clear local files not present in
  the index; R2 always wins over a tail or environment snapshot.
- **Same live allocation.** Preserve local files and pending changes; do not
  restore over them on a socket reconnect or wrapper restart.
- **Restore failure.** Retry within a bound, then surface a specific preparation
  error instead of starting against a partially restored directory. If a
  degraded mode is preferred later, it must disable the deletion pass.
- **Shutdown.** Stop the polling loop and cancel pending operations. Do not rely
  on shutdown for durability.

Use the existing workspace stamp (`workspace-stamp.ts`), not a new marker, to tell
a surviving disk from a replacement or snapshot. For workspaces with no git,
`classifyWorkspace` always reports `empty`, so compare `stamp.allocationId`
directly. Write the stamp only after restore completes, matching root-recovery
behavior.

Restore runs inside `withWorkspaceLock`, at three points in `prepare.ts`:

- On the normal path, before `runPreparationCommands`. The existing
  `onReplacementWorkspace` hook runs after setup, which is too late.
- On the tail-snapshot path, before its start commands.
- In the branch for routes with no git and no setup.

Main integration:

- `services/cloud-agent-next/wrapper/src/control-plane/prepare.ts`
- `services/cloud-agent-next/wrapper/src/control-plane/workspace-stamp.ts`
- `services/cloud-agent-next/wrapper/src/control-plane/main.ts`
- `services/cloud-agent-next/Dockerfile.containers`
- `services/cloud-agent-next/src/byoc/vercel-runtime-base.ts`

## 6. Expose Offline Access

Add authenticated listing and download operations through the existing Worker
handlers (`src/router/handlers/`, modeled on `session-worktree-changes.ts`) and
personal/organization tRPC paths, using `requireCurrentSessionAccess`. Add the
procedures to the hand-written `CloudAgentNextTRPCClient` interface.

These operations read the Sandbox DO index and R2 without preparing or waking a
sandbox.

Downloads resolve object keys server-side after the access check; never accept
bucket keys from the browser. Either stream through the Worker or sign a
short-lived GET with a new read-only key scoped to the artifact bucket
(`r2-client.ts` supports `response-content-disposition`). Always use
`attachment` disposition with an RFC 5987 filename, particularly for HTML and SVG.

Notify through the `worktree_changes` precedent: after each index change, the
Sandbox DO enqueues `{ kind: 'workspace_artifacts', revision }` to every route in
the workspace through the existing notification dispatcher. The Session DO
persists a deduplicated event (`insertUnique`, `entityId:
workspace-artifacts/<revision>`) and broadcasts it. The dispatcher is
best-effort, so the UI also refetches on panel open, focus, and reconnect.

Main integration:

- `services/cloud-agent-next/src/router.ts` and `src/router/handlers/`
- `services/cloud-agent-next/src/control-plane/session/session-do.ts`
- `services/cloud-agent-next/src/control-plane/sandbox/notifications.ts`
- `services/cloud-agent-next/src/shared/protocol.ts`
- `services/cloud-agent-next/src/websocket/types.ts`
- `packages/cloud-agent-sdk/src/schemas.ts`
- `packages/cloud-agent-sdk/src/normalizer.ts`
- `packages/cloud-agent-sdk/src/session-manager.ts`
- `apps/web/src/lib/cloud-agent-next/cloud-agent-client.ts`
- `apps/web/src/routers/cloud-agent-next-router.ts`
- `apps/web/src/routers/organizations/organization-cloud-agent-next-router.ts`

## 7. Add The Artifacts View

Add an Artifacts button beside Changes in the chat header. Follow the Changes
pattern: a toggle that replaces the chat content area, mutually exclusive with
Changes and the child-session and preparation drawers, with its own mobile
layout. Adjust the header's reserved width.

The read-only view shows:

- Filename, size, and last synchronized time.
- Download action.
- Loading, empty, and error states.
- An offline notice explaining that saved files remain accessible but new changes
  are not syncing.

Start with file listing and download only. Rich previews can follow separately.

Update `buildCloudAgentRules` (`src/shared/cloud-agent-rules.ts`): replace "The
filesystem is ephemeral and will not persist after the session ends" with wording
that keeps everything ephemeral except `/artifacts`, and state that user-facing
outputs belong in `/artifacts`. Do not require the agent to know about
synchronization.

Add the rule to `### Workspace` in `.specs/cloud-agent-session.md` with a
Changelog entry.

Main integration:

- `apps/web/src/components/cloud-agent-next/ChatHeader.tsx`
- `apps/web/src/components/cloud-agent-next/CloudChatPage.tsx`
- A new artifacts component and query hook in the same subtree, modeled on
  `WorktreeChanges.tsx` and `useSavedWorktreeChanges.ts`.

## 8. Verify

- Transfer channel refactor: existing log and diagnostic upload tests still pass;
  logs and artifact scopes cannot be used interchangeably; a grant for one
  allocation or wrapper is rejected for another.
- Unit-test creation, modification, deletion, unchanged files, failed scans,
  concurrent writes, upload retries, idempotent commits, late deletes, and
  interrupted restores.
- Test workspace isolation, stale allocation rejection at commit, path traversal,
  symlinks, quotas, and unauthorized downloads.
- Confirm sibling chats share one folder and one synchronizer.
- Verify the turn-end flush lands a file written in the turn's last seconds
  before an unattended idle stop, and that idle polling never extends compute.
- Verify uploads work in a restricted-egress container.
- Verify metadata survives DO eviction and migrations.
- Test notification reconnect behavior and view states on desktop and mobile.
- On both providers, create artifacts, stop the sandbox, download them offline,
  then replace the sandbox (including from a tail snapshot) and verify
  restoration before another turn.
- Run focused formatting, type checks, and tests for changed packages.

## Expected Behavior And Limitations

Completed small files should generally appear within roughly 5-10 seconds plus
upload time when the sync queue is not busy, and at the latest by the turn-end
flush. Continuously changing files may take longer. Two unchanged scans are a
heuristic, not proof that a producer has finished.

R2 contains the last successfully synchronized state. Files written outside a
turn (for example by a background process) and lost to a crash or idle stop
before the next scan are not recoverable; this is eventual synchronization, not
synchronous filesystem durability.

## Order

1. Generalize the transfer channel (grant scopes, shared wrapper identity, route
   helpers, wrapper client) with no behavior change for logs.
2. Artifact bucket, index table, and transfer routes.
3. Sync loop and turn-end flush.
4. Restore hooks.
5. Read endpoints and notifications.
6. UI, agent rules, and spec.
