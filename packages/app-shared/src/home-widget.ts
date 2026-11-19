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
  isStartableGlanceableWork,
  isTerminalGlanceableStatus,
  type BuildGlanceableSnapshotInput,
  type GlanceableNeedsInputKind,
  type GlanceableSessionRow,
  type GlanceableStatusKind,
  compareSessionInstant,
} from './glanceable-agents-snapshot';
import { timestampMs, timestampToIso } from './utils';

export const HOME_WIDGET_DETAIL_LIMIT = 3;
const titleSchema = z.string().max(GLANCEABLE_TITLE_LIMIT);
const kindSchema = z.enum(GLANCEABLE_STATUS_KINDS);

/** Private Home-only data. Never include this in Live Activity content-state. */
export const homeWidgetDetailsSchema = z.object({
  approvalKey: approvalKeySchema.default(null),
  /**
   * The kind whose row produced `primaryTitle`, so the title always describes
   * the kind drawn beside it. Optional on input: a payload stored or pushed
   * before this field existed omits it, which reads as an unknown kind and
   * keeps the title, so an older payload renders as it did.
   */
  primaryKind: kindSchema.nullable().optional(),
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
    .max(3),
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
  /** Optional for persisted older responses; current server producers always supply it. */
  presentationTimeline: z.array(homeWidgetTimelineEntrySchema).max(3).optional(),
});
export type HomeWidgetResponse = z.infer<typeof homeWidgetResponseSchema>;
export type HomeWidgetSessionRow = GlanceableSessionRow & {
  title?: string | null;
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

function refreshInterval(snapshot: GlanceableAgentsSnapshot): number {
  return snapshot.status === 'waiting' ||
    snapshot.status === 'stale' ||
    snapshot.status === 'expired' ||
    isStartableGlanceableWork(snapshot)
    ? ACTIVE_REFRESH_MS
    : QUIET_REFRESH_MS;
}

/**
 * The one display-title cut every glanceable surface draws: the text as one
 * line of what it draws, trimmed, then capped at `GLANCEABLE_TITLE_LIMIT` on a
 * character boundary. A surface adds only its own empty or placeholder rule on
 * top, so the cap cannot drift between the Home widget and the session card.
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
  const waiting: { row: HomeWidgetSessionRow; kind: GlanceableNeedsInputKind }[] = [];
  for (const row of sessions) {
    const kind = glanceableNeedsInputKind(row.status);
    if (kind !== null) waiting.push({ row, kind });
  }
  waiting.sort(
    (a, b) =>
      Number(b.row.approvalKey != null) - Number(a.row.approvalKey != null) ||
      byStatusUpdatedAt(a.row, b.row)
  );
  const scheduled = sessions
    .filter(row => glanceableStatusKind(row.status) === 'scheduled')
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
  return {
    // The sort put the approvable row first, so the key belongs to the same
    // row the needs-input primary title reads.
    approvalKey: waiting[0]?.row.approvalKey ?? null,
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
  return {
    snapshot,
    details: isTerminalGlanceableStatus(snapshot.status)
      ? emptyHomeWidgetDetails()
      : buildHomeWidgetDetails(input.sessions),
  };
}

/**
 * Decide four linked presentation facts once: terminal, primaryKind,
 * checkedAt, and staleAt. The presentation's `stale` flag and the timeline
 * boundary both read `staleAt`, so native aging cannot disagree with the flag.
 */
function staleness(data: HomeWidgetData): {
  terminal: boolean;
  primaryKind: GlanceableStatusKind | null;
  checkedAt: string | null;
  staleAt: number | null;
} {
  const { snapshot } = data;
  const terminal = isTerminalGlanceableStatus(snapshot.status);
  const primaryKind = terminal ? null : primaryKindOf(snapshot);
  const checkedAt =
    terminal || (primaryKind === null && snapshot.status !== 'empty') ? null : snapshot.updatedAt;
  const confirmedAt = timestampMs(checkedAt);
  return {
    terminal,
    primaryKind,
    checkedAt,
    staleAt: confirmedAt === null ? null : confirmedAt + refreshInterval(snapshot),
  };
}

/**
 * The one wake rule: a snapshot has a wake time only when it is not terminal
 * and counts a scheduled session. The ms form and the ISO form come from one
 * guard, so presentation, refresh cadence and the timeline cannot disagree
 * about whether a wake exists or which instant it names.
 */
function scheduledWake(
  snapshot: GlanceableAgentsSnapshot,
  terminal: boolean
): { at: number | null; iso: string | null } {
  if (terminal || snapshot.scheduled <= 0) return { at: null, iso: null };
  return { at: timestampMs(snapshot.scheduledAt), iso: timestampToIso(snapshot.scheduledAt) };
}

/**
 * The one status precedence: a terminal snapshot outranks content, content
 * outranks a request for input, and an acknowledged snapshot that is neither is
 * either empty or unavailable.
 */
function presentationStatus(
  snapshot: GlanceableAgentsSnapshot,
  terminal: boolean,
  primaryKind: GlanceableStatusKind | null
): HomeWidgetPresentation['status'] {
  if (terminal) return snapshot.status === 'privacy' ? 'privacy' : 'signed_out';
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
  // A title is drawn only beside the kind it describes. A payload stored or
  // pushed before details carried the kind omits it, which reads as unknown and
  // keeps the title, so that payload renders as it did.
  const titleKind = details.primaryKind ?? null;
  const wake = scheduledWake(snapshot, terminal);
  const status = presentationStatus(snapshot, terminal, primaryKind);
  return {
    status,
    primaryKind,
    primaryCount: primaryKind === null ? 0 : snapshot[primaryKind],
    secondaryCounts: terminal
      ? []
      : KIND_ORDER.filter(kind => kind !== primaryKind && snapshot[kind] > 0).map(kind => ({
          kind,
          count: snapshot[kind],
        })),
    checkedAt,
    stale:
      !terminal &&
      (snapshot.status === 'stale' ||
        snapshot.status === 'expired' ||
        (staleAt !== null && now >= staleAt)),
    scheduledAt: wake.iso,
    approvalKey: terminal || snapshot.needsInput === 0 ? null : details.approvalKey,
    awaitingUpdate: wake.at !== null && now >= wake.at,
    primaryTitle:
      terminal || primaryKind === null || (titleKind !== null && titleKind !== primaryKind)
        ? null
        : details.primaryTitle,
    waitingAgents: terminal || snapshot.needsInput === 0 ? [] : details.waitingAgents,
    scheduledAgents: terminal || snapshot.scheduled === 0 ? [] : details.scheduledAgents,
    canCreate: status === 'content' || status === 'empty' || status === 'unavailable',
    // This is visibility, not approval authority. Every action revalidates the exact current request.
    canApprove: !terminal && snapshot.needsApproval > 0 && details.approvalKey !== null,
  };
}

/** Requested refresh only; native minimum intervals and OS budgets still apply. */
export function homeWidgetRefreshAt(data: HomeWidgetData, now: number): number {
  const { snapshot } = data;
  const terminal = isTerminalGlanceableStatus(snapshot.status);
  const next = now + (terminal ? QUIET_REFRESH_MS : refreshInterval(snapshot));
  const wake = scheduledWake(snapshot, terminal).at;
  // An overdue wake is not proof of running and must not create a busy refresh loop.
  return wake !== null && wake > now ? Math.min(next, wake) : next;
}

/** Native offline aging uses these server/shared-derived boundaries, not a second policy. */
export function buildHomeWidgetPresentationTimeline(
  data: HomeWidgetData,
  now: number
): HomeWidgetTimelineEntry[] {
  const times = [now];
  const { snapshot } = data;
  const { terminal, staleAt } = staleness(data);
  if (!terminal) {
    if (staleAt !== null && staleAt > now) times.push(staleAt);
    const wake = scheduledWake(snapshot, terminal).at;
    if (wake !== null && wake > now && wake !== staleAt) times.push(wake);
  }
  return times
    .sort((a, b) => a - b)
    .map(at => ({
      at,
      home: buildHomeWidgetPresentation(data, at),
    }));
}
