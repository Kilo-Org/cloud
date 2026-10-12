import {
  buildSessionLiveActivityContentState,
  type SessionLiveActivityContentState,
  type SessionLiveActivityRow,
} from '@kilocode/notifications';

import { runGlanceableApprove } from '@/lib/glanceable/approve-ask';
import { setFollowedSessionsSource } from '@/lib/glanceable/followed-sessions';
import {
  getLiveActivityEnabled,
  getNotificationPermissionGranted,
} from '@/lib/glanceable/live-activity-switch';
import {
  registerAndroidSessionToken,
  releaseAndroidSessionToken,
  setAndroidSessionScope,
} from '@/lib/glanceable/session-activity-tokens-android';
import * as SecureStore from '@/lib/auth/secure-store';
import { ACTIVE_USER_ID_KEY, ORGANIZATION_STORAGE_KEY } from '@/lib/storage-keys';
import {
  buildSessionNotificationCard,
  SESSION_FINISHED_DISMISS_MS,
} from './session-notification-card';
import {
  dismissSessionCard,
  getStoredSessionCards,
  postSessionCard,
  pruneSessionCards,
} from './session-notification';

/**
 * The per-session ongoing notification on Android
 * (`.specs/mobile-session-live-activity.md` "Android"): one silent ongoing
 * notification per followed session, keyed by a stable id derived from the
 * session id. Follow starts it from the session screen; a data-only push updates
 * or ends it while the app is backgrounded, and a foreground tray read updates
 * it in place. Native storage is the source of truth: a notification outlives
 * the process that posted it, so a launch rebuilds the followed set from
 * `getStoredSessionCards` and cancels the cards the app no longer counts.
 * `session-notification-card.ts` owns the card's copy and times.
 */

export type SessionFollowContext = { userId: string; organizationId: string | null };
export type SessionLiveUpdateContent = SessionLiveActivityContentState;
export type FollowResult = 'started' | 'followed' | 'refused';

/** Post or update one followed session's notification from its content. */
function render(content: SessionLiveActivityContentState, ctx: SessionFollowContext): void {
  const stored = followed.get(content.sessionId);
  if (stored !== undefined && content.updatedAt < stored.content.updatedAt) {
    // An out-of-order push must not undo newer content.
    return;
  }
  followed.set(content.sessionId, { content, approvalKey: content.approvalKey, ctx });
  postSessionCard(buildSessionNotificationCard(content, ctx), 0);
  emit();
}

/** Re-post the stored card of one followed session (after an Approve). */
function repost(sessionId: string): void {
  const stored = followed.get(sessionId);
  if (stored === undefined) {
    return;
  }
  postSessionCard(buildSessionNotificationCard(stored.content, stored.ctx), 0);
}

/** Rebuild the followed set from native truth; re-register every kept card. */
export function restoreFollowedSessionCards(ctx: SessionFollowContext | null): void {
  const stored = getStoredSessionCards();
  const kept = new Set<string>();
  for (const card of stored) {
    if (ctx === null || card.organizationId !== ctx.organizationId) {
      dismissSessionCard(card.sessionId);
    } else {
      kept.add(card.sessionId);
    }
  }
  pruneSessionCards([...kept]);
  let dropped = false;
  for (const sessionId of followed.keys()) {
    if (!kept.has(sessionId)) {
      followed.delete(sessionId);
      dropped = true;
    }
  }
  if (dropped) {
    emit();
  }
  if (ctx === null) {
    return;
  }
  setAndroidSessionScope(ctx);
  for (const sessionId of kept) {
    registerAndroidSessionToken({ sessionId, ...ctx });
  }
}

/** Follow one session from the row the session screen shows. */
export function followSession(
  row: SessionLiveActivityRow,
  ctx: SessionFollowContext,
  now: number = Date.now()
): FollowResult {
  if (followed.has(row.id)) {
    return 'followed';
  }
  const at = new Date(now).toISOString();
  const content = buildSessionLiveActivityContentState(row, {
    // The row carries no approval key; the server's first push adds it.
    approvalKey: null,
    updatedAt: at,
    statusSinceFallback: at,
  });
  if (
    !isLiveKind(content.statusKind) ||
    !getLiveActivityEnabled() ||
    !getNotificationPermissionGranted()
  ) {
    return 'refused';
  }
  setAndroidSessionScope(ctx);
  render(content, ctx);
  registerAndroidSessionToken({ sessionId: row.id, ...ctx });
  return 'started';
}

/** Unfollow: cancel the notification at once and release its token. */
export function unfollowSession(sessionId: string): void {
  if (!followed.delete(sessionId)) {
    return;
  }
  dismissSessionCard(sessionId);
  releaseAndroidSessionToken(sessionId);
  emit();
}

/** Opening a session dismisses its finished notification at once (spec "Ending" 1). */
export function dismissFinishedSessionCard(sessionId: string): void {
  const stored = followed.get(sessionId);
  if (stored !== undefined && isLiveKind(stored.content.statusKind)) {
    return;
  }
  if (followed.delete(sessionId)) {
    emit();
  }
  dismissSessionCard(sessionId);
}

/** End every followed notification at once: sign-out, an account or organization change, or the switch off. */
export function endAllSessionCards(): void {
  for (const sessionId of followed.keys()) {
    dismissSessionCard(sessionId);
  }
  pruneSessionCards([]);
  if (followed.size > 0) {
    followed.clear();
    emit();
  }
}

/** Update the followed notifications from the foreground tray. */
export function syncFollowedSessionCards(
  rows: readonly SessionLiveActivityRow[],
  checkedAt: number = Date.now()
): void {
  if (followed.size === 0) {
    return;
  }
  const updatedAt = new Date(checkedAt).toISOString();
  for (const [sessionId, stored] of followed) {
    const row = rows.find(candidate => candidate.id === sessionId);
    if (row !== undefined) {
      const content = buildSessionLiveActivityContentState(row, {
        approvalKey: stored.approvalKey,
        updatedAt,
        statusSinceFallback: stored.content.statusSince,
      });
      if (isLiveKind(content.statusKind)) {
        render(content, stored.ctx);
      } else {
        followed.delete(sessionId);
        emit();
        postSessionCard(
          buildSessionNotificationCard(content, stored.ctx),
          SESSION_FINISHED_DISMISS_MS
        );
      }
    }
  }
}

/**
 * Apply one server push. A session the app does not follow renders nothing, and
 * the caller drops that server row.
 */
export function applySessionLiveUpdate(
  event: 'update' | 'end',
  content: SessionLiveActivityContentState,
  dismissAfterMs?: number
): boolean {
  const stored = followed.get(content.sessionId);
  if (stored === undefined) {
    return false;
  }
  if (event === 'end') {
    followed.delete(content.sessionId);
    emit();
    postSessionCard(
      buildSessionNotificationCard(content, stored.ctx),
      dismissAfterMs ?? SESSION_FINISHED_DISMISS_MS
    );
    return true;
  }
  render(content, stored.ctx);
  return true;
}

/** Answer the exact request a followed card shows, revalidating it as iOS does. */
export async function approveFollowedSession(
  sessionId: string,
  approvalKey: string
): Promise<boolean> {
  // The stored card carries the scope it was followed in, which is the scope
  // the permission belongs to: a headless tap has no live context.
  const stored = followed.get(sessionId);
  const fallback = stored === undefined ? await readStoredContext() : null;
  const organizationId = stored?.ctx.organizationId ?? fallback?.organizationId ?? null;
  const result = await runGlanceableApprove({
    target: { kiloSessionId: sessionId, organizationId, approvalKey },
    now: () => Date.now(),
  });
  if (stored === undefined) {
    return false;
  }
  if (result.kind === 'approved' || result.kind === 'gone') {
    followed.set(sessionId, {
      content: { ...stored.content, awaitingPermission: false, approvalKey: null },
      approvalKey: null,
      ctx: stored.ctx,
    });
    emit();
    repost(sessionId);
    return true;
  }
  return false;
}

// The aggregate card and its Approve read the followed sessions through this
// source, so their test graphs never load the Android notification bridge.
setFollowedSessionsSource({ ids: () => followed.keys(), counts: followedSessionCounts });

/** Test-only: drop the followed set and the listeners. */
export function _resetSessionFollowForTests(): void {
  followed.clear();
  listeners.clear();
  revision = 0;
}

/** The stored account and scope, as the iOS adoption reads them. */
async function readStoredContext(): Promise<SessionFollowContext | null> {
  try {
    const userId = await SecureStore.getItemAsync(ACTIVE_USER_ID_KEY);
    if (userId === null) {
      return null;
    }
    return { userId, organizationId: await SecureStore.getItemAsync(ORGANIZATION_STORAGE_KEY) };
  } catch {
    // An unavailable keychain only costs this restoration; the next foreground retries.
    return null;
  }
}

/** Launch and foreground: rebuild the set from native truth and the stored scope. */
export async function restoreFollowedSessionCardsFromStorage(): Promise<void> {
  restoreFollowedSessionCards(await readStoredContext());
}
