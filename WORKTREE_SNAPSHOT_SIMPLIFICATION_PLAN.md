# Worktree Snapshot Simplification Plan

PR: https://github.com/Kilo-Org/cloud/pull/9635

Review baseline: `348eac004a`, compared with `origin/main`.

## Goal

Reduce the implementation and operational complexity of continuous worktree snapshots without weakening recovery or security. Fix the correctness issues identified during review before enabling the feature.

The reviewed PR adds 10,880 lines: 6,979 in tests and test infrastructure and 3,901 elsewhere. The main targets are duplicated authentication lifecycle management, handwritten archive framing, and per-file Git subprocesses, not the safety tests.

This document is an implementation plan, not authorization to deploy, enable flags, or change production resources.

## Scope And Invariants

- Keep both snapshot feature flags disabled during implementation.
- Preserve recovery of changed regular-file bytes, binary files, executable modes, deletions, untracked files, and the contents of unpushed changes.
- Do not mutate the user's Git index or refs during capture.
- Continue excluding ignored files and reporting omissions and partial captures.
- Keep snapshot restoration authoritative over legacy file recovery when a valid snapshot is found.
- Preserve the existing fallback for unreadable snapshots and bounded, retryable failure for download failures.
- Preserve upstream changes and retain conflicting saved files for recovery.
- Reject traversal, unauthorized `.git` paths, links, special files, duplicate entries, and conflicting archive paths.
- Validate archives in private staging before applying changes to the worktree.
- Retain compressed/decompressed size limits, file limits, checksums, cancellation, and execution deadlines.
- Keep Stop and turn completion non-blocking.
- Keep the existing single-root eligibility restriction; multi-root support is not part of this refactor.
- Keep credentials out of logs and out of child application environments.

## Implementation Order

### 1. Fix Deletion Restoration

Target: `services/cloud-agent-next/wrapper/src/control/worktree-snapshot.ts`, `applyExtracted`, and its tests.

The deletion branch currently skips restoration when a path is absent from the restored Git HEAD. Preparation may nevertheless have recreated that path in the working directory.

1. Add a regression test: capture a deletion, commit and push it, clone the updated branch, recreate the file as preparation might, then restore the snapshot.
2. Treat absence in HEAD as absence of an upstream conflict, not as proof that the working directory needs no restoration.
3. Apply the existing safe deletion operation to the working-directory path.
4. Retain conflict handling for paths changed upstream and filesystem type clashes.

Acceptance: the recreated file is removed; an upstream modification is preserved; an already absent file remains an idempotent success.

### 2. Reuse Wrapper Authentication

Targets:

- `services/cloud-agent-next/src/sandbox-control/worktree-snapshot-grant.ts`
- `services/cloud-agent-next/src/sandbox-control/worktree-snapshot-routes.ts`
- `services/cloud-agent-next/src/control-plane/sandbox/sandbox-do.ts`
- `services/cloud-agent-next/src/sandbox-control/wrapper-launch-env.ts`
- `services/cloud-agent-next/wrapper/src/control-plane/worktree-snapshots.ts`
- Wrapper bootstrap, environment contracts, and associated tests.

The snapshot bearer currently bypasses the stored wrapper credential hash. Snapshot-start fallback can rotate that hash without changing allocation ID, leaving the retired snapshot bearer authorized. Independently, missing the snapshot grant renewal window can permanently disable captures for an otherwise healthy allocation.

1. Follow the existing launch-credential HTTP pattern in `src/sandbox-control/startup-failure.ts`.
2. Verify the signed launch binding at the HTTP boundary and validate the current credential hash and allocation in the Sandbox DO.
3. Retain worktree ownership, allocation-state, and deletion checks on snapshot operations.
4. Keep archive bytes on HTTP; do not transfer them over the control WebSocket.
5. Remove snapshot-specific JWT minting/verification, the `/renew` endpoint, renewal timers, expiry states, credential cache, and grant environment plumbing.
6. Retain only the transport configuration and credentials needed by the wrapper itself; preserve secret stripping before child processes inherit the environment.
7. Remove obsolete tests and replace them with tests of the shared authentication contract.

Acceptance:

- Rotating the credential within the same allocation revokes the old caller's snapshot access.
- Wrong-allocation, wrong-worktree, deleted-worktree, and stopped-allocation requests are rejected.
- Snapshot service recovery after an outage allows captures to resume without an independent grant-renewal lifecycle.
- Wrapper restarts preserve authorized access through the existing credential mechanism.

### 3. Replace Handwritten Tar Framing

Targets: `wrapper/src/control/worktree-snapshot.ts`, its tests, the wrapper manifest, and the lockfile.

1. Verify the repository's existing `tar-stream` usage and select an appropriate explicit wrapper dependency.
2. Replace custom header writing, octal encoding, checksums, long-name framing, and byte-reader/archive-decoder mechanics with streaming pack/extract primitives.
3. Keep application-level entry validation and limits outside the library. Do not extract directly into the worktree.
4. Preserve the archive manifest and deterministic content digest behavior where practical.
5. Verify whether any snapshots were produced by an enabled test or deployed environment before deciding format compatibility. Disabled defaults alone do not establish that no persisted snapshots exist.
6. Use standard archive tooling/library fixtures for interoperability tests. Keep handcrafted malformed fixtures where they test application rejection rules.
7. Replace manual manifest shape validation with a Zod schema and inferred type, retaining semantic refinements for safe paths, duplicates, dates, and omission reasons.

Acceptance: valid snapshots round-trip across old/new implementations where compatibility is required; unsafe or oversized archives remain rejected; binary contents and executable bits are preserved; capture timestamp changes do not defeat content deduplication.

### 4. Batch Git Inspection

Target: `wrapper/src/control/worktree-snapshot.ts`, especially `headFileBytes`, `headFileMode`, `headPathExists`, and `applyExtracted`.

Restore currently performs up to two serialized Git subprocesses for each already-pushed file. The review's temporary fixture with 3,000 tiny files produced a 32 KB archive but took 37.8 seconds to restore with zero applied changes. This is a sandbox measurement, not a production latency claim.

1. Replace per-path tree/mode/existence queries with a bounded tree inventory or batched lookup.
2. Use batched object reads, such as `git cat-file --batch`, for content comparisons that remain necessary.
3. Keep parsing binary-safe and handle unusual filenames correctly.
4. Bound output, memory, subprocess lifetime, and cancellation behavior.
5. Preserve upstream-divergence decisions and the existing repair of files overwritten by preparation.
6. Add a many-small-files benchmark alongside the existing few-large-files coverage. Include a fresh clone where the captured changes have subsequently been pushed.

Acceptance: Git subprocess count is bounded independently of changed-file count, or uses a small documented number of batches; recovery results are unchanged; the many-small-files case materially improves without increasing restore deadlines to conceal the cost.

### 5. Decide The Publication Contract

Targets: `src/sandbox-control/worktree-snapshot-routes.ts` and Sandbox DO publication/deletion coordination.

This is a separate design decision, not a prerequisite for removing the credential and tar machinery. Resolve it before enabling the feature.

Current concerns:

- Authorization can change while an upload is in flight; conditional overwrite alone does not establish current allocation authority at publication.
- `discardIfCurrent` performs HEAD followed by unconditional DELETE, which is not an atomic conditional delete.
- The defensive actual-size rejection happens after replacing the last-good object.

1. Specify whether an upload from a superseded allocation may publish after replacement, and define when a snapshot becomes authoritative.
2. Add interleaving tests for allocation replacement during upload, a newer upload arriving during cleanup, and rejected uploads preserving the last-good checkpoint.
3. If strict publication fencing is required, upload to an immutable unique key and publish a pointer through one short serialized DO operation.
4. At publication, check current credential/allocation, worktree ownership, deletion state, and the expected previous pointer.
5. Keep R2 I/O outside the DO serial queue. Delete rejected immutable objects by exact key rather than using shared-key rollback.
6. Define orphan cleanup/retention and verify it is provisioned; do not rely on an undocumented bucket lifecycle assumption.
7. Evaluate reuse of the existing worktree-deletion journal instead of maintaining parallel deletion authority.

Acceptance: rejected or stale uploads cannot destroy the last-good published snapshot; deletion cannot revive access; cleanup cannot delete a newer valid snapshot; slow object storage does not block wrapper coordination.

## Verification

Read current root and package manifests and load `repository-verification` before execution. Use focused checks and the sandbox command-time limits.

- Run archive capture/apply unit tests, including deletion and malicious-archive regressions.
- Run scheduler, preparation, multi-root exclusion, session-host, and turn lifecycle tests.
- Run Worker route/authentication tests and Workers-runtime snapshot integration tests.
- Run focused package typechecking and linting, formatting checks, and `git diff --check`.
- Run a bounded local cold-recovery E2E covering unpushed contents, dirty/untracked/binary files, deletions, upstream conflicts, Stop, and wrapper restart.
- Run the many-small-files benchmark and record capture/restore timings and subprocess counts.
- Report both transient-failure recovery and time-to-error for genuine failures; simplification must not create silent hangs or extend failure waits unnecessarily.
- Review the resulting diff for actual removal of mechanisms, not merely moving the same complexity into additional files.

At the review baseline, 486 focused unit tests and 12 Workers-runtime integration tests passed. A deletion reproduction demonstrated the missing case, and temporary benchmarks exposed per-file subprocess costs. Full browser/provider cold-recovery E2E was not rerun. These results are baseline evidence, not verification of the planned changes.

## Delivery

Use small, independently reviewable changes in the order above. Keep behavior fixes separate from archive and transport refactoring where practical. Do not cut recovery/security tests to meet a line-count target. Do not deploy or enable flags as part of this plan.

## Implementation Record (2026-11-05)

The plan was reviewed against the implementation with Claude Opus 5.5 at medium reasoning before code changes. The review supported the deletion and authentication fixes and recommended a smaller Git comparison and publication design. Implementation used that advice rather than adding a tree inventory, `cat-file --batch`, or an immutable-object pointer system.

### Completed Changes

- Pushed deletions now remove preparation-recreated files, while preserving upstream edits and filesystem clashes. Regression coverage includes a fresh clone after the captured deletion was committed and pushed, and an idempotent second apply.
- Restore uses one bounded `git diff --raw --no-abbrev --no-renames -z` to obtain modes and object IDs. In-process Git blob hashing replaces per-file subprocesses, including SHA-1 and SHA-256 object formats. Capture uses five Git commands and restore uses four in the 3,000-file benchmark.
- Snapshot HTTP routes authenticate the signed wrapper launch credential and check its current stored hash, allocation, route ownership, and tombstone in the Sandbox DO. Snapshot grants, renewal, expiry, credential cache, and grant environment plumbing are removed. Shared credential checks do not emit misleading hello-admission logs for snapshot requests.
- `tar-stream@3.1.9`, already used elsewhere in the repository, replaces handwritten tar framing and decoding. Zod validates manifest shapes and semantic paths/dates. Private staging, path/type/mode validation, duplicates, conflicts, checksums, compressed/decompressed limits, file limits, cancellation, and deadlines remain enforced. Extended-header metadata has an application-level approximately 1 MiB streaming bound, in addition to the library's per-header bound.
- An independent diff review found the metadata-bound regression and a locked-stream cancellation stall. Both were fixed with regression tests before delivery. Storage rejection now cancels the request reader even when the R2 body reader remains locked.

### Archive Compatibility

Remote bucket inventories and personal-test deployment histories were not queried, so absence of persisted snapshots is not established. Readers retain v1 ustar/GNU-longname compatibility. New captures explicitly use manifest version 2 because `tar-stream` can emit PAX headers that the previous reader did not support. The existing `v1/<worktreeId>.tar.gz` storage key is retained so old checkpoints remain discoverable. No bucket rewrite or migration is required.

System tar interoperability is tested in both directions. Old wrappers cannot read version 2 archives; rolling back to the old wrapper requires accepting its existing legacy-recovery fallback. Do not claim bidirectional old/new compatibility.

### Publication Contract

- Authorization is checked immediately before streaming. A successful conditional R2 put makes the checkpoint authoritative unless the worktree is permanently tombstoned.
- An already-authorized upload may finish after allocation replacement if no intervening publication changed its expected etag. This intentionally preserves the previous allocation's latest edits until a successor publishes. It may not overwrite an intervening successor publication. No strict allocation-at-commit fence is claimed.
- `FixedLengthStream` validates the declared body length before R2 commit; R2 validates SHA-256. Rejected short, long, or checksum-mismatched uploads preserve the last-good object. The unsafe post-overwrite oversized-object rollback is removed.
- HEAD-then-DELETE is not an atomic conditional delete. It remains only for permanently tombstoned worktrees, where no newer object is an authorized checkpoint and GET refuses access regardless of object presence. Tests cover replacement during upload, a successor publication, deletion during upload, and cleanup encountering a newer object.
- R2 I/O remains outside the Sandbox DO coordination queue. No immutable-object orphan sweep or parallel publication authority was added.

### Verification Results

These are focused checks, not a full repository validation or production-provider E2E:

- Archive/filesystem/Git suite: 41 tests passed, including legacy v1 compatibility, v2/PAX interoperability, binary/executable/unpushed content, deletions, upstream conflicts, malicious archives, metadata/decompressed bounds, and many-small-files recovery.
- Scheduler, preparation, multi-root, session-host, turn, and supervisor suites: 426 tests passed across seven files, including non-blocking Stop and wrapper restart cases.
- Worker sandbox-control unit suites: 293 tests passed across 17 files, including 33 route tests.
- Workers-runtime snapshot and Sandbox DO integration suites: 162 tests passed across two files. Deliberate stream-abort/provider-error cases emit runtime diagnostics while the suites pass.
- Service and wrapper typechecks, wrapper bundle build, focused lint, formatting, and `git diff --check` passed.
- Final 3,000-file fresh-clone benchmark: 36,768-byte archive; capture 9.121 seconds / five Git commands; restore 5.691 seconds / four Git commands. The original sandbox baseline was 37.8 seconds. Timings are sandbox measurements, not production latency claims or test thresholds.
- Few-large-files benchmark: 52,445,669-byte archive; capture 4.206 seconds; restore 1.213 seconds.
- The locked-consumer regression timed out before its fix; both rejection cases now complete within the one-second test bound. Fake-clock tests retain the 20-second capture bound, 60-second upload/restore bounds, 30-second upload retry, and three bounded download attempts. Transient 503 recovery, digest/length retry recovery, and terminal authorization failures remain covered; deadlines were not increased.

### Remaining Activation Gates

- Both feature flags remain disabled in every tracked environment; nothing was deployed or enabled.
- The repository binds the R2 bucket but does not provision the previously claimed 30-day lifecycle. Provision and verify retention/orphan cleanup before enabling either flag; failed deletion remains access-revoked by its tombstone but is not guaranteed to reclaim storage.
- Full Docker/provider/browser cold-recovery E2E was not run. This environment has no Docker, running dev services, local environment configuration, or push-capable GitHub fixture. Isolated real-filesystem and Workers-runtime integrations do not substitute for a live cold boot, Stop, and supervisor restart.
- Verify real R2 streaming/conditional-write behavior and the live cold-recovery matrix before activation. Miniflare tests establish the local runtime contract, not production-provider behavior.
