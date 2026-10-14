import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetLiveActivitySwitchForTests,
  setLiveActivityEnabledValue,
  setNotificationPermissionGrantedValue,
} from '@/lib/glanceable/live-activity-switch';

import {
  _resetSessionFollowForTests,
  applySessionLiveUpdate,
  approveFollowedSession,
  dismissFinishedSessionCard,
  followSession,
  isSessionFollowed,
  syncFollowedSessionCards,
} from './session-follow';

const mocks = vi.hoisted(() => ({
  postSessionCard: vi.fn(),
  dismissSessionCard: vi.fn(),
  pruneSessionCards: vi.fn(),
  restoreSessionCard: vi.fn(),
  getStoredSessionCards: vi.fn<() => unknown[]>(() => []),
  registerAndroidSessionToken: vi.fn(),
  releaseAndroidSessionToken: vi.fn(async () => {
    await Promise.resolve();
  }),
  retryAndroidSessionTokens: vi.fn(async () => {
    await Promise.resolve();
  }),
  setAndroidSessionScope: vi.fn(),
  runGlanceableApprove: vi.fn(),
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

vi.mock('@/lib/glanceable/approve-ask', () => ({
  runGlanceableApprove: mocks.runGlanceableApprove,
}));

// The card builder reads the app's locale through the widget copy module, which
// loads the native localization runtime; the assertions below read the copy off
// the native post arguments instead.
vi.mock('./count-format', () => ({
  formatGlanceableClock: (at: string) => at.slice(11, 16),
  formatGlanceableCount: String,
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

describe('dismissFinishedSessionCard', () => {
  it('cancels a finished card and keeps a live one', () => {
    followSession(RUNNING, CTX, NOW);
    mocks.dismissSessionCard.mockClear();

    dismissFinishedSessionCard('session-1');
    expect(mocks.dismissSessionCard).not.toHaveBeenCalled();

    syncFollowedSessionCards([{ ...RUNNING, status: 'idle' }], NOW + 1);
    mocks.dismissSessionCard.mockClear();
    dismissFinishedSessionCard('session-1');
    expect(mocks.dismissSessionCard).toHaveBeenCalledWith('session-1');
  });
});

describe('approveFollowedSession', () => {
  it('drops Approve from the card once the request is answered', async () => {
    mocks.runGlanceableApprove.mockResolvedValue({ kind: 'approved' });
    followSession({ ...RUNNING, status: 'permission' }, CTX, NOW);
    await applySessionLiveUpdate('update', {
      sessionId: 'session-1',
      title: 'Migrate the billing webhooks',
      statusKind: 'needsInput',
      statusSince: '2026-10-12T09:55:00.000Z',
      scheduledAt: null,
      awaitingPermission: true,
      approvalKey: 'c'.repeat(64),
      updatedAt: '2026-10-12T10:01:00.000Z',
    });
    expect(lastCard()).toMatchObject({ approveLabel: 'Approve' });
    mocks.postSessionCard.mockClear();

    await expect(approveFollowedSession('session-1', 'c'.repeat(64))).resolves.toBe(true);

    expect(mocks.runGlanceableApprove).toHaveBeenCalledWith(
      expect.objectContaining({
        target: {
          kiloSessionId: 'session-1',
          organizationId: 'org-1',
          approvalKey: 'c'.repeat(64),
        },
      })
    );
    expect(lastCard()).toMatchObject({ approveLabel: null, approvalKey: null });
  });

  it('leaves the card asking when the request is retryable', async () => {
    mocks.runGlanceableApprove.mockResolvedValue({ kind: 'retryable' });
    followSession({ ...RUNNING, status: 'permission' }, CTX, NOW);

    await expect(approveFollowedSession('session-1', 'd'.repeat(64))).resolves.toBe(false);
  });
});

describe('applySessionLiveUpdate', () => {
  it('renders an update for a followed session and an end after the window', async () => {
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
    expect(await applySessionLiveUpdate('end', content, 900_000)).toBe(true);
    expect(mocks.postSessionCard).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Finished') }),
      900_000
    );
    expect(isSessionFollowed('session-1')).toBe(false);
  });

  it('waits for its own row release before completing a pushed end', async () => {
    followSession(RUNNING, CTX, NOW);
    const release = Promise.withResolvers<undefined>();
    mocks.releaseAndroidSessionToken.mockReturnValueOnce(release.promise);
    let completed = false;
    const ending = (async () => {
      const result = await applySessionLiveUpdate('end', {
        sessionId: 'session-1',
        title: RUNNING.title,
        statusKind: 'idle',
        statusSince: new Date(NOW).toISOString(),
        scheduledAt: null,
        awaitingPermission: false,
        approvalKey: null,
        updatedAt: new Date(NOW).toISOString(),
      });
      completed = true;
      return result;
    })();

    await Promise.resolve();
    expect(isSessionFollowed('session-1')).toBe(false);
    expect(mocks.releaseAndroidSessionToken).toHaveBeenCalledExactlyOnceWith('session-1');
    expect(completed).toBe(false);
    release.resolve(undefined);
    expect(await ending).toBe(true);
  });

  it('cancels at once an end with no window: the session is gone or out of scope', async () => {
    followSession(RUNNING, CTX, NOW);
    mocks.postSessionCard.mockClear();

    expect(
      await applySessionLiveUpdate(
        'end',
        {
          sessionId: 'session-1',
          title: null,
          statusKind: 'idle',
          statusSince: '2026-10-12T10:05:00.000Z',
          scheduledAt: null,
          awaitingPermission: false,
          approvalKey: null,
          updatedAt: '2026-10-12T10:05:00.000Z',
        },
        0
      )
    ).toBe(true);

    // A posted card with no timeout would stay in the shade and in the store.
    expect(mocks.postSessionCard).not.toHaveBeenCalled();
    expect(mocks.dismissSessionCard).toHaveBeenCalledWith('session-1');
    expect(isSessionFollowed('session-1')).toBe(false);
  });

  it('shows the wake time of a scheduled card, not the time it was drawn', async () => {
    followSession(RUNNING, CTX, NOW);
    await applySessionLiveUpdate('update', {
      sessionId: 'session-1',
      title: 'Nightly dependency audit',
      statusKind: 'scheduled',
      statusSince: '2026-10-12T09:30:00.000Z',
      scheduledAt: '2026-10-12T11:30:00.000Z',
      awaitingPermission: false,
      approvalKey: null,
      updatedAt: '2026-10-12T10:06:00.000Z',
    });

    expect(lastCard()).toMatchObject({
      whenMs: Date.parse('2026-10-12T11:30:00.000Z'),
      chronometer: false,
    });
  });

  it('shows the time a finished card ended, not the time it was drawn', async () => {
    followSession(RUNNING, CTX, NOW);
    mocks.postSessionCard.mockClear();

    await applySessionLiveUpdate(
      'end',
      {
        sessionId: 'session-1',
        title: 'Migrate the billing webhooks',
        statusKind: 'idle',
        statusSince: '2026-10-12T10:05:00.000Z',
        scheduledAt: null,
        awaitingPermission: false,
        approvalKey: null,
        updatedAt: '2026-10-12T10:05:00.000Z',
      },
      900_000
    );

    expect(lastCard()).toMatchObject({
      whenMs: Date.parse('2026-10-12T10:05:00.000Z'),
      chronometer: false,
    });
  });

  it('ignores a push for a session this device does not follow', async () => {
    expect(
      await applySessionLiveUpdate('update', {
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

  it('does not let an out-of-order update undo newer content', async () => {
    followSession(RUNNING, CTX, NOW);
    await applySessionLiveUpdate('update', {
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

    await applySessionLiveUpdate('update', {
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
      await applySessionLiveUpdate('update', {
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
