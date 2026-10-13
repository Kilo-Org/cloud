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
  endAllSessionCards,
  followSession,
  isSessionFollowed,
  restoreFollowedSessionCards,
  restoreFollowedSessionCardsFromStorage,
  syncFollowedSessionCards,
  unfollowDismissedSession,
  unfollowSession,
} from './session-follow';
import { _setStoredContextReaderForTests } from './session-stored-context';

const mocks = vi.hoisted(() => ({
  postSessionCard: vi.fn(),
  dismissSessionCard: vi.fn(),
  pruneSessionCards: vi.fn(),
  restoreSessionCard: vi.fn(),
  getStoredSessionCards: vi.fn<
    () => {
      sessionId: string;
      organizationId: string | null;
      approvalKey: string | null;
      finishedUntil?: number;
    }[]
  >(() => []),
  registerAndroidSessionToken: vi.fn(async () => {
    await Promise.resolve();
  }),
  releaseAndroidSessionToken: vi.fn(async (_sessionId: string) => {
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

vi.mock('@/lib/glanceable/approve-ask', () => ({ runGlanceableApprove: vi.fn() }));

vi.mock('./count-format', () => ({
  formatGlanceableClock: (at: string) => at.slice(11, 16),
  formatGlanceableCount: String,
}));

const NOW = Date.parse('2026-10-12T10:00:00.000Z');
const CTX = { userId: 'user-1', organizationId: 'org-1' };
const ROW = {
  id: 'session-1',
  title: 'Migrate the billing webhooks',
  status: 'busy',
  statusUpdatedAt: '2026-10-12T09:48:00.000Z',
};
const FINISHED = {
  sessionId: 'session-1',
  title: 'Migrate the billing webhooks',
  statusKind: 'idle' as const,
  statusSince: '2026-10-12T10:05:00.000Z',
  scheduledAt: null,
  awaitingPermission: false,
  approvalKey: null,
  updatedAt: '2026-10-12T10:05:00.000Z',
};

/** The session ids released so far, in call order. */
function released(): string[] {
  return mocks.releaseAndroidSessionToken.mock.calls.map(([sessionId]) => sessionId);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getStoredSessionCards.mockReturnValue([]);
  _resetSessionFollowForTests();
  _setStoredContextReaderForTests(null);
  _resetLiveActivitySwitchForTests();
  setLiveActivityEnabledValue(true);
  setNotificationPermissionGrantedValue(true);
  followSession(ROW, CTX, NOW);
});

describe('every end path releases the session row', () => {
  it('a server end with the finished window', async () => {
    await applySessionLiveUpdate('end', FINISHED, 900_000);
    expect(isSessionFollowed('session-1')).toBe(false);
    expect(released()).toEqual(['session-1']);
  });

  it('a server end at once (the session is gone or out of scope)', async () => {
    await applySessionLiveUpdate('end', { ...FINISHED, title: null }, 0);
    expect(released()).toEqual(['session-1']);
  });

  it('a tray read that finds the session finished', () => {
    syncFollowedSessionCards([{ ...ROW, status: 'idle' }], NOW + 60_000);
    expect(isSessionFollowed('session-1')).toBe(false);
    expect(released()).toEqual(['session-1']);
  });

  it('opening a finished session', async () => {
    // A rebuilt or finished follow: the content says the session finished.
    await applySessionLiveUpdate('update', { ...FINISHED, statusKind: 'failed' });
    mocks.releaseAndroidSessionToken.mockClear();

    dismissFinishedSessionCard('session-1');

    expect(mocks.dismissSessionCard).toHaveBeenCalledWith('session-1');
    expect(released()).toEqual(['session-1']);
  });

  it('but opening a session this device does not follow deletes no row', () => {
    // Another device's or another surface's follow: its row is not this device's.
    dismissFinishedSessionCard('session-9');

    expect(mocks.dismissSessionCard).toHaveBeenCalledWith('session-9');
    expect(mocks.releaseAndroidSessionToken).not.toHaveBeenCalled();
  });

  it('nor does opening a finished session whose end already released its row', async () => {
    await applySessionLiveUpdate('end', FINISHED, 900_000);
    mocks.releaseAndroidSessionToken.mockClear();

    dismissFinishedSessionCard('session-1');

    expect(mocks.dismissSessionCard).toHaveBeenCalledWith('session-1');
    expect(mocks.releaseAndroidSessionToken).not.toHaveBeenCalled();
  });

  it('an Unfollow and a dismissal', async () => {
    unfollowSession('session-1');
    expect(released()).toEqual(['session-1']);

    followSession({ ...ROW, id: 'session-2' }, CTX, NOW);
    await unfollowDismissedSession('session-2');
    expect(released()).toEqual(['session-1', 'session-2']);
  });

  it('a teardown (sign-out, an account or organization change, the switch off)', () => {
    followSession({ ...ROW, id: 'session-2' }, CTX, NOW);

    endAllSessionCards();

    expect(mocks.pruneSessionCards).toHaveBeenCalledWith([]);
    expect(released().toSorted((a, b) => a.localeCompare(b))).toEqual(['session-1', 'session-2']);
  });

  it('a restore that finds the follow gone from native storage', () => {
    mocks.getStoredSessionCards.mockReturnValue([]);

    restoreFollowedSessionCards(CTX, NOW);

    expect(isSessionFollowed('session-1')).toBe(false);
    expect(released()).toEqual(['session-1']);
  });
});

describe('restoreFollowedSessionCardsFromStorage', () => {
  it('cancels nothing when the keychain cannot be read, and says so', async () => {
    mocks.getStoredSessionCards.mockReturnValue([
      { sessionId: 'session-1', organizationId: 'org-1', approvalKey: null },
    ]);
    _setStoredContextReaderForTests(() => 'unavailable');

    await expect(restoreFollowedSessionCardsFromStorage()).resolves.toBe(false);

    expect(mocks.dismissSessionCard).not.toHaveBeenCalled();
    expect(mocks.pruneSessionCards).not.toHaveBeenCalled();
    expect(mocks.releaseAndroidSessionToken).not.toHaveBeenCalled();
    expect(isSessionFollowed('session-1')).toBe(true);
  });

  it('ends every follow when the keychain says no account is signed in', async () => {
    mocks.getStoredSessionCards.mockReturnValue([
      { sessionId: 'session-1', organizationId: 'org-1', approvalKey: null },
    ]);
    _setStoredContextReaderForTests(() => null);

    await expect(restoreFollowedSessionCardsFromStorage()).resolves.toBe(true);

    expect(mocks.dismissSessionCard).toHaveBeenCalledWith('session-1');
    expect(isSessionFollowed('session-1')).toBe(false);
  });
});

describe('a finished card in its window', () => {
  it('stays cancelable by a teardown but never follows again', () => {
    _resetSessionFollowForTests();
    vi.clearAllMocks();
    mocks.getStoredSessionCards.mockReturnValue([
      {
        sessionId: 'session-1',
        organizationId: 'org-1',
        approvalKey: null,
        finishedUntil: NOW + 60_000,
      },
    ]);

    restoreFollowedSessionCards(CTX, NOW);

    expect(isSessionFollowed('session-1')).toBe(false);
    expect(mocks.registerAndroidSessionToken).not.toHaveBeenCalled();
    // Kept in the store, so the next prune or teardown can still cancel it.
    expect(mocks.pruneSessionCards).toHaveBeenCalledWith(['session-1']);
    expect(mocks.dismissSessionCard).not.toHaveBeenCalled();
  });

  it('is removed once its window passed (API 24-25 has no system timeout)', () => {
    _resetSessionFollowForTests();
    mocks.getStoredSessionCards.mockReturnValue([
      { sessionId: 'session-1', organizationId: 'org-1', approvalKey: null, finishedUntil: NOW },
    ]);

    restoreFollowedSessionCards(CTX, NOW);

    expect(mocks.dismissSessionCard).toHaveBeenCalledWith('session-1');
    expect(mocks.pruneSessionCards).toHaveBeenCalledWith([]);
  });

  it('is cancelled with the others on a sign-out restore', () => {
    _resetSessionFollowForTests();
    mocks.getStoredSessionCards.mockReturnValue([
      {
        sessionId: 'session-1',
        organizationId: 'org-1',
        approvalKey: null,
        finishedUntil: NOW + 60_000,
      },
    ]);

    restoreFollowedSessionCards(null, NOW);

    expect(mocks.dismissSessionCard).toHaveBeenCalledWith('session-1');
  });
});
