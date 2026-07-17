import {
  type AgentSessionSortBy,
  getAgentSessionTimestamp,
  parseAgentSessionSortBy,
} from './agent-session-sort';
import { parseTimestamp } from '@/lib/utils';

type SessionTimestamps = { created_at: string; updated_at: string };

type AgentSessionDateGroup<T extends SessionTimestamps> = {
  label: string;
  sessions: T[];
};

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function getWeekdayName(date: Date): string {
  return new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(date);
}

function timestampMs(session: SessionTimestamps, sortBy: AgentSessionSortBy): number {
  return parseTimestamp(getAgentSessionTimestamp(session, sortBy)).getTime();
}

/**
 * Bucket sessions into the existing Today / Yesterday / weekday / Older
 * sections, sorted newest-first by the selected timestamp. The input array
 * is never mutated — callers can hand in the tRPC query result directly.
 *
 * Server-side ordering is authoritative for cross-page consistency, but
 * every section boundary check uses the same timestamp the row's relative
 * meta label will display, so a session can never end up in a section that
 * contradicts the timestamp it shows.
 */
export function groupAgentSessionsByDate<T extends SessionTimestamps>(
  sessions: T[],
  sortBy: AgentSessionSortBy,
  now: Date = new Date()
): AgentSessionDateGroup<T>[] {
  // Defensive: tolerate callers (e.g. older call sites) that pass an unknown
  // string here, the same way parseAgentSessionSortBy would have.
  const resolvedSort = parseAgentSessionSortBy(sortBy);
  // eslint-disable-next-line unicorn/no-array-sort -- Hermes does not implement Array.prototype.toSorted; spread already prevents mutation of the source
  const sorted = [...sessions].sort(
    (a, b) => timestampMs(b, resolvedSort) - timestampMs(a, resolvedSort)
  );

  const yesterday = addDays(now, -1);

  const buckets = new Map<string, T[]>();
  const bucketOrder: string[] = [];

  function addToBucket(label: string, session: T) {
    const existing = buckets.get(label);
    if (existing) {
      existing.push(session);
    } else {
      buckets.set(label, [session]);
      bucketOrder.push(label);
    }
  }

  for (const session of sorted) {
    const date = parseTimestamp(getAgentSessionTimestamp(session, resolvedSort));

    if (isSameDay(date, now)) {
      addToBucket('Today', session);
    } else if (isSameDay(date, yesterday)) {
      addToBucket('Yesterday', session);
    } else {
      const diffMs = now.getTime() - date.getTime();
      const diffDays = diffMs / (1000 * 60 * 60 * 24);
      if (diffDays <= 7) {
        addToBucket(getWeekdayName(date), session);
      } else {
        addToBucket('Older', session);
      }
    }
  }

  // The weekday bucket holds sessions in their sorted (newest-first) order
  // already; Older needs a second pass because it's keyed by label, not by
  // insertion order of distinct days.
  const olderBucket = buckets.get('Older');
  if (olderBucket) {
    olderBucket.sort((a, b) => timestampMs(b, resolvedSort) - timestampMs(a, resolvedSort));
  }

  return bucketOrder.map(label => ({
    label,
    sessions: buckets.get(label) ?? [],
  }));
}
