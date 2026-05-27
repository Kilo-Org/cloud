import type { UserWebSessionEventData } from '@/lib/cloud-agent-sdk';
import type { DbSessionV2 } from '../store/db-session-atoms';
import {
  createSidebarQueryReconciler,
  dbSessionToStoredSession,
  dbSessionMatchesSearch,
  eventRowMatchesSidebarFilters,
  removeSidebarDbSession,
  SIDEBAR_RECONCILE_DELAY_MS,
  upsertSidebarDbSession,
} from './useSidebarSessions';

function makeDbSession(sessionId: string, updatedAt: string): DbSessionV2 {
  return {
    session_id: sessionId,
    title: sessionId,
    cloud_agent_session_id: null,
    created_on_platform: 'web',
    organization_id: null,
    git_url: 'https://github.com/kilo/repo',
    git_branch: 'main',
    parent_session_id: null,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date(updatedAt),
    version: 2,
    status: 'idle',
    status_updated_at: null,
  };
}

function makeEventRow(overrides?: Partial<UserWebSessionEventData<'session.created'>['session']>) {
  return {
    source: 'v2',
    sessionId: 'ses_root',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    title: 'Root',
    createdOnPlatform: 'web',
    organizationId: null,
    gitUrl: 'https://github.com/kilo/repo',
    gitBranch: 'main',
    parentSessionId: null,
    status: 'idle',
    statusUpdatedAt: null,
    ...overrides,
  } satisfies UserWebSessionEventData<'session.created'>['session'];
}

describe('useSidebarSessions live update helpers', () => {
  it('preserves updated_at descending order when patching a visible row', () => {
    const newest = makeDbSession('ses_newest', '2026-01-03T00:00:00.000Z');
    const middle = makeDbSession('ses_middle', '2026-01-02T00:00:00.000Z');
    const olderPatch = makeDbSession('ses_older_patch', '2026-01-01T00:00:00.000Z');

    const result = upsertSidebarDbSession([newest, middle], olderPatch);

    expect(result.map(session => session.session_id)).toEqual([
      'ses_newest',
      'ses_middle',
      'ses_older_patch',
    ]);
  });

  it('moves a patched row according to updated_at instead of prepending blindly', () => {
    const newest = makeDbSession('ses_newest', '2026-01-03T00:00:00.000Z');
    const stale = makeDbSession('ses_stale', '2026-01-01T00:00:00.000Z');
    const refreshed = makeDbSession('ses_stale', '2026-01-04T00:00:00.000Z');

    const result = upsertSidebarDbSession([newest, stale], refreshed);

    expect(result.map(session => session.session_id)).toEqual(['ses_stale', 'ses_newest']);
  });

  it('preserves fetched Cloud Agent and PR fields when a live row patches the session', () => {
    const associatedPr = {
      url: 'https://github.com/kilo/repo/pull/42',
      number: 42,
      state: 'open',
      title: 'Realtime sidebar',
      headSha: 'abc123',
      lastSyncedAt: '2026-01-01T00:00:00.000Z',
      reviewDecision: 'approved' as const,
      reviewDecisionPending: false,
    };
    const cached = {
      ...makeDbSession('ses_cached', '2026-01-01T00:00:00.000Z'),
      cloud_agent_session_id: 'agent_123',
      associatedPr,
    };
    const livePatch = {
      ...makeDbSession('ses_cached', '2026-01-04T00:00:00.000Z'),
      title: 'Updated live title',
      status: 'busy',
    };

    const result = upsertSidebarDbSession([cached], livePatch);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      title: 'Updated live title',
      status: 'busy',
      cloud_agent_session_id: 'agent_123',
      associatedPr,
    });
  });

  it('removes deleted rows immediately from the visible list', () => {
    const result = removeSidebarDbSession(
      [
        makeDbSession('ses_keep', '2026-01-02T00:00:00.000Z'),
        makeDbSession('ses_delete', '2026-01-01T00:00:00.000Z'),
      ],
      'ses_delete'
    );

    expect(result.map(session => session.session_id)).toEqual(['ses_keep']);
  });

  it('excludes child session rows from root-only sidebar filters', () => {
    const result = eventRowMatchesSidebarFilters(
      makeEventRow({ parentSessionId: 'ses_parent' }),
      {}
    );

    expect(result).toBe(false);
  });

  it('treats the platform other filter as unsafe for local-only patching', () => {
    const result = eventRowMatchesSidebarFilters(makeEventRow(), { createdOnPlatform: 'other' });

    expect(result).toBeNull();
  });

  it('preserves associated PR data from fetched sidebar rows', () => {
    const session = {
      ...makeDbSession('ses_with_pr', '2026-01-01T00:00:00.000Z'),
      associatedPr: {
        url: 'https://github.com/kilo/repo/pull/42',
        number: 42,
        state: 'open',
        title: 'Realtime sidebar',
        headSha: 'abc123',
        lastSyncedAt: '2026-01-01T00:00:00.000Z',
        reviewDecision: 'approved' as const,
        reviewDecisionPending: false,
      },
    };

    expect(dbSessionToStoredSession(session).associatedPr).toEqual(session.associatedPr);
  });

  describe('dbSessionMatchesSearch', () => {
    it('matches by session_id substring', () => {
      const session = makeDbSession('abc-123-def', '2026-01-01T00:00:00.000Z');
      expect(dbSessionMatchesSearch(session, '123')).toBe(true);
    });

    it('matches by title substring (case-insensitive)', () => {
      const session = makeDbSession('ses-1', '2026-01-01T00:00:00.000Z');
      const withTitle = { ...session, title: 'Hello World' };
      expect(dbSessionMatchesSearch(withTitle, 'world')).toBe(true);
    });

    it('returns false when neither session_id nor title matches', () => {
      const session = makeDbSession('ses-1', '2026-01-01T00:00:00.000Z');
      expect(dbSessionMatchesSearch(session, 'zzz')).toBe(false);
    });
  });

  describe('createSidebarQueryReconciler', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('coalesces status event bursts into one delayed authoritative reconciliation', () => {
      const reconcile = jest.fn();
      const reconciler = createSidebarQueryReconciler(reconcile);

      reconciler.schedule();
      reconciler.schedule();
      jest.advanceTimersByTime(SIDEBAR_RECONCILE_DELAY_MS - 1);
      expect(reconcile).not.toHaveBeenCalled();

      jest.advanceTimersByTime(1);
      expect(reconcile).toHaveBeenCalledTimes(1);

      reconciler.schedule();
      jest.advanceTimersByTime(SIDEBAR_RECONCILE_DELAY_MS);
      expect(reconcile).toHaveBeenCalledTimes(2);
    });

    it('reconciles immediately after reconnect without running a pending delayed refresh', () => {
      const reconcile = jest.fn();
      const reconciler = createSidebarQueryReconciler(reconcile);

      reconciler.schedule();
      reconciler.reconcileNow();
      expect(reconcile).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(SIDEBAR_RECONCILE_DELAY_MS);
      expect(reconcile).toHaveBeenCalledTimes(1);
    });

    it('cancels pending reconciliation when its listener owner is disposed', () => {
      const reconcile = jest.fn();
      const reconciler = createSidebarQueryReconciler(reconcile);

      reconciler.schedule();
      reconciler.dispose();
      jest.advanceTimersByTime(SIDEBAR_RECONCILE_DELAY_MS);

      expect(reconcile).not.toHaveBeenCalled();
    });
  });
});
