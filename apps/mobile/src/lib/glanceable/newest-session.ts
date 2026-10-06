import { type GlanceableSessionRow } from '@kilocode/app-shared/glanceable-agents-snapshot';

import { sessionDisplayTitle } from '@/lib/session-display-title';
import { parseTimestamp } from '@/lib/utils';

/**
 * The newest-active-session rule, shared by the Home card and every platform
 * widget so the two surfaces always name the same session. Pure and
 * React-free: the publisher stores the widget title in `surface-extras.ts`.
 */

/**
 * The row fields the newest-session rule reads. Every one is optional so the
 * minimal shared row (`status` + `statusUpdatedAt`) also fits: the publisher
 * hands over live `ActiveSession` rows, which carry all of them.
 */
export type NewestSessionRow = GlanceableSessionRow & {
  title?: string | null;
  /** ISO 8601; when the session row was created. */
  createdAt?: string | null;
  /** ISO 8601; when the session row was last updated. */
  updatedAt?: string | null;
  /** ISO 8601; latest agent activity, from `cli_sessions_v2.last_activity_at`. */
  lastActivityAt?: string | null;
};

export type NewestSession<T> = {
  row: T;
  /** The timestamp that ranked the row, or null when the row carries none. */
  at: string | null;
};

/**
 * The newest row by one clock: the latest parseable value wins, and a tie
 * keeps the earlier row so the line does not flicker between equally new
 * sessions. `parseTimestamp` is the app's reader for these fields: the wire
 * carries raw PostgreSQL text, which Hermes' `Date` cannot parse without it.
 */
function newestBy<T>(
  rows: readonly T[],
  clock: (row: T) => string | null | undefined
): NewestSession<T> | null {
  let newest: NewestSession<T> | null = null;
  let newestAt = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    const value = clock(row);
    const at = value === undefined || value === null ? Number.NaN : parseTimestamp(value).getTime();
    if (at > newestAt) {
      newest = { row, at: value ?? null };
      newestAt = at;
    }
  }
  return newest;
}

/**
 * The newest active session, or null only for an empty tray.
 *
 * The status-change time ranks first, so the row matches the snapshot's
 * newest result (`newestGlanceableResult`). Rows without one (never enriched,
 * or an old row) rank by `updatedAt ?? lastActivityAt ?? createdAt`; when no
 * row carries any time, the first row stands in. A tray with a session
 * therefore always names one.
 */
export function pickNewestSession<T extends NewestSessionRow>(
  rows: readonly T[]
): NewestSession<T> | null {
  const first = rows[0];
  if (first === undefined) {
    return null;
  }
  return (
    newestBy(rows, row => row.statusUpdatedAt) ??
    newestBy(rows, row => row.updatedAt ?? row.lastActivityAt ?? row.createdAt) ?? {
      row: first,
      at: null,
    }
  );
}

/**
 * The widget line's title: the newest session's title, or null when the tray
 * is empty or that session has no name a person wrote. A backend default
 * title (`New session - <ISO>`) is machine output, so the widget shows nothing
 * rather than the machine string.
 */
export function newestSessionTitle(rows: readonly NewestSessionRow[]): string | null {
  const newest = pickNewestSession(rows);
  return newest === null ? null : (sessionDisplayTitle(newest.row.title) ?? null);
}
