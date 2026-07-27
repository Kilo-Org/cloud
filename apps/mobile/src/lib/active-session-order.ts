import { type ActiveSession } from '@/lib/hooks/use-agent-sessions';
import { parseTimestamp } from '@/lib/utils';

type Decorated = {
  session: ActiveSession;
  /** null = missing or unparseable `createdAt` (unenriched bucket). */
  createdAtMs: number | null;
};

/**
 * Parse `createdAt` once per row. Missing, non-string, and unparseable
 * values all become `null` so they share the unenriched sort bucket.
 * Never treat NaN as epoch 0.
 */
function parseCreatedAtMs(session: ActiveSession): number | null {
  if (typeof session.createdAt !== 'string') {
    return null;
  }
  const ms = parseTimestamp(session.createdAt).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function compareIdAsc(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

/**
 * Deterministic order for the Agents "Active now" tray and Home active
 * rows. Shared read-boundary sort so live-sync `setQueryData` and full
 * refetches cannot reshuffle the list.
 *
 * 1. Unenriched (no parseable `createdAt`) first, by `id` ascending.
 * 2. Enriched by `createdAt` descending (newest first).
 * 3. Equal `createdAt` → `id` ascending.
 *
 * Keys strictly on parseable `createdAt`, not on `isEnriched` (any of
 * createdOnPlatform / createdAt / updatedAt).
 */
export function sortActiveSessionsByCreatedAt(sessions: ActiveSession[]): ActiveSession[] {
  const decorated: Decorated[] = sessions.map(session => ({
    session,
    createdAtMs: parseCreatedAtMs(session),
  }));

  // eslint-disable-next-line unicorn/no-array-sort -- Hermes does not implement Array.prototype.toSorted; map already copies so the react-query cache array is not mutated
  decorated.sort((a, b) => {
    const aMs = a.createdAtMs;
    const bMs = b.createdAtMs;
    const aUnenriched = aMs === null;
    const bUnenriched = bMs === null;

    if (aUnenriched && bUnenriched) {
      return compareIdAsc(a.session.id, b.session.id);
    }
    if (aUnenriched) {
      return -1;
    }
    if (bUnenriched) {
      return 1;
    }
    // Both enriched: newest first.
    if (aMs !== bMs) {
      return bMs - aMs;
    }
    return compareIdAsc(a.session.id, b.session.id);
  });

  return decorated.map(d => d.session);
}
