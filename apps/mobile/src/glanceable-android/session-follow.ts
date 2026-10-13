import {
  buildSessionLiveActivityContentState,
  type SessionLiveActivityContentState,
  type SessionLiveActivityRow,
} from '@kilocode/notifications';

import { runGlanceableApprove } from '@/lib/glanceable/approve-ask';
import {
  type FollowedSessionCounts,
  setFollowedSessionsSource,
} from '@/lib/glanceable/followed-sessions';
import {
  getLiveActivityEnabled,
  getNotificationPermissionGranted,
} from '@/lib/glanceable/live-activity-switch';
import {
  registerAndroidSessionToken,
  releaseAndroidSessionToken,
  retryAndroidSessionTokens,
  setAndroidSessionScope,
} from '@/lib/glanceable/session-activity-tokens-android';

import { buildSessionNotificationCard } from './session-notification-card';
import { ensureAndroidNotificationChannels } from './ensure-notification-channels';
import { readStoredContext } from './session-stored-context';
import {
  dismissSessionCard,
  getStoredSessionCards,
  postSessionCard,
  pruneSessionCards,
  restoreSessionCard,
} from './session-notification';

/**
 * The per-session ongoing notification on Android
 * (`.specs/mobile-session-live-activity.md` "Android"). Follow, the store, and
 * the follow lifecycle live here; `session-notification-card.ts` maps the one
 * shared content contract to the notification's copy and times, and the native
 * module owns the notification id, the channel, the actions, and the Live
 * Update promotion.
 */

/** A finished notification stays in the shade this long after it ends. */
export const SESSION_FINISHED_DISMISS_MS = 15 * 60 * 1000;

export type SessionFollowContext = { userId: string; organizationId: string | null };
export type SessionLiveUpdateContent = SessionLiveActivityContentState;
export type FollowResult = 'started' | 'followed' | 'refused';

/**
 * One followed session. `content` is null for a follow a fresh process rebuilt
 * from native storage: the store keeps the card, not its content, so the next
 * push or tray read supplies it.
 */
type Followed = {
  content: SessionLiveActivityContentState | null;
  approvalKey: string | null;
  ctx: SessionFollowContext;
};

/** The followed sessions this process holds. */
const followed = new Map<string, Followed>();
const listeners = new Set<() => void>();
let revision = 0;

function emit(): void {
  revision += 1;
  for (const listener of listeners) {
    listener();
  }
}

export function getSessionFollowsRevision(): number {
  return revision;
}

export function subscribeSessionFollows(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function isSessionFollowed(sessionId: string): boolean {
  return followed.has(sessionId);
}

/** A card that still represents work the user follows. */
function isLiveKind(kind: SessionLiveActivityContentState['statusKind']): boolean {
  return kind !== 'idle' && kind !== 'failed';
}

/** Live counts by status kind of the followed sessions, for the aggregate card. */
export function followedSessionCounts(): FollowedSessionCounts {
  const counts = { running: 0, needsInput: 0, needsApproval: 0, idle: 0, scheduled: 0 };
  for (const { content } of followed.values()) {
    // A finished or failed session leaves the set when it ends, so only live
    // kinds are counted here.
    if (content !== null && content.statusKind !== 'idle' && content.statusKind !== 'failed') {
      counts[content.statusKind] += 1;
      if (content.awaitingPermission) {
        counts.needsApproval += 1;
      }
    }
  }
  return counts;
}

/** Post or update one followed session's notification from its content. */
function render(content: SessionLiveActivityContentState, ctx: SessionFollowContext): void {
  const stored = followed.get(content.sessionId);
  if (stored?.content != null && content.updatedAt < stored.content.updatedAt) {
    // An out-of-order push must not undo newer content.
    return;
  }
  followed.set(content.sessionId, { content, approvalKey: content.approvalKey, ctx });
  postSessionCard(buildSessionNotificationCard(content, ctx.organizationId), 0);
  emit();
}

/**
 * Stop following one session: forget it, drop its pending registration, and
 * delete its server row, as every iOS card end releases its token. Every end
 * path runs through this, so no ended follow leaves a row the server keeps
 * pushing to. Resolves once the delete settled, for the headless callers.
 */
async function endFollow(sessionId: string): Promise<void> {
  if (followed.delete(sessionId)) {
    emit();
  }
  await releaseAndroidSessionToken(sessionId);
}

/** Re-post the stored card of one followed session (after an Approve). */
function repost(sessionId: string): void {
  const stored = followed.get(sessionId);
  if (stored?.content != null) {
    postSessionCard(buildSessionNotificationCard(stored.content, stored.ctx.organizationId), 0);
  }
}

/**
 * Rebuild the followed set from native truth. A stored card of another scope is
 * cancelled and forgotten. A kept card is followed again — a fresh process
 * starts with an empty set, and a push or tray read for a followed session must
 * still find it — and its registration runs again.
 */
export function restoreFollowedSessionCards(
  ctx: SessionFollowContext | null,
  now: number = Date.now()
): void {
  const stored = getStoredSessionCards();
  const kept = new Map<string, string | null>();
  // A finished card in its window: still in the shade, still cancelable by a
  // teardown, but no longer a follow.
  const finished: string[] = [];
  for (const card of stored) {
    if (ctx === null || card.organizationId !== ctx.organizationId) {
      dismissSessionCard(card.sessionId);
    } else if (card.finishedUntil === undefined) {
      kept.set(card.sessionId, card.approvalKey);
      restoreSessionCard(card.sessionId);
    } else if (card.finishedUntil > now) {
      finished.push(card.sessionId);
    } else {
      // The window passed: the system removed it (API 26+) or it is still
      // drawn (API 24-25, no timeout). Either way it goes now.
      dismissSessionCard(card.sessionId);
    }
  }
  pruneSessionCards([...kept.keys(), ...finished]);
  let changed = false;
  for (const sessionId of followed.keys()) {
    if (!kept.has(sessionId)) {
      followed.delete(sessionId);
      void releaseAndroidSessionToken(sessionId);
      changed = true;
    }
  }
  if (ctx !== null) {
    for (const [sessionId, approvalKey] of kept) {
      if (!followed.has(sessionId)) {
        followed.set(sessionId, { content: null, approvalKey, ctx });
        changed = true;
      }
    }
  }
  if (changed) {
    emit();
  }
  if (ctx === null) {
    return;
  }
  setAndroidSessionScope(ctx);
  for (const sessionId of kept.keys()) {
    void registerAndroidSessionToken({ sessionId, ...ctx });
  }
}

/**
 * Launch, foreground, and a headless push: rebuild the set from native truth
 * and the stored scope. Resolves false when the keychain could not be read:
 * nothing is cancelled then, and the caller must not read the empty set as
 * "not followed".
 */
export async function restoreFollowedSessionCardsFromStorage(): Promise<boolean> {
  await ensureAndroidNotificationChannels();
  const ctx = await readStoredContext();
  if (ctx === 'unavailable') {
    return false;
  }
  restoreFollowedSessionCards(ctx);
  return true;
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
  void registerAndroidSessionToken({ sessionId: row.id, ...ctx });
  return 'started';
}

/** Unfollow: cancel the notification at once and release its token. */
export function unfollowSession(sessionId: string): void {
  if (!followed.has(sessionId)) {
    return;
  }
  dismissSessionCard(sessionId);
  void endFollow(sessionId);
}

/**
 * The user dismissed the notification: that is an Unfollow (spec "Android:
 * actions" rule 3). The native receiver already cancelled the card; this stops
 * following the session in this runtime and deletes its server row, so no later
 * update re-posts it. Runs headless, so it resolves only once the delete settled.
 */
export async function unfollowDismissedSession(sessionId: string): Promise<void> {
  dismissSessionCard(sessionId);
  await endFollow(sessionId);
}

/**
 * Opening a session dismisses its finished notification at once (spec "Ending" 1).
 *
 * Only a session this device still follows has a row to release. Any other
 * session either never had a row from this device, or released it when its
 * card ended (every end goes through `endFollow`), so opening it cancels the
 * native card and deletes nothing: a row another surface or device owns must
 * not be touched by a screen visit.
 */
export function dismissFinishedSessionCard(sessionId: string): void {
  const stored = followed.get(sessionId);
  // A rebuilt follow with no content yet still follows live work.
  if (stored !== undefined && (stored.content === null || isLiveKind(stored.content.statusKind))) {
    return;
  }
  dismissSessionCard(sessionId);
  if (stored !== undefined) {
    void endFollow(sessionId);
  }
}

/**
 * End every followed notification: sign-out, an account or organization change,
 * a lost organization, and the in-app switch turned off.
 */
export function endAllSessionCards(): void {
  // The native prune also cancels the finished cards still in their window.
  pruneSessionCards([]);
  // `endFollow` deletes its entry before its first await, which a Map
  // iteration allows.
  for (const sessionId of followed.keys()) {
    void endFollow(sessionId);
  }
}

/** Update the followed notifications from the foreground tray. */
export function syncFollowedSessionCards(
  rows: readonly SessionLiveActivityRow[],
  checkedAt: number = Date.now()
): void {
  // Every publish is a chance to land a registration a network failure left pending.
  void retryAndroidSessionTokens();
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
        statusSinceFallback: stored.content?.statusSince ?? updatedAt,
      });
      if (isLiveKind(content.statusKind)) {
        render(content, stored.ctx);
      } else {
        postSessionCard(
          buildSessionNotificationCard(content, stored.ctx.organizationId),
          SESSION_FINISHED_DISMISS_MS
        );
        void endFollow(sessionId);
      }
    }
  }
}

/**
 * Apply one server push. A session the app does not follow renders nothing, and
 * the caller drops that server row. A headless caller restores the set from
 * native storage first (`restoreFollowedSessionCardsFromStorage`).
 */
export async function applySessionLiveUpdate(
  event: 'update' | 'end',
  content: SessionLiveActivityContentState,
  dismissAfterMs?: number
): Promise<boolean> {
  const stored = followed.get(content.sessionId);
  if (stored === undefined) {
    return false;
  }
  if (event === 'end') {
    const afterMs = dismissAfterMs ?? SESSION_FINISHED_DISMISS_MS;
    if (afterMs === 0) {
      // A session that is gone or out of scope ends at once, with no content.
      dismissSessionCard(content.sessionId);
    } else {
      postSessionCard(buildSessionNotificationCard(content, stored.ctx.organizationId), afterMs);
    }
    // The server retires its row on an accepted end; the release also covers an
    // end the app reached first, so no path leaves the row behind.
    await endFollow(content.sessionId);
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
  // The stored card carries the scope it was followed in; a headless tap has no
  // live context, so the stored scope is the fallback.
  const stored = followed.get(sessionId);
  const fallback = stored === undefined ? await readStoredContext() : null;
  const organizationId =
    stored?.ctx.organizationId ??
    (fallback === null || fallback === 'unavailable' ? null : fallback.organizationId);
  const result = await runGlanceableApprove({
    target: { kiloSessionId: sessionId, organizationId, approvalKey },
    now: () => Date.now(),
  });
  if (stored === undefined) {
    return false;
  }
  if (result.kind === 'approved' || result.kind === 'gone') {
    followed.set(sessionId, {
      content:
        stored.content === null
          ? null
          : { ...stored.content, awaitingPermission: false, approvalKey: null },
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
