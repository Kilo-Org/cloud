/**
 * Whether the session sheet offers "Start fresh", and the snapshot state that
 * offer names.
 *
 * Ported from the web's `workspaceSnapshotRecoveryOffered`: the offer belongs to
 * a start that failed, and its state must come from a fresh successful read for
 * that failure. Retained data from an earlier failure of the same session names
 * a capture time this failure may not have, and the action discards the
 * workspace snapshot, so a stale read must not put it on screen. A null
 * `capturedAt` is still an offer: the snapshot exists but its descriptor could
 * not be read, and the copy says so rather than hiding the only way out of a
 * start that keeps failing.
 */
export type WorkspaceSnapshotRecoveryState = { capturedAt: number | null };

export function workspaceSnapshotRecoveryOffered(input: {
  /** This session's start failed; that failure is what a fresh start answers. */
  startFailed: boolean;
  /** The read's data, `null` when the workspace holds no snapshot to discard. */
  recovery: WorkspaceSnapshotRecoveryState | null | undefined;
  /** The read answered this mount and is not still fetching. */
  recoveryIsFresh: boolean;
}): WorkspaceSnapshotRecoveryState | null {
  if (!input.startFailed) {
    return null;
  }
  if (!input.recoveryIsFresh) {
    return null;
  }
  return input.recovery ?? null;
}
