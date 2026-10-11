import {
  glanceableStatusKind,
  type GlanceableStatusKind,
} from '@kilocode/app-shared/glanceable-agents-snapshot';

/**
 * The four state counts the Home `Live now` card draws, in the card's order.
 * The order is the card's, so the filter and the card name a status the same
 * way: what the user must act on, then what is making progress, then what will
 * wake later, then what is only connected.
 */
export const STATUS_FILTER_ORDER: readonly { kind: GlanceableStatusKind; labelKey: string }[] = [
  { kind: 'needsInput', labelKey: 'glanceable.needsInput' },
  { kind: 'running', labelKey: 'common.working' },
  { kind: 'scheduled', labelKey: 'common.scheduled' },
  { kind: 'idle', labelKey: 'common.idle' },
];

/** The copy key for one status kind. Falls back to the working label. */
export function statusFilterLabelKey(kind: GlanceableStatusKind): string {
  return STATUS_FILTER_ORDER.find(line => line.kind === kind)?.labelKey ?? 'common.working';
}

/**
 * Read the `status` route parameter as one status kind. Returns null for an
 * absent, repeated, or unknown value, so a stale or hand-written link never
 * filters the list to a status that does not exist.
 */
export function parseStatusFilterKind(
  value: string | string[] | undefined
): GlanceableStatusKind | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return STATUS_FILTER_ORDER.find(line => line.kind === raw)?.kind ?? null;
}

/**
 * Keep only the sessions that show one status kind. A null kind is "no filter",
 * and returns the same array, so the unfiltered list keeps its identity and the
 * screen's memos stay stable.
 */
export function filterSessionsByStatusKind<T extends { status: string }>(
  sessions: T[],
  kind: GlanceableStatusKind | null
): T[] {
  if (kind === null) {
    return sessions;
  }
  return sessions.filter(session => glanceableStatusKind(session.status) === kind);
}
