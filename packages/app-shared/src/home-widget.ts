import { z } from 'zod';
import {
  buildGlanceableSnapshot,
  type GlanceableAgentsSnapshot,
  glanceableAgentsSnapshotSchema,
  glanceableNeedsInputKind,
  GLANCEABLE_NEEDS_INPUT_STATUSES,
  GLANCEABLE_STATUS_KINDS,
  glanceableStatusKind,
  isStartableGlanceableWork,
  isTerminalGlanceableStatus,
  type BuildGlanceableSnapshotInput,
  type GlanceableSessionRow,
  type GlanceableStatusKind,
} from './glanceable-agents-snapshot';
import { parseTimestamp } from './utils';

export const HOME_WIDGET_DETAIL_LIMIT = 3;
export const HOME_WIDGET_TITLE_LIMIT = 120;
const titleSchema = z.string().max(HOME_WIDGET_TITLE_LIMIT);
const kindSchema = z.enum(GLANCEABLE_STATUS_KINDS);

/** Private Home-only data. Never include this in Live Activity content-state. */
export const homeWidgetDetailsSchema = z.object({
  /** SHA-256 hex of the exact visible approval target; grants no authority. */
  approvalKey: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable()
    .default(null),
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
export const EMPTY_HOME_WIDGET_DETAILS: HomeWidgetDetails = {
  approvalKey: null,
  primaryTitle: null,
  waitingAgents: [],
  scheduledAgents: [],
};

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
  approvalKey: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
});
export type HomeWidgetPresentation = z.infer<typeof homeWidgetPresentationSchema>;
export type HomeWidgetTimelineEntry = { at: number; home: HomeWidgetPresentation };
export const homeWidgetResponseSchema = homeWidgetDataSchema.extend({
  home: homeWidgetPresentationSchema,
  refreshAt: z.number().finite(),
  /** Optional for persisted older responses; current server producers always supply it. */
  presentationTimeline: z
    .array(
      z.object({
        at: z.number().finite(),
        home: homeWidgetPresentationSchema,
      })
    )
    .max(3)
    .optional(),
});
export type HomeWidgetResponse = z.infer<typeof homeWidgetResponseSchema>;
export type HomeWidgetSessionRow = GlanceableSessionRow & {
  title?: string | null;
  approvalKey?: string | null;
};

const PRIORITY: readonly GlanceableStatusKind[] = ['needsInput', 'running', 'scheduled', 'idle'];
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

function usableTime(value: string | undefined | null): number | null {
  if (value == null) {
    return null;
  }
  const at = parseTimestamp(value).getTime();
  return Number.isFinite(at) ? at : null;
}

/**
 * Code points that occupy no display width: directional marks and embeddings, the invisible
 * operators, and the zero-width space. ZWNJ and ZWJ stay, because they join the glyphs of
 * Persian and Indic words and of emoji sequences.
 */
const NON_PRINTING_TITLE_CHARACTERS =
  /[\u061c\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/** ISO 8601 form of a row time, or null when it does not parse. */
function isoTime(value: string | undefined | null): string | null {
  const at = usableTime(value);
  return at === null ? null : new Date(at).toISOString();
}

function safeTitle(value: string | undefined | null): string {
  const title = (value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(NON_PRINTING_TITLE_CHARACTERS, '')
    .trim();
  const bounded = title.slice(0, HOME_WIDGET_TITLE_LIMIT);
  // Do not end a truncated title in the middle of a UTF-16 surrogate pair.
  const last = bounded.charCodeAt(bounded.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? bounded.slice(0, -1) : bounded;
}

/** Same authorized rows as counts, with stable ties and unknown times ranked last. */
export function buildHomeWidgetDetails(
  sessions: readonly HomeWidgetSessionRow[]
): HomeWidgetDetails {
  const waiting = sessions
    .filter(row => glanceableStatusKind(row.status) === 'needsInput')
    .sort(
      (a, b) =>
        Number(b.approvalKey != null) - Number(a.approvalKey != null) ||
        (usableTime(a.statusUpdatedAt) ?? Infinity) - (usableTime(b.statusUpdatedAt) ?? Infinity)
    );
  const scheduled = sessions
    .filter(row => row.status === 'scheduled')
    .sort(
      (a, b) => (usableTime(a.scheduledAt) ?? Infinity) - (usableTime(b.scheduledAt) ?? Infinity)
    );
  const primaryKind = PRIORITY.find(kind =>
    sessions.some(row => glanceableStatusKind(row.status) === kind)
  );
  const primary =
    primaryKind === 'needsInput'
      ? waiting[0]
      : primaryKind === 'scheduled'
        ? scheduled[0]
        : sessions
            .filter(row => glanceableStatusKind(row.status) === primaryKind)
            .sort(
              (a, b) =>
                (usableTime(b.statusUpdatedAt) ?? -Infinity) -
                (usableTime(a.statusUpdatedAt) ?? -Infinity)
            )[0];
  return {
    approvalKey: waiting.find(row => row.approvalKey != null)?.approvalKey ?? null,
    primaryTitle: primary === undefined ? null : safeTitle(primary.title),
    waitingAgents: waiting.slice(0, HOME_WIDGET_DETAIL_LIMIT).flatMap(row => {
      // The status fold above admits only needs-input statuses; a status that
      // is not one of them has no kind here and the row is dropped rather
      // than mislabelled.
      const kind = glanceableNeedsInputKind(row.status);
      return kind === null ? [] : [{ title: safeTitle(row.title), kind }];
    }),
    scheduledAgents: scheduled.slice(0, HOME_WIDGET_DETAIL_LIMIT).map(row => ({
      title: safeTitle(row.title),
      scheduledAt: isoTime(row.scheduledAt),
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
      ? { ...EMPTY_HOME_WIDGET_DETAILS }
      : buildHomeWidgetDetails(input.sessions),
  };
}

/** Pure policy: counts survive activity expiry; only explicit privacy/auth clears hide them. */
export function buildHomeWidgetPresentation(
  data: HomeWidgetData,
  now: number
): HomeWidgetPresentation {
  const { snapshot, details } = data;
  const terminal = isTerminalGlanceableStatus(snapshot.status);
  const primaryKind = terminal ? null : (PRIORITY.find(kind => snapshot[kind] > 0) ?? null);
  const checkedAt =
    terminal || (primaryKind === null && snapshot.status !== 'empty') ? null : snapshot.updatedAt;
  const confirmedAt = usableTime(checkedAt);
  const wake = snapshot.scheduled > 0 ? usableTime(snapshot.scheduledAt) : null;
  const scheduledAt = wake === null ? null : new Date(wake).toISOString();
  return {
    status: terminal
      ? snapshot.status === 'privacy'
        ? 'privacy'
        : 'signed_out'
      : primaryKind !== null
        ? 'content'
        : snapshot.status === 'waiting'
          ? 'waiting'
          : snapshot.status === 'empty'
            ? 'empty'
            : 'unavailable',
    primaryKind,
    primaryCount: primaryKind === null ? 0 : snapshot[primaryKind],
    secondaryCounts: terminal
      ? []
      : PRIORITY.filter(kind => kind !== primaryKind && snapshot[kind] > 0).map(kind => ({
          kind,
          count: snapshot[kind],
        })),
    checkedAt,
    stale:
      !terminal &&
      (snapshot.status === 'stale' ||
        snapshot.status === 'expired' ||
        (confirmedAt !== null && now >= confirmedAt + refreshInterval(snapshot))),
    scheduledAt: terminal ? null : scheduledAt,
    approvalKey: terminal || snapshot.needsInput === 0 ? null : details.approvalKey,
    awaitingUpdate: !terminal && wake !== null && now >= wake,
    primaryTitle: terminal || primaryKind === null ? null : details.primaryTitle,
    waitingAgents: terminal || snapshot.needsInput === 0 ? [] : details.waitingAgents,
    scheduledAgents: terminal || snapshot.scheduled === 0 ? [] : details.scheduledAgents,
    canCreate: !terminal && (primaryKind !== null || snapshot.status !== 'waiting'),
    // This is visibility, not approval authority. Every action revalidates the exact current request.
    canApprove: !terminal && snapshot.needsApproval > 0 && details.approvalKey !== null,
  };
}

/** Requested refresh only; native minimum intervals and OS budgets still apply. */
export function homeWidgetRefreshAt(data: HomeWidgetData, now: number): number {
  const { snapshot } = data;
  const terminal = isTerminalGlanceableStatus(snapshot.status);
  const next = now + (terminal ? QUIET_REFRESH_MS : refreshInterval(snapshot));
  const wake = terminal || snapshot.scheduled === 0 ? null : usableTime(snapshot.scheduledAt);
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
  if (!isTerminalGlanceableStatus(snapshot.status)) {
    const checked = usableTime(buildHomeWidgetPresentation(data, now).checkedAt);
    const staleAt = checked === null ? null : checked + refreshInterval(snapshot);
    if (staleAt !== null && staleAt > now) times.push(staleAt);
    const wake = snapshot.scheduled > 0 ? usableTime(snapshot.scheduledAt) : null;
    if (wake !== null && wake > now && wake !== staleAt) times.push(wake);
  }
  return times
    .sort((a, b) => a - b)
    .map(at => ({
      at,
      home: buildHomeWidgetPresentation(data, at),
    }));
}
