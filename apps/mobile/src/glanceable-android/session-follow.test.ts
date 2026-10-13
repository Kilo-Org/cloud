import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetLiveActivitySwitchForTests,
  setLiveActivityEnabledValue,
  setNotificationPermissionGrantedValue,
} from '@/lib/glanceable/live-activity-switch';

import {
  _resetSessionFollowForTests,
  applySessionLiveUpdate,
  endAllSessionCards,
  followedSessionCounts,
  followSession,
  getSessionFollowsRevision,
  isSessionFollowed,
  restoreFollowedSessionCards,
  restoreFollowedSessionCardsFromStorage,
  SESSION_FINISHED_DISMISS_MS,
  subscribeSessionFollows,
  syncFollowedSessionCards,
  unfollowSession,
} from './session-follow';
import { _setStoredContextReaderForTests } from './session-stored-context';

const mocks = vi.hoisted(() => ({
  postSessionCard: vi.fn(),
  dismissSessionCard: vi.fn<(sessionId: string) => void>(),
  pruneSessionCards: vi.fn(),
  restoreSessionCard: vi.fn(),
  getStoredSessionCards: vi.fn<
    () => { sessionId: string; organizationId: string | null; approvalKey: string | null }[]
  >(() => []),
  registerAndroidSessionToken: vi.fn(),
  releaseAndroidSessionToken: vi.fn(async (_sessionId: string) => {
    await Promise.resolve();
  }),
  retryAndroidSessionTokens: vi.fn(async () => {
    await Promise.resolve();
  }),
  setAndroidSessionScope: vi.fn(),
  runGlanceableApprove: vi.fn(),
}));

// The card builder reads the app's locale and number formatting through the
// widget copy module, which loads the native localization runtime; the copy and
// the times are asserted through the native post arguments below instead.
vi.mock('./count-format', () => ({
  formatGlanceableClock: (at: string) => at.slice(11, 16),
  formatGlanceableCount: String,
}));

vi.mock('./session-notification', () => ({
  postSessionCard: mocks.postSessionCard,
  dismissSessionCard: mocks.dismissSessionCard,
  pruneSessionCards: mocks.pruneSessionCards,
  restoreSessionCard: mocks.restoreSessionCard,
  getStoredSessionCards: mocks.getStoredSessionCards,
}));

vi.mock('./ensure-notification-channels', () => ({
  ensureAndroidNotificationChannels: vi.fn(async () => {
    await Promise.resolve();
  }),
}));

vi.mock('@/lib/glanceable/session-activity-tokens-android', () => ({
  registerAndroidSessionToken: mocks.registerAndroidSessionToken,
  releaseAndroidSessionToken: mocks.releaseAndroidSessionToken,
  retryAndroidSessionTokens: mocks.retryAndroidSessionTokens,
  setAndroidSessionScope: mocks.setAndroidSessionScope,
}));

vi.mock('@/lib/glanceable/approve-ask', () => ({
  runGlanceableApprove: mocks.runGlanceableApprove,
}));

const NOW = Date.parse('2026-10-12T10:00:00.000Z');
const CTX = { userId: 'user-1', organizationId: 'org-1' };
const RUNNING = {
  id: 'session-1',
  title: 'Migrate the billing webhooks',
  status: 'busy',
  statusUpdatedAt: '2026-10-12T09:48:00.000Z',
};

/** The card the module last handed to the native post. */
function lastCard(): Record<string, unknown> {
  const call = mocks.postSessionCard.mock.calls.at(-1);
  return (call?.[0] ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getStoredSessionCards.mockReturnValue([]);
  _resetSessionFollowForTests();
  _setStoredContextReaderForTests(null);
  _resetLiveActivitySwitchForTests();
  setLiveActivityEnabledValue(true);
  setNotificationPermissionGrantedValue(true);
});

describe('followSession', () => {
  it('posts one notification for a running session and registers its token', () => {
    expect(followSession(RUNNING, CTX, NOW)).toBe('started');

    expect(mocks.postSessionCard).toHaveBeenCalledTimes(1);
    expect(lastCard()).toMatchObject({
      sessionId: 'session-1',
      organizationId: 'org-1',
      title: 'Migrate the billing webhooks',
      text: 'Working',
      chronometer: true,
      approveLabel: null,
      openUrl: 'kiloapp:///cloud/sessions/session-1',
    });
    expect(mocks.registerAndroidSessionToken).toHaveBeenCalledWith({
      sessionId: 'session-1',
      userId: 'user-1',
      organizationId: 'org-1',
    });
    expect(isSessionFollowed('session-1')).toBe(true);
  });

  it('shows Approve only for a permission wait that carries a key', async () => {
    followSession({ ...RUNNING, status: 'permission' }, CTX, NOW);
    expect(lastCard()).toMatchObject({ approveLabel: null });

    await applySessionLiveUpdate('update', {
      sessionId: 'session-1',
      title: 'Migrate the billing webhooks',
      statusKind: 'needsInput',
      statusSince: '2026-10-12T09:55:00.000Z',
      scheduledAt: null,
      awaitingPermission: true,
      approvalKey: 'b'.repeat(64),
      updatedAt: '2026-10-12T10:01:00.000Z',
    });
    expect(lastCard()).toMatchObject({ approveLabel: 'Approve', approvalKey: 'b'.repeat(64) });
  });

  it('second follow and a refusal change nothing', () => {
    followSession(RUNNING, CTX, NOW);
    expect(followSession(RUNNING, CTX, NOW)).toBe('followed');

    _resetSessionFollowForTests();
    mocks.postSessionCard.mockClear();
    setNotificationPermissionGrantedValue(false);
    expect(followSession(RUNNING, CTX, NOW)).toBe('refused');
    expect(mocks.postSessionCard).not.toHaveBeenCalled();
  });
});

describe('syncFollowedSessionCards', () => {
  it('updates the posted notification in place', () => {
    followSession(RUNNING, CTX, NOW);
    mocks.postSessionCard.mockClear();

    syncFollowedSessionCards([{ ...RUNNING, status: 'question' }], NOW + 60_000);

    expect(mocks.postSessionCard).toHaveBeenCalledTimes(1);
    expect(lastCard()).toMatchObject({
      text: expect.stringContaining('Needs input'),
      chronometer: false,
    });
  });

  it('ends a finished session after the finished window', () => {
    followSession(RUNNING, CTX, NOW);
    mocks.postSessionCard.mockClear();

    syncFollowedSessionCards([{ ...RUNNING, status: 'idle' }], NOW + 60_000);

    expect(mocks.postSessionCard).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Finished') }),
      SESSION_FINISHED_DISMISS_MS
    );
    expect(isSessionFollowed('session-1')).toBe(false);
  });
});

describe('unfollowSession and endAllSessionCards', () => {
  it('unfollow dismisses the notification and releases the token row', () => {
    followSession(RUNNING, CTX, NOW);
    unfollowSession('session-1');

    expect(mocks.dismissSessionCard).toHaveBeenCalledWith('session-1');
    expect(mocks.releaseAndroidSessionToken).toHaveBeenCalledWith('session-1');
    expect(isSessionFollowed('session-1')).toBe(false);
  });

  it('sign-out cancels every session notification', () => {
    followSession(RUNNING, CTX, NOW);
    followSession({ ...RUNNING, id: 'session-2' }, CTX, NOW);
    mocks.dismissSessionCard.mockClear();

    endAllSessionCards();

    // The native prune with an empty keep list cancels every stored card,
    // the finished ones in their window included.
    expect(mocks.pruneSessionCards).toHaveBeenCalledWith([]);
    expect(
      mocks.releaseAndroidSessionToken.mock.calls
        .map(call => call[0])
        .toSorted((a, b) => a.localeCompare(b))
    ).toEqual(['session-1', 'session-2']);
    expect(followedSessionCounts().running).toBe(0);
  });
});

describe('restoreFollowedSessionCards', () => {
  it('cancels a stored card of another scope and re-registers the kept ones', () => {
    followSession(RUNNING, CTX, NOW);
    mocks.getStoredSessionCards.mockReturnValue([
      { sessionId: 'session-1', organizationId: 'org-1', approvalKey: null },
      { sessionId: 'session-7', organizationId: null, approvalKey: null },
    ]);
    mocks.dismissSessionCard.mockClear();
    mocks.registerAndroidSessionToken.mockClear();

    restoreFollowedSessionCards(CTX);

    expect(mocks.dismissSessionCard).toHaveBeenCalledWith('session-7');
    expect(mocks.pruneSessionCards).toHaveBeenCalledWith(['session-1']);
    expect(mocks.registerAndroidSessionToken).toHaveBeenCalledWith({
      sessionId: 'session-1',
      userId: 'user-1',
      organizationId: 'org-1',
    });
  });

  it('notifies subscribers on every real change, and the revision moves with them', () => {
    const listener = vi.fn<() => void>();
    const before = getSessionFollowsRevision();
    const unsubscribe = subscribeSessionFollows(listener);
    followSession(RUNNING, CTX, NOW);
    expect(listener).toHaveBeenCalled();
    expect(getSessionFollowsRevision()).toBeGreaterThan(before);
    unsubscribe();
  });

  it('restores from the stored account and scope when the caller has none', async () => {
    _setStoredContextReaderForTests(() => CTX);
    mocks.getStoredSessionCards.mockReturnValue([
      { sessionId: 'session-1', organizationId: 'org-1', approvalKey: null },
    ]);

    await restoreFollowedSessionCardsFromStorage();

    expect(mocks.pruneSessionCards).toHaveBeenCalledWith(['session-1']);
    expect(mocks.registerAndroidSessionToken).toHaveBeenCalledWith({
      sessionId: 'session-1',
      userId: 'user-1',
      organizationId: 'org-1',
    });
  });
});
