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
- Offline listing and downloads.
- Restore artifacts when replacing a sandbox.

Out of scope:

- Publish tool, filesystem watcher, browser editing, previews, version history.
- Native mobile UI (`.specs/cloud-agent-session.md` already scopes mobile out).
- Files larger than the per-file cap (multipart uploads are a follow-up).

Naming: "runtime artifacts" already exists (`runtime-artifact-routes.ts`). Use
"workspace artifacts" / `workspaceArtifact*` in code, routes, and events.

## Key Decisions

| Decision | Choice | Reason |
|---|---|---|
| Byte path | Wrapper → Worker HTTP route → R2 binding | `WORKER_URL` is already on the native egress allowlist; direct R2 hosts are not |
| Transport | Generalize the existing log upload channel | Already has scoped grants, size checks, and idempotent writes |
| Bytes through the DO | Never | 8 MiB control outbox, single-threaded DO shared by all sibling chats |
| Control-socket changes | None for artifacts | No new frames, no `hello` capability negotiation |
| Index owner | Sandbox DO SQLite | Keyed by stable `sandboxId`, shared by sibling chats, survives replacement |
| Stale-wrapper fence | Current `allocationId` + `wrapperId` in `AllocationState` | Existing state; do not add a new epoch |
| Replacement detection | Existing workspace stamp | Do not add a separate marker |
| Durability point | Turn-end flush | Idle stop destroys compute without a `shutdown` frame |
| Notification | Copy `worktree_changes` | Persisted, deduplicated, revisioned, refetch on reconnect |
| UI shape | Copy the Changes toggle | Changes replaces the chat content area; it is not a side panel |

## Limits

Define these as named constants in a shared module
(`src/shared/workspace-artifacts.ts`), used by the wrapper, Worker routes, and
Sandbox DO.

| Constant | V1 value | Why |
|---|---|---|
| `WORKSPACE_ARTIFACT_MAX_FILE_BYTES` | 50 MiB | Under Cloudflare's lowest-plan 100 MB Worker ingress limit, which can 413 at the edge before the handler runs; fits the turn-end flush budget |
| `WORKSPACE_ARTIFACT_MAX_TOTAL_BYTES` | 500 MiB | Bounds restore time during preparation |
| `WORKSPACE_ARTIFACT_MAX_FILES` | 1,000 | Keeps scans and index reads cheap |
| `WORKSPACE_ARTIFACT_MAX_PATH_BYTES` | 1,024 | Relative path, UTF-8 |
| `WORKSPACE_ARTIFACT_MAX_DEPTH` | 16 | Directory levels under `/artifacts` |
| `WORKSPACE_ARTIFACT_SCAN_INTERVAL_MS` | 4,000 | Between the end of one scan and the next start |
| `WORKSPACE_ARTIFACT_TRANSFER_TIMEOUT_MS` | 120,000 | Per upload or download request |
| `WORKSPACE_ARTIFACT_FLUSH_BUDGET_MS` | 30,000 | Turn-end flush |
| `WORKSPACE_ARTIFACT_RESTORE_BUDGET_MS` | 120,000 | Including retries |
| `WORKSPACE_ARTIFACT_DOWNLOAD_URL_SECONDS` | 300 | Browser download links |

Before raising the per-file cap, confirm the account's Worker ingress limit and
verify Vercel forwarding at the target size. `docs/control-plane.md` records that
Vercel forwarding is only verified for 8 MiB transfers; verify 50 MiB as part of
this work.

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

### Changes

1. **Grant.** Rename `log-upload-grant.ts` to `sandbox-transfer-grant.ts`.
   - Claims: `type: 'sandbox_transfer'`, `aud: 'cloud-agent-sandbox-transfer'`,
     `identity`, `scopes: ('logs' | 'workspace_artifacts')[]`, `iat`, `exp`.
   - Keep the current strict validation (`exp - iat` cap, clock skew,
     max header length).
   - Accept the old `control_log_upload` grant on log routes only, until older
     wrapper releases age out.
2. **Minting.** Mint the grant on every wrapper launch, independent of whether
   diagnostics are enabled. Include `workspace_artifacts` when the feature is
   enabled for the session.
3. **Env names.** Add `SANDBOX_TRANSFER_URL` (base:
   `${WORKER_URL}/sandbox-transfer/<sandboxId>/<allocationId>/<wrapperInstanceId>`)
   and `SANDBOX_TRANSFER_GRANT`. Keep emitting the `CONTROL_LOG_*` names for
   older wrappers during rollout. Update the allowlists in
   `runtime-bootstrap.ts` and `shared/runtime-environment.ts`.
4. **One wrapper identity.** Pass `CONTROL_WRAPPER_INSTANCE_ID` into
   `createControlPlaneConnection({ wrapperId })` so the grant and the `hello`
   frame name the same wrapper. The Sandbox DO can then compare a transfer's
   `wrapperInstanceId` with `AllocationState.wrapperId`. Keep the random
   fallback when the env value is absent.
5. **Worker route helpers.** Move `authorizeIdentity`, `declaredLength`,
   `mediaType`, and `readBoundedBytes` into
   `src/sandbox-control/sandbox-transfer-http.ts`.
   - `authorizeTransfer(c, scope)` validates the grant, path identity, and scope.
   - Add `streamToBucket(bucket, key, request, { maxBytes, sha256, contentType })`.
     It requires `Content-Length`, rejects values above `maxBytes`, and passes
     `request.body` to `R2Bucket.put` with the `sha256` option, so R2 rejects a
     mismatched body. The body is never buffered.
   - Log routes keep their buffered, JSON-validated path.
6. **Wrapper client.** Add `wrapper/src/control/sandbox-transfer-client.ts`.
   - Holds the base URL and grant.
   - Provides `put`, `get`, `delete` with `redirect: 'error'`, abort signals,
     per-request timeouts, and bounded retry with jittered backoff on network
     errors, 429, and 5xx.
   - Returns a classified result (`ok`, `rejected` with status, `unavailable`).
   - The log uploader and diagnostics migrate to it with no behavior change.
7. **Routes.** Register `/sandbox-transfer/:sandboxId/:allocationId/:wrapperInstanceId/logs/...`
   with identical behavior to today, and keep `/sandbox-logs/...` as an alias.
8. **Grant lifetime.** Confirm whether a wrapper can outlive four hours. If it
   can, renew the grant in the `hello` acknowledgement over the existing control
   connection; do not add a new credential path. Until then, a `401` from the
   transfer route pauses artifact sync and reports a diagnostic.

Main integration:

- `src/sandbox-control/log-upload-grant.ts` → `sandbox-transfer-grant.ts`
- `src/sandbox-control/log-routes.ts`
- New `src/sandbox-control/sandbox-transfer-http.ts`
- `src/sandbox-control/wrapper-launch-env.ts`
- `src/sandbox-control/runtime-bootstrap.ts`
- `src/shared/runtime-environment.ts`
- `src/shared/control-diagnostics.ts`
- `src/server.ts`
- New `wrapper/src/control/sandbox-transfer-client.ts`
- `wrapper/src/control/file-log-uploader.ts`
- `wrapper/src/control/diagnostics.ts`
- `wrapper/src/control-plane/connection.ts`
- `wrapper/src/control-plane/main.ts`

All paths in this document are relative to `services/cloud-agent-next/` unless
they start with `apps/`, `packages/`, `docs/`, or `.specs/`.

## 2. Storage And Ownership

### Ownership

The Sandbox DO owns the index. It is addressed by the workspace's stable
`sandboxId` (`SANDBOX_CONTROL.getByName(sandboxId)`), which sibling chats share
through `metadata.workspace.sandboxId` and which survives allocation replacement.

Confirm that one sandbox serves exactly one workspace. `docs/control-plane.md`
states it in its model section, but its test scenario 5 describes two worktrees
in one sandbox. If a sandbox can host more than one workspace, `/artifacts` and
the index must become per-workspace before V1.

### Bucket

- Add a dedicated private bucket binding, `WORKSPACE_ARTIFACTS_BUCKET`, in
  production and dev in `wrangler.jsonc`, and to the Worker `Env` type.
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
- Uncommitted objects (upload succeeded, commit never happened) are swept by an
  R2 lifecycle rule. Committed objects are never deleted by lifecycle rules, so
  the sweep relies on the orphan table. Alternative if needed: the Worker inserts
  an orphan row before the upload and removes it at commit.
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
- `wrangler.jsonc`, `src/types.ts`
- `docs/do-sqlite-drizzle.md`

## 3. Artifact Transfer Routes

Register under
`/sandbox-transfer/:sandboxId/:allocationId/:wrapperInstanceId/artifacts`. Each
route runs `authorizeTransfer(c, 'workspace_artifacts')`, then calls a Sandbox DO
RPC.

### Sandbox DO RPCs

All RPCs take the grant identity and first check that
`AllocationState.kind === 'connected'`, `allocationId` matches, and `wrapperId`
equals `wrapperInstanceId`. A mismatch returns `stale` and the route responds
`409`. The upload is stateless, so this check runs at commit time, not only at
upload start.

```ts
getWorkspaceArtifactIndex(identity): Promise<
  | { status: 'ok'; revision: number; entries: WorkspaceArtifactEntry[] }
  | { status: 'stale' }
>

resolveWorkspaceArtifactObject(identity, relativePath): Promise<
  | { status: 'ok'; objectKey: string; contentHash: string; sizeBytes: number }
  | { status: 'stale' | 'not_found' }
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

- Same path and same hash: `unchanged`; queue the new object as an orphan.
- New entry: check file count and total bytes against the limits.
- Replacement: queue the previous object as an orphan.
- Increment the revision and notify (Section 6) only on real changes.

Delete rules: remove only when the stored hash equals `expectedHash`, so a late
delete cannot remove a newer file.

### HTTP contract

| Route | Request | Success | Errors |
|---|---|---|---|
| `GET .../index` | none | `200` JSON `{ revision, entries }` | `401`, `403`, `409` stale |
| `GET .../objects?path=<p>` | none | `200` stream, `Content-Length`, `ETag` | `404`, `409` |
| `PUT .../objects?path=<p>` | headers `Content-Length`, `Content-Type`, `X-Content-SHA256` | `200` JSON `{ status, revision }` | `400` invalid path, `409` stale, `411`, `413` file or quota, `422` hash mismatch, `503` storage |
| `DELETE .../objects?path=<p>&hash=<h>` | none | `200` JSON `{ status, revision }` | `409` stale |

`PUT` flow: validate path and declared size, stream to a new key with the
`sha256` option, call `commitWorkspaceArtifact`. If the commit is rejected, queue
the new object as an orphan and return the mapped error.

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
  client: SandboxTransferClient;
  timers: Timers;
  log: (message: string) => void;
  onDiagnostic: DiagnosticSink;
}): {
  restore(signal: AbortSignal): Promise<RestoreResult>;
  start(): void;                     // after restore succeeded
  flush(budgetMs: number): Promise<void>;
  isFlushing(): boolean;
  stop(): Promise<void>;
}
```

One instance per wrapper, which is one per sandbox. `main.ts` creates it when
`SANDBOX_TRANSFER_URL` and the `workspace_artifacts` scope are present, and stops
it in `lifecycle.stop`. Follow the `file-log-uploader.ts` loop shape.

### Scan

Run a scan every `WORKSPACE_ARTIFACT_SCAN_INTERVAL_MS`, never overlapping:

1. Enumerate regular files under `/artifacts` with `lstat`.
2. Record relative path, size, `mtimeNs`, `ctimeNs`, and inode.
3. A file is eligible once unchanged across two successful scans.
4. Hash eligible files (streaming SHA-256). Skip files whose hash matches the
   last committed hash for that path.
5. Upload one file at a time. Re-`stat` after hashing and after the upload; if
   anything changed, discard the result and wait for stability again.
6. The `PUT` route commits on success.
7. Delete remote entries for paths absent across two complete scans, sending the
   last known hash.

### Rules

- Keep the previous published version until its replacement commits.
- A missing or unreadable root and incomplete scans are errors, not empty
  folders. They never trigger deletion and reset stability observations.
- Rejected or unstable files are not treated as absent.
- Symlinks, sockets, FIFOs, and devices are skipped and reported.
- Files over the per-file cap, paths over the limits, and files that would
  exceed the quota are skipped with a diagnostic. They are retried only when
  they change.
- Never run the deletion pass until `restore()` has succeeded for this
  allocation.
- `409` (stale) stops the synchronizer. `401` pauses it with a diagnostic.
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
  `src/byoc/vercel-runtime-base.ts`.
- The wrapper also runs `mkdir -p /artifacts` before restore, so older images
  still work.
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

### Restore

Restore when the workspace is a replacement: the stamp is absent, `foreign`, or
from another allocation. Do not restore when the stamp says `same`; that is a
surviving disk (reconnect or wrapper restart), and local files win.

Steps:

1. `GET .../index`.
2. Remove local files under `/artifacts` that are not in the index. This handles
   stale files resurrected by a tail or environment snapshot. R2 always wins.
3. For each entry whose local hash differs, download to a temporary file in
   `/artifacts/.kilo-restore/`, verify size and SHA-256, then rename into place.
4. Remove the temporary directory. Seed the synchronizer's last-committed hashes
   from the index.

Failure: retry within `WORKSPACE_ARTIFACT_RESTORE_BUDGET_MS`, then fail
preparation with a specific reason (`workspace_artifacts_restore_failed`) instead
of starting against a partially restored folder. If a degraded mode is preferred
later, it must disable the deletion pass.

### Where restore runs in `prepare.ts`

Inside `withWorkspaceLock`, so sibling chats cannot race it, at three points:

- On the normal path, before `runPreparationCommands`. The existing
  `onReplacementWorkspace` hook runs after setup, which is too late.
- On the tail-snapshot path, before its start commands.
- In the branch for routes with no git and no setup commands.

Use the existing workspace stamp (`workspace-stamp.ts`) to decide. For workspaces
with no git, `classifyWorkspace` always reports `empty`, so compare
`stamp.allocationId` directly. Write the stamp only after restore completes,
matching root-recovery behavior. Restore runs once per allocation; later routes
see the result and skip it.

Report preparation progress through `emitProgress` while restoring, adding an
`artifacts` step to the progress schema if the existing steps do not fit.

### Shutdown

`sync.stop()` cancels the loop and in-flight requests. Shutdown is not a
durability point.

Main integration:

- `wrapper/src/control-plane/prepare.ts`
- `wrapper/src/control-plane/workspace-stamp.ts`
- `wrapper/src/control-plane/main.ts`
- `wrapper/src/control-plane/turn.ts`
- `Dockerfile.containers`
- `src/byoc/vercel-runtime-base.ts`

## 6. Offline Access And Notifications

### Worker procedures

Add `src/router/handlers/session-workspace-artifacts.ts`, modeled on
`session-worktree-changes.ts`, and compose it in `src/router.ts`:

- `listWorkspaceArtifacts({ sessionId })` returns `{ revision, entries }`.
- `getWorkspaceArtifactDownload({ sessionId, relativePath })` returns
  `{ url, expiresAt }`.

Both use `protectedProcedure` and `requireCurrentSessionAccess`. They resolve
the session's `sandboxId` and read the Sandbox DO index. They never prepare,
start, or wake a sandbox.

### Downloads

- Resolve the object key server-side from `relativePath` after the access check.
  Never accept bucket keys from the browser.
- Preferred: a Worker download route with a short-lived signed token, streaming
  from the binding. No new R2 credentials, and it works the same everywhere.
- Alternative: a presigned R2 GET with a new read-only key scoped to the
  artifacts bucket (`r2-client.ts` supports `responseContentDisposition`). This
  needs a new secret and a CSP check.
- Always send `Content-Disposition: attachment` with an RFC 5987 encoded
  filename, `X-Content-Type-Options: nosniff`, and the stored content type.
  HTML and SVG are never rendered inline.

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
  ends" with: the filesystem is ephemeral, except `/artifacts`.
- Add an "Artifacts" section: put user-facing outputs (reports, screenshots,
  exports, generated files) in `/artifacts`; they are shown to the user and kept
  after the session ends. State the per-file and total limits.
- Do not mention synchronization.

### Spec

Add a rule under `### Workspace` in `.specs/cloud-agent-session.md` (shared
artifacts, offline access, owner-only, restore on replacement) and a Changelog
entry.

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
- Deploy order: Worker and DO (routes, schema, RPCs) before the wrapper release
  that uses them, then the UI.

## 9. Verify

### Unit and integration tests

- **Transfer channel:** existing log and diagnostic tests pass unchanged; scopes
  are not interchangeable; a grant for one allocation or wrapper is rejected for
  another; old grants work only on log routes.
- **Routes:** missing or oversized `Content-Length`, hash mismatch, quota, invalid
  paths, stale wrapper at commit, idempotent repeat commit, late delete with a
  stale hash.
- **DO index:** migration applies on an existing DO; revision increments only on
  real changes; orphans are queued and swept; workspace deletion clears
  everything; data survives DO eviction.
- **Synchronizer:** creation, modification, deletion, unchanged files, failed
  and incomplete scans, missing root, concurrent writes, symlinks and special
  files, oversized files, retries and back-off, `409` stop, `401` pause.
- **Restore:** replacement versus `same` stamp, no-git workspaces, stale snapshot
  files removed, interrupted restore, restore failure surfaces the specific error.
- **Lifecycle:** turn-end flush keeps `active` only within its budget; idle
  polling never sets `active`.
- **Notifications:** dedup by revision, reconnect refetch, sibling fan-out.

### End to end

- Sibling chats share one folder and one synchronizer.
- A file written in a turn's last seconds is uploaded before an unattended idle
  stop.
- Uploads work in a restricted-egress Cloudflare container.
- A 50 MiB upload and restore succeed on both providers.
- On both providers: create artifacts, stop the sandbox, list and download them
  offline, then replace the sandbox (including from a Cloudflare tail snapshot)
  and verify restoration before setup commands and the next turn.
- View states on desktop and mobile web; downloads of HTML and SVG save as
  attachments.

### Checks

Run focused formatting, type checks, and tests for
`services/cloud-agent-next`, its wrapper, `packages/cloud-agent-sdk`, and
`apps/web`.

## Expected Behavior And Limitations

- Completed small files usually appear within 5-10 seconds plus upload time,
  and at the latest by the turn-end flush.
- Continuously changing files may take longer. Two unchanged scans are a
  heuristic, not proof that a producer has finished.
- R2 holds the last successfully synchronized state. Files written outside a
  turn (for example by a background process) and lost to a crash or idle stop
  before the next scan are not recoverable.
- Files over 50 MiB or beyond the quota are not synchronized; the agent is told
  the limits.

## Open Questions

1. Can a sandbox ever host more than one workspace? If yes, make `/artifacts`
   per workspace before V1.
2. Can a wrapper outlive the four-hour grant? If yes, add renewal in the `hello`
   acknowledgement.
3. What is the account's Worker ingress limit, and does Vercel forwarding pass at
   50 MiB?
4. Download path: Worker streaming route (preferred) or presigned R2 GET?
5. Should a restore failure block the turn, or start with sync disabled and a
   visible warning?

## Implementation Order

1. Generalize the transfer channel: grant scopes, shared wrapper identity, route
   helpers, wrapper client. No behavior change for logs.
2. Artifact bucket, index schema and migration, DO RPCs, transfer routes.
3. Wrapper synchronizer and turn-end flush.
4. Folder provisioning and restore hooks in `prepare.ts`.
5. Worker read procedures, downloads, and notifications through the SDK.
6. Web tRPC, Artifacts view, agent rules, and spec.
