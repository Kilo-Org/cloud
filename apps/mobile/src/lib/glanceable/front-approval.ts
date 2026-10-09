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
  return rankApprovableSessions(rows)[0] ?? null;
}

/**
 * Every permission row, front first, under the `pickFrontApprovableSession`
 * rule: earliest usable `statusUpdatedAt`, rows without one last, list order
 * breaking ties. The server binds the widget's approval key to the row this
 * rule puts first (`pickFrontPermissionRow` in
 * `apps/web/src/lib/glanceable-agents-snapshot-server.ts`), so a bounded scan
 * of this ranking always includes the displayed request.
 */
export function rankApprovableSessions<T extends FrontApprovableRow>(rows: readonly T[]): T[] {
  const ranked: { row: T; at: number; index: number }[] = [];
  for (const [index, row] of rows.entries()) {
    if (row.status === 'permission') {
      const parsed =
        row.statusUpdatedAt === undefined ? Number.NaN : Date.parse(row.statusUpdatedAt);
      ranked.push({ row, at: Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed, index });
    }
  }
  // Two untimed rows subtract to NaN, which falls through to list order.
  // eslint-disable-next-line unicorn/no-array-sort -- Hermes does not implement Array.prototype.toSorted; `ranked` is a local copy
  ranked.sort((a, b) => a.at - b.at || a.index - b.index);
  return ranked.map(entry => entry.row);
}
