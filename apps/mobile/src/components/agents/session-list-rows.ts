import { type SessionSection } from '@/components/agents/session-list-helpers';
import { type StoredSession } from '@/lib/hooks/use-agent-sessions';

/**
 * One row of the flattened session-history list.
 *
 * A `section-header` row carries the same `title`/`count` the
 * `SessionListSectionHeader` receives today; a `session` row carries the
 * stored session `StoredSessionRow` renders. A `section-header-skeleton` row is
 * the reserved cold-open date-header placeholder and a `skeleton` row is a
 * reserved cold-open session slot (see `skeletonSessionRows`). `key` is stable
 * across renders: `header:<title>` for headers (date-section titles are unique
 * per render), `session.session_id` for sessions, and `skeleton:header` /
 * `skeleton:<index>` for loading slots.
 */
export type SessionListRow =
  | { kind: 'section-header'; key: string; title: string; count: number }
  | { kind: 'section-header-skeleton'; key: string }
  | { kind: 'skeleton'; key: string; index: number }
  | {
      kind: 'session';
      key: string;
      session: StoredSession;
      /** Heading of the date section this row sits under, so the row can tell
       * when its relative label would restate it (see `sectionAwareTimeMeta`). */
      sectionTitle: string;
      /** The zone that heading was grouped in, so the row names the same day. */
      timeZone: string;
    };

/** Reserved loading rows shown while the first history page loads. */
export const SESSION_LIST_SKELETON_COUNT = 8;
/** Key of the reserved cold-open date-header placeholder. */
export const SESSION_LIST_SKELETON_HEADER_KEY = 'skeleton:header';

/**
 * Reserved cold-open loading rows, rendered in the list data itself instead
 * of `ListEmptyComponent`. FlashList mis-lays-out the empty → populated
 * transition (one stray row over a blank gap until a later data commit), so
 * the loading phase must keep the list populated: the
 * swap to real rows is then a plain populated → populated data update that
 * reuses the reserved space in place. Keys are unique per slot.
 *
 * The placeholder shape matches the real flattened shape item for item: a
 * date-header placeholder followed by session placeholders, exactly as
 * `flattenSessionSections` emits a `section-header` row followed by `session`
 * rows. A composite item (header and row in one cell) is measured at that
 * composite height and then corrected when the real, separate rows arrive,
 * which is the jump this shape avoids. So `skeletonSessionRows(count)` has
 * `count + 1` items, and the caller's list data is `header + N rows` in both
 * the placeholder and the loaded state.
 */
export function skeletonSessionRows(
  count: number = SESSION_LIST_SKELETON_COUNT
): readonly SessionListRow[] {
  return [
    { kind: 'section-header-skeleton', key: SESSION_LIST_SKELETON_HEADER_KEY },
    ...Array.from({ length: count }, (_, index) => ({
      kind: 'skeleton' as const,
      key: `skeleton:${index}`,
      index,
    })),
  ];
}

/**
 * Flatten `SessionSection[]` into the single row array a recycling list
 * renders. Section order and per-section session order are preserved, so the
 * flattened output shows exactly the headers and rows the sectioned list shows.
 * The input is never mutated; a fresh array is returned.
 */
export function flattenSessionSections(
  sections: readonly SessionSection[]
): readonly SessionListRow[] {
  const rows: SessionListRow[] = [];
  for (const section of sections) {
    rows.push({
      kind: 'section-header',
      key: `header:${section.title}`,
      title: section.title,
      count: section.data.length,
    });
    for (const session of section.data) {
      rows.push({
        kind: 'session',
        key: session.session_id,
        session,
        sectionTitle: section.title,
        timeZone: section.timeZone,
      });
    }
  }
  return rows;
}
