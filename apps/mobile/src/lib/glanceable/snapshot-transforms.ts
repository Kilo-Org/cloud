import {
  GLANCEABLE_SNAPSHOT_EXPIRY_MS,
  type GlanceableAgentsSnapshot,
  type GlanceableAgentsSnapshotStatus,
} from '@kilocode/app-shared/glanceable-agents-snapshot';

/**
 * Pure snapshot transforms shared by the publisher and the side effects that
 * reason about a previous snapshot (cleanup, view props). Kept out of
 * `publisher.ts` so that state machine stays within the module size limit.
 */

/** Advance the status and revision without renewing stale data's lifetime. */
export function withStatus(
  snapshot: GlanceableAgentsSnapshot,
  status: GlanceableAgentsSnapshotStatus,
  now: number
): GlanceableAgentsSnapshot {
  if (status === 'stale') {
    if (snapshot.status === 'signed_out' || snapshot.status === 'privacy') {
      return snapshot;
    }
    const expired = snapshot.status === 'expired' || now >= Date.parse(snapshot.expiresAt);
    return {
      ...snapshot,
      revision: snapshot.revision + 1,
      status: expired ? 'expired' : 'stale',
      ...(expired
        ? {
            running: 0,
            needsInput: 0,
            idle: 0,
            scheduled: 0,
            needsInputSince: null,
            scheduledAt: null,
          }
        : {}),
    };
  }
  const updatedAt = new Date(now).toISOString();
  return {
    ...snapshot,
    revision: snapshot.revision + 1,
    updatedAt,
    expiresAt: new Date(now + GLANCEABLE_SNAPSHOT_EXPIRY_MS).toISOString(),
    status,
  };
}

/**
 * True when two snapshot + newest-title pairs would draw the same native
 * surface. Compares the user-visible fields only — `status`, the counts, the
 * wait anchor, and the title the widget draws from the surface extras — so a
 * tray write whose only difference is `revision`/`updatedAt` does not
 * re-render the widget or update the ongoing notification / Live Activity.
 */
export function hasSameGlanceableContent(
  a: { snapshot: GlanceableAgentsSnapshot; newestSessionTitle: string | null },
  b: { snapshot: GlanceableAgentsSnapshot; newestSessionTitle: string | null }
): boolean {
  return (
    a.snapshot.status === b.snapshot.status &&
    a.snapshot.running === b.snapshot.running &&
    a.snapshot.needsInput === b.snapshot.needsInput &&
    (a.snapshot.needsApproval ?? 0) === (b.snapshot.needsApproval ?? 0) &&
    a.snapshot.idle === b.snapshot.idle &&
    a.snapshot.scheduled === b.snapshot.scheduled &&
    a.snapshot.needsInputSince === b.snapshot.needsInputSince &&
    a.snapshot.scheduledAt === b.snapshot.scheduledAt &&
    a.newestSessionTitle === b.newestSessionTitle
  );
}
