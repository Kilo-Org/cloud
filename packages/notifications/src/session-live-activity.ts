import {
  glanceableStatusKind,
  type GlanceableStatusKind,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import { HOME_WIDGET_TITLE_LIMIT } from '@kilocode/app-shared/home-widget';
import { isDefaultSessionTitle } from '@kilocode/session-ingest-contracts';

import { LIVE_ACTIVITY_RELEVANCE, type SessionLiveActivityContentState } from './push-data';
import {
  SESSION_CARD_QUIET_AFTER_MS,
  type SessionLiveChanges,
  type SessionLiveFailureKind,
  type SessionLiveOutcomeKind,
  type SessionLivePlan,
  type SessionLiveStep,
} from './session-live-content';

/** The card's status kinds: the shared vocabulary plus a turn that failed. */
export type SessionCardStatusKind = GlanceableStatusKind | 'failed';

/**
 * The session card title (spec "Content" rule 2): the home widget row title
 * rules, but an untitled session or the backend `New session - <ISO>`
 * placeholder gives null, so the card draws `common.agent` instead.
 */
export function sessionLiveActivityTitle(raw: string | null | undefined): string | null {
  // eslint-disable-next-line no-control-regex
  const title = (raw ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (title === '' || isDefaultSessionTitle(title)) return null;
  const bounded = title.slice(0, HOME_WIDGET_TITLE_LIMIT);
  // Do not end a truncated title in the middle of a UTF-16 surrogate pair.
  const last = bounded.charCodeAt(bounded.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? bounded.slice(0, -1) : bounded;
}

/** The facts of one session row that the session card shows. */
export type SessionLiveActivityRow = {
  id: string;
  title?: string | null;
  status: string;
  statusUpdatedAt?: string | null;
  scheduledAt?: string | null;
  /** The stored summary the ingest service derived, when the row carries it. */
  currentStep?: SessionLiveStep | null;
  plan?: SessionLivePlan | null;
  changes?: SessionLiveChanges | null;
  permissionCommand?: string | null;
  lastActivityAt?: string | null;
  costMicrodollars?: number | null;
  outcome?: SessionLiveOutcomeKind | null;
  failure?: SessionLiveFailureKind | null;
  startedAt?: string | null;
  /** True when this session has an open pull request; set on a finished row. */
  prOpened?: boolean;
};

export type SessionLiveActivityBuildOptions = {
  approvalKey: string | null;
  updatedAt: string;
  statusSinceFallback: string;
  /** The content the card already shows, so server-only facts survive a local rebuild. */
  previous?: Partial<SessionLiveActivityContentState> | undefined;
};

function isoOrNull(value: string | null | undefined): string | null {
  const at = value == null ? Number.NaN : Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

/** The larger of the stored and the new cost, so a local update never lowers it. */
function maxCost(
  previous: number | null | undefined,
  next: number | null | undefined
): number | null {
  if (next === null || next === undefined) return previous ?? null;
  if (previous === null || previous === undefined) return next;
  return Math.max(previous, next);
}

/** How a finished session ended: the PR it opened, its diff, or nothing. */
function outcomeKind(
  row: SessionLiveActivityRow,
  changes: SessionLiveChanges | null
): SessionLiveOutcomeKind {
  if (row.outcome !== null && row.outcome !== undefined) return row.outcome;
  if (row.prOpened === true) return 'pr_opened';
  return changes === null ? 'none' : 'changes';
}

/**
 * Build the session card content-state from one session row. The app (local
 * start and foreground updates) and the notifications service (remote
 * updates) both use this, so the two producers cannot disagree.
 *
 * - `approvalKey` is kept only while the row waits on a permission, and
 *   `awaitingPermission` is true only when that key is present.
 * - `statusSinceFallback` is used when the row has no usable status time.
 * - `scheduledAt` is set only for the scheduled status kind.
 * - The richer facts keep the value the row carries, and fall back to the
 *   content the card already shows. A tray row carries no step, plan, diff or
 *   outcome, so a local update must not wipe the ones a push delivered.
 * - A finished row with a failure reads as the `failed` kind, which the layout
 *   draws as a stopped turn. A row that carries `failure: null` reports no
 *   failure and clears the remembered one; a row with no `failure` key at all
 *   cannot report it either way, so the remembered failure survives, which is
 *   what keeps a push-delivered `failed` card through a tray rebuild.
 */
export function buildSessionLiveActivityContentState(
  row: SessionLiveActivityRow,
  options: SessionLiveActivityBuildOptions
): SessionLiveActivityContentState {
  const previous = options.previous;
  const base = glanceableStatusKind(row.status);
  const failure = row.failure === undefined ? (previous?.failure?.kind ?? null) : row.failure;
  const statusKind: SessionCardStatusKind = base === 'idle' && failure !== null ? 'failed' : base;
  const approvalKey = row.status === 'permission' ? options.approvalKey : null;
  const changes = row.changes ?? previous?.changes ?? null;
  const finished = statusKind === 'idle' || statusKind === 'failed';
  return {
    sessionId: row.id,
    title: sessionLiveActivityTitle(row.title),
    statusKind,
    statusSince: isoOrNull(row.statusUpdatedAt) ?? options.statusSinceFallback,
    scheduledAt: statusKind === 'scheduled' ? isoOrNull(row.scheduledAt) : null,
    awaitingPermission: approvalKey !== null,
    approvalKey,
    updatedAt: options.updatedAt,
    currentStep: row.currentStep ?? previous?.currentStep ?? null,
    plan: row.plan ?? previous?.plan ?? null,
    permissionCommand:
      approvalKey === null ? null : (row.permissionCommand ?? previous?.permissionCommand ?? null),
    changes,
    lastActivityAt: isoOrNull(row.lastActivityAt) ?? previous?.lastActivityAt ?? null,
    costMicrodollars: maxCost(previous?.costMicrodollars, row.costMicrodollars),
    outcome: finished ? { kind: outcomeKind(row, changes) } : null,
    failure: failure === null || statusKind !== 'failed' ? null : { kind: failure },
    startedAt: isoOrNull(row.startedAt) ?? previous?.startedAt ?? null,
  };
}

/**
 * The moment a card can no longer claim to be current, in Unix seconds.
 *
 * A working card goes stale at the end of the quiet window after the last
 * activity the server saw, so a card whose agent stopped reporting activity
 * reaches its stale date and the layout can draw the quiet warning. Every
 * other card keeps the caller's own window (`defaultStaleAtSeconds`), which is
 * the same stale window the aggregate card uses.
 */
export function sessionCardStaleAtSeconds(
  content: Pick<SessionLiveActivityContentState, 'statusKind' | 'lastActivityAt'>,
  nowSeconds: number,
  defaultStaleAtSeconds: number
): number {
  if (content.statusKind !== 'running') return defaultStaleAtSeconds;
  const at = content.lastActivityAt == null ? Number.NaN : Date.parse(content.lastActivityAt);
  if (!Number.isFinite(at)) return defaultStaleAtSeconds;
  return Math.min(
    defaultStaleAtSeconds,
    Math.floor(at / 1000) + SESSION_CARD_QUIET_AFTER_MS / 1000
  );
}

/**
 * ActivityKit ends a Live Activity after at most 8 hours. A session card token
 * older than this can no longer reach a card, so the server ignores and drops
 * it, and its session counts as unfollowed again.
 */
export const SESSION_LIVE_ACTIVITY_MAX_AGE_MS = 8 * 60 * 60_000;

// The recency term counts from this fixed origin, so two scores computed at
// different times compare correctly.
const RECENCY_ORIGIN_MS = Date.parse('2026-01-01T00:00:00.000Z');
const RECENCY_HALF_MS = 365 * 24 * 60 * 60_000;

/**
 * A tie-break inside one relevance band (spec "Presentation order" rule 3):
 * a newer change first, and a bounded term so no tie-break can leave its band.
 */
function recencyTerm(changedAt: string | null): number {
  const at = changedAt === null ? Number.NaN : Date.parse(changedAt);
  if (!Number.isFinite(at)) return 0;
  const elapsed = Math.max(0, at - RECENCY_ORIGIN_MS);
  return Math.min(19, (19 * elapsed) / (elapsed + RECENCY_HALF_MS));
}

/**
 * The session card relevance score (spec "Presentation order"): the band of
 * the status kind, then a newer `statusSince` first.
 */
export function sessionLiveActivityRelevance(
  statusKind: SessionCardStatusKind,
  statusSince: string | null
): number {
  const band =
    statusKind === 'needsInput'
      ? LIVE_ACTIVITY_RELEVANCE.sessionNeedsInput
      : statusKind === 'idle' || statusKind === 'failed'
        ? LIVE_ACTIVITY_RELEVANCE.sessionIdle
        : LIVE_ACTIVITY_RELEVANCE.sessionActive;
  return band + recencyTerm(statusSince);
}

/**
 * The aggregate card relevance score: the needs-input band while unfollowed
 * work waits, then a newer `changedAt` (the newest agent state change) first.
 */
export function aggregateLiveActivityRelevance(
  needsInput: number,
  changedAt: string | null
): number {
  const band =
    needsInput > 0
      ? LIVE_ACTIVITY_RELEVANCE.aggregateNeedsInput
      : LIVE_ACTIVITY_RELEVANCE.aggregate;
  return band + recencyTerm(changedAt);
}
