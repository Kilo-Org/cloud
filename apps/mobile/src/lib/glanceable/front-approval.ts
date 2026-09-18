import { type GlanceableSessionRow } from '@kilocode/app-shared/glanceable-agents-snapshot';

/**
 * One session row as the front-approval picker reads it: the active-sessions
 * row the glanceable snapshot is built from, plus the session id the approve
 * call needs. Structurally a `GlanceableSessionRow`, so the picker and the
 * snapshot counts can never disagree about what `permission` means.
 */
export type FrontApprovableRow = GlanceableSessionRow & { id: string };

/**
 * The session the wrist control approves: the permission row the user has
 * waited on longest.
 *
 * Only `status === 'permission'` rows qualify — a `question` needs an answer
 * and a `retry` needs the provider to come back, so neither is approvable.
 * Among the permission rows the earliest `statusUpdatedAt` wins, mirroring the
 * documented front-of-queue rule in `oldestNeedsInputSince`. A row whose
 * timestamp is missing or unparseable sorts last rather than reading as
 * "waiting since now" (which would let a timestamp-less row cut the queue), and
 * list order breaks every remaining tie, so the result is deterministic for
 * identical rows. Returns null when no permission row waits.
 */
export function pickFrontApprovableSession<T extends FrontApprovableRow>(
  rows: readonly T[]
): T | null {
  let front: T | null = null;
  let frontAt: number | null = null;
  for (const row of rows) {
    if (row.status === 'permission') {
      const parsed =
        row.statusUpdatedAt === undefined ? Number.NaN : Date.parse(row.statusUpdatedAt);
      const at = Number.isNaN(parsed) ? null : parsed;
      if (front === null) {
        front = row;
        frontAt = at;
      } else if (at !== null && (frontAt === null || at < frontAt)) {
        // A row without a usable timestamp sorts last: it cannot displace a row
        // that carried one, and the earlier list position breaks its own ties.
        front = row;
        frontAt = at;
      }
    }
  }
  return front;
}
