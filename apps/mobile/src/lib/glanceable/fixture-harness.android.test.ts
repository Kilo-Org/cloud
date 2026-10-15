import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as androidFollow from '@/glanceable-android/session-follow';
import {
  _resetLiveActivitySwitchForTests,
  setLiveActivityEnabledValue,
  setNotificationPermissionGrantedValue,
} from '@/lib/glanceable/live-activity-switch';

import { handleGlanceableFixturePath, setGlanceableFixtureScope } from './fixture-harness';
import { isGlanceableFixtureHeld, releaseGlanceableFixtureHold } from './fixture-hold';
import { _setAndroidFollowForTests, syncFollowedSessionCards } from './session-follow';

/**
 * The session card fixtures on Android: the harness must drive the Android
 * notification through the same follow and push paths a real follow takes,
 * and a held fixture's card must not be overwritten by the live tray.
 */

const mocks = vi.hoisted(() => ({
  postSessionCard: vi.fn(),
  dismissSessionCard: vi.fn(),
  pruneSessionCards: vi.fn(),
  restoreSessionCard: vi.fn(),
  registerAndroidSessionToken: vi.fn(async () => {
    await Promise.resolve();
  }),
  releaseAndroidSessionToken: vi.fn(async () => {
    await Promise.resolve();
  }),
}));

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));

// The native card bridge and the token rows: observed, never reached.
vi.mock('@/glanceable-android/session-notification', () => ({
  postSessionCard: mocks.postSessionCard,
  dismissSessionCard: mocks.dismissSessionCard,
  pruneSessionCards: mocks.pruneSessionCards,
  restoreSessionCard: mocks.restoreSessionCard,
  getStoredSessionCards: () => [],
}));
vi.mock('@/lib/glanceable/session-activity-tokens-android', () => ({
  registerAndroidSessionToken: mocks.registerAndroidSessionToken,
  releaseAndroidSessionToken: mocks.releaseAndroidSessionToken,
  retryAndroidSessionTokens: vi.fn(async () => {
    await Promise.resolve();
  }),
  setAndroidSessionScope: vi.fn(),
}));
vi.mock('@/lib/glanceable/approve-ask', () => ({ runGlanceableApprove: vi.fn() }));
vi.mock('@/glanceable-android/count-format', () => ({
  formatGlanceableClock: (at: string) => at.slice(11, 16),
  formatGlanceableCount: String,
}));

// The Home widget's native refresh store and the persisted snapshot.
vi.mock('./home-widget-refresh', () => ({
  HomeWidgetRefresh: null,
  clearHomeWidgetRefresh: vi.fn(async () => {
    await Promise.resolve();
  }),
  syncFixtureWidgetLocale: vi.fn(async () => {
    await Promise.resolve();
  }),
}));
vi.mock('./persist', () => ({ getLastGlanceableSnapshot: () => null }));

const CTX = { userId: 'user-1', organizationId: 'org-1' };

/** Apply one fixture and wait for the harness to finish drawing it. */
async function applyFixture(name: string): Promise<void> {
  handleGlanceableFixturePath(`dev/glanceable-fixture/${name}`);
  await vi.waitFor(() => {
    expect(mocks.postSessionCard).toHaveBeenCalled();
  });
}

/** Every card the harness posted for the fixture session, in order. */
function fixtureCards(): Record<string, unknown>[] {
  return mocks.postSessionCard.mock.calls
    .map(([card]) => card as Record<string, unknown>)
    .filter(card => card.sessionId === 'glanceable-fixture-0');
}

beforeEach(() => {
  vi.clearAllMocks();
  releaseGlanceableFixtureHold();
  androidFollow._resetSessionFollowForTests();
  _setAndroidFollowForTests(androidFollow);
  _resetLiveActivitySwitchForTests();
  setLiveActivityEnabledValue(true);
  setNotificationPermissionGrantedValue(true);
  setGlanceableFixtureScope(CTX);
});

describe('session card fixtures on Android', () => {
  it('post the fixture card through the production follow and card builder', async () => {
    await applyFixture('session-card-android-working');

    expect(isGlanceableFixtureHeld()).toBe(true);
    expect(androidFollow.isSessionFollowed('glanceable-fixture-0')).toBe(true);
    expect(fixtureCards().at(-1)).toMatchObject({
      sessionId: 'glanceable-fixture-0',
      organizationId: 'org-1',
      title: 'Migrate the billing webhooks',
      chronometer: true,
      openUrl: 'kiloapp:///cloud/sessions/glanceable-fixture-0',
    });
  });

  it('draw Approve for the permission fixture from the content a push would carry', async () => {
    await applyFixture('session-card-android-permission');

    expect(fixtureCards().at(-1)).toMatchObject({
      approveLabel: 'Approve',
      approvalKey: 'a'.repeat(64),
    });
  });

  it('replace a real followed card on the same surface', async () => {
    androidFollow.followSession(
      { id: 'real-session', title: 'A real follow', status: 'busy', statusUpdatedAt: null },
      CTX,
      Date.now()
    );
    expect(androidFollow.isSessionFollowed('real-session')).toBe(true);
    mocks.postSessionCard.mockClear();

    await applyFixture('session-card-android-working');

    expect(androidFollow.isSessionFollowed('real-session')).toBe(false);
    expect(mocks.pruneSessionCards).toHaveBeenCalledWith([]);
    expect(androidFollow.isSessionFollowed('glanceable-fixture-0')).toBe(true);
  });

  it('draw the failed fixture with its stop reason, as the end push carries it', async () => {
    await applyFixture('session-card-failed');

    const [card, dismissAfterMs] = mocks.postSessionCard.mock.calls.at(-1) ?? [];
    expect(card).toMatchObject({
      sessionId: 'glanceable-fixture-0',
      text: expect.stringContaining('Stopped: provider error'),
      subText: '2 of 5',
      chronometer: false,
    });
    expect(dismissAfterMs).toBe(androidFollow.SESSION_FINISHED_DISMISS_MS);
    // The failed card ends the follow, as a real failed run does.
    expect(androidFollow.isSessionFollowed('glanceable-fixture-0')).toBe(false);
  });

  it('keep the fixture card while held: the live tray does not overwrite it', async () => {
    await applyFixture('session-card-android-working');
    mocks.postSessionCard.mockClear();

    // A live tray read that names the fixture session as finished.
    syncFollowedSessionCards(
      [{ id: 'glanceable-fixture-0', title: 'Live title', status: 'idle', statusUpdatedAt: null }],
      Date.now()
    );

    expect(mocks.postSessionCard).not.toHaveBeenCalled();
    expect(androidFollow.isSessionFollowed('glanceable-fixture-0')).toBe(true);
  });

  it('let the tray update the cards again once the fixture is released', async () => {
    await applyFixture('session-card-android-working');
    handleGlanceableFixturePath('dev/glanceable-fixture/release');
    await vi.waitFor(() => {
      expect(isGlanceableFixtureHeld()).toBe(false);
    });
    androidFollow.followSession(
      { id: 'real-session', title: 'A real follow', status: 'busy', statusUpdatedAt: null },
      CTX,
      Date.now()
    );
    mocks.postSessionCard.mockClear();

    syncFollowedSessionCards(
      [{ id: 'real-session', title: 'A real follow', status: 'question', statusUpdatedAt: null }],
      Date.now()
    );

    expect(mocks.postSessionCard).toHaveBeenCalledTimes(1);
  });
});
