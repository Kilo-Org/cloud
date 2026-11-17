import { workspaceSnapshotRecoveryOffered } from './workspace-snapshot-recovery';

describe('workspaceSnapshotRecoveryOffered', () => {
  it('offers the capture time only for a failed preparation with a snapshot', () => {
    expect(
      workspaceSnapshotRecoveryOffered({
        cloudStatus: { type: 'error' },
        recovery: { capturedAt: 1_700_000_000_000 },
        recoveryIsFresh: true,
        isReadOnly: false,
      })
    ).toEqual({ capturedAt: 1_700_000_000_000 });
  });

  it('offers it for a snapshot whose capture time cannot be trusted', () => {
    expect(
      workspaceSnapshotRecoveryOffered({
        cloudStatus: { type: 'error' },
        recovery: { capturedAt: null },
        recoveryIsFresh: true,
        isReadOnly: false,
      })
    ).toEqual({ capturedAt: null });
  });

  it('does not offer it without a workspace snapshot', () => {
    expect(
      workspaceSnapshotRecoveryOffered({
        cloudStatus: { type: 'error' },
        recovery: null,
        recoveryIsFresh: true,
        isReadOnly: false,
      })
    ).toBeNull();
  });

  it('does not offer retained recovery data that was not freshly read for this failure', () => {
    expect(
      workspaceSnapshotRecoveryOffered({
        cloudStatus: { type: 'error' },
        recovery: { capturedAt: 1_700_000_000_000 },
        recoveryIsFresh: false,
        isReadOnly: false,
      })
    ).toBeNull();
  });

  it('does not offer it while preparation is not in the error state', () => {
    for (const type of ['preparing', 'ready', 'finalizing'] as const) {
      expect(
        workspaceSnapshotRecoveryOffered({
          cloudStatus: { type },
          recovery: { capturedAt: 1_700_000_000_000 },
          recoveryIsFresh: true,
          isReadOnly: false,
        })
      ).toBeNull();
    }
  });

  it('does not offer it to a read-only viewer', () => {
    expect(
      workspaceSnapshotRecoveryOffered({
        cloudStatus: { type: 'error' },
        recovery: { capturedAt: 1_700_000_000_000 },
        recoveryIsFresh: true,
        isReadOnly: true,
      })
    ).toBeNull();
  });
});
