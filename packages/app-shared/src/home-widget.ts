import {
  isDefaultSessionTitle,
  sessionDisplayLine,
  sessionLiveCut,
} from '@kilocode/session-ingest-contracts/session-live-summary';
import { z } from 'zod';
import { approvalKeySchema } from './approval-key';
import {
  buildGlanceableSnapshot,
  countGlanceableSessions,
  type GlanceableAgentsSnapshot,
  type GlanceableCounts,
  glanceableAgentsSnapshotSchema,
  glanceableNeedsInputKind,
  GLANCEABLE_NEEDS_INPUT_STATUSES,
  GLANCEABLE_STATUS_KINDS,
  GLANCEABLE_TITLE_LIMIT,
  glanceableStatusKind,
  isScheduledSessionRow,
  isStartableGlanceableWork,
  isApprovableGlanceableStatus,
  isTerminalGlanceableStatus,
  type BuildGlanceableSnapshotInput,
  type GlanceableAgentsSnapshotStatus,
  type GlanceableNeedsInputKind,
  type GlanceableSessionRow,
  type GlanceableStatusKind,
  type GlanceableTerminalStatus,
  compareSessionInstant,
} from './glanceable-agents-snapshot';
import { epochMsToIso, timestampMs, timestampToIso } from './utils';

export const HOME_WIDGET_DETAIL_LIMIT = 3;
const titleSchema = z.string().max(GLANCEABLE_TITLE_LIMIT);
const kindSchema = z.enum(GLANCEABLE_STATUS_KINDS);

/** Private Home-only data. Never include this in Live Activity content-state. */
export const homeWidgetDetailsSchema = z.object({
  approvalKey: approvalKeySchema.default(null),
  /**
   * The kind whose row produced `primaryTitle`. Thus the title always describes
   * the kind drawn beside it. A payload that was stored or pushed before this
   * field existed omits it. The schema normalizes an omitted value to `null`,
   * which is an unknown kind. The title is kept, so an older payload renders as
   * it did.
   */
  primaryKind: kindSchema.nullable().default(null),
  primaryTitle: titleSchema.nullable(),
  waitingAgents: z
    .array(
      z.object({
        title: titleSchema,
        kind: z.enum(GLANCEABLE_NEEDS_INPUT_STATUSES),
      })
    )
    .max(HOME_WIDGET_DETAIL_LIMIT),
  scheduledAgents: z
    .array(
      z.object({
        title: titleSchema,
        scheduledAt: z.string().nullable(),
      })
    )
    .max(HOME_WIDGET_DETAIL_LIMIT),
});
export type HomeWidgetDetails = z.infer<typeof homeWidgetDetailsSchema>;

/**
 * Details with no private work to describe, as a record the caller owns. A
 * payload that shared one instance's arrays would let a caller's write change
 * what every later empty payload reports. A caller that needs to change a field
 * spreads this record into a new one.
 */
export function emptyHomeWidgetDetails(): HomeWidgetDetails {
  return {
    approvalKey: null,
    primaryKind: null,
    primaryTitle: null,
    waitingAgents: [],
    scheduledAgents: [],
  };
}

export const homeWidgetDataSchema = z.object({
  snapshot: glanceableAgentsSnapshotSchema,
  details: homeWidgetDetailsSchema,
});
export type HomeWidgetData = z.infer<typeof homeWidgetDataSchema>;

export const homeWidgetPresentationSchema = z.object({
  status: z.enum(['waiting', 'unavailable', 'empty', 'signed_out', 'privacy', 'content']),
  primaryKind: kindSchema.nullable(),
  primaryCount: z.number().int().min(0),
  secondaryCounts: z
    .array(z.object({ kind: kindSchema, count: z.number().int().positive() }))
    .max(GLANCEABLE_STATUS_KINDS.length - 1),
  checkedAt: z.string().nullable(),
  stale: z.boolean(),
  scheduledAt: z.string().nullable(),
  awaitingUpdate: z.boolean(),
  primaryTitle: titleSchema.nullable(),
  waitingAgents: homeWidgetDetailsSchema.shape.waitingAgents,
  scheduledAgents: homeWidgetDetailsSchema.shape.scheduledAgents,
  canCreate: z.boolean(),
  canApprove: z.boolean(),
  approvalKey: approvalKeySchema,
});
export type HomeWidgetPresentation = z.infer<typeof homeWidgetPresentationSchema>;
/** One native aging boundary and the presentation policy that holds from it. */
export const homeWidgetTimelineEntrySchema = z.object({
  at: z.number().finite(),
  home: homeWidgetPresentationSchema,
});
export type HomeWidgetTimelineEntry = z.infer<typeof homeWidgetTimelineEntrySchema>;
export const homeWidgetResponseSchema = homeWidgetDataSchema.extend({
  home: homeWidgetPresentationSchema,
  refreshAt: z.number().finite(),
  /**
   * Optional for persisted older responses; current server producers always
   * supply it. Four is the most the policy can build: the request instant, the
   * wake, its one retry, and the stale instant. A cap below that would refuse a
   * payload the producers are entitled to send.
   */
  presentationTimeline: z.array(homeWidgetTimelineEntrySchema).max(4).optional(),
});
export type HomeWidgetResponse = z.infer<typeof homeWidgetResponseSchema>;
export type HomeWidgetSessionRow = GlanceableSessionRow & {
  title?: string | null;
  /** Raw candidate value; buildHomeWidgetDetails keeps it only when approvalKeySchema accepts it. */
  approvalKey?: string | null;
};

const KIND_RANK = {
  needsInput: 0,
  running: 1,
  scheduled: 2,
  idle: 3,
} as const satisfies Record<GlanceableStatusKind, number>;
const KIND_ORDER: readonly GlanceableStatusKind[] = [...GLANCEABLE_STATUS_KINDS].sort(
  (a, b) => KIND_RANK[a] - KIND_RANK[b]
);

/**
 * The one primary-kind ranking a snapshot or its rows read: the first kind in
 * `KIND_ORDER` with a positive count, else null. Details and presentation both
 * call it, so the title's kind and the count drawn beside it cannot rank
 * differently.
 */
function primaryKindOf(counts: GlanceableCounts): GlanceableStatusKind | null {
  return KIND_ORDER.find(kind => counts[kind] > 0) ?? null;
}

const ACTIVE_REFRESH_MS = 30 * 60 * 1000;
const QUIET_REFRESH_MS = 2 * 60 * 60 * 1000;
// Both native schedulers clamp a request to a 15-minute floor, so a retry that
// asks for the wake plus this delay is the instant the widget can fetch.
const WAKE_RETRY_MS = 15 * 60 * 1000;

/**
 * The one terminal narrowing: the status when it ends the surface, else null.
 * Callers read this value instead of testing the predicate and keeping a
 * boolean beside a status a later branch can contradict.
 */
function terminalStatusOf(status: GlanceableAgentsSnapshotStatus): GlanceableTerminalStatus | null {
  return isTerminalGlanceableStatus(status) ? status : null;
}

/**
 * The one cadence rule: every caller that needs a snapshot's refresh interval
 * reads this function. It takes the caller's already-narrowed terminal status
 * rather than testing the predicate again, and a terminal snapshot is quiet
 * regardless of the counts that survive beside it, so auth/privacy termination
 * cannot keep polling.
 */
function refreshInterval(
  snapshot: GlanceableAgentsSnapshot,
  terminal: GlanceableTerminalStatus | null
): number {
  if (terminal !== null) return QUIET_REFRESH_MS;
  return snapshot.status === 'waiting' ||
    snapshot.status === 'stale' ||
    snapshot.status === 'expired' ||
    isStartableGlanceableWork(snapshot)
    ? ACTIVE_REFRESH_MS
    : QUIET_REFRESH_MS;
}

/**
 * Trim to one line of what the surface draws, then apply `sessionLiveCut` at a
 * character boundary. A surface adds only its own empty or placeholder rule on
 * top.
 */
export function glanceableTitle(value: string | null | undefined): string {
  const title = sessionDisplayLine(value ?? '').trim();
  return sessionLiveCut(title, GLANCEABLE_TITLE_LIMIT);
}

/**
 * The one title rule every drawing surface applies: the shared display cut, or
 * null for an empty title and for the backend `New session - <ISO>`
 * placeholder. Each surface maps null to its own generic agent label. The
 * stored Home details keep the plain cut, so every app build can still read a
 * payload.
 */
export function glanceableSessionTitle(value: string | null | undefined): string | null {
  const title = glanceableTitle(value);
  return title === '' || isDefaultSessionTitle(title) ? null : title;
}

/**
 * Same authorized rows as counts, with stable ties and unknown times ranked
 * last. Returns the kind its `primaryTitle` belongs to, so the title and the
 * count drawn beside it cannot describe different kinds.
 */
export function buildHomeWidgetDetails(
  sessions: readonly HomeWidgetSessionRow[]
): HomeWidgetDetails {
  const byStatusUpdatedAt = compareSessionInstant(row => row.statusUpdatedAt, 'earliest');
  // One status predicate owns both membership and the kind, so a needs-input
  // row and the label drawn for it cannot disagree.
  const waiting: {
    row: HomeWidgetSessionRow;
    kind: GlanceableNeedsInputKind;
    /** The schema-valid key the row carries, or null when it carries none. */
    key: string | null;
  }[] = [];
  for (const row of sessions) {
    const kind = glanceableNeedsInputKind(row.status);
    if (kind !== null) {
      waiting.push({
        row,
        kind,
        key: approvalKeySchema.safeParse(row.approvalKey).data ?? null,
      });
    }
  }
  waiting.sort(
    (a, b) => Number(b.key !== null) - Number(a.key !== null) || byStatusUpdatedAt(a.row, b.row)
  );
  const scheduled = sessions
    .filter(isScheduledSessionRow)
    .sort(compareSessionInstant(row => row.scheduledAt, 'earliest'));
  const primaryKind = primaryKindOf(countGlanceableSessions(sessions));
  const primary =
    primaryKind === 'needsInput'
      ? waiting[0]?.row
      : primaryKind === 'scheduled'
        ? scheduled[0]
        : sessions
            .filter(row => glanceableStatusKind(row.status) === primaryKind)
            .sort(compareSessionInstant(row => row.statusUpdatedAt, 'latest'))[0];
  // The list still ranks any row carrying a valid key first, but the key handed
  // to Approve comes only from a permission row: a question or retry row's key
  // is ignored, so that entry may not be waiting[0].
  const approvalRow = waiting.find(
    entry => entry.key !== null && isApprovableGlanceableStatus(entry.row.status)
  );
  return {
    approvalKey: approvalRow?.key ?? null,
    primaryKind: primaryKind ?? null,
    primaryTitle: primary === undefined ? null : glanceableTitle(primary.title),
    waitingAgents: waiting
      .slice(0, HOME_WIDGET_DETAIL_LIMIT)
      .map(entry => ({ title: glanceableTitle(entry.row.title), kind: entry.kind })),
    scheduledAgents: scheduled.slice(0, HOME_WIDGET_DETAIL_LIMIT).map(row => ({
      title: glanceableTitle(row.title),
      scheduledAt: timestampToIso(row.scheduledAt),
    })),
  };
}

export function buildHomeWidgetData(
  input: Omit<BuildGlanceableSnapshotInput, 'sessions'> & {
    sessions: readonly HomeWidgetSessionRow[];
  }
): HomeWidgetData {
  const snapshot = buildGlanceableSnapshot(input);
  const terminal = terminalStatusOf(snapshot.status);
  return {
    snapshot,
    details: terminal === null ? buildHomeWidgetDetails(input.sessions) : emptyHomeWidgetDetails(),
  };
}

/**
 * Decide the linked presentation facts once: terminal, primaryKind, checkedAt,
 * staleAt, and the cadence they age by. The presentation's `stale` flag and the
 * timeline boundary both read `staleAt`, so native aging cannot disagree with
 * the flag.
 */
function staleness(data: HomeWidgetData): {
  /**
   * The narrowed terminal status, or null when the snapshot is not terminal.
   * One value, so no caller keeps a boolean beside a status a later branch can
   * contradict.
   */
  terminal: GlanceableTerminalStatus | null;
  primaryKind: GlanceableStatusKind | null;
  checkedAt: string | null;
  staleAt: number | null;
  /** The cadence the snapshot ages by, so a caller needs no second `refreshInterval` read. */
  refreshMs: number;
} {
  const { snapshot } = data;
  const terminal = terminalStatusOf(snapshot.status);
  const primaryKind = terminal === null ? primaryKindOf(snapshot) : null;
  const checkedAt =
    terminal !== null || (primaryKind === null && snapshot.status !== 'empty')
      ? null
      : snapshot.updatedAt;
  const confirmedAt = timestampMs(checkedAt);
  const refreshMs = refreshInterval(snapshot, terminal);
  return {
    terminal,
    primaryKind,
    checkedAt,
    staleAt: confirmedAt === null ? null : confirmedAt + refreshMs,
    refreshMs,
  };
}

/**
 * The one wake rule: a snapshot has a wake time only when it is not terminal
 * and counts a scheduled session. The ms form, the ISO form and the derived
 * retry come from one guard, so presentation, refresh cadence and the timeline
 * cannot disagree about whether a wake exists or which instants it names.
 *
 * The union carries the invariant: `WAKE_RETRY_MS` is a positive floor, so a
 * retry exists exactly when its wake does and is always strictly later. No
 * caller compares the two instants, because no state exists where they meet.
 */
type ScheduledWake =
  | { at: null; iso: null; retryAt: null }
  | { at: number; iso: string; retryAt: number };

function scheduledWake(
  snapshot: GlanceableAgentsSnapshot,
  terminal: GlanceableTerminalStatus | null
): ScheduledWake {
  if (terminal !== null || snapshot.scheduled <= 0) return { at: null, iso: null, retryAt: null };
  const at = timestampMs(snapshot.scheduledAt);
  if (at === null) return { at: null, iso: null, retryAt: null };
  // `at` parsed, so the ISO form of the same value parses too.
  return { at, iso: epochMsToIso(at), retryAt: at + WAKE_RETRY_MS };
}

/**
 * The one status precedence: a terminal snapshot outranks content, content
 * outranks a request for input, and an acknowledged snapshot that is neither is
 * either empty or unavailable. A terminal status is returned as it is, so a
 * terminal member the presentation status enum lacks fails to compile here
 * instead of being reported as another terminal state.
 */
function presentationStatus(
  terminal: GlanceableTerminalStatus | null,
  snapshot: GlanceableAgentsSnapshot,
  primaryKind: GlanceableStatusKind | null
): HomeWidgetPresentation['status'] {
  if (terminal !== null) return terminal;
  if (primaryKind !== null) return 'content';
  if (snapshot.status === 'waiting') return 'waiting';
  if (snapshot.status === 'empty') return 'empty';
  return 'unavailable';
}

/** Pure policy: counts survive activity expiry; only explicit privacy/auth clears hide them. */
export function buildHomeWidgetPresentation(
  data: HomeWidgetData,
  now: number
): HomeWidgetPresentation {
  const { snapshot, details } = data;
  const { terminal, primaryKind, checkedAt, staleAt } = staleness(data);
  const wake = scheduledWake(snapshot, terminal);
  const status = presentationStatus(terminal, snapshot, primaryKind);
  // One approval availability: the same value decides the key the native action
  // submits and whether Approve is offered, so the card cannot advertise Approve
  // without a request key. This is visibility, not approval authority. Every
  // action revalidates the exact current request.
  const approvalAvailable =
    terminal === null && snapshot.needsApproval > 0 && details.approvalKey !== null;
  return {
    status,
    primaryKind,
    primaryCount: primaryKind === null ? 0 : snapshot[primaryKind],
    secondaryCounts:
      terminal !== null
        ? []
        : KIND_ORDER.filter(kind => kind !== primaryKind && snapshot[kind] > 0).map(kind => ({
            kind,
            count: snapshot[kind],
          })),
    checkedAt,
    stale:
      terminal === null &&
      (snapshot.status === 'stale' ||
        snapshot.status === 'expired' ||
        (staleAt !== null && now >= staleAt)),
    scheduledAt: wake.iso,
    approvalKey: approvalAvailable ? details.approvalKey : null,
    // The card never advertises an update past the retry deadline.
    awaitingUpdate: wake.at !== null && now >= wake.at && now < wake.retryAt,
    primaryTitle:
      terminal !== null ||
      primaryKind === null ||
      (details.primaryKind !== null && details.primaryKind !== primaryKind)
        ? null
        : details.primaryTitle,
    waitingAgents: terminal !== null || snapshot.needsInput === 0 ? [] : details.waitingAgents,
    scheduledAgents: terminal !== null || snapshot.scheduled === 0 ? [] : details.scheduledAgents,
    canCreate: status === 'content' || status === 'empty' || status === 'unavailable',
    canApprove: approvalAvailable,
  };
}

/**
 * Requested refresh only; native minimum intervals and OS budgets still apply.
 * A wake that just passed retries once shortly after its wake, then backs off.
 */
export function homeWidgetRefreshAt(data: HomeWidgetData, now: number): number {
  const { snapshot } = data;
  const { terminal, refreshMs } = staleness(data);
  const next = now + refreshMs;
  const wake = scheduledWake(snapshot, terminal);
  // Both instants come from the snapshot, so a passed wake cannot create a busy refresh loop.
  const requested =
    wake.at !== null && wake.at > now
      ? wake.at
      : wake.retryAt !== null && wake.retryAt > now
        ? wake.retryAt
        : null;
  return requested !== null ? Math.min(next, requested) : next;
}

/**
 * Native offline aging uses these server/shared-derived boundaries, not a second policy.
 *
 * One `scheduledWake` reads both instants. Its retry is strictly later than its
 * wake, so the two are never equal and neither needs to be compared with the
 * other. `staleAt` is a separate interval, though, so it can coincide with
 * either instant and both keep their own comparison against it.
 */
export function buildHomeWidgetPresentationTimeline(
  data: HomeWidgetData,
  now: number
): HomeWidgetTimelineEntry[] {
  const times = [now];
  const { snapshot } = data;
  const { terminal, staleAt } = staleness(data);
  if (terminal === null) {
    if (staleAt !== null && staleAt > now) times.push(staleAt);
    const wake = scheduledWake(snapshot, terminal);
    if (wake.at !== null && wake.at > now && wake.at !== staleAt) times.push(wake.at);
    if (wake.retryAt !== null && wake.retryAt > now && wake.retryAt !== staleAt) {
      times.push(wake.retryAt);
    }
  }
  return times
    .sort((a, b) => a - b)
    .map(at => ({
      at,
      home: buildHomeWidgetPresentation(data, at),
    }));
}
