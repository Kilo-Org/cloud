import type { CloudStatus } from '@kilocode/cloud-agent-sdk';

export type WorkspaceSnapshotRecoveryState = { capturedAt: number | null };

/**
 * "Start fresh" is only for a workspace snapshot start that failed. The
 * recovery state must come from a fresh, successful read for this failure
 * (never retained data from an earlier one), the preparation must have failed,
 * and a read-only viewer cannot mutate the workspace. Returns the recovery
 * state when the action should be offered; its `capturedAt` is null when the
 * snapshot's capture time cannot be trusted.
 */
export function workspaceSnapshotRecoveryOffered(input: {
  cloudStatus: Pick<CloudStatus, 'type'> | null | undefined;
  recovery: WorkspaceSnapshotRecoveryState | null | undefined;
  recoveryIsFresh: boolean;
  isReadOnly: boolean;
}): WorkspaceSnapshotRecoveryState | null {
  if (input.isReadOnly) return null;
  if (input.cloudStatus?.type !== 'error') return null;
  if (!input.recoveryIsFresh) return null;
  return input.recovery ?? null;
}
