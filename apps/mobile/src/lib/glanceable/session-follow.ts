import { Platform } from 'react-native';

import { GLANCEABLE_STALE_MS } from '@kilocode/app-shared/glanceable-agents-snapshot';
import {
  type SessionLiveActivityContentState,
  sessionLiveActivityRelevance,
  type SessionLiveActivityRow,
} from '@kilocode/notifications';

import type * as AndroidFollow from '@/glanceable-android/session-follow';
import type * as IosFollow from '@/glanceable-ios/session-follow';

import { isGlanceableFixtureHeld } from './fixture-hold';

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

/**
 * A suite's Android follow module: the lazy `require` below is not reachable by
 * `vi.mock`, so a test hands in the real module it imported with its own mocks.
 */
let androidFollowForTests: typeof AndroidFollow | null = null;

export function _setAndroidFollowForTests(module: typeof AndroidFollow | null): void {
  androidFollowForTests = module;
}

function android(): typeof AndroidFollow {
  if (androidFollowForTests !== null) {
    return androidFollowForTests;
  }
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

/**
 * The tray rows update the followed cards. While a dev fixture is held, the
 * fixture owns every surface, so the live tray must not overwrite its card (the
 * flag is always false in a release build).
 */
export const syncFollowedSessionCards = (
  rows: readonly SessionCardRow[],
  checkedAt?: number
): void => {
  if (isGlanceableFixtureHeld()) {
    return;
  }
  follow().syncFollowedSessionCards(rows, checkedAt);
};

/** End every session card: the fixture harness clears the surface before it draws one. */
export const endAllSessionCards = (): void => {
  follow().endAllSessionCards();
};

/**
 * Dev fixtures: the fixture harness drives the session card through the same
 * paths a real follow takes. `applyFixtureSessionContent` lays the content a
 * server push would carry onto the followed card: the Android push path, or an
 * ActivityKit update with the shared stale window and relevance on iOS.
 * `finishFixtureSessionCard` ends a fixture's follow the way a finished or
 * failed run does; the live tray stays gated while the fixture is held.
 */
export const finishFixtureSessionCard = (
  row: SessionCardRow,
  content: SessionLiveActivityContentState | null,
  checkedAt: number
): void => {
  if (Platform.OS === 'android' && content !== null) {
    // Android ends the follow as the card finishes, so content applied after
    // the end is dropped: the fixture's content is the end itself, as the
    // server's end push carries it.
    void android().applySessionLiveUpdate('end', content);
    return;
  }
  // iOS ends the card inside the tray sync, so content applied after the end
  // finds no card. The finishing row carries the content's facts instead, and
  // the shared builder ends the card with them (a failure reads as the
  // stopped state with its reason).
  follow().syncFollowedSessionCards(
    [
      content === null
        ? row
        : {
            ...row,
            currentStep: content.currentStep ?? null,
            plan: content.plan ?? null,
            changes: content.changes ?? null,
            lastActivityAt: content.lastActivityAt ?? null,
            costMicrodollars: content.costMicrodollars ?? null,
            outcome: content.outcome?.kind ?? null,
            failure: content.failure?.kind ?? null,
            startedAt: content.startedAt ?? null,
          },
    ],
    checkedAt
  );
};

export const applyFixtureSessionContent = async (
  content: SessionLiveActivityContentState
): Promise<boolean> => {
  if (Platform.OS === 'android') {
    const applied = await android().applySessionLiveUpdate('update', content);
    return applied;
  }
  const card = iosFollow()
    .discoverSessionCards()
    .find(activity => activity.getProps()?.sessionId === content.sessionId);
  if (card === undefined) {
    return false;
  }
  void settleFixtureCardWork(
    card.update(
      content,
      GLANCEABLE_STALE_MS / 1000,
      sessionLiveActivityRelevance(content.statusKind, content.statusSince)
    )
  );
  return true;
};

/** Run one fixture card write whose failure has nothing left to correct. */
async function settleFixtureCardWork(work: Promise<void>): Promise<void> {
  try {
    await work;
  } catch {
    // A card iOS already removed; the fixture shows the rest.
  }
}

/** Android only: apply one server push to the followed set. */
export const applySessionLiveUpdate = async (
  event: 'update' | 'end',
  content: AndroidFollow.SessionLiveUpdateContent,
  dismissAfterMs?: number
): Promise<boolean> => {
  if (Platform.OS !== 'android') {
    return false;
  }
  const applied = await android().applySessionLiveUpdate(event, content, dismissAfterMs);
  return applied;
};

/**
 * Android only: hydrate the followed set from storage. A headless push runs in
 * a fresh process whose in-memory follow map is empty, so without this a push
 * for a followed session is indistinguishable from one for a stranger. Resolves
 * false when the stored scope could not be read: the empty set then says
 * nothing, and the caller must keep the session's row.
 */
export const restoreFollowedSessionsFromStorage = async (): Promise<boolean> => {
  if (Platform.OS !== 'android') {
    return true;
  }
  const known = await android().restoreFollowedSessionCardsFromStorage();
  return known;
};

/** Android only: a dismissed notification is an Unfollow (spec "Android: actions" 3). */
export const unfollowDismissedSession = async (sessionId: string): Promise<void> => {
  if (Platform.OS === 'android') {
    await android().unfollowDismissedSession(sessionId);
  }
};

/** Android only: revalidate the exact request a card shows and answer it. */
export const approveFollowedSession = async (
  sessionId: string,
  approvalKey: string
): Promise<void> => {
  if (Platform.OS === 'android') {
    await android().approveFollowedSession(sessionId, approvalKey);
  }
};
