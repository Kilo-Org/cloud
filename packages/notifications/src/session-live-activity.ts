import {
  glanceableStatusKind,
  type GlanceableStatusKind,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import { HOME_WIDGET_TITLE_LIMIT } from '@kilocode/app-shared/home-widget';
import { isDefaultSessionTitle } from '@kilocode/session-ingest-contracts';

import { LIVE_ACTIVITY_RELEVANCE, type SessionLiveActivityContentState } from './push-data';

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
};

function isoOrNull(value: string | null | undefined): string | null {
  const at = value == null ? Number.NaN : Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
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
 */
export function buildSessionLiveActivityContentState(
  row: SessionLiveActivityRow,
  options: { approvalKey: string | null; updatedAt: string; statusSinceFallback: string }
): SessionLiveActivityContentState {
  const statusKind = glanceableStatusKind(row.status);
  const approvalKey = row.status === 'permission' ? options.approvalKey : null;
  return {
    sessionId: row.id,
    title: sessionLiveActivityTitle(row.title),
    statusKind,
    statusSince: isoOrNull(row.statusUpdatedAt) ?? options.statusSinceFallback,
    scheduledAt: statusKind === 'scheduled' ? isoOrNull(row.scheduledAt) : null,
    awaitingPermission: approvalKey !== null,
    approvalKey,
    updatedAt: options.updatedAt,
  };
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
 * a later change gives a higher term. The term grows with the time since a
 * fixed origin and approaches 19 without reaching it, so it never leaves the
 * band. iOS reads `relevance-score` as a Double, so the term keeps a usable
 * resolution for many years. An unusable time gives 0.
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
  statusKind: GlanceableStatusKind,
  statusSince: string | null
): number {
  const band =
    statusKind === 'needsInput'
      ? LIVE_ACTIVITY_RELEVANCE.sessionNeedsInput
      : statusKind === 'idle'
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
