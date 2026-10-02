import {
  countGlanceableSessions,
  type GlanceableCounts,
  type GlanceableStatusKind,
  glanceableStatusKind,
  newestGlanceableResult,
  oldestNeedsInputSince,
} from '@kilocode/app-shared/glanceable-agents-snapshot';

import { resolveAnsweredRaises } from '@/lib/glanceable/attention-rows';
import { newestSessionTitle } from '@/lib/glanceable/newest-session';
import { type GlanceableCountLine } from '@/lib/glanceable/presentation';
import { type ActiveSession } from '@/lib/hooks/use-agent-sessions';
import { parseTimestamp } from '@/lib/utils';

/**
 * Rank order shared with `@/lib/glanceable/presentation` (`COUNT_ORDER`): what
 * the user must act on first, then what is working, then what will wake later,
 * then what is only connected. Kept local because that const is private; the
 * values still come from the shared counts, so only this ordering can drift
 * from the native surfaces.
 */
const COUNT_LINE_ORDER = [
  { key: 'glanceable.needsInput', kind: 'needsInput' },
  { key: 'common.working', kind: 'running' },
  { key: 'common.scheduled', kind: 'scheduled' },
  { key: 'common.idle', kind: 'idle' },
] as const satisfies readonly Pick<GlanceableCountLine, 'key' | 'kind'>[];

function countLinesFor(counts: GlanceableCounts): GlanceableCountLine[] {
  return COUNT_LINE_ORDER.map(({ key, kind }) => ({ key, kind, count: counts[kind] }));
}

function statusUpdatedAtMs(session: ActiveSession): number | null {
  const value = session.statusUpdatedAt;
  if (value === undefined) {
    return null;
  }
  const at = parseTimestamp(value).getTime();
  return Number.isFinite(at) ? at : null;
}

function activeTimestampMs(session: ActiveSession): number | null {
  const value = session.updatedAt ?? session.lastActivityAt ?? session.createdAt;
  if (value === undefined) {
    return null;
  }
  const at = parseTimestamp(value).getTime();
  return Number.isFinite(at) ? at : null;
}

/**
 * The navigation destination, chosen from the *unresolved* server rows.
 *
 * `resolveAnsweredRaises` folds an answered raise to `idle` for the counts, and
 * that folded status is what decides whether a raise still waits on the user:
 * an answered one must not keep the card pointed at it. The row handed to
 * `RemoteSessionRow` must stay the original server row, though; that row
 * reconciles the ack store with the status it renders, so an ack-folded `idle`
 * status would delete the ack this fold just honored and the raise would
 * reappear as needs-input.
 *
 * Both candidates are read from `sessions` at the position the resolved view
 * classified, so the row that reaches the card keeps its server status and no
 * positional map back is needed.
 *
 * The needs-input wait ranks like `oldestNeedsInputSince`: an untimed row never
 * displaces a timed one, a tie keeps the earlier row, and — unlike that helper
 * — the first row still wins when none carried a timestamp, because navigation
 * needs a destination. The fallback ranks like `newestSessionTitle`
 * (`updatedAt ?? lastActivityAt ?? createdAt`), where an untimed row never
 * displaces a timed one either.
 */
function selectRelevantSession(
  sessions: readonly ActiveSession[],
  resolved: readonly ActiveSession[]
): ActiveSession | null {
  let oldestNeedsInput: ActiveSession | null = null;
  let oldestMs: number | null = null;
  let newest: ActiveSession | null = null;
  let newestMs: number | null = null;
  for (const [index, session] of sessions.entries()) {
    if (glanceableStatusKind(resolved[index]?.status ?? session.status) === 'needsInput') {
      const at = statusUpdatedAtMs(session);
      if (oldestNeedsInput === null) {
        oldestNeedsInput = session;
        oldestMs = at;
      } else if (at !== null && (oldestMs === null || at < oldestMs)) {
        oldestNeedsInput = session;
        oldestMs = at;
      }
    }
    const at = activeTimestampMs(session);
    const isNewer = newest === null || (at !== null && (newestMs === null || at > newestMs));
    if (isNewer) {
      newest = session;
      newestMs = at;
    }
  }
  return oldestNeedsInput ?? newest;
}

export type ActiveAgentsCardModel = {
  /** Every count line in rank order, zeros included. */
  countLines: GlanceableCountLine[];
  /**
   * Highest-ranked count line with a non-zero count, or null when every count is
   * zero. Only this line keeps the emphasized color; the native glanceable
   * ranks its rows the same way, so a zero needs-input row stays muted instead
   * of borrowing the warning reserved for an agent actually waiting.
   */
  primaryCountKind: GlanceableStatusKind | null;
  /** ISO timestamp of the longest unresolved needs-input wait, or null. */
  needsInputSince: string | null;
  /** Kind of the most recent state change, or null when no row carried one. */
  newestResultKind: GlanceableStatusKind | null;
  newestResultAt: string | null;
  /** Newest active session's display title, or null. */
  newestTitle: string | null;
  /** Oldest unresolved needs-input session, else the newest active one. */
  relevantSession: ActiveSession | null;
};

/**
 * Derive the Home card from the shared `activeSessions.list` rows. Pure: the
 * caller owns the cache read, and the ack store is applied before any
 * derivation, so an answered raise stops counting exactly as it does on the
 * native glanceable and the Agents badge.
 */
export function buildActiveAgentsCardModel(
  sessions: readonly ActiveSession[]
): ActiveAgentsCardModel {
  const resolved = resolveAnsweredRaises(sessions);
  const newest = newestGlanceableResult(resolved);
  const countLines = countLinesFor(countGlanceableSessions(resolved));
  return {
    countLines,
    primaryCountKind: countLines.find(line => line.count > 0)?.kind ?? null,
    needsInputSince: oldestNeedsInputSince(resolved),
    newestResultKind: newest?.kind ?? null,
    newestResultAt: newest?.at ?? null,
    newestTitle: newestSessionTitle(resolved),
    relevantSession: selectRelevantSession(sessions, resolved),
  };
}
