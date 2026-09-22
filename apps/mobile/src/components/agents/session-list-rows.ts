import { type SessionSection } from '@/components/agents/session-list-helpers';
import { type StoredSession } from '@/lib/hooks/use-agent-sessions';

/**
 * One row of the flattened session-history list.
 *
 * A `section-header` row carries the same `title`/`count` the
 * `SessionListSectionHeader` receives today; a `session` row carries the
 * stored session `StoredSessionRow` renders. A `skeleton` row is a reserved
 * cold-open loading slot (see `skeletonSessionRows`). `key` is stable across
 * renders: `header:<title>` for headers (date-section titles are unique per
 * render), `session.session_id` for sessions, and `skeleton:<index>` for
 * loading slots.
 */
export type SessionListRow =
  | { kind: 'section-header'; key: string; title: string; count: number }
  | { kind: 'skeleton'; key: string }
  | { kind: 'session'; key: string; session: StoredSession };

/** Reserved loading rows shown while the first history page loads. */
export const SESSION_LIST_SKELETON_COUNT = 8;

/**
 * Reserved cold-open loading rows, rendered in the list data itself instead
 * of `ListEmptyComponent`. FlashList mis-lays-out the empty → populated
 * transition (one stray row over a blank gap until a later data commit), so
 * the loading phase must keep the list populated: the
 * swap to real rows is then a plain populated → populated data update that
 * reuses the reserved space in place. Keys are unique per slot.
 */
export function skeletonSessionRows(
  count: number = SESSION_LIST_SKELETON_COUNT
): readonly SessionListRow[] {
  return Array.from({ length: count }, (_, index) => ({
    kind: 'skeleton' as const,
    key: `skeleton:${index}`,
  }));
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
      rows.push({ kind: 'session', key: session.session_id, session });
    }
  }
  return rows;
}
