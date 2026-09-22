import { type GlanceableSessionRow } from '@kilocode/app-shared/glanceable-agents-snapshot';

import { parseTimestamp } from '@/lib/utils';

/**
 * The newest-active-session line, derived from the tray rows the publisher
 * already receives. Pure and React-free: the publisher stores the result in
 * `surface-extras.ts` and every platform widget reads it from there.
 */

/**
 * The row fields the newest-session line reads. Every one is optional so the
 * minimal shared row (`status` + `statusUpdatedAt`) also fits: the publisher
 * hands over live `ActiveSession` rows, which carry all three.
 */
export type NewestSessionRow = {
  title?: string | null;
  /** ISO 8601; when the session row was created. */
  createdAt?: string | null;
  /** ISO 8601; when the session row was last updated. */
  updatedAt?: string | null;
  /** ISO 8601; latest agent activity, from `cli_sessions_v2.last_activity_at`. */
  lastActivityAt?: string | null;
};

/**
 * The row's own clock: its last activity, else its update, else its creation.
 * Null when the row carries none, or when the first one it carries is not a
 * parseable timestamp — the row then ranks below every timed row.
 *
 * `parseTimestamp` is the app's reader for these fields: the wire carries raw
 * PostgreSQL text, which Hermes' `Date` cannot parse without it.
 */
function rowTimestamp(row: NewestSessionRow): number | null {
  const value = row.updatedAt ?? row.lastActivityAt ?? row.createdAt;
  if (value === undefined || value === null) {
    return null;
  }
  const at = parseTimestamp(value).getTime();
  return Number.isNaN(at) ? null : at;
}

function titleOf(row: NewestSessionRow | null): string | null {
  if (row === null) {
    return null;
  }
  const title = row.title;
  // A blank title would draw an empty newest line; the surface shows nothing
  // rather than a label with no name after it.
  if (title === null || title === undefined || title.trim().length === 0) {
    return null;
  }
  return title;
}

/**
 * The newest row's title, or null when the tray is empty (or every row has a
 * blank title). Newest ranks by `updatedAt ?? lastActivityAt ?? createdAt`;
 * an untimed row never displaces a timed one, and a tie keeps the earlier row
 * so the line does not flicker between equally new sessions.
 */
export function newestSessionTitle(
  rows: readonly (GlanceableSessionRow & NewestSessionRow)[]
): string | null {
  let newestRow: NewestSessionRow | null = null;
  let newestAt: number | null = null;
  for (const row of rows) {
    const at = rowTimestamp(row);
    const isNewer = newestRow === null || (at !== null && (newestAt === null || at > newestAt));
    if (isNewer) {
      newestRow = row;
      newestAt = at;
    }
  }
  return titleOf(newestRow);
}
