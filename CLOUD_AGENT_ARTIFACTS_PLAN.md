# Cloud Agent Workspace Artifacts Plan

## Goal

Add a normal `/artifacts` folder for agents, automatically synchronized to private
R2 storage. Users browse and download its contents from an Artifacts view,
including when the sandbox is offline.

## V1 Scope

In scope:

- Near-real-time synchronization through wrapper polling, plus a flush at turn end.
- Create, update, and delete files using normal filesystem operations.
- Artifacts shared across sibling chats in the same workspace. Access stays
  owner-only, matching Changes and session history.
- Offline listing and downloads of everything ever synchronized for the
  workspace.

Out of scope:

- Restoring R2 contents into a replacement sandbox. The local folder comes back
  only through a workspace tail snapshot (Section 5).
- Publish tool, filesystem watcher, browser editing, previews, version history.
- Native mobile UI (`.specs/cloud-agent-session.md` already scopes mobile out).
- Files larger than the per-file cap (multipart uploads are a follow-up).

Naming: "runtime artifacts" already exists (`runtime-artifact-routes.ts`). Use
"workspace artifacts" / `workspaceArtifact*` in code, routes, and events.

All paths are relative to `services/cloud-agent-next/` unless they start with
`apps/`, `packages/`, `docs/`, or `.specs/`.

## Key Decisions

| Decision | Choice | Reason |
|---|---|---|
| Byte path | Wrapper → Worker HTTP route → R2 binding | `WORKER_URL` is already on the native egress allowlist; direct R2 hosts are not |
| Transport | Generalize the existing log upload channel | Already has scoped grants, size checks, and idempotent writes |
| Bytes through the DO | Never | 8 MiB control outbox, single-threaded DO shared by all sibling chats |
| Control-socket changes | One small request pair for grant renewal | No file data or artifact operations on the socket |
| Index owner | Sandbox DO SQLite | Keyed by stable `sandboxId`; one sandbox serves exactly one workspace |
| Stale-wrapper fence | Current `allocationId` + `wrapperId` in `AllocationState` | Existing state; do not add a new epoch |
| Grant lifetime | Short-lived; the wrapper renews it from the Sandbox DO | Wrappers can outlive four hours (12-hour turns, unbounded allocations); also fixes log uploads |
| Replacement sandboxes | No manual restore; rely on workspace tail snapshots | Avoids a second restore mechanism; R2 keeps the user-facing copy either way |
| Safety without restore | Baseline on first scan; publish only observed changes | An empty or stale folder can never delete or overwrite newer R2 state |
| Durability point | Turn-end flush | Idle stop destroys compute without a `shutdown` frame |
| Downloads | Presigned R2 GET with forced attachment disposition | Decided; needs a read-only key scoped to the artifacts bucket |
| Notification | Copy `worktree_changes` | Persisted, deduplicated, revisioned, refetch on reconnect |
| UI shape | Copy the Changes toggle | Changes replaces the chat content area; it is not a side panel |

## Limits

Define these as named constants in a shared module
(`src/shared/workspace-artifacts.ts`), used by the wrapper, Worker routes, and
Sandbox DO.

| Constant | V1 value | Why |
|---|---|---|
| `WORKSPACE_ARTIFACT_MAX_FILE_BYTES` | 50 MiB | Under Cloudflare's lowest-plan 100 MB Worker ingress limit, which can 413 at the edge before the handler runs; fits the turn-end flush budget |
| `WORKSPACE_ARTIFACT_MAX_TOTAL_BYTES` | 500 MiB | Bounds storage per workspace |
| `WORKSPACE_ARTIFACT_MAX_FILES` | 1,000 | Keeps scans and index reads cheap |
| `WORKSPACE_ARTIFACT_MAX_PATH_BYTES` | 1,024 | Relative path, UTF-8 |
| `WORKSPACE_ARTIFACT_MAX_DEPTH` | 16 | Directory levels under `/artifacts` |
| `WORKSPACE_ARTIFACT_SCAN_INTERVAL_MS` | 4,000 | Between the end of one scan and the next start |
| `WORKSPACE_ARTIFACT_TRANSFER_TIMEOUT_MS` | 120,000 | Per upload request |
| `WORKSPACE_ARTIFACT_FLUSH_BUDGET_MS` | 30,000 | Turn-end flush |
| `WORKSPACE_ARTIFACT_DOWNLOAD_URL_SECONDS` | 300 | Presigned browser download links |

Before raising the per-file cap, confirm the account's Worker ingress limit.
Vercel BYOC is not live; verify Vercel forwarding at 50 MiB before it launches
(`docs/control-plane.md` records only 8 MiB transfers as verified).

## 1. Generalize The Existing Sandbox Upload Channel

### Current state

- `src/sandbox-control/wrapper-launch-env.ts` mints an HS256 grant
  (`log-upload-grant.ts`) scoped to `{sandboxId, allocationId,
  wrapperInstanceId}`, valid for `CONTROL_LOG_GRANT_SECONDS` (four hours). It
  passes `CONTROL_LOG_UPLOAD_URL`, `CONTROL_LOG_UPLOAD_GRANT`, and
  `CONTROL_WRAPPER_INSTANCE_ID` to the wrapper, but only when
  `diagnostics.signingSecret` is set.
- `src/sandbox-control/log-routes.ts` (registered in `src/server.ts`) checks the
  grant against the path identity, media type, encoding, `Content-Length`, and a
  byte cap. It buffers the body (`readBoundedBytes`) and writes through
  `R2_BUCKET` with `onlyIf: { etagDoesNotMatch: '*' }`.
- `wrapper/src/control/file-log-uploader.ts` and
  `wrapper/src/control/diagnostics.ts` send `PUT` with `redirect: 'error'` and an
  abort signal.
- `wrapper/src/control-plane/main.ts` reads and deletes the env values. It
  deletes `CONTROL_WRAPPER_INSTANCE_ID` without using it. The control
  connection (`connection.ts`) generates its own random `wrapperId`.
- There is no cap on allocation lifetime, and the grant is fixed at launch, so
  log uploads from a wrapper older than four hours already fail with `401`. The
  12-hour turn work makes this common; renewal (item 3) fixes it.

### Changes

1. **Grant.** Rename `log-upload-grant.ts` to `sandbox-transfer-grant.ts`.
   - Claims: `type: 'sandbox_transfer'`, `aud: 'cloud-agent-sandbox-transfer'`,
     `identity`, `scopes: ('logs' | 'workspace_artifacts')[]`, `iat`, `exp`.
   - Keep the current strict validation (signature, audience, clock skew,
     maximum header length).
    - Keep the short lifetime (`SANDBOX_TRANSFER_GRANT_SECONDS`, four hours) for
     every scope. Renewal (item 3) removes the need for long-lived grants.
   - Accept the old `control_log_upload` grant on log routes only, until older
     wrapper releases age out.
2. **Minting.** Extract minting into one Sandbox DO helper used at launch
   (`wrapperLaunchEnv`, which already holds the signing secret) and at renewal.
   Mint on every wrapper launch, independent of whether diagnostics are enabled.
   Include `workspace_artifacts` when the feature is enabled for the session.
3. **Renewal over the control connection.** The wrapper asks the Sandbox DO for
   a fresh grant instead of relying on the launch-time one.
   - Add a wrapper-to-DO request pair, `transfer.grant` / `transfer.grant.result`
     (`{ requestId }` → `{ requestId, grant, expiresAt }` or an error), modeled on
     `history.page` / `history.result` (`history-requests.ts`,
     `history-pages.ts`). Handle it off the serial queue like `history.page`.
   - The DO answers only when `connectionMatches` holds for the sending socket,
     and mints for the identity it already knows: `sandboxId`, the current
     `allocationId`, and `AllocationState.wrapperId`. The wrapper cannot choose
     the identity or scopes.
   - Gate it with a `transferGrants` capability in `hello`, following the
     `startCommands` pattern. Older wrappers or DOs keep the launch-time grant.
   - The wrapper's transfer client renews at half the grant's lifetime, and once
     immediately on a `401`. It renews only while connected; uploads after a
     disconnect use the last grant until it expires, which keeps the final log
     upload working.
   - Renewal fixes the existing problem of log uploads stopping after four
     hours, which the 12-hour turn work would otherwise make common.
4. **Env names.** Add `SANDBOX_TRANSFER_URL` (base:
   `${WORKER_URL}/sandbox-transfer/<sandboxId>/<allocationId>/<wrapperInstanceId>`)
   and `SANDBOX_TRANSFER_GRANT`. Keep emitting the `CONTROL_LOG_*` names for
   older wrappers during rollout. Update the allowlists in
   `runtime-bootstrap.ts` and `shared/runtime-environment.ts`.
5. **One wrapper identity.** Pass `CONTROL_WRAPPER_INSTANCE_ID` into
   `createControlPlaneConnection({ wrapperId })` so the grant and the `hello`
   frame name the same wrapper. The Sandbox DO can then compare a transfer's
   `wrapperInstanceId` with `AllocationState.wrapperId`. Keep the random
   fallback when the env value is absent.
6. **Worker route helpers.** Move `authorizeIdentity`, `declaredLength`,
   `mediaType`, and `readBoundedBytes` into
   `src/sandbox-control/sandbox-transfer-http.ts`.
   - `authorizeTransfer(c, scope)` validates the grant, path identity, and scope.
   - Add `streamToBucket(bucket, key, request, { maxBytes, sha256, contentType })`.
     It requires `Content-Length`, rejects values above `maxBytes`, and passes
     `request.body` to `R2Bucket.put` with the `sha256` option, so R2 rejects a
     mismatched body. The body is never buffered.
   - Log routes keep their buffered, JSON-validated path.
7. **Wrapper client.** Add `wrapper/src/control/sandbox-transfer-client.ts`.
   - Holds the base URL and the current grant, swapping in renewed grants from
     item 3.
   - Provides `put` and `delete` with `redirect: 'error'`, abort signals,
     per-request timeouts, and bounded retry with jittered backoff on network
     errors, 429, and 5xx.
   - Returns a classified result (`ok`, `rejected` with status, `unavailable`).
   - The log uploader and diagnostics migrate to it with no behavior change.
8. **Routes.** Register `/sandbox-transfer/:sandboxId/:allocationId/:wrapperInstanceId/logs/...`
   with identical behavior to today, and keep `/sandbox-logs/...` as an alias.

Main integration:

- `src/sandbox-control/log-upload-grant.ts` → `sandbox-transfer-grant.ts`
- `src/sandbox-control/log-routes.ts`
- New `src/sandbox-control/sandbox-transfer-http.ts`
- `src/sandbox-control/wrapper-launch-env.ts`
- `src/shared/control-plane-protocol.ts` (`transfer.grant` frames, `hello`
  capability)
- `src/control-plane/sandbox/sandbox-do.ts` and a new
  `src/control-plane/sandbox/transfer-grants.ts` handler, modeled on
  `history-pages.ts`
- `src/sandbox-control/runtime-bootstrap.ts`
- `src/shared/runtime-environment.ts`
- `src/shared/control-diagnostics.ts`
- `src/server.ts`
- New `wrapper/src/control/sandbox-transfer-client.ts`
- `wrapper/src/control/file-log-uploader.ts`
- `wrapper/src/control/diagnostics.ts`
- `wrapper/src/control-plane/connection.ts`
- New `wrapper/src/control-plane/transfer-grant-requests.ts`, modeled on
  `history-requests.ts`
- `wrapper/src/control-plane/main.ts`

## 2. Storage And Ownership

### Ownership

The Sandbox DO owns the index. It is addressed by the workspace's stable
`sandboxId` (`SANDBOX_CONTROL.getByName(sandboxId)`), which sibling chats share
through `metadata.workspace.sandboxId` and which survives allocation replacement.
One sandbox serves exactly one workspace, so `/artifacts` and the index are
per workspace. Correct `docs/control-plane.md` test scenario 5 ("two worktrees in
one sandbox"), which contradicts this.

### Bucket and credentials

- Add a dedicated private bucket binding, `WORKSPACE_ARTIFACTS_BUCKET`, in
  production and dev in `wrangler.jsonc`, and to the Worker `Env` type.
- Add a bucket name variable and a read-only S3 access key scoped to that bucket
  for presigned downloads: `WORKSPACE_ARTIFACTS_BUCKET_NAME`,
  `WORKSPACE_ARTIFACTS_READONLY_ACCESS_KEY_ID`,
  `WORKSPACE_ARTIFACTS_READONLY_SECRET_ACCESS_KEY` (reuse `R2_ENDPOINT`).
  Document them in `ENVIRONMENT.md`.
- Object keys: `<sandboxId>/<uuid>`, generated by the Worker. Each upload gets a
  new key, so a failed or rejected upload cannot damage the current file.
- Write with `onlyIf: { etagDoesNotMatch: '*' }`.
- Object metadata: `contentType`, `customMetadata: { sandboxId, sha256 }`.

### Index schema

Add to `src/control-plane/sandbox/sqlite-schema.ts` and generate a migration with
`drizzle-kit generate --config drizzle.sandbox.config.ts`. Commit the SQL,
snapshot, and `migrations.js`. Never bump `GENERATION`; a change wipes DO
storage.

`workspace_artifacts`:

| Column | Type | Notes |
|---|---|---|
| `relative_path` | text, primary key | Normalized NFC, `/`-separated, validated |
| `object_key` | text, not null | Current object |
| `content_hash` | text, not null | Hex SHA-256 |
| `size_bytes` | integer, not null | |
| `content_type` | text, not null | From extension; default `application/octet-stream` |
| `updated_at` | integer, not null | Epoch ms of commit |

`workspace_artifact_orphans`:

| Column | Type | Notes |
|---|---|---|
| `object_key` | text, primary key | Replaced, deleted, or rejected object |
| `queued_at` | integer, not null | |

Keep `workspace_artifacts_revision` as a single integer in `ctx.storage.kv`,
incremented in the same transaction as each index change.

### Cleanup and deletion

- Replaced, deleted, and rejected objects go to the orphan table in the same
  transaction as the index change. The existing Sandbox DO alarm deletes them in
  batches.
- Uncommitted objects (upload succeeded, commit never happened, for example a
  Worker crash between the two): the route inserts an orphan row before the
  upload and removes it at commit, so the alarm sweeps anything left behind.
- Workspace deletion (`worktree-deletion.ts` flow) deletes the index and queues
  every object. Account deletion goes through the same workspace deletion path.
- Retention: artifacts live as long as the workspace.

Main integration:

- `src/control-plane/sandbox/sqlite-schema.ts`
- `src/control-plane/sandbox/drizzle/`
- `src/control-plane/sandbox/sandbox-do.ts`
- New `src/control-plane/sandbox/workspace-artifacts.ts` (index logic, kept out
  of `sandbox-do.ts`)
- `src/control-plane/sandbox/worktree-deletion.ts`
- `drizzle.sandbox.config.ts`
- `wrangler.jsonc`, `src/types.ts`, `ENVIRONMENT.md`
- `docs/do-sqlite-drizzle.md`

## 3. Artifact Transfer Routes

Register under
`/sandbox-transfer/:sandboxId/:allocationId/:wrapperInstanceId/artifacts`. Each
route runs `authorizeTransfer(c, 'workspace_artifacts')`, then calls a Sandbox DO
RPC. The wrapper only uploads and deletes; it never downloads.

### Sandbox DO RPCs

All RPCs take the grant identity and first check that
`AllocationState.kind === 'connected'`, `allocationId` matches, and `wrapperId`
equals `wrapperInstanceId`. A mismatch returns `stale` and the route responds
`409`. The upload is stateless, so this check runs at commit time, not only at
upload start. A still-valid grant held by a replaced wrapper is therefore
rejected for artifacts even before it expires.

```ts
reserveWorkspaceArtifactUpload(identity, { relativePath, sizeBytes }): Promise<
  | { status: 'ok'; objectKey: string }          // orphan row inserted
  | { status: 'stale' | 'quota_exceeded' | 'invalid_path' }
>

commitWorkspaceArtifact(identity, {
  relativePath, objectKey, contentHash, sizeBytes, contentType,
}): Promise<
  | { status: 'committed' | 'unchanged'; revision: number }
  | { status: 'stale' | 'quota_exceeded' | 'invalid_path' }
>

deleteWorkspaceArtifact(identity, { relativePath, expectedHash }): Promise<
  | { status: 'deleted' | 'absent' | 'hash_mismatch'; revision: number }
  | { status: 'stale' }
>
```

Commit rules:

- Same path and same hash: `unchanged`; the new object stays queued as an orphan.
- New entry: check file count and total bytes against the limits.
- Replacement: queue the previous object as an orphan.
- Increment the revision and notify (Section 6) only on real changes.

Delete rules: remove only when the stored hash equals `expectedHash`, so a late
or stale delete cannot remove a newer file.

### HTTP contract

| Route | Request | Success | Errors |
|---|---|---|---|
| `PUT .../objects?path=<p>` | headers `Content-Length`, `Content-Type`, `X-Content-SHA256` | `200` JSON `{ status, revision }` | `400` invalid path, `409` stale, `411`, `413` file or quota, `422` hash mismatch, `503` storage |
| `DELETE .../objects?path=<p>&hash=<h>` | none | `200` JSON `{ status, revision }` | `409` stale |

`PUT` flow: validate path and declared size, reserve (orphan row and key), stream
to the key with the `sha256` option, commit. If the commit is rejected, the
object stays queued as an orphan and the route returns the mapped error.

Path validation (shared by wrapper, routes, and DO): relative, NFC, no empty,
`.`, or `..` segments, no backslashes, NUL, or control characters, within the
path length and depth limits.

Main integration:

- New `src/sandbox-control/workspace-artifact-routes.ts`
- New `src/shared/workspace-artifacts.ts` (limits, path validation, schemas)
- `src/server.ts`
- `src/control-plane/sandbox/sandbox-do.ts`

## 4. Wrapper Synchronizer

Add `wrapper/src/control-plane/workspace-artifacts.ts`:

```ts
createWorkspaceArtifactSync(options: {
  root: string;                      // '/artifacts'
  statePath: string;                 // outside /artifacts, see "Baseline"
  allocationId: string;
  client: SandboxTransferClient;
  timers: Timers;
  log: (message: string) => void;
  onDiagnostic: DiagnosticSink;
}): {
  start(): void;
  flush(budgetMs: number): Promise<void>;
  isFlushing(): boolean;
  stop(): Promise<void>;
}
```

One instance per wrapper, which is one per sandbox. `main.ts` creates and starts
it at wrapper startup, before any route preparation, when `SANDBOX_TRANSFER_URL`
and the `workspace_artifacts` scope are present. It stops in `lifecycle.stop`.
Follow the `file-log-uploader.ts` loop shape.

### Baseline

Without a restore, the folder at wrapper start may be empty (fresh sandbox),
older than R2 (a tail snapshot captured before a later allocation whose capture
failed), or setup output from an environment snapshot. None of these may delete
or overwrite newer R2 state. So the synchronizer only publishes changes it
observes:

- The synchronizer keeps a small state file (`statePath`, for example
  `/var/lib/kilo/workspace-artifacts.json`) with `allocationId` and, per path, the
  last observed `{ size, mtimeNs, inode, publishedHash }`. Write it atomically.
- **Same allocation** (wrapper restart): state file `allocationId` matches.
  Resume from it; anything that changed while the wrapper was down is published
  normally.
- **New allocation** (fresh disk or any snapshot): no state file, or one from
  another allocation (a tail snapshot carries the old file). The first complete
  scan records every existing file as baseline and publishes nothing.
- A baseline file is published only after it changes (size, mtime, or inode).
- A baseline file that disappears is deleted remotely with `expectedHash` set to
  its baseline hash. If R2 holds a different (newer) version, the DO returns
  `hash_mismatch` and nothing is removed.
- New files created after baseline are published normally.

Consequence: in a sandbox without a tail snapshot, files from earlier sandboxes
remain in R2 and in the Artifacts view, but are not present locally. Writing the
same path again replaces the R2 copy.

### Scan

Run a scan every `WORKSPACE_ARTIFACT_SCAN_INTERVAL_MS`, never overlapping:

1. Enumerate regular files under `/artifacts` with `lstat`.
2. Record relative path, size, `mtimeNs`, `ctimeNs`, and inode.
3. A changed or new file is eligible once unchanged across two successful scans.
4. Hash eligible files (streaming SHA-256). Skip files whose hash equals the
   last published hash for that path.
5. Upload one file at a time. Re-`stat` after hashing and after the upload; if
   anything changed, discard the result and wait for stability again.
6. The `PUT` route commits on success; record `publishedHash` in the state file.
7. For paths absent across two complete scans that were published or baselined,
   send `DELETE` with the last known hash.

### Rules

- Keep the previous published version until its replacement commits.
- A missing or unreadable root and incomplete scans are errors, not empty
  folders. They never trigger deletion and reset stability observations.
- Rejected or unstable files are not treated as absent.
- Symlinks, sockets, FIFOs, and devices are skipped and reported.
- Files over the per-file cap, paths over the limits, and files that would
  exceed the quota are skipped with a diagnostic. They are retried only when
  they change.
- `409` (stale) stops the synchronizer. `401` triggers one grant renewal and a
  retry; a second `401` pauses it with a diagnostic until the next renewal.
  `503` and network errors back off and retry on the next scan.

### Idle behavior

Background scans never set the heartbeat's `active` flag; only `active` renews the
provider lease and moves `lastActivityAt` (`allocation.ts`). The turn-end flush is
the only exception.

## 5. Sandbox Lifecycle

### Folder provisioning

- Cloudflare: `RUN mkdir -p /artifacts` in `Dockerfile.containers` (root, which
  the wrapper and agent run as).
- Vercel: add `/artifacts` to the `sudo mkdir -p` and `sudo chown` line in
  `src/byoc/vercel-runtime-base.ts`. Vercel is not live; ship the provisioning,
  defer end-to-end verification.
- The wrapper also runs `mkdir -p /artifacts` at startup, so older images still
  work.
- `/artifacts` sits outside every git root, so auto-commit and worktree diffs
  ignore it.

### Turn-end flush

Idle stop calls `container.destroy()` / `stopSession` directly
(`sandbox-do.ts`) and never sends `shutdown`, so wrapper shutdown hooks do not
run. Unattended sessions can stop one minute after activity.

- When a turn reaches an outcome (`sendOutcome` in `turn.ts`, any status), call
  `sync.flush(WORKSPACE_ARTIFACT_FLUSH_BUDGET_MS)`.
- A flush runs one scan that bypasses the two-scan stability rule but keeps the
  concurrent-modification re-checks, then uploads and deletes as usual.
- Add `sync.isFlushing()` to `getHeartbeat().active` in `main.ts`, so compute
  stays alive for at most the budget.
- Do not delay the turn outcome for the flush.

Because a workspace tail snapshot is captured only after one minute without
activity, and the flush counts as activity, capture happens after the flush. The
snapshot's `/artifacts` therefore matches R2 at capture time.

### Replacement sandboxes

There is no manual restore. What the agent sees locally depends on how the
replacement starts:

| Start | Local `/artifacts` | R2 / Artifacts view |
|---|---|---|
| Workspace tail snapshot | As of the last capture | Unchanged |
| Environment snapshot or image | Empty, or setup output | Unchanged |
| Same allocation (reconnect, wrapper restart) | Untouched | Unchanged |

Workspace tail snapshots cover only part of the fleet (`docs/control-plane.md`,
"Workspace tail snapshots"; `src/control-plane/sandbox/workspace-snapshot.ts`):

- Owners enrolled through `WORKSPACE_SNAPSHOT_ORG_IDS` / `WORKSPACE_SNAPSHOT_USER_IDS`
  only; empty disables the feature.
- Isolated native Cloudflare Containers and registered `worktree_*` workspaces
  only; standalone sessions and other providers never capture or restore.
- Capture is best effort and runs once per idle period.

This is acceptable for V1 because the user-facing copy lives in R2 regardless,
and the baseline rule keeps R2 safe from empty or stale folders. If agents need
earlier artifacts locally outside tail-snapshot coverage, add an on-demand
restore later.

### Shutdown

`sync.stop()` cancels the loop and in-flight requests. Shutdown is not a
durability point.

Main integration:

- `wrapper/src/control-plane/main.ts`
- `wrapper/src/control-plane/turn.ts`
- `Dockerfile.containers`
- `src/byoc/vercel-runtime-base.ts`

## 6. Offline Access And Notifications

### Worker procedures

Add `src/router/handlers/session-workspace-artifacts.ts`, modeled on
`session-worktree-changes.ts`, and compose it in `src/router.ts`:

- `listWorkspaceArtifacts({ sessionId })` returns `{ revision, entries }`.
- `getWorkspaceArtifactDownloadUrl({ sessionId, relativePath })` returns
  `{ url, expiresAt }`.

Both use `protectedProcedure` and `requireCurrentSessionAccess`. They resolve
the session's `sandboxId` and read the Sandbox DO index. They never prepare,
start, or wake a sandbox.

### Downloads (presigned R2 GET)

- Resolve the object key server-side from `relativePath` after the access check.
  Never accept bucket keys from the browser.
- Sign with `createR2Client` from `packages/worker-utils/src/r2-client.ts`, using
  the read-only key scoped to the artifacts bucket, expiring after
  `WORKSPACE_ARTIFACT_DOWNLOAD_URL_SECONDS`.
- Always set `response-content-disposition: attachment; filename*=UTF-8''<name>`
  (RFC 5987). Extend `getSignedURL` with an optional `responseContentType` and
  set `application/octet-stream` for HTML, SVG, and XML so they can never render
  as active content on the R2 origin.
- The browser starts the download by navigating to the URL (`window.location` or
  an anchor without `download`, which is ignored cross-origin). Navigation is not
  subject to `connect-src`; confirm no CSP directive blocks it.

### Web tRPC

- Add both procedures to the hand-written `CloudAgentNextTRPCClient` interface
  and wrapper methods in `apps/web/src/lib/cloud-agent-next/cloud-agent-client.ts`.
- Personal router: `assertUserOwnsSession`, then the client call.
- Organization router: `organizationMemberProcedure` and
  `assertOrganizationOwnsSession`, then the client call.

### Notification

Copy the `worktree_changes` path end to end:

1. After a real index change, the Sandbox DO enqueues
   `{ kind: 'workspace_artifacts', payload: { revision } }` for every route in
   the workspace, using the existing dispatcher
   (`src/control-plane/sandbox/notifications.ts`).
2. `notifySession` calls a new Session DO method
   `onWorkspaceArtifactsChanged({ revision })`.
3. The Session DO persists a deduplicated event (`insertUnique`, `entityId:
   workspace-artifacts/<revision>`) and broadcasts it as
   `cloud.workspace.artifacts.changed`.
4. Add the event type to both `StreamEventType` unions
   (`src/websocket/types.ts`, `src/shared/protocol.ts`).
5. SDK: add the schema (`schemas.ts`), normalizer mapping
   (`normalizer.ts`), and a `workspaceArtifactsRefresh` atom in
   `session-manager.ts` that ignores revisions that are not newer and bumps on
   reconnect.

The dispatcher is best-effort, so the UI also refetches on view open, window
focus, and reconnect.

Main integration:

- `src/router.ts`, new `src/router/handlers/session-workspace-artifacts.ts`
- `src/control-plane/session/session-do.ts`
- `src/control-plane/sandbox/notifications.ts`
- `src/control-plane/sandbox/sandbox-do.ts`
- `src/shared/protocol.ts`, `src/websocket/types.ts`
- `packages/worker-utils/src/r2-client.ts`
- `packages/cloud-agent-sdk/src/schemas.ts`
- `packages/cloud-agent-sdk/src/normalizer.ts`
- `packages/cloud-agent-sdk/src/session-manager.ts`
- `apps/web/src/lib/cloud-agent-next/cloud-agent-client.ts`
- `apps/web/src/routers/cloud-agent-next-router.ts`
- `apps/web/src/routers/organizations/organization-cloud-agent-next-router.ts`

## 7. Artifacts View, Agent Rules, And Spec

### UI

Follow the Changes pattern (`WorktreeChanges.tsx`, `CloudChatPage.tsx`):

- `WorkspaceArtifactsButton` beside the Changes button in `ChatHeader.tsx`,
  shown under the same conditions as Changes (`canOpenWorktreeChanges`).
- Opening it replaces the chat content area. It is mutually exclusive with
  Changes and the child-session and preparation drawers.
- Adjust the header's reserved width in `CloudChatPage.tsx`.
- `useWorkspaceArtifacts` query hook, modeled on `useSavedWorktreeChanges.ts`,
  choosing the personal or organization procedure and refetching on mount,
  focus, reconnect, and the refresh atom.

The read-only view shows:

- Path (grouped by folder), size, and last synchronized time.
- Download action per file.
- Loading, empty, and error states.
- An offline notice when the sandbox is not running: saved files remain
  available, but new changes are not syncing.

Follow `DESIGN.md` and the `kilo-design-cloud` skill.

### Agent rules

Update `buildCloudAgentRules` in `src/shared/cloud-agent-rules.ts`:

- Replace "The filesystem is ephemeral and will not persist after the session
  ends" with: the filesystem is ephemeral, except that files saved in
  `/artifacts` are kept for the user.
- Add an "Artifacts" section: put user-facing outputs (reports, screenshots,
  exports, generated files) in `/artifacts`; the user can see and download them
  after the session ends. Files from earlier sessions may not be present in the
  folder. State the per-file and total limits.
- Do not mention synchronization.

### Spec

Add a rule under `### Workspace` in `.specs/cloud-agent-session.md` (shared
artifacts, offline access, owner-only, no restore outside tail snapshots) and a
Changelog entry.

Main integration:

- `apps/web/src/components/cloud-agent-next/ChatHeader.tsx`
- `apps/web/src/components/cloud-agent-next/CloudChatPage.tsx`
- New `apps/web/src/components/cloud-agent-next/WorkspaceArtifacts.tsx`
- New `apps/web/src/components/cloud-agent-next/useWorkspaceArtifacts.ts`
- `src/shared/cloud-agent-rules.ts`
- `.specs/cloud-agent-session.md`

## 8. Rollout And Compatibility

- Gate artifact sync behind a feature flag checked when minting the grant scope
  and when rendering the button.
- Old wrappers: no `SANDBOX_TRANSFER_URL` means no sync; listing still works and
  shows whatever exists.
- Old routes and grant types (`/sandbox-logs`, `control_log_upload`) stay until
  telemetry shows no older wrappers.
- Deploy order: Worker and DO (routes, schema, RPCs, secrets) before the wrapper
  release that uses them, then the UI.
- Coordinate with the 12-hour turn work: grant renewal (Section 1, item 3) also
  keeps log uploads working past four hours. Whichever change lands first should
  own the renewal request pair; the other reuses it.
- Grant renewal needs both a new DO (frame handler) and a new wrapper
  (`transferGrants` capability); mixed versions fall back to the launch-time
  grant.

## 9. Verify

### Unit and integration tests

- **Transfer channel:** existing log and diagnostic tests pass unchanged; scopes
  are not interchangeable; a grant for a replaced allocation or wrapper is
  rejected on artifact routes; old grants work only on log routes.
- **Grant renewal:** the DO mints only for a socket that passes
  `connectionMatches`, with the identity and scopes it already holds; the
  wrapper renews at half-life and on `401`; renewal stops while disconnected and
  the last grant still serves the final log upload; logs and artifacts keep
  uploading past four hours; peers without the `transferGrants` capability keep
  the launch-time grant.
- **Routes:** missing or oversized `Content-Length`, hash mismatch, quota, invalid
  paths, stale wrapper at commit, idempotent repeat commit, late delete with a
  stale hash, uncommitted objects swept.
- **DO index:** migration applies on an existing DO; revision increments only on
  real changes; orphans are queued and swept; workspace deletion clears
  everything; data survives DO eviction.
- **Synchronizer:** creation, modification, deletion, unchanged files, failed
  and incomplete scans, missing root, concurrent writes, symlinks and special
  files, oversized files, retries and back-off, `409` stop, `401` pause.
- **Baseline:** fresh allocation with an empty folder deletes nothing; a stale
  tail-snapshot folder neither overwrites nor deletes newer R2 entries; a
  baseline file that changes is published; a baseline file that disappears is
  deleted only when R2 still holds the baseline hash; wrapper restart in the same
  allocation resumes from the state file.
- **Lifecycle:** turn-end flush keeps `active` only within its budget; idle
  polling never sets `active`.
- **Notifications:** dedup by revision, reconnect refetch, sibling fan-out.
- **Downloads:** URL carries attachment disposition and octet-stream for HTML and
  SVG; unauthorized sessions and unknown paths are rejected.

### End to end (Cloudflare)

- Sibling chats share one folder and one synchronizer.
- A file written in a turn's last seconds is uploaded before an unattended idle
  stop.
- Uploads work in a restricted-egress container.
- A 50 MiB upload succeeds.
- Create artifacts, stop the sandbox, list and download them offline.
- Start a replacement without a tail snapshot: R2 is unchanged, the agent sees an
  empty folder, and new files sync.
- Start a replacement from a tail snapshot (enrolled owner): the folder matches
  R2 and nothing is re-uploaded.
- View states on desktop and mobile web; HTML and SVG downloads save as files.

Vercel end-to-end verification is deferred until Vercel BYOC is live.

### Checks

Run focused formatting, type checks, and tests for
`services/cloud-agent-next`, its wrapper, `packages/worker-utils`,
`packages/cloud-agent-sdk`, and `apps/web`.

## Expected Behavior And Limitations

- Completed small files usually appear within 5-10 seconds plus upload time,
  and at the latest by the turn-end flush.
- Continuously changing files may take longer. Two unchanged scans are a
  heuristic, not proof that a producer has finished.
- R2 holds the last successfully synchronized state. Files written outside a
  turn (for example by a background process) and lost to a crash or idle stop
  before the next scan are not recoverable.
- Outside workspace tail snapshot coverage, a replacement sandbox starts with an
  empty `/artifacts`. Earlier files stay downloadable but are not available to
  the agent.
- Files over 50 MiB or beyond the quota are not synchronized; the agent is told
  the limits.

## Resolved Questions

| Question | Answer |
|---|---|
| Can a sandbox host more than one workspace? | No. One `/artifacts` and one index per sandbox |
| Can a wrapper outlive the four-hour grant? | Yes (12-hour turns, no allocation cap). The wrapper renews short-lived grants from the Sandbox DO over the control connection |
| Download path | Presigned R2 GET |
| Restore on replacement | None. Rely on workspace tail snapshots; baseline rule protects R2 |

## Open Questions

1. What is the account's Worker ingress limit? It decides whether the 50 MiB cap
   can be raised.
2. Vercel forwarding at 50 MiB: verify before Vercel BYOC launches.

## Implementation Order

1. Generalize the transfer channel: grant scopes, DO-minted grant renewal,
   shared wrapper identity, route helpers, wrapper client. Logs behave as today,
   except that they keep uploading past four hours.
2. Artifact bucket, credentials, index schema and migration, DO RPCs, transfer
   routes.
3. Wrapper synchronizer with baseline state, and the turn-end flush.
4. Folder provisioning.
5. Worker read procedures, presigned downloads, and notifications through the
   SDK.
6. Web tRPC, Artifacts view, agent rules, and spec.
