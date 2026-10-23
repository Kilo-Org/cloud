/**
 * The facts comparison and the stale window of one followed session's card,
 * split out of `session-follow.ts` so each module stays inside the line
 * budget. Both are pure: they read a content state and a tray row only.
 */

import { parseTimestamp } from '@kilocode/app-shared/utils';
import {
  SESSION_CARD_QUIET_AFTER_MS,
  type SessionLiveActivityContentState,
  type SessionLiveActivityRow,
} from '@kilocode/notifications';

import { SESSION_CARD_STALE_AFTER_SECONDS } from './session-card-press';
import { type SessionLiveActivityProps } from './session-live-activity';

/** The facts the card draws; a change in anything else is not an update (spec "Updates" rule 2). */
export function drawsSame(
  a: SessionLiveActivityProps | null,
  b: SessionLiveActivityProps
): boolean {
  return (
    a !== null &&
    a.title === b.title &&
    a.statusKind === b.statusKind &&
    a.statusSince === b.statusSince &&
    a.scheduledAt === b.scheduledAt &&
    a.awaitingPermission === b.awaitingPermission &&
    a.approvalKey === b.approvalKey &&
    // The richer facts and the times move on a push; a local rebuild that
    // changed one of them is still a change the card must show.
    JSON.stringify(a.currentStep ?? null) === JSON.stringify(b.currentStep ?? null) &&
    JSON.stringify(a.plan ?? null) === JSON.stringify(b.plan ?? null) &&
    JSON.stringify(a.changes ?? null) === JSON.stringify(b.changes ?? null) &&
    JSON.stringify(a.outcome ?? null) === JSON.stringify(b.outcome ?? null) &&
    JSON.stringify(a.failure ?? null) === JSON.stringify(b.failure ?? null) &&
    a.permissionCommand === b.permissionCommand &&
    a.lastActivityAt === b.lastActivityAt &&
    a.costMicrodollars === b.costMicrodollars &&
    a.startedAt === b.startedAt
  );
}

/**
 * The number of seconds until the card can no longer claim to be current.
 * ActivityKit takes a duration, so a working card ends its window five minutes
 * after the last activity the server reported; that is what lets a card whose
 * agent stopped reporting activity reach the quiet warning with no push for
 * the clock alone. Every other card keeps the shared stale window.
 */
export function sessionCardStaleAfterSeconds(
  content: SessionLiveActivityContentState | SessionLiveActivityProps,
  nowMs: number = Date.now()
): number {
  if (content.statusKind !== 'running') {
    return SESSION_CARD_STALE_AFTER_SECONDS;
  }
  const at = content.lastActivityAt == null ? Number.NaN : Date.parse(content.lastActivityAt);
  if (!Number.isFinite(at)) {
    return SESSION_CARD_STALE_AFTER_SECONDS;
  }
  const quietRemaining = Math.max(0, Math.floor((at + SESSION_CARD_QUIET_AFTER_MS - nowMs) / 1000));
  return Math.min(SESSION_CARD_STALE_AFTER_SECONDS, quietRemaining);
}

/**
 * True when the row describes a state older than the one the card shows. A
 * server push can land before the tray catches up, and the stale row must not
 * undo it (or drop the approval key it carried).
 */
export function isOlderThanCard(
  row: SessionLiveActivityRow,
  card: SessionLiveActivityProps | null
): boolean {
  const rowAt =
    row.statusUpdatedAt == null ? Number.NaN : parseTimestamp(row.statusUpdatedAt).getTime();
  const cardAt =
    card?.statusSince == null ? Number.NaN : parseTimestamp(card.statusSince).getTime();
  return Number.isFinite(rowAt) && Number.isFinite(cardAt) && rowAt < cardAt;
}
