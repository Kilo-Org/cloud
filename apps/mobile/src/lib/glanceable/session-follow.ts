import { Platform } from 'react-native';

import * as android from '@/glanceable-android/session-follow';
import * as ios from '@/glanceable-ios/session-follow';

/**
 * The per-session follow lifecycle, per platform
 * (`.specs/mobile-session-live-activity.md`).
 *
 * One session card per followed session, on both platforms: an ActivityKit
 * Live Activity on iOS and an ongoing notification on Android. The contract,
 * the content model, the follow store, and the rules are shared; only the
 * native surface and its lifecycle calls differ, so the two modules keep their
 * own implementation and this shim picks the one for the running platform.
 * Every symbol is re-exported, so nothing loads the other platform's module:
 * the iOS module imports `expo-widgets` (ActivityKit), and the Android one
 * imports its own native bridge.
 */

export type SessionFollowContext = ios.SessionFollowContext;
export type FollowResult = ios.FollowResult;
export type SessionCardRow = ios.SessionCardRow;

/** The one shared row shape both platforms follow: the notifications package's. */
export type SessionFollowRow = SessionCardRow;

export const getSessionFollowsRevision: () => number =
  Platform.OS === 'android' ? android.getSessionFollowsRevision : ios.getSessionFollowsRevision;

export const subscribeSessionFollows = (listener: () => void): (() => void) =>
  Platform.OS === 'android'
    ? android.subscribeSessionFollows(listener)
    : ios.subscribeSessionFollows(listener);

export const isSessionFollowed = (sessionId: string): boolean =>
  Platform.OS === 'android'
    ? android.isSessionFollowed(sessionId)
    : ios.isSessionFollowed(sessionId);

export const followSession = (
  row: SessionCardRow,
  ctx: SessionFollowContext,
  now?: number
): FollowResult =>
  Platform.OS === 'android'
    ? android.followSession(row, ctx, now)
    : ios.followSession(row, ctx, now);

export const unfollowSession = (sessionId: string): void => {
  if (Platform.OS === 'android') {
    android.unfollowSession(sessionId);
  } else {
    ios.unfollowSession(sessionId);
  }
};

export const dismissFinishedSessionCard = (sessionId: string): void => {
  if (Platform.OS === 'android') {
    android.dismissFinishedSessionCard(sessionId);
  } else {
    ios.dismissFinishedSessionCard(sessionId);
  }
};

export const syncFollowedSessionCards = (
  rows: readonly SessionCardRow[],
  checkedAt?: number
): void => {
  if (Platform.OS === 'android') {
    android.syncFollowedSessionCards(rows, checkedAt);
  } else {
    ios.syncFollowedSessionCards(rows, checkedAt);
  }
};

export const endAllSessionCards = (): void => {
  if (Platform.OS === 'android') {
    android.endAllSessionCards();
  } else {
    ios.endAllSessionCards();
  }
};

/** Apply one server update or end to the followed set. Android only; a no-op elsewhere. */
export const applySessionLiveUpdate = (
  event: 'update' | 'end',
  content: android.SessionLiveUpdateContent,
  dismissAfterMs?: number
): boolean =>
  Platform.OS === 'android'
    ? android.applySessionLiveUpdate(event, content, dismissAfterMs)
    : false;

/** Launch and foreground: rebuild the followed set from native truth (Android). */
export const restoreFollowedSessionCardsFromStorage: () => Promise<void> =
  Platform.OS === 'android'
    ? android.restoreFollowedSessionCardsFromStorage
    : async () => {
        await Promise.resolve();
      };

/** Revalidate the exact request a card shows and answer it. Android only. */
export async function approveFollowedSession(
  sessionId: string,
  approvalKey: string
): Promise<void> {
  if (Platform.OS === 'android') {
    await android.approveFollowedSession(sessionId, approvalKey);
  }
}
