# Repository snapshots for control-plane sessions

**Date**: 2026-09-30 (draft for discussion)
**Branch**: `eshurakov/spry-cardinal`, on top of the control-plane rewrite (`2dd921b1c5`)
**Scope**: `workspace_*` sessions on `cloudflare-containers`, isolated sandboxes only (`ses-`: one
session, or one worktree group).
**Out of scope**: the legacy plane, shared sandboxes, Vercel, and the Sandbox SDK provider.
**Depends on**: `eshurakov/upbeat-forest` (isolated sessions use `/workspace/app`).
**Prior art**: `eshurakov/lush-lark` (warm base on the old plane). This plan keeps its lessons, not
its protocol.

## Goal

Every container start for a repository that has a snapshot starts from that snapshot. That covers
a new session and the cold start of an existing session whose container stopped. The session then
does four things:

1. switches to its branch;
2. pulls;
3. applies its env;
4. runs its setup commands.

The dependencies are already installed, so setup runs incrementally. The clone and the cold install
leave the start path.

## What the platform gives us (verified from docs and workerd source)

- **What is captured.** `snapshotContainer()` captures the writable root filesystem of a running
  container. It does not capture memory, processes, process env or separate mounts.
- **Restore.** Pass `start({ containerSnapshot: { id } })` instead of `image`.
- **Reuse across containers.** A snapshot restores in any Durable Object of the same class, so one
  repository snapshot can seed many sessions. Cloudflare's blog describes this pattern.
- **Image tie.** A snapshot works only with the image version that created it. A deploy that
  changes the image invalidates every repository snapshot.
- **Lifetime.** Snapshots have an implicit 30-day TTL, refreshed by each restore. There is no list
  or delete API.
- **Unknowns.** Creation time, restore latency, size limits and cost are not documented.
- **Directory snapshots.** These are experimental in workerd only, not in production. The unit is
  therefore the whole container.
- **Local dev.** workerd implements snapshots as `docker commit` plus a start from that image, so
  local E2E can cover the path. Snapshot images build up in Docker.

## Today's start path (verified)

Everything runs in sequence:

1. Worker admission.
2. Session DO queues the message.
3. Sandbox DO issues the credential grant, bounded at 30 s. This happens before create.
4. Provider create and billing admission.
5. `container.start` and supervisor exec.
6. Wrapper `hello`.
7. `session.prepare`:
   1. Full `git clone`, then checkout.
   2. Setup commands.
   3. `kilo serve`.
   4. Kilo session: found on disk, restored from session-ingest (history plus diffs), or created.
8. `session.ready`, then deliver, then `prompt_async`.

A repository snapshot removes step 7.1 and makes step 7.2 incremental.

## Design

### 1. One start-source rule (`SandboxContainers` owns it)

On a physical start, use the repository snapshot for the launch's `repoKey` and the current image,
if the index has one. Otherwise, start from the image.

**Session snapshots go away (decided).** This removes `snapshotBeforeDestroy` and `lastSnapshot`.
There is then one snapshot kind with one meaning. It also removes the defects of today's idle-stop
path:

- the restored git remote keeps a stale credential;
- a resume after a deploy boots the old image;
- a snapshot that takes over 10 s is dropped, and the older one is kept;
- deletions take snapshots needlessly.

Stops also get faster, by up to 10 s.

**First start only.** Only the first physical start of a route attempt uses a snapshot. A retry
after a create failure or a first-connect timeout starts from the image, so a broken snapshot costs
at most one attempt.

`launch` returns `startSource: 'image' | 'repository'`. The Sandbox DO never sees snapshot ids.

### 2. Workspace stamp (the wrapper owns it)

Replace the boolean bootstrap marker `.git/kilo-bootstrap-complete` with `.git/kilo-workspace.json`,
which holds `{ allocationId, commit }`. At `session.prepare`, the wrapper decides from the
filesystem alone:

| Found | Meaning | Work |
|---|---|---|
| No `.git` | Image start | Clone, checkout, setup, optional capture (section 4), write stamp |
| Stamp from this allocation | Same container: a sibling chat or a wrapper restart | Nothing (as today) |
| Stamp from another allocation | **Adopt** a repository snapshot | See below |

**Adopt** runs these steps:

1. `git remote set-url` with this route's credential.
2. `fetch --prune`.
3. Check out this route's branch with today's branch logic: working branch, explicit branch or
   review ref. An existing session gets its own branch.
4. Set the git author.
5. Run the setup commands.
6. Write the stamp.

If any step fails, the wrapper empties the directory and clones. The fallback is today's cold
path.

The Kilo session step is unchanged. A new session creates its Kilo session. An existing session
restores its history and diffs from session-ingest, as on today's cold path. The snapshot has no
Kilo home in it (section 4), so nothing stale shadows that restore.

The stamp replaces lush-lark's acknowledgement protocol (`restoredFromBackup`,
`warmRestorePending`, `bootstrapped`, `WarmRestoreAcknowledgementError`). A foreign stamp is always
reconciled before `session.ready`, and no Worker-side fencing is needed.

`session.ready` reports `workspace: 'cloned' | 'same' | 'adopted'`. A new
`restore` progress step maps to the existing public `workspace_restore`, labelled "Using prepared
repository".

### 3. Repository snapshot index (`SandboxContainers` reads and writes it)

- **Store:** a KV namespace, `REPO_SNAPSHOTS`.
- **Key:** a keyed hash (HMAC) of:
  - scope (the user);
  - repository URL.

  The Sandbox DO computes that as `repoKey`. `SandboxContainers` appends the image, which it owns.
- **Why env and secrets are not in the key:** setup re-runs on every start and rewrites whatever it
  derives from env, so an adopted snapshot only has to save the clone and checkout.
- **What is not in the key:**
  - setup commands, because setup always re-runs;
  - the path, because it is constant;
  - the branch, because adopt checks out the branch.
- **Scope:** per user for now (decided). Per org would share one user's secret-derived files with
  the org; until those files have security handling, the key stays per user and org sharing is out;
  see D3.
- **Value:** `{ snapshotId, commit }`, with `expirationTtl` 10 days.
- **Concurrent writes:** harmless. The last write wins, and orphans expire on the platform TTL.

### 4. Capture: after setup, before Kilo starts (D1: before the first prompt)

The Sandbox DO sets `capture: true` in `session.prepare` when these hold:

- `launch` reported `startSource: 'image'`;
- the route has a `repoKey`;
- the provider supports capture.

The wrapper captures only if it actually cloned. It runs these steps:

1. After the setup commands succeed, set `origin` to the bare URL, with no credential.
2. Emit progress step `snapshot`, which maps to public `workspace_backup`, labelled "Saving
   repository for faster starts".
3. Send `workspace.capture`.
4. Wait for `workspace.captured`. The wait is bounded, and the bound is a backstop over the
   container DO's capture timeout.
5. Restore the authenticated URL and continue to `kilo_runtime`.

The Sandbox DO calls `provider.captureRepository(ref, repoKey)` off the serialized queue. The
container DO snapshots, writes the index, and the Sandbox DO answers.

A failure is logged, and the preparation continues. The route attempt deadline already bounds the
wait, and no new route state is needed.

Capturing at this point means the snapshot holds:

- no agent edits;
- no Kilo home, so no Kilo `auth.json` and no Kilo state;
- no git credential.

Process env, including the wrapper's control credential, is never on disk. What remains is only
what setup wrote, and that is covered by the key.

### Protocol and provider changes

- `session.prepare` spec: add `capture?: true`.
- Wrapper → DO: add `workspace.capture { sessionId }`.
- DO → wrapper: add `workspace.captured { sessionId, ok }`.
- `session.ready`: add `workspace`.
- `ProviderAdapter.launch(ref, env, { repoKey? })` now returns `{ startSource }`.
- Optional `captureRepository?(ref, repoKey)`, implemented only by the containers adapter.

## Work

### Repository snapshots (after upbeat-forest)

- **Changes:**
  - wrapper: the stamp, the adopt path and the capture step;
  - Sandbox DO: `repoKey` and the `capture` flag;
  - `SandboxContainers`: the start-source rule and the index;
  - removal of session snapshots;
  - protocol frames;
  - `restore` and `snapshot` steps;
  - enrollment gate, set to `*` in local dev;
  - spec: Preparation 2 lists saving and using a prepared repository.
- **Tests:**
  - wrapper adopt in each branch mode, including an existing session's branch;
  - adopt failure falls back to clone;
  - capture restores the authenticated remote, and a capture failure continues;
  - start-source selection: image mismatch, and retry after a failed start;
  - key scoping.
- **Local E2E:**
  - Two new sessions on one repo. The second shows restore and setup, but no clone.
  - A follow-up in an idle-stopped session adopts the snapshot and gets its history back.
  - Credential scan: start a container from the captured snapshot and grep it for the publisher's
    grant tokens and aliases. Expect none, and no Kilo home.
  - A start with a missing snapshot id fails that attempt, and the retry starts from the image.

### Later (separate work)

Steps that snapshots do not touch and that could overlap:

- grant issuance before create;
- the `kilo serve` start;
- the empty `/export` download for a new session.

## Wait effects (for the PR, per AGENTS "Failure UX")

| Case | Effect |
|---|---|
| First cold start per key and image, per 10 days | Waits once for the capture, before Kilo starts |
| Every later start | Skips the clone and the cold install. Pays the snapshot restore and an incremental setup. |
| Broken snapshot | At most one create attempt |
| Deploy | The next start per key is cold |
| Existing session after an idle stop | Uncommitted files come back from session-ingest diffs, as on today's image cold path |

## Decisions

- **D1 (decided):** capture before the first prompt. In practice this means after setup and before
  Kilo starts.
- **D2 (decided):** setup always re-runs after adopt.
- **D3 (decided):** per user for now. Tokens are easy to keep out: bare remote during capture, and
  no Kilo home yet. Setup can still write secret-derived files (`.npmrc`, `.env`) and the key no
  longer hashes env, so org sharing would hand those files to the whole org. It stays per user, with
  no org sharing, until those files have security handling.
- **D4 (decided):** the index store is KV (`REPO_SNAPSHOTS`), with a 10-day `expirationTtl`.
- **D6 (decided):** remove session snapshots.
