# Cloud Agent Artifacts Plan

## Goal

Add a normal `/artifacts` folder for agents, automatically synchronized to private
R2 storage. Users browse and download its contents from an Artifacts panel,
including when the sandbox is offline.

## V1 Scope

- Near-real-time synchronization through wrapper polling.
- Create, update, and delete files using normal filesystem operations.
- Shared artifacts across sibling chats in the same workspace.
- Offline listing and downloads.
- Restore artifacts when replacing a sandbox.
- No publish tool, filesystem watcher, browser editing, or version-history UI.

## 1. Define Storage And Ownership

Use the existing Sandbox DO to own the durable artifact index. Derive workspace
ownership from trusted session registration.

Store one current entry per relative path:

```text
relativePath
objectKey
contentHash
sizeBytes
contentType
updatedAt
```

Use a private artifact bucket with server-generated object keys. Each replacement
upload gets a new key, so a failed upload cannot damage the currently available
file.

Add the index using the existing DO SQLite/Drizzle migration conventions. Define
bucket retention, quotas, abandoned-upload cleanup, and workspace/account deletion
behavior before rollout. Clean up replaced or deleted objects asynchronously.

Main integration:

- `services/cloud-agent-next/src/control-plane/sandbox/sqlite-schema.ts`
- `services/cloud-agent-next/src/control-plane/sandbox/sandbox-do.ts`
- `services/cloud-agent-next/drizzle.sandbox.config.ts`
- `docs/do-sqlite-drizzle.md`

## 2. Add Wrapper-To-Storage Operations

Extend the existing authenticated wrapper control connection with operations to:

1. Retrieve the current artifact index and restore URLs.
2. Request short-lived presigned PUT URLs.
3. Commit successful uploads and confirmed deletions.

The DO validates the workspace and current allocation/connection, including after
asynchronous storage checks. The wrapper uploads bytes directly to R2; the DO
verifies the object before updating the index.

Make retries idempotent. Never expose bucket credentials to the sandbox, and never
send file bytes over the control WebSocket. Verify the storage hostname is allowed
by provider egress policies. Validate presigned PUT integrity and replay behavior
before relying on published objects being immutable.

Main integration:

- `services/cloud-agent-next/src/shared/control-plane-protocol.ts`
- `services/cloud-agent-next/wrapper/src/control-plane/history-requests.ts`
- `services/cloud-agent-next/src/control-plane/sandbox/sandbox-do.ts`
- `packages/worker-utils/src/r2-client.ts`

## 3. Implement One Polling Loop

Create one artifact synchronizer per workspace in the wrapper, not one per chat.

Run a scan approximately every four seconds, without overlapping passes:

1. Enumerate regular files under `/artifacts`.
2. Compare relative paths, sizes, and modification times.
3. Consider a file eligible after it is unchanged across two successful scans.
4. Hash eligible candidates and skip content already uploaded.
5. Capture and upload changed content, checking for concurrent modification.
6. Commit successful uploads to the remote index.
7. Remove remote entries for paths absent across two complete scans.

Keep the previous published version until its replacement succeeds. Missing or
unreadable roots and incomplete scans are errors, not empty folders, and must not
trigger deletion. Do not treat rejected or unstable files as absent. Reset
stability observations after a scan failure.

Bound file count, file size, total storage, path length/depth, and transfer time.
Reject symlinks and special files. Start with one transfer at a time. Polling must
not keep otherwise-idle compute alive.

Main integration: a focused wrapper artifact-sync module, composed through
`services/cloud-agent-next/wrapper/src/control-plane/main.ts`.

## 4. Handle Sandbox Lifecycle

Provision writable `/artifacts` on both native Cloudflare Containers and BYOC
Vercel sandboxes.

- Replacement sandbox: restore the remote folder before setup commands, agent
  execution, or synchronization begins. Remove stale files resurrected by an older
  snapshot as part of restoration.
- Same live allocation: preserve local files and pending changes; do not restore
  over them on a socket reconnect.
- Restore failure: retry within a bound, then surface a specific preparation error
  rather than starting against a partially restored directory.
- Shutdown: stop the polling loop and cancel pending operations. Do not rely on
  shutdown for durability.

A small allocation marker distinguishes surviving local disk from a replacement
or stale snapshot. Use the existing workspace preparation lock so sibling chats
cannot race restoration.

Main integration:

- `services/cloud-agent-next/wrapper/src/control-plane/prepare.ts`
- `services/cloud-agent-next/wrapper/src/control-plane/main.ts`
- `services/cloud-agent-next/Dockerfile.containers`
- `services/cloud-agent-next/src/byoc/vercel-runtime-base.ts`

## 5. Expose Offline Access

Add authenticated listing and download operations through the existing Worker and
personal/organization tRPC paths.

These operations read the durable index and R2 without preparing or waking a
sandbox.

Downloads use short-lived GET URLs. Resolve object keys server-side after checking
access; never accept arbitrary bucket keys from the browser.

Emit a small artifact-change notification after index updates and fan it out to
sibling sessions. The UI refetches on notifications, panel opening, and reconnect.

Main integration:

- `services/cloud-agent-next/src/router.ts`
- `services/cloud-agent-next/src/control-plane/session/session-do.ts`
- `services/cloud-agent-next/src/control-plane/sandbox/notifications.ts`
- `services/cloud-agent-next/src/shared/protocol.ts`
- `services/cloud-agent-next/src/websocket/types.ts`
- `packages/cloud-agent-sdk/src/normalizer.ts`
- `packages/cloud-agent-sdk/src/session-manager.ts`
- `apps/web/src/lib/cloud-agent-next/cloud-agent-client.ts`
- `apps/web/src/routers/cloud-agent-next-router.ts`
- `apps/web/src/routers/organizations/organization-cloud-agent-next-router.ts`

## 6. Add The Artifacts Panel

Add an Artifacts button beside Changes in the chat header. Use a side panel on
desktop and a mobile-appropriate sheet, following existing UI primitives.

The read-only panel shows:

- Filename, size, and last synchronized time.
- Download action.
- Loading, empty, and error states.
- An offline notice explaining that saved files remain accessible but new changes
  are not syncing.

Start with file listing and download only. Rich previews can follow separately.
Downloads should use safe attachment disposition, particularly for HTML and SVG.

Update agent instructions to say that user-facing outputs belong in `/artifacts`.
Do not require the agent to know about synchronization.

Main integration:

- `apps/web/src/components/cloud-agent-next/ChatHeader.tsx`
- `apps/web/src/components/cloud-agent-next/CloudChatPage.tsx`
- A new artifact-panel component in the same subtree.

## 7. Verify

- Unit-test creation, modification, deletion, unchanged files, failed scans,
  concurrent writes, upload retries, and interrupted restores.
- Test workspace isolation, stale allocation rejection, path traversal, symlinks,
  quotas, and unauthorized downloads.
- Confirm sibling chats share one folder and one synchronizer.
- Verify metadata survives DO eviction and migrations.
- Test notification reconnect behavior and panel states on desktop and mobile.
- On both providers, create artifacts, stop the sandbox, download them offline,
  then replace the sandbox and verify restoration before another turn.
- Run focused formatting, type checks, and tests for changed packages.

## Expected Behavior And Limitations

Completed small files should generally appear within roughly 5-10 seconds plus
upload time when the sync queue is not busy. Continuously changing files may take
longer. Two unchanged scans are a heuristic, not proof that a producer has finished.

R2 contains the last successfully synchronized state. A sandbox crash before
upload can lose the latest local changes; this is eventual synchronization, not
synchronous filesystem durability.

Implement the storage and wrapper path first, then connect the UI.
