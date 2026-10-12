import { Platform } from 'react-native';

import { type SessionLiveActivityRow } from '@kilocode/notifications';

import type * as AndroidFollow from '@/glanceable-android/session-follow';
import type * as IosFollow from '@/glanceable-ios/session-follow';

/**
 * The per-session follow lifecycle, per platform
 * (`.specs/mobile-session-live-activity.md`).
 *
 * One session card per followed session on both platforms: an ActivityKit Live
 * Activity on iOS and an ongoing notification on Android. The contract, the
 * content model, the follow store, and the rules are shared; only the native
 * surface and its lifecycle calls differ, so each platform keeps its own module
 * and this shim picks the one for the running platform.
 *
 * The platform module loads lazily — each reaches a native surface, and the
 * Android one also reaches the tRPC client — so importing this shim never costs
 * the widget or notification graphs that only need one platform.
 */

function android(): typeof AndroidFollow {
  // eslint-disable-next-line typescript-eslint/no-require-imports, typescript-eslint/no-var-requires, unicorn/prefer-module -- lazy native load
  return require('@/glanceable-android/session-follow') as typeof AndroidFollow;
}

function iosFollow(): typeof IosFollow {
  // eslint-disable-next-line typescript-eslint/no-require-imports, typescript-eslint/no-var-requires, unicorn/prefer-module -- lazy native load
  return require('@/glanceable-ios/session-follow') as typeof IosFollow;
}

export type SessionFollowContext = IosFollow.SessionFollowContext;
export type FollowResult = IosFollow.FollowResult;
/** The one shared row shape both platforms follow: the notifications package's. */
export type SessionCardRow = SessionLiveActivityRow;

function follow(): typeof IosFollow | typeof AndroidFollow {
  return Platform.OS === 'android' ? android() : iosFollow();
}

export const getSessionFollowsRevision = (): number => follow().getSessionFollowsRevision();

export const subscribeSessionFollows = (listener: () => void): (() => void) =>
  follow().subscribeSessionFollows(listener);

export const isSessionFollowed = (sessionId: string): boolean =>
  follow().isSessionFollowed(sessionId);

export const followSession = (
  row: SessionCardRow,
  ctx: SessionFollowContext,
  now?: number
): FollowResult => follow().followSession(row, ctx, now);

export const unfollowSession = (sessionId: string): void => {
  follow().unfollowSession(sessionId);
};

export const dismissFinishedSessionCard = (sessionId: string): void => {
  follow().dismissFinishedSessionCard(sessionId);
};

export const syncFollowedSessionCards = (
  rows: readonly SessionCardRow[],
  checkedAt?: number
): void => {
  follow().syncFollowedSessionCards(rows, checkedAt);
};

/** Android only: apply one server push to the followed set. */
export const applySessionLiveUpdate = (
  event: 'update' | 'end',
  content: AndroidFollow.SessionLiveUpdateContent,
  dismissAfterMs?: number
): boolean =>
  Platform.OS === 'android'
    ? android().applySessionLiveUpdate(event, content, dismissAfterMs)
    : false;

/** Android only: revalidate the exact request a card shows and answer it. */
export const approveFollowedSession = async (
  sessionId: string,
  approvalKey: string
): Promise<void> => {
  if (Platform.OS === 'android') {
    await android().approveFollowedSession(sessionId, approvalKey);
  }
};
