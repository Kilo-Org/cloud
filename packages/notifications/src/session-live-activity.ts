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

/** The session card relevance score (spec "Presentation order"). */
export function sessionLiveActivityRelevance(statusKind: GlanceableStatusKind): number {
  if (statusKind === 'needsInput') return LIVE_ACTIVITY_RELEVANCE.sessionNeedsInput;
  if (statusKind === 'idle') return LIVE_ACTIVITY_RELEVANCE.sessionIdle;
  return LIVE_ACTIVITY_RELEVANCE.sessionActive;
}
