import { describe, expect, it } from 'vitest';

import { workspaceSnapshotRecoveryOffered } from './workspace-snapshot-recovery';

const CAPTURED = { capturedAt: 1_760_000_000_000 };

describe('workspaceSnapshotRecoveryOffered', () => {
  it('offers the discard only for a failed start with a fresh read', () => {
    expect(
      workspaceSnapshotRecoveryOffered({
        startFailed: true,
        recovery: CAPTURED,
        recoveryIsFresh: true,
      })
    ).toEqual(CAPTURED);
    expect(
      workspaceSnapshotRecoveryOffered({
        startFailed: false,
        recovery: CAPTURED,
        recoveryIsFresh: true,
      })
    ).toBeNull();
  });

  it('ignores a read that has not answered this mount', () => {
    // `staleTime: 0` refetches on mount but keeps the cached value while it
    // fetches: the discard would then name a snapshot an earlier failure left
    // in cache.
    expect(
      workspaceSnapshotRecoveryOffered({
        startFailed: true,
        recovery: CAPTURED,
        recoveryIsFresh: false,
      })
    ).toBeNull();
  });

  it('offers nothing when the workspace holds no snapshot', () => {
    expect(
      workspaceSnapshotRecoveryOffered({
        startFailed: true,
        recovery: null,
        recoveryIsFresh: true,
      })
    ).toBeNull();
    expect(
      workspaceSnapshotRecoveryOffered({
        startFailed: true,
        recovery: undefined,
        recoveryIsFresh: true,
      })
    ).toBeNull();
  });

  it('still offers the action when the capture time cannot be trusted', () => {
    // The snapshot exists but its descriptor cannot be read: hiding the action
    // would leave a start that keeps failing with no way out.
    expect(
      workspaceSnapshotRecoveryOffered({
        startFailed: true,
        recovery: { capturedAt: null },
        recoveryIsFresh: true,
      })
    ).toEqual({ capturedAt: null });
  });
});
