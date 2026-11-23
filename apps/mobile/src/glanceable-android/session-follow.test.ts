/* eslint-disable max-lines -- one follow-lifecycle suite: the tray carry cases share the native mock harness with the lifecycle cases. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildSessionLiveActivityContentState } from '@kilocode/notifications/schemas';

import { i18n } from '@/i18n';
import {
  _resetLiveActivitySwitchForTests,
  setLiveActivityEnabledValue,
  setNotificationPermissionGrantedValue,
} from '@/lib/glanceable/live-activity-switch';

import {
  _peekFollowedContentForTests,
  _resetSessionFollowForTests,
  applySessionLiveUpdate,
  endAllSessionCards,
  followedSessionCounts,
  followSession,
  getSessionFollowsRevision,
  isSessionFollowed,
  restoreFollowedSessionCards,
  SESSION_FINISHED_DISMISS_MS,
  subscribeSessionFollows,
  syncFollowedSessionCards,
  unfollowSession,
} from './session-follow';
import { restoreFollowedSessionCardsFromStorage } from './session-follow-storage';
import { _setStoredContextReaderForTests } from './session-stored-context';

const mocks = vi.hoisted(() => ({
  postSessionCard: vi.fn(),
  dismissSessionCard: vi.fn<(sessionId: string) => void>(),
  pruneSessionCards: vi.fn(),
  restoreSessionCard: vi.fn(),
  getStoredSessionCards: vi.fn<
    () => {
      sessionId: string;
      userId?: string | null;
      organizationId: string | null;
      approvalKey: string | null;
      finishedUntil?: number;
    }[]
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
  ensureAndroidNotificationChannels: vi.fn(() => Promise.resolve(true)),
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
  ensureAndroidNotificationChannels: mocks.ensureAndroidNotificationChannels,
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
  mocks.ensureAndroidNotificationChannels.mockResolvedValue(true);
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

  it('keeps the facts a push delivered when the tray row omits them', async () => {
    followSession(RUNNING, CTX, NOW);
    const pushed = buildSessionLiveActivityContentState(
      {
        ...RUNNING,
        currentStep: { verb: 'editing', target: 'auth.ts' },
        plan: { done: 1, total: 4, current: 'Read the tests' },
        changes: { files: 2, added: 10, removed: 1 },
        lastActivityAt: '2026-10-12T09:59:00.000Z',
        startedAt: '2026-10-12T09:40:00.000Z',
        costMicrodollars: 840_000,
      },
      {
        approvalKey: null,
        updatedAt: new Date(NOW + 30_000).toISOString(),
        statusSinceFallback: new Date(NOW).toISOString(),
      }
    );
    await applySessionLiveUpdate('update', pushed);
    mocks.postSessionCard.mockClear();

    syncFollowedSessionCards([{ id: 'session-1', status: 'busy' }], NOW + 60_000);

    // The tray row's own facts draw the plan line and the cost so far, from the
    // values the push delivered.
    const card = lastCard();
    expect(card.subText).toBe(i18n.t('glanceable.planProgress', { done: '1', total: '4' }));
    expect(String(card.expandedText)).toContain('0.84');
    // The step, the diff, the start time and the last activity never reach this
    // card, so the followed content is where they survive the rebuild.
    expect(_peekFollowedContentForTests('session-1')).toMatchObject({
      currentStep: { verb: 'editing', target: 'auth.ts' },
      plan: { done: 1, total: 4, current: 'Read the tests' },
      changes: { files: 2, added: 10, removed: 1 },
      lastActivityAt: '2026-10-12T09:59:00.000Z',
      startedAt: '2026-10-12T09:40:00.000Z',
    });
  });

  it('keeps the permission command a push delivered through a waiting tray row', async () => {
    followSession({ ...RUNNING, status: 'permission' }, CTX, NOW);
    const pushed = buildSessionLiveActivityContentState(
      { ...RUNNING, status: 'permission', permissionCommand: 'pnpm test auth' },
      {
        approvalKey: 'a'.repeat(64),
        updatedAt: new Date(NOW + 30_000).toISOString(),
        statusSinceFallback: new Date(NOW).toISOString(),
      }
    );
    await applySessionLiveUpdate('update', pushed);
    mocks.postSessionCard.mockClear();

    syncFollowedSessionCards([{ id: 'session-1', status: 'permission' }], NOW + 60_000);

    expect(lastCard()).toMatchObject({
      text: expect.stringContaining('pnpm test auth'),
      approveLabel: 'Approve',
    });
  });

  it('replaces a remembered fact the row carries', async () => {
    followSession(RUNNING, CTX, NOW);
    const pushed = buildSessionLiveActivityContentState(
      {
        ...RUNNING,
        currentStep: { verb: 'editing', target: 'auth.ts' },
        plan: { done: 1, total: 4, current: 'Read the tests' },
        changes: { files: 2, added: 10, removed: 1 },
        startedAt: '2026-10-12T09:40:00.000Z',
      },
      {
        approvalKey: null,
        updatedAt: new Date(NOW + 30_000).toISOString(),
        statusSinceFallback: new Date(NOW).toISOString(),
      }
    );
    await applySessionLiveUpdate('update', pushed);
    mocks.postSessionCard.mockClear();

    syncFollowedSessionCards(
      [
        {
          id: 'session-1',
          status: 'busy',
          currentStep: { verb: 'running', target: 'schema.ts' },
          plan: { done: 3, total: 4, current: 'Ship the migration' },
        },
      ],
      NOW + 60_000
    );

    expect(_peekFollowedContentForTests('session-1')).toMatchObject({
      currentStep: { verb: 'running', target: 'schema.ts' },
      plan: { done: 3, total: 4, current: 'Ship the migration' },
      // The facts the row omits are still the push's.
      changes: { files: 2, added: 10, removed: 1 },
      startedAt: '2026-10-12T09:40:00.000Z',
    });
    expect(lastCard().subText).toBe(i18n.t('glanceable.planProgress', { done: '3', total: '4' }));
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
  it('cancels a stored card of another organization and re-registers the kept ones', () => {
    followSession(RUNNING, CTX, NOW);
    mocks.getStoredSessionCards.mockReturnValue([
      { sessionId: 'session-1', userId: 'user-1', organizationId: 'org-1', approvalKey: null },
      { sessionId: 'session-7', userId: 'user-1', organizationId: null, approvalKey: null },
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

  it('cancels a stored card of another account in the same organization', () => {
    mocks.getStoredSessionCards.mockReturnValue([
      { sessionId: 'session-1', userId: 'user-2', organizationId: 'org-1', approvalKey: null },
    ]);
    mocks.dismissSessionCard.mockClear();

    restoreFollowedSessionCards(CTX);

    expect(mocks.dismissSessionCard).toHaveBeenCalledWith('session-1');
    expect(mocks.pruneSessionCards).toHaveBeenCalledWith([]);
    expect(isSessionFollowed('session-1')).toBe(false);
    expect(mocks.registerAndroidSessionToken).not.toHaveBeenCalled();
  });

  it('cancels a stored card that carries no account', () => {
    mocks.getStoredSessionCards.mockReturnValue([
      { sessionId: 'session-1', organizationId: 'org-1', approvalKey: null },
    ]);
    mocks.dismissSessionCard.mockClear();

    restoreFollowedSessionCards(CTX);

    expect(mocks.dismissSessionCard).toHaveBeenCalledWith('session-1');
    expect(mocks.registerAndroidSessionToken).not.toHaveBeenCalled();
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
      { sessionId: 'session-1', userId: 'user-1', organizationId: 'org-1', approvalKey: null },
    ]);

    await restoreFollowedSessionCardsFromStorage();

    expect(mocks.pruneSessionCards).toHaveBeenCalledWith(['session-1']);
    expect(mocks.registerAndroidSessionToken).toHaveBeenCalledWith({
      sessionId: 'session-1',
      userId: 'user-1',
      organizationId: 'org-1',
    });
  });

  it('cancels a foreign-scope card before the channel pass, even when it fails', async () => {
    _setStoredContextReaderForTests(() => CTX);
    mocks.ensureAndroidNotificationChannels.mockResolvedValue(false);
    mocks.getStoredSessionCards.mockReturnValue([
      { sessionId: 'session-7', userId: 'user-1', organizationId: null, approvalKey: null },
    ]);

    // The channel pass failed, so the follow set is still unknown.
    await expect(restoreFollowedSessionCardsFromStorage()).resolves.toBe(false);

    // The card another scope left behind is pruned even though the channels could
    // not be created: reconciliation owns the cards, the channel pass only the post.
    expect(mocks.dismissSessionCard).toHaveBeenCalledWith('session-7');
    expect(mocks.pruneSessionCards).toHaveBeenCalledWith([]);
    expect(mocks.ensureAndroidNotificationChannels).toHaveBeenCalledTimes(1);
    expect(mocks.dismissSessionCard.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.ensureAndroidNotificationChannels.mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY
    );
  });

  it('restores a same-scope card only once the channel pass succeeded', async () => {
    _setStoredContextReaderForTests(() => CTX);
    const own = [
      { sessionId: 'session-1', userId: 'user-1', organizationId: 'org-1', approvalKey: null },
    ];
    mocks.getStoredSessionCards.mockReturnValue(own);
    mocks.ensureAndroidNotificationChannels.mockResolvedValue(false);

    // The follow set is still empty, so the result must not claim it is known: a
    // headless push would release a token for a session this device does follow.
    await expect(restoreFollowedSessionCardsFromStorage()).resolves.toBe(false);

    // A card restored before its channel existed would be posted into nothing and
    // never reposted once creation succeeded.
    expect(mocks.restoreSessionCard).not.toHaveBeenCalled();
    expect(mocks.dismissSessionCard).not.toHaveBeenCalledWith('session-1');

    // The next launch reconciles again, and now the card is restored.
    mocks.ensureAndroidNotificationChannels.mockResolvedValue(true);
    await expect(restoreFollowedSessionCardsFromStorage()).resolves.toBe(true);

    expect(mocks.restoreSessionCard).toHaveBeenCalledWith('session-1');
    expect(mocks.ensureAndroidNotificationChannels.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.restoreSessionCard.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
  });
});
