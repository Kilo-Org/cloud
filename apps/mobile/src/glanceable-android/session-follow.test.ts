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
  isSessionFollowed,
  restoreFollowedSessionCards,
  SESSION_FINISHED_DISMISS_MS,
  subscribeSessionFollows,
  syncFollowedSessionCards,
  unfollowSession,
} from './session-follow';

const mocks = vi.hoisted(() => ({
  postSessionCard: vi.fn(),
  dismissSessionCard: vi.fn(),
  pruneSessionCards: vi.fn(),
  getStoredSessionCards: vi.fn<
    () => { sessionId: string; organizationId: string | null; approvalKey: string | null }[]
  >(() => []),
  registerAndroidSessionToken: vi.fn(),
  releaseAndroidSessionToken: vi.fn(),
  setAndroidSessionScope: vi.fn(),
  runGlanceableApprove: vi.fn(),
}));

// The card builder reads the app's locale and number formatting through the
// widget copy module, which loads the native localization runtime; the copy and
// the times are asserted through the native post arguments below instead.
vi.mock('./count-format', () => ({
  formatGlanceableClock: (at: string) => at.slice(11, 16),
}));

vi.mock('./session-notification', () => ({
  postSessionCard: mocks.postSessionCard,
  dismissSessionCard: mocks.dismissSessionCard,
  pruneSessionCards: mocks.pruneSessionCards,
  getStoredSessionCards: mocks.getStoredSessionCards,
}));

vi.mock('@/lib/glanceable/session-activity-tokens-android', () => ({
  registerAndroidSessionToken: mocks.registerAndroidSessionToken,
  releaseAndroidSessionToken: mocks.releaseAndroidSessionToken,
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

  it('shows Approve only for a permission wait that carries a key', () => {
    followSession({ ...RUNNING, status: 'permission' }, CTX, NOW);
    expect(lastCard()).toMatchObject({ approveLabel: null });

    applySessionLiveUpdate('update', {
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
      showWhen: true,
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

    expect(
      mocks.dismissSessionCard.mock.calls
        .map(call => call[0])
        .toSorted((a, b) => a.localeCompare(b))
    ).toEqual(['session-1', 'session-2']);
    expect(mocks.pruneSessionCards).toHaveBeenCalledWith([]);
    expect(followedSessionCounts().running).toBe(0);
  });
});

describe('applySessionLiveUpdate', () => {
  it('renders an update for a followed session and an end after the window', () => {
    followSession(RUNNING, CTX, NOW);
    mocks.postSessionCard.mockClear();

    const content = {
      sessionId: 'session-1',
      title: 'Migrate the billing webhooks',
      statusKind: 'idle' as const,
      statusSince: '2026-10-12T10:05:00.000Z',
      scheduledAt: null,
      awaitingPermission: false,
      approvalKey: null,
      updatedAt: '2026-10-12T10:05:00.000Z',
    };
    expect(applySessionLiveUpdate('end', content, 0)).toBe(true);
    expect(mocks.postSessionCard).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Finished') }),
      0
    );
    expect(isSessionFollowed('session-1')).toBe(false);
  });

  it('ignores a push for a session this device does not follow', () => {
    expect(
      applySessionLiveUpdate('update', {
        sessionId: 'session-9',
        title: null,
        statusKind: 'running',
        statusSince: '2026-10-12T10:05:00.000Z',
        scheduledAt: null,
        awaitingPermission: false,
        approvalKey: null,
        updatedAt: '2026-10-12T10:05:00.000Z',
      })
    ).toBe(false);
    expect(mocks.postSessionCard).not.toHaveBeenCalled();
  });

  it('does not let an out-of-order update undo newer content', () => {
    followSession(RUNNING, CTX, NOW);
    applySessionLiveUpdate('update', {
      sessionId: 'session-1',
      title: 'Migrate the billing webhooks',
      statusKind: 'needsInput',
      statusSince: '2026-10-12T10:01:00.000Z',
      scheduledAt: null,
      awaitingPermission: true,
      approvalKey: 'a'.repeat(64),
      updatedAt: '2026-10-12T10:01:00.000Z',
    });
    mocks.postSessionCard.mockClear();

    applySessionLiveUpdate('update', {
      sessionId: 'session-1',
      title: 'Migrate the billing webhooks',
      statusKind: 'running',
      statusSince: '2026-10-12T09:50:00.000Z',
      scheduledAt: null,
      awaitingPermission: false,
      approvalKey: null,
      updatedAt: '2026-10-12T09:58:00.000Z',
    });

    expect(mocks.postSessionCard).not.toHaveBeenCalled();
    expect(
      applySessionLiveUpdate('update', {
        sessionId: 'session-1',
        title: 'Migrate the billing webhooks',
        statusKind: 'running',
        statusSince: '2026-10-12T10:01:30.000Z',
        scheduledAt: null,
        awaitingPermission: false,
        approvalKey: null,
        updatedAt: '2026-10-12T10:01:30.000Z',
      })
    ).toBe(true);
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

  it('notifies subscribers on every real change', () => {
    const listener = vi.fn<() => void>();
    const unsubscribe = subscribeSessionFollows(listener);
    followSession(RUNNING, CTX, NOW);
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });
});
