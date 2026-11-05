# Continuous worktree snapshots for cold restore

Date: 2026-11-03 (replaces the 2026-11-02 draft). Implemented 2026-11-04;
snapshot writes and reads remain disabled by default pending rollout.

Paths are relative to `services/cloud-agent-next/` unless they start with a top-level
directory.

## Summary

When a sandbox is lost, the replacement sandbox should get back the work that was not
pushed. Today it gets a small patch set captured at turn end, or older session-ingest
diffs. This plan replaces that with one file snapshot per worktree in R2:

1. The wrapper captures after any tool finishes and after turn finalization (after
   auto-commit and push, when enabled), with a 1-second debounce and a 15-second
   maximum wait.
2. A capture is a gzipped tar of every file that differs from the branch on the
   remote: unpushed commits, staged and unstaged edits, and untracked files. It also
   records deletions and the base commit.
3. The wrapper streams it to a Worker route that writes one R2 object per worktree,
   replacing the previous one.
4. Restoring a replacement workspace downloads that object and writes the files over
   the restored branch. When a snapshot exists, session-ingest file replay does not run.

This is one PR, or two if the Worker routes land before the wrapper. It needs no
Session DO, prepare-spec, diff-display, web or session-ingest changes. Commit messages
and the history of unpushed commits are not preserved; their files are.

## Current behavior

| Area | Today | Source |
|---|---|---|
| Restore source | One recovery value: merge-base-to-working-tree text patches, at most 256 KiB, with no base SHA. Binary and oversized files are dropped without a recorded reason. | `worktreeRecoverySchema` in `src/shared/worktree-changes-wire.ts` |
| Capture timing | Attach, turn close, error, message outcome and settled interruption. Nothing during a turn. `session.worktree.changed` is handled, but nothing in this repo emits it. | `onEvent()` in `src/sandbox-session/worktree-changes.ts` |
| Restore timing | Replacement workspaces apply recovery after setup, under a 30-second timeout that release does not cancel. Applying any file disables session-ingest file replay. | `prepareWorkspace()` and `restoreFilesFor()` in `wrapper/src/control-plane/prepare.ts` |
| Fallbacks | A saved empty recovery is read as "none", so ingest replay can bring back old files. Ingest falls back to historical message diffs. | `readRecovery()` in `src/sandbox-session/worktree-changes.ts`; `extractDiffs()` in `wrapper/src/restore-session.ts` |
| Retry gap | A preparation that fails during setup leaves an unstamped repository. Its retry never runs worktree recovery and replays ingest files instead. | `classifyWorkspace()` in `wrapper/src/control-plane/workspace-stamp.ts`; `cloning \|\| adopted` in `prepare.ts` |
| Worktree id in the wrapper | `spec.kilo.scopeId` is the worktree id (`worktree_*`) for worktree routes. | `src/sandbox-control/session-credentials.ts` |
| Upload pattern | Log uploads use a launch-env HS256 grant bound to `{sandboxId, allocationId, wrapperInstanceId}`, valid 4 hours and never renewed. The Worker route buffers up to 8 MiB before writing to R2. | `src/sandbox-control/wrapper-launch-env.ts`, `log-upload-grant.ts`, `log-routes.ts` |

The control socket cannot carry large payloads. Its disconnected outbox holds 8 MiB,
and shutdown closes it before stopping runtimes (`wrapper/src/control-plane/connection.ts`,
`wrapper/src/control-plane/main.ts`).

## Scope

This covers worktree sessions: browser and Agent Manager first sessions, their sibling
chats, and hosted workspaces. Worktree-less sessions keep today's behavior.

Saved:

- Regular files that differ from the remote branch, with their bytes and executable
  bit. This includes committed-but-unpushed, staged, unstaged and untracked
  non-ignored files.
- Deletions.

Not saved:

- Commit messages and history. Unpushed commits come back as uncommitted changes, and
  the next auto-commit commits them again.
- The staged-versus-unstaged distinction.
- Ignored files, such as build output and `.env`.
- Symlinks and submodules. These are listed as omitted.
- Local branches, stashes and merge or rebase state.

This is best effort. A crash loses the work since the last uploaded snapshot, normally
the debounce plus capture and upload time, and longer while uploads fail. Surviving
workspaces and session disk snapshots keep their existing restore paths, and a snapshot
is never applied over them.

## Capture

### Contents

Run Git as the existing producer does, with `--no-optional-locks` and
`-c core.fsmonitor=false`:

```sh
branch=$(git symbolic-ref --short -q HEAD)
base=$(git rev-parse --verify -q "refs/remotes/origin/$branch") \
  || base=$(git merge-base HEAD refs/remotes/origin/HEAD)
git diff --name-status --no-renames --ignore-submodules=all -z "$base" --
git ls-files --others --exclude-standard -z
```

- Use `refs/remotes/origin/<branch>`, not `@{upstream}`. A never-pushed branch is
  created without an upstream (`checkout -b <branch>` in `prepare.ts`), and an upstream
  can be repointed.
- `git push` updates the local remote-tracking ref, so pushed work drops out of the next
  snapshot without a fetch. Capture never fetches; a stale ref only makes the snapshot
  larger.
- Detached HEAD uses the merge-base fallback. If neither ref resolves, as with no
  remote, do not capture; log it.
- Paths with status `D` go in the deletion list. Every other path that is a regular
  file goes in the archive. Anything else is omitted with a reason.

The archive is a gzipped tar written to a temporary file, never held whole in memory:

- `snapshot.json`: `{version: 1, worktreeId, branch, base, capturedAt, deleted, omitted: [{path, reason}], partial}`.
- `files/<path>` for each saved file, with mode 0644 or 0755.
- Sorted paths and fixed tar timestamps and owners. A logical `contentDigest` excludes
  the manifest's capture timestamp, so identical content produces an identical digest.
  The transport separately hashes the archive bytes for R2 integrity verification.
  Skip the upload when the content digest equals the last accepted upload for
  that worktree. The digest covers `base`, so a push always uploads, even when the file
  list becomes empty. That upload is required: otherwise restore compares against a
  stale base.

Initial caps, to be measured:

| Limit | Value | When exceeded |
|---|---|---|
| Files | 10,000 | Remaining paths omitted |
| Single file | 10 MiB raw | File omitted |
| Total file bytes | 50 MiB raw | Remaining paths omitted |
| Uploaded object | 64 MiB | Worker rejects; tar headers and incompressible data stay below this |

Tracked paths come before untracked ones, then sort by path. Any omission sets
`partial`. 64 MiB is below the 100 MB request-body limit of the smallest Cloudflare
plan.

### Triggers and scheduling

- **Tool finished.** `message.part.updated` where the part is a tool whose
  `state.status` is `completed` or `error`, from any chat in the worktree. Hook it next
  to `turns?.observeKiloEvent(event)` in `wrapper/src/control-plane/main.ts`. Map the
  event's runtime to its directory: the runtime key for shared runtimes, the route
  directory for per-session runtimes. Do not classify shell commands; failed and
  aborted tools can also have written files.
- **Turn finalization.** Request a capture right after `runAutoCommitStep` in
  `finalize()` in `wrapper/src/control-plane/turn.ts`, without awaiting it.
  - With auto-commit off, this is the idle capture. With it on, this is the post-push
    capture.
  - It runs before condense, which does not touch files.
  - If the push fails, the local commit stays in the snapshot, because the
    remote-tracking ref did not move.
- **Scheduler.** One per worktree directory in the wrapper:
  - 1-second trailing debounce.
  - 15-second maximum wait from the first uncaptured signal.
  - One capture in flight plus one trailing per worktree, and at most two captures per
    sandbox.
- **Start after restore.** A worktree starts capturing only after its route is ready
  and its restore step has settled. A capture therefore cannot overwrite a snapshot
  that was not restored yet.
- **Never blocking.** Stop, turn completion and shutdown never wait for a capture.
  There is no shutdown flush.
- **Bounds.** Git work and archiving get 20 seconds; the upload gets 60 seconds. A
  failed or timed-out attempt keeps the worktree dirty and retries on the next signal
  or after 30 seconds.

Writes made outside tools, such as from the terminal or background processes, are saved
by the next tool or finalization capture. This version has no filesystem watcher or
periodic scan.

## Storage and transport

- **Bucket.** A new private R2 binding, `WORKTREE_SNAPSHOTS_BUCKET`, per environment.
  The Worker builds the key `v1/<worktreeId>.tar.gz`. There is one object per worktree,
  and R2 overwrites are atomic.
- **Grant.**
  - Mint a second HS256 grant next to the log grant in
    `src/sandbox-control/wrapper-launch-env.ts`, with audience
    `cloud-agent-worktree-snapshot` and the same identity.
  - Pass it as `CONTROL_WORKTREE_SNAPSHOT_URL` and `CONTROL_WORKTREE_SNAPSHOT_GRANT`.
    The wrapper deletes both after reading them, as it does for the log grant.
  - A renew route exchanges an unexpired grant for a fresh one while the allocation is
    current. The wrapper renews at half-life, so a sandbox can outlive 4 hours.
- **Routes.** In a new `src/sandbox-control/worktree-snapshot-routes.ts`, registered
  next to the log routes in `src/server.ts`:
  - `PUT /sandbox-worktree-snapshots/:sandboxId/:allocationId/:wrapperInstanceId/:worktreeId`
    requires `Content-Length` of at most 64 MiB and an `x-kilo-sha256` header. It passes
    `request.body` to `put` with `sha256`, so R2 verifies the bytes. The Worker does
    not buffer the body.
  - `GET` on the same path streams the object and its digest.
  - `POST .../renew` returns a fresh grant.
- **Authorization.** Every request is checked in two steps:
  - The grant identity must match the path.
  - A new Sandbox DO method, `authorizeWorktreeSnapshot({allocationId, worktreeId})`,
    checks that the allocation is current, that a route in this sandbox has
    `credentialSource.scopeId === worktreeId`, and that the worktree has no deletion
    tombstone.

  A dying or partitioned old sandbox is refused as soon as a new allocation exists. The
  remaining window is one upload authorized just before the switch that finishes after
  it. The new sandbox restores first and captures only after its first tool or turn, so
  an overlap needs a stalled upload.
- **Deletion.** `deleteWorktreeResources` in `src/control-plane/sandbox/sandbox-do.ts`
  deletes the object next to `worktreeChanges.purge(worktreeId)`. The tombstone refuses
  later uploads.
- **Retention.** An R2 lifecycle rule deletes objects 30 days after their last upload,
  matching the provider's 30-day unused disk-snapshot retention.
  - This also bounds an existing leak: deleting a worktree's last chat only releases the
    route and never purges (`release()` in `sandbox-do.ts`).
  - A worktree resumed after 30 idle days falls back to today's behavior.
- **Logging.** Log metadata only: sizes, counts, digests and durations. Never log file
  contents or grants.

## Restore

The snapshot runs first in the replacement-workspace callback in `prepare.ts`, before
the legacy recovery:

1. **When.** Run for `cloning` and `adopted`, and also for an unstamped repository: a
   preparation that failed before stamping, usually in setup. Without the last case,
   the retry skips the snapshot and the next capture overwrites it.
2. **Download.** Retry transient failures up to 3 times within the step.
   - On 404 (no snapshot, or reads disabled), run today's recovery unchanged.
   - If it still fails, fail preparation with a specific retryable error. Continuing
     would let the next capture overwrite the saved snapshot. The next message retries.
   - On a digest mismatch, unreadable archive or unknown version, report that saved
     changes could not be restored and continue. Captures resume.
3. **Validate before extracting.**
   - List the members. Accept only `snapshot.json` and regular `files/...` entries.
   - Apply the existing path checks from `wrapper/src/control-plane/worktree-recovery.ts`.
     These reject absolute paths, `..`, `.git`, NUL, backslashes and symlinked parents.
   - Extract to a private temporary directory.
4. **Compare `base` with the restored tip `R`** (`HEAD` after checkout):
   - **`R == base`:** write every file and apply every deletion.
   - **`base` is an ancestor of `R`:** a push happened after the last snapshot. Causes
     include a crash between the auto-commit push and the post-push capture, an
     external push, or a moved default branch for a never-pushed branch.
     - For each path in `git diff --name-only -z base R`, skip it if the snapshot's
       bytes equal `R`'s version, because it is already pushed. Otherwise it is a
       conflict.
     - Write all other paths.
   - **`base` missing or not an ancestor (force-push):** every path is a conflict.
   - **Conflicts:** write the snapshot's version under `.git/kilo-recovered/<capturedAt>/`,
     which is never committed or captured, and list the paths in the restore progress
     message.
5. **Write.** Write files with their mode and the current time, and delete listed paths
   that exist. Snapshot bytes win over files that setup modified.
6. **Authority.** A snapshot that exists is authoritative even when empty, partial or
   conflicting. Set `localRecoveryApplied` so neither legacy recovery nor
   session-ingest file replay runs. Transcript import is unaffected. Report omitted and
   conflicting counts in one progress message.

Restore stays after setup, so setup still runs on a clean checkout and there is no new
interaction with setup scripts. Bound download, validation and writing to 60 seconds,
abort on release, and add that bound to `ROUTE_PREPARATION_MS` in
`src/shared/control-plane-timers.ts`. This replaces today's 30-second inline-recovery
timeout for this path. Benchmark a 50 MiB snapshot against it.

## Rollout and rollback

The private `cloud-agent-worktree-snapshots` and `cloud-agent-worktree-snapshots-dev`
buckets must be provisioned before deployment. Their 30-day `v1/` lifecycle rules are
operational configuration, not Wrangler bindings. Provisioning, lifecycle changes,
deployment and flag enablement are not part of the implementation:

```sh
pnpm exec wrangler r2 bucket lifecycle add cloud-agent-worktree-snapshots worktree-snapshot-retention v1/ --expire-days 30
pnpm exec wrangler r2 bucket lifecycle add cloud-agent-worktree-snapshots-dev worktree-snapshot-retention v1/ --expire-days 30
```

- **Writes.** The Worker sets the snapshot environment variables only when writes are
  enabled by an environment flag. Old wrappers ignore unknown variables, so no
  capability flag or protocol change is needed.
- **Reads.** A separate flag. The GET route returns 404 while it is off, so restore
  uses today's recovery. Reads require writes.
- **Order.** Enable writes first. Compare snapshot sizes, omission rates, upload volume
  and cost before enabling reads.
- **Rollback.** Legacy recovery keeps being captured and sent in `spec.worktreeRecovery`
  throughout, so turning reads off is an immediate rollback. Remove it in a later
  cleanup once reads are on by default.
- **Specs.** When reads are on by default, update the persistence rule in
  `.specs/cloud-agent-session.md` ("Uncommitted files are not guaranteed to survive
  replacement of the shared physical environment") and the preparation section of
  `docs/control-plane.md`.

## Changes by file

| File | Change |
|---|---|
| `wrapper/src/control/worktree-snapshot.ts` (new) | Capture: base, path lists, caps, archive, manifest. Apply: validation, base check, writes, conflicts. |
| `wrapper/src/control-plane/worktree-snapshots.ts` (new) | Per-worktree scheduler, upload, download, grant renewal |
| `wrapper/src/control-plane/main.ts` | Read the environment variables, feed tool events, register worktrees when routes are ready |
| `wrapper/src/control-plane/turn.ts` | Request a capture after `runAutoCommitStep` |
| `wrapper/src/control-plane/prepare.ts` | Snapshot restore first, unstamped repositories included, ingest replay suppressed |
| `src/sandbox-control/wrapper-launch-env.ts` | Mint the snapshot grant and URL when writes are enabled |
| `src/sandbox-control/worktree-snapshot-routes.ts` (new), `src/server.ts` | PUT, GET and renew routes |
| `src/control-plane/sandbox/sandbox-do.ts` | `authorizeWorktreeSnapshot`; delete the object on worktree deletion |
| `wrangler.jsonc`, `src/types.ts` | Bucket binding and flags; regenerate `worker-configuration.d.ts` |

## Tests

- **Capture, real Git fixtures:**
  - unpushed commits; staged, unstaged and untracked files; deletions;
  - executable bit; binary files;
  - never-pushed branch; detached HEAD;
  - ignored files excluded; symlinks and submodules omitted;
  - caps and `partial`;
  - empty snapshot with the new base after a push; a failed push keeps the commit's
    files.
- **Apply, real Git fixtures:**
  - `R == base`;
  - base ancestor with untouched, already-pushed and conflicting paths;
  - force-push;
  - an empty snapshot suppresses ingest replay; partial snapshots;
  - unsafe member names; restored modes;
  - unstamped retry after a setup failure.
- **Scheduler, fake clock:**
  - debounce; continuous signals reach the 15-second maximum;
  - one in flight plus one trailing;
  - capture after auto-commit success, skip and failure;
  - Stop and the outcome are not delayed;
  - no capture before restore settles.
- **Worker routes:**
  - grant and path mismatch, expired grant, renew;
  - non-current allocation, missing route, tombstone;
  - size cap, digest mismatch;
  - 404 while reads are off.
- **Local E2E (`test/e2e`):**
  - Edit files mid-turn, kill the sandbox before the turn ends, send a message in the
    same chat, and verify a byte-for-byte restore.
  - Repeat with auto-commit on, killing the sandbox right after the push.

## Known limits and follow-ups

- Work done in the terminal or by background processes is saved only at the next tool
  completion or turn finalization. Add a periodic scan if that matters.
- Every capture uploads the whole archive. The caps, the debounce and the
  unchanged-digest skip bound this; measure before adding incremental uploads.
- Conflicting versions exist only in the restored sandbox's `.git/kilo-recovered/`. The
  next capture replaces the R2 object.
- Larger diff display is a separate project.
