import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetLiveActivitySwitchForTests,
  setLiveActivityEnabledValue,
  setNotificationPermissionGrantedValue,
} from '@/lib/glanceable/live-activity-switch';

import {
  _resetSessionFollowForTests,
  applySessionLiveUpdate,
  dismissFinishedSessionCard,
  followSession,
  isSessionFollowed,
  restoreFollowedSessionCards,
  syncFollowedSessionCards,
  unfollowDismissedSession,
} from './session-follow';

const mocks = vi.hoisted(() => ({
  postSessionCard: vi.fn(),
  dismissSessionCard: vi.fn(),
  pruneSessionCards: vi.fn(),
  restoreSessionCard: vi.fn(),
  getStoredSessionCards: vi.fn<
    () => { sessionId: string; organizationId: string | null; approvalKey: string | null }[]
  >(() => []),
  registerAndroidSessionToken: vi.fn(async () => {
    await Promise.resolve();
  }),
  releaseAndroidSessionToken: vi.fn(async () => {
    await Promise.resolve();
  }),
  retryAndroidSessionTokens: vi.fn(async () => {
    await Promise.resolve();
  }),
  setAndroidSessionScope: vi.fn(),
}));

vi.mock('./session-notification', () => ({
  postSessionCard: mocks.postSessionCard,
  dismissSessionCard: mocks.dismissSessionCard,
  pruneSessionCards: mocks.pruneSessionCards,
  restoreSessionCard: mocks.restoreSessionCard,
  getStoredSessionCards: mocks.getStoredSessionCards,
}));

vi.mock('@/lib/glanceable/session-activity-tokens-android', () => ({
  registerAndroidSessionToken: mocks.registerAndroidSessionToken,
  releaseAndroidSessionToken: mocks.releaseAndroidSessionToken,
  retryAndroidSessionTokens: mocks.retryAndroidSessionTokens,
  setAndroidSessionScope: mocks.setAndroidSessionScope,
}));

vi.mock('@/lib/glanceable/approve-ask', () => ({ runGlanceableApprove: vi.fn() }));

vi.mock('./count-format', () => ({
  formatGlanceableClock: (at: string) => at.slice(11, 16),
  formatGlanceableCount: String,
}));

vi.mock('./ensure-notification-channels', () => ({
  ensureAndroidNotificationChannels: vi.fn(async () => {
    await Promise.resolve();
  }),
}));

const NOW = Date.parse('2026-10-12T10:00:00.000Z');
const PERSONAL = { userId: 'user-1', organizationId: null };
const ROW = {
  id: 'session-1',
  title: 'Migrate the billing webhooks',
  status: 'busy',
  statusUpdatedAt: '2026-10-12T09:48:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getStoredSessionCards.mockReturnValue([]);
  _resetSessionFollowForTests();
  _resetLiveActivitySwitchForTests();
  setLiveActivityEnabledValue(true);
  setNotificationPermissionGrantedValue(true);
});

describe('a fresh process', () => {
  it('follows the stored cards again, so a push for one still renders', async () => {
    mocks.getStoredSessionCards.mockReturnValue([
      { sessionId: 'session-1', organizationId: null, approvalKey: null },
    ]);

    restoreFollowedSessionCards(PERSONAL);

    expect(isSessionFollowed('session-1')).toBe(true);
    expect(mocks.dismissSessionCard).not.toHaveBeenCalled();
    expect(
      await applySessionLiveUpdate('update', {
        sessionId: 'session-1',
        title: 'Migrate the billing webhooks',
        statusKind: 'running',
        statusSince: '2026-10-12T09:48:00.000Z',
        scheduledAt: null,
        awaitingPermission: false,
        approvalKey: null,
        updatedAt: '2026-10-12T10:01:00.000Z',
      })
    ).toBe(true);
    expect(mocks.postSessionCard).toHaveBeenCalledTimes(1);
  });

  it('re-posts the kept native card after a force-stop without waiting for the tray', () => {
    mocks.getStoredSessionCards.mockReturnValue([
      { sessionId: 'session-1', organizationId: null, approvalKey: null },
      { sessionId: 'other-scope', organizationId: 'org-1', approvalKey: null },
    ]);

    restoreFollowedSessionCards(PERSONAL, NOW);

    expect(mocks.restoreSessionCard).toHaveBeenCalledExactlyOnceWith('session-1');
    expect(isSessionFollowed('session-1')).toBe(true);
    expect(mocks.dismissSessionCard).toHaveBeenCalledWith('other-scope');
    expect(mocks.postSessionCard).not.toHaveBeenCalled();
  });

  it('lets the tray fill a rebuilt follow and keeps it on a session open', () => {
    mocks.getStoredSessionCards.mockReturnValue([
      { sessionId: 'session-1', organizationId: null, approvalKey: null },
    ]);
    restoreFollowedSessionCards(PERSONAL);

    // Content is still unknown: opening the session must not drop the follow.
    dismissFinishedSessionCard('session-1');
    expect(isSessionFollowed('session-1')).toBe(true);

    syncFollowedSessionCards([ROW], NOW);
    expect(mocks.postSessionCard).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1', chronometer: true }),
      0
    );
  });

  it('retries a pending registration on every publish', () => {
    syncFollowedSessionCards([], NOW);
    expect(mocks.retryAndroidSessionTokens).toHaveBeenCalledTimes(1);
  });
});

describe('unfollowDismissedSession', () => {
  it('stops following the swiped session and waits for its row delete', async () => {
    followSession(ROW, PERSONAL, NOW);
    let released = false;
    mocks.releaseAndroidSessionToken.mockImplementationOnce(async () => {
      await Promise.resolve();
      released = true;
    });

    await unfollowDismissedSession('session-1');

    expect(isSessionFollowed('session-1')).toBe(false);
    expect(mocks.releaseAndroidSessionToken).toHaveBeenCalledWith('session-1');
    expect(released).toBe(true);
  });

  it('deletes the row even when this process did not follow the session', async () => {
    // The headless task starts in a fresh process with an empty follow set.
    await unfollowDismissedSession('session-7');

    expect(mocks.releaseAndroidSessionToken).toHaveBeenCalledWith('session-7');
  });
});
