import type { SessionSyncResult } from '../shared/sandbox-control-protocol.js';

/**
 * A turn's inactivity clock is advanced only by real agent progress. The wrapper
 * synthesizes `{ type: 'busy' }` from `session.sync` while any operation is
 * active, so control-plane liveness signals -- snapshots, operation receipts,
 * retry/offline status, and pending questions/permissions -- must never reset
 * the clock.
 */
export function isRealTurnActivity(type: string, properties: Record<string, unknown>): boolean {
  if (
    type === 'message.updated' ||
    type === 'message.part.updated' ||
    type === 'message.part.delta'
  ) {
    return true;
  }
  if (type !== 'session.status') return false;
  const status = properties.status;
  return (
    typeof status === 'object' && status !== null && (status as { type?: unknown }).type === 'busy'
  );
}

export type AcceptedSnapshotKind = 'waiting' | 'inactive';

/**
 * Liveness/pending-input classification for the 90s accepted health check.
 * This never writes the activity clock.
 */
export function acceptedSnapshotKind(snapshot: SessionSyncResult): AcceptedSnapshotKind {
  const status = snapshot.status.type;
  if (status === 'busy' || status === 'retry' || status === 'offline') return 'waiting';
  if (snapshot.questions.length > 0 || snapshot.permissions.length > 0) return 'waiting';
  return 'inactive';
}
