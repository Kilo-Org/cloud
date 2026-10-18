/* eslint-disable max-lines -- one follow-controller suite sharing the fake ActivityKit harness */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GLANCEABLE_STALE_MS } from '@kilocode/app-shared/glanceable-agents-snapshot';
import { sessionLiveActivityRelevance } from '@kilocode/notifications';

import {
  _resetLiveActivitySwitchForTests,
  setLiveActivityEnabledValue,
  setNotificationPermissionGrantedValue,
} from '@/lib/glanceable/live-activity-switch';

import {
  _resetSessionFollowForTests,
  discoverSessionCards,
  dismissFinishedSessionCard,
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
import { sessionCardStaleAfterSeconds } from './session-card-facts';
import {
  renderSessionCardPress,
  SESSION_CARD_STALE_AFTER_SECONDS,
  type SessionActivity,
  sessionCardPress,
} from './session-card-press';

type Props = Record<string, unknown>;
type FakeActivity = {
  state: 'active' | 'stale' | 'ended' | 'dismissed';
  props: Props;
  getId: () => string;
  getInfo: () => { id: string; state: FakeActivity['state'] };
  getProps: () => Props;
  getPushToken: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
};

const mocks = vi.hoisted(() => ({
  instances: [] as FakeActivity[],
  startError: null as Error | null,
  start: vi.fn(),
  getInstances: vi.fn(),
  systemAllowed: true,
  registerSessionActivityToken: vi.fn(),
  releaseSessionActivity: vi.fn<(id: string) => string | null>(() => null),
  retrySessionActivityTokens: vi.fn(),
  observedSessionActivityIds: vi.fn<() => string[]>(() => []),
  deleteSessionActivityToken: vi.fn(),
  cleanupTokens: vi.fn(),
}));

function fakeActivity(id: string, props: Props): FakeActivity {
  const activity: FakeActivity = {
    state: 'active',
    props,
    getId: () => id,
    getInfo: () => ({ id, state: activity.state }),
    getProps: () => activity.props,
    getPushToken: vi.fn(async () => {
      await Promise.resolve();
      return `token-${id}`;
    }),
    update: vi.fn(async (next: Props) => {
      await Promise.resolve();
      activity.props = next;
    }),
    end: vi.fn(async (policy: unknown, next?: Props) => {
      await Promise.resolve();
      activity.state = policy === 'immediate' ? 'dismissed' : 'ended';
      if (next !== undefined) {
        activity.props = next;
      }
    }),
  };
  return activity;
}

vi.mock('expo-widgets', () => ({ after: (date: Date) => ({ after: date }) }));
vi.mock('./session-live-activity', () => ({
  SessionLiveActivity: { start: mocks.start, getInstances: mocks.getInstances },
}));
vi.mock('./system-switch', () => ({ liveActivitiesAllowedBySystem: () => mocks.systemAllowed }));
vi.mock('@/lib/glanceable/session-activity-tokens', () => ({
  registerSessionActivityToken: mocks.registerSessionActivityToken,
  releaseSessionActivity: mocks.releaseSessionActivity,
  retrySessionActivityTokens: mocks.retrySessionActivityTokens,
  observedSessionActivityIds: mocks.observedSessionActivityIds,
  deleteSessionActivityToken: mocks.deleteSessionActivityToken,
}));
vi.mock('@/lib/glanceable/sink-registry', () => ({
  getGlanceableDelivery: () => ({ cleanupTokens: mocks.cleanupTokens }),
}));

const NOW = Date.parse('2026-10-12T10:00:00.000Z');
const CTX = { userId: 'user-1', organizationId: 'org-1' };
const RUNNING = {
  id: 'session-1',
  title: 'Migrate the billing webhooks',
  status: 'busy',
  statusUpdatedAt: '2026-10-12T09:48:00.000Z',
};

function startFake(props: Props): FakeActivity {
  if (mocks.startError !== null) {
    throw mocks.startError;
  }
  const activity = fakeActivity(`activity-${mocks.instances.length}`, props);
  mocks.instances.push(activity);
  return activity;
}

function listFakes(includeEnded = false): FakeActivity[] {
  return mocks.instances.filter(
    activity =>
      activity.state === 'active' ||
      activity.state === 'stale' ||
      (includeEnded && activity.state === 'ended')
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.start.mockImplementation(startFake);
  mocks.getInstances.mockImplementation(listFakes);
  mocks.releaseSessionActivity.mockReturnValue(null);
  mocks.observedSessionActivityIds.mockReturnValue([]);
  mocks.instances = [];
  mocks.startError = null;
  mocks.systemAllowed = true;
  _resetSessionFollowForTests();
  _resetLiveActivitySwitchForTests();
  setNotificationPermissionGrantedValue(true);
});

describe('followSession', () => {
  it('starts one collapsed card for the session and registers its token', () => {
    const listener = vi.fn<() => void>();
    subscribeSessionFollows(listener);

    expect(followSession(RUNNING, CTX, NOW)).toBe('started');

    const content = mocks.start.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(content).toMatchObject({
      sessionId: 'session-1',
      title: 'Migrate the billing webhooks',
      statusKind: 'running',
      statusSince: '2026-10-12T09:48:00.000Z',
      scheduledAt: null,
      awaitingPermission: false,
      approvalKey: null,
      updatedAt: '2026-10-12T10:00:00.000Z',
    });
    expect(mocks.start).toHaveBeenCalledWith(
      content,
      'kiloapp:///cloud/sessions/session-1',
      GLANCEABLE_STALE_MS / 1000,
      sessionLiveActivityRelevance('running', RUNNING.statusUpdatedAt)
    );
    expect(mocks.registerSessionActivityToken).toHaveBeenCalledWith(
      'activity-0',
      mocks.instances[0],
      { sessionId: 'session-1', ...CTX }
    );
    expect(isSessionFollowed('session-1')).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('never starts a second card for a followed session', () => {
    followSession(RUNNING, CTX, NOW);

    expect(followSession(RUNNING, CTX, NOW)).toBe('followed');
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });

  it('stays unfollowed when iOS refuses the start', () => {
    mocks.startError = new Error('maximum number of activities');

    expect(followSession(RUNNING, CTX, NOW)).toBe('refused');
    expect(isSessionFollowed('session-1')).toBe(false);
    expect(mocks.registerSessionActivityToken).not.toHaveBeenCalled();
  });

  it('refuses without a start while a switch forbids Live Activities', () => {
    setLiveActivityEnabledValue(false);
    expect(followSession(RUNNING, CTX, NOW)).toBe('refused');
    setLiveActivityEnabledValue(true);
    setNotificationPermissionGrantedValue(false);
    expect(followSession(RUNNING, CTX, NOW)).toBe('refused');
    setNotificationPermissionGrantedValue(true);
    mocks.systemAllowed = false;
    expect(followSession(RUNNING, CTX, NOW)).toBe('refused');
    // A finished session is never followed.
    mocks.systemAllowed = true;
    expect(followSession({ ...RUNNING, status: 'idle' }, CTX, NOW)).toBe('refused');

    expect(mocks.start).not.toHaveBeenCalled();
  });
});

describe('unfollowSession', () => {
  it('ends the card at once and releases its token', async () => {
    followSession(RUNNING, CTX, NOW);
    const [card] = mocks.instances;

    unfollowSession('session-1');

    expect(card?.end).toHaveBeenCalledWith('immediate', undefined, expect.any(Date), undefined);
    expect(mocks.releaseSessionActivity).toHaveBeenCalledWith('activity-0');
    expect(mocks.cleanupTokens).toHaveBeenCalledWith('session', expect.any(Promise));
    await expect(mocks.cleanupTokens.mock.calls[0]?.[1]).resolves.toBe('token-activity-0');
    expect(isSessionFollowed('session-1')).toBe(false);
  });
});

describe('discoverSessionCards', () => {
  it('rebuilds the map from content props and ends a duplicate card', () => {
    const first = fakeActivity('native-1', { sessionId: 'session-1', statusKind: 'running' });
    const duplicate = fakeActivity('native-2', { sessionId: 'session-1', statusKind: 'running' });
    const other = fakeActivity('native-3', { sessionId: 'session-2', statusKind: 'needsInput' });
    mocks.instances = [first, duplicate, other];

    discoverSessionCards();

    expect(isSessionFollowed('session-1')).toBe(true);
    expect(isSessionFollowed('session-2')).toBe(true);
    expect(first.end).not.toHaveBeenCalled();
    expect(duplicate.end).toHaveBeenCalledWith('immediate', undefined, expect.any(Date), undefined);
  });

  it('registers every discovered card again when the account is known', () => {
    mocks.instances = [fakeActivity('native-1', { sessionId: 'session-1' })];

    restoreFollowedSessionCards(null);
    expect(mocks.registerSessionActivityToken).not.toHaveBeenCalled();

    restoreFollowedSessionCards(CTX);
    expect(mocks.registerSessionActivityToken).toHaveBeenCalledWith(
      'native-1',
      mocks.instances[0],
      { sessionId: 'session-1', ...CTX }
    );
    expect(mocks.retrySessionActivityTokens).toHaveBeenCalled();
  });
});

describe('syncFollowedSessionCards', () => {
  it('updates a card only when what it draws changes', () => {
    followSession(RUNNING, CTX, NOW);
    const [card] = mocks.instances;

    syncFollowedSessionCards([RUNNING], NOW + 60_000);
    expect(card?.update).not.toHaveBeenCalled();

    const waiting = {
      ...RUNNING,
      status: 'permission',
      statusUpdatedAt: '2026-10-12T10:01:00.000Z',
    };
    syncFollowedSessionCards([waiting], NOW + 60_000);
    expect(card?.update).toHaveBeenCalledWith(
      expect.objectContaining({ statusKind: 'needsInput', statusSince: waiting.statusUpdatedAt }),
      GLANCEABLE_STALE_MS / 1000,
      sessionLiveActivityRelevance('needsInput', waiting.statusUpdatedAt)
    );
  });

  it('ends a finished session with the Finished content for 15 minutes', () => {
    followSession(RUNNING, CTX, NOW);
    const [card] = mocks.instances;
    const finished = { ...RUNNING, status: 'idle', statusUpdatedAt: '2026-10-12T10:05:00.000Z' };

    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    syncFollowedSessionCards([finished], NOW);

    expect(card?.end).toHaveBeenCalledWith(
      { after: new Date(now + SESSION_FINISHED_DISMISS_MS) },
      expect.objectContaining({ statusKind: 'idle', statusSince: finished.statusUpdatedAt }),
      expect.any(Date),
      sessionLiveActivityRelevance('idle', finished.statusUpdatedAt)
    );
    vi.restoreAllMocks();
    expect(mocks.cleanupTokens).toHaveBeenCalledWith('session', expect.any(Promise));
    expect(isSessionFollowed('session-1')).toBe(false);
  });

  it('ends a failed session with its stop reason for 15 minutes', () => {
    followSession(RUNNING, CTX, NOW);
    const [card] = mocks.instances;
    const failed = {
      ...RUNNING,
      status: 'idle',
      statusUpdatedAt: '2026-10-12T10:05:00.000Z',
      failure: 'provider' as const,
      changes: { files: 3, added: 12, removed: 4 },
    };

    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    syncFollowedSessionCards([failed], NOW);

    // The fixture's finish path ends the card with the stop reason, not with
    // a plain Finished card and a later update that finds no card.
    expect(card?.end).toHaveBeenCalledWith(
      { after: new Date(now + SESSION_FINISHED_DISMISS_MS) },
      expect.objectContaining({
        statusKind: 'failed',
        failure: { kind: 'provider' },
        changes: { files: 3, added: 12, removed: 4 },
      }),
      expect.any(Date),
      sessionLiveActivityRelevance('failed', failed.statusUpdatedAt)
    );
    vi.restoreAllMocks();
    expect(card?.update).not.toHaveBeenCalled();
    expect(isSessionFollowed('session-1')).toBe(false);
  });

  it('leaves a card whose session the tray no longer lists to the server', () => {
    followSession(RUNNING, CTX, NOW);
    const [card] = mocks.instances;

    syncFollowedSessionCards([], NOW);

    expect(card?.update).not.toHaveBeenCalled();
    expect(card?.end).not.toHaveBeenCalled();
  });
});

describe('endAllSessionCards', () => {
  it('ends every session card, including an ended one still on screen', () => {
    followSession(RUNNING, CTX, NOW);
    const finished = fakeActivity('native-9', { sessionId: 'session-9', statusKind: 'idle' });
    finished.state = 'ended';
    mocks.instances.push(finished);

    endAllSessionCards();

    for (const card of mocks.instances) {
      expect(card.end).toHaveBeenCalledWith('immediate');
    }
    expect(isSessionFollowed('session-1')).toBe(false);
    // The caller retires the whole token scope; no per-card delete runs here.
    expect(mocks.cleanupTokens).not.toHaveBeenCalled();
  });
});

describe('dismissFinishedSessionCard', () => {
  it('dismisses a finished card at once and keeps a live one', () => {
    const live = fakeActivity('native-1', { sessionId: 'session-1', statusKind: 'running' });
    const finished = fakeActivity('native-2', { sessionId: 'session-2', statusKind: 'idle' });
    finished.state = 'ended';
    mocks.instances = [live, finished];

    dismissFinishedSessionCard('session-1');
    dismissFinishedSessionCard('session-2');

    expect(live.end).not.toHaveBeenCalled();
    expect(finished.end).toHaveBeenCalledWith('immediate', undefined, expect.any(Date), undefined);
  });

  it('drops the press state of the dismissed card', async () => {
    const card = fakeActivity('native-3', { sessionId: 'session-3', statusKind: 'needsInput' });
    mocks.instances = [card];
    discoverSessionCards();
    await renderSessionCardPress(card as unknown as SessionActivity, { notice: 'Approve failed' });
    expect(sessionCardPress('session-3')).toEqual({ notice: 'Approve failed' });
    card.props = { ...card.props, statusKind: 'idle' };

    dismissFinishedSessionCard('session-3');

    expect(isSessionFollowed('session-3')).toBe(false);
    expect(sessionCardPress('session-3')).toBeUndefined();
  });

  it('drops the press state of a card iOS ended', async () => {
    const card = fakeActivity('native-4', { sessionId: 'session-4', statusKind: 'needsInput' });
    mocks.instances = [card];
    discoverSessionCards();
    await renderSessionCardPress(card as unknown as SessionActivity, { notice: 'Approve failed' });

    mocks.instances = [];
    discoverSessionCards();

    expect(isSessionFollowed('session-4')).toBe(false);
    expect(sessionCardPress('session-4')).toBeUndefined();
  });
});

describe('followedSessionCounts', () => {
  it('counts each live followed card by status kind', () => {
    mocks.instances = [
      fakeActivity('native-1', { sessionId: 's1', statusKind: 'running' }),
      fakeActivity('native-2', {
        sessionId: 's2',
        statusKind: 'needsInput',
        awaitingPermission: true,
      }),
      fakeActivity('native-3', { sessionId: 's3', statusKind: 'scheduled' }),
    ];
    discoverSessionCards();

    expect(followedSessionCounts()).toEqual({
      running: 1,
      needsInput: 1,
      needsApproval: 1,
      idle: 0,
      scheduled: 1,
    });
  });
});

describe('session card tokens', () => {
  it('deletes the reported token of a known card that is no longer live', () => {
    followSession(RUNNING, CTX, NOW);
    const [card] = mocks.instances;
    if (card === undefined) {
      throw new Error('expected a card');
    }
    // The server ended the card and iOS dismissed it while the app was away.
    card.state = 'dismissed';
    mocks.observedSessionActivityIds.mockReturnValue(['activity-0', 'activity-gone']);
    mocks.releaseSessionActivity.mockImplementation(id => `reported-${id}`);

    discoverSessionCards();

    expect(mocks.releaseSessionActivity).toHaveBeenCalledWith('activity-0');
    expect(mocks.releaseSessionActivity).toHaveBeenCalledWith('activity-gone');
    expect(mocks.deleteSessionActivityToken.mock.calls).toEqual([
      ['reported-activity-0'],
      ['reported-activity-gone'],
    ]);
    expect(isSessionFollowed('session-1')).toBe(false);
  });

  it('changes nothing when ActivityKit cannot be read', () => {
    followSession(RUNNING, CTX, NOW);
    mocks.getInstances.mockImplementation(() => {
      throw new Error('ActivityKit unavailable');
    });

    discoverSessionCards();

    expect(mocks.releaseSessionActivity).not.toHaveBeenCalled();
    expect(isSessionFollowed('session-1')).toBe(true);
  });

  it('falls back to the reported token when the native read has none', async () => {
    followSession(RUNNING, CTX, NOW);
    const [card] = mocks.instances;
    card?.getPushToken.mockResolvedValue(null);
    mocks.releaseSessionActivity.mockReturnValue('reported-token');

    unfollowSession('session-1');

    await expect(mocks.cleanupTokens.mock.calls[0]?.[1]).resolves.toBe('reported-token');
  });

  it('retires the token scope before ending the cards when the switch is off at restore', () => {
    followSession(RUNNING, CTX, NOW);
    const [card] = mocks.instances;
    setLiveActivityEnabledValue(false);

    restoreFollowedSessionCards(CTX);

    expect(mocks.cleanupTokens).toHaveBeenCalledWith('scope');
    expect(card?.end).toHaveBeenCalledWith('immediate');
    expect(mocks.cleanupTokens.mock.invocationCallOrder[0]).toBeLessThan(
      card?.end.mock.invocationCallOrder[0] ?? 0
    );
  });
});

describe('syncFollowedSessionCards against a newer push', () => {
  it('keeps the pushed content when the row is older than the card', () => {
    followSession(RUNNING, CTX, NOW);
    const [card] = mocks.instances;
    if (card === undefined) {
      throw new Error('expected a card');
    }
    // A push moved the card into a permission wait with its approval key.
    card.props = {
      ...card.props,
      statusKind: 'needsInput',
      statusSince: '2026-10-12T10:02:00.000Z',
      awaitingPermission: true,
      approvalKey: 'c'.repeat(64),
    };

    syncFollowedSessionCards([RUNNING], NOW + 60_000);

    expect(card.update).not.toHaveBeenCalled();
    expect(card.end).not.toHaveBeenCalled();
  });
});

describe('follow revision and card freshness', () => {
  it('moves the revision on every real change', () => {
    const before = getSessionFollowsRevision();
    followSession(RUNNING, CTX, NOW);
    expect(getSessionFollowsRevision()).toBeGreaterThan(before);
  });

  it('keeps the shared stale window unless a working card just went quiet', () => {
    expect(sessionCardStaleAfterSeconds({ statusKind: 'idle' }, NOW)).toBe(
      SESSION_CARD_STALE_AFTER_SECONDS
    );
    expect(sessionCardStaleAfterSeconds({ statusKind: 'running' }, NOW)).toBe(
      SESSION_CARD_STALE_AFTER_SECONDS
    );
    // Just active: the card may not claim to be current past its quiet window.
    const active = { statusKind: 'running' as const, lastActivityAt: new Date(NOW).toISOString() };
    expect(sessionCardStaleAfterSeconds(active, NOW)).toBeLessThanOrEqual(
      SESSION_CARD_STALE_AFTER_SECONDS
    );
    // Quiet long ago: it is stale now.
    expect(sessionCardStaleAfterSeconds(active, NOW + 60 * 60_000)).toBe(0);
  });
});
