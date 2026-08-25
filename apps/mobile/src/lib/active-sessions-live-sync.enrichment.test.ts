import { describe, expect, it, vi } from 'vitest';

import * as sessionsLive from '@/lib/active-sessions-live';
import {
  ActiveSessionsLiveSync,
  makeCached,
  makeConnection,
  makeFakeQueryClient,
  makeQueryFn,
  QUERY_KEY,
  setupNow,
  setupTimers,
  type SystemEvent,
} from '@/lib/active-sessions-live-sync.test-helpers';

setupTimers();

describe('ActiveSessionsLiveSync — enrichment retry policy', () => {
  it('schedules enrichment when the cache has an unenriched live id', async () => {
    const conn = makeConnection();
    const qc = makeFakeQueryClient();
    qc.__setCached({ sessions: [makeCached({ id: 'a' })] });
    const queryFn = makeQueryFn();
    const sync = new ActiveSessionsLiveSync({
      connection: conn,
      queryClient: qc,
      queryKey: QUERY_KEY,
      queryFn,
    });
    sync.attach();
    const heartbeat: SystemEvent = {
      event: 'sessions.heartbeat',
      data: {
        connectionId: 'c1',
        sessions: [{ id: 'a', status: 'running', title: 'A' }],
      },
    };
    conn.__fireSystem(heartbeat);
    await sync.getWriteQueue();
    await sync.getFetchQueue();
    expect(sync.getPendingReasons().has('enrichment')).toBe(true);
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it('a failed enrichment retry is dropped once the id enriches or leaves', async () => {
    const conn = makeConnection();
    const qc = makeFakeQueryClient();
    qc.__setCached({ sessions: [makeCached({ id: 'a' })] });
    const queryFn = makeQueryFn();
    const sync = new ActiveSessionsLiveSync({
      connection: conn,
      queryClient: qc,
      queryKey: QUERY_KEY,
      queryFn,
    });
    sync.attach();
    const heartbeat: SystemEvent = {
      event: 'sessions.heartbeat',
      data: {
        connectionId: 'c1',
        sessions: [{ id: 'a', status: 'running', title: 'A' }],
      },
    };
    conn.__fireSystem(heartbeat);
    await sync.getWriteQueue();
    await sync.getFetchQueue();
    expect(sync.getPendingReasons().has('enrichment')).toBe(true);
    // The enrichment fetch fails. The reason stays pending for now.
    qc.__triggerFetchReject(new Error('network down'));
    await sync.getFetchCompletion();
    expect(sync.getPendingReasons().has('enrichment')).toBe(true);
    expect(queryFn).toHaveBeenCalledTimes(1);
    // A later heartbeat no longer reports the unenriched id, so the
    // stale enrichment reason is cleared and cannot drive retries.
    const emptyHeartbeat: SystemEvent = {
      event: 'sessions.heartbeat',
      data: { connectionId: 'c1', sessions: [] },
    };
    conn.__fireSystem(emptyHeartbeat);
    await sync.getWriteQueue();
    expect(sync.getPendingReasons().has('enrichment')).toBe(false);
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it('does NOT schedule enrichment when every row is already enriched', async () => {
    const conn = makeConnection();
    const qc = makeFakeQueryClient();
    qc.__setCached({ sessions: [makeCached({ id: 'a', createdOnPlatform: 'cli' })] });
    const queryFn = makeQueryFn();
    const sync = new ActiveSessionsLiveSync({
      connection: conn,
      queryClient: qc,
      queryKey: QUERY_KEY,
      queryFn,
    });
    sync.attach();
    const heartbeat: SystemEvent = {
      event: 'sessions.heartbeat',
      data: {
        connectionId: 'c1',
        sessions: [{ id: 'a', status: 'running', title: 'A' }],
      },
    };
    conn.__fireSystem(heartbeat);
    await sync.getWriteQueue();
    await sync.getFetchQueue();
    expect(sync.getPendingReasons().has('enrichment')).toBe(false);
    expect(queryFn).toHaveBeenCalledTimes(0);
  });

  it('rate-limits enrichment retries ≥10s apart', async () => {
    const conn = makeConnection();
    const qc = makeFakeQueryClient();
    qc.__setCached({ sessions: [makeCached({ id: 'a' })] });
    const queryFn = makeQueryFn();
    const { now, advance } = setupNow();
    const sync = new ActiveSessionsLiveSync({
      connection: conn,
      queryClient: qc,
      queryKey: QUERY_KEY,
      queryFn,
      now,
    });
    sync.attach();
    // First enrichment attempt.
    const heartbeat1: SystemEvent = {
      event: 'sessions.heartbeat',
      data: {
        connectionId: 'c1',
        sessions: [{ id: 'a', status: 'running', title: 'A' }],
      },
    };
    conn.__fireSystem(heartbeat1);
    await sync.getWriteQueue();
    await sync.getFetchQueue();
    qc.__triggerFetchResolve({ sessions: [makeCached({ id: 'a' })] });
    await sync.getFetchCompletion();
    // Second heartbeat within < 10s of last completion → no new fetch.
    const heartbeat2: SystemEvent = {
      event: 'sessions.heartbeat',
      data: {
        connectionId: 'c1',
        sessions: [{ id: 'a', status: 'running', title: 'A' }],
      },
    };
    conn.__fireSystem(heartbeat2);
    await sync.getWriteQueue();
    await sync.getFetchQueue();
    expect(queryFn).toHaveBeenCalledTimes(1);
    // Advance past 10s and try again → second fetch.
    advance(10_001);
    const heartbeat3: SystemEvent = {
      event: 'sessions.heartbeat',
      data: {
        connectionId: 'c1',
        sessions: [{ id: 'a', status: 'running', title: 'A' }],
      },
    };
    conn.__fireSystem(heartbeat3);
    await sync.getWriteQueue();
    await sync.getFetchQueue();
    expect(queryFn).toHaveBeenCalledTimes(2);
  });

  it('rate-limits enrichment retries after a failed fetch', async () => {
    const conn = makeConnection();
    const qc = makeFakeQueryClient();
    qc.__setCached({ sessions: [makeCached({ id: 'a' })] });
    const queryFn = makeQueryFn();
    const { now, advance } = setupNow();
    const sync = new ActiveSessionsLiveSync({
      connection: conn,
      queryClient: qc,
      queryKey: QUERY_KEY,
      queryFn,
      now,
    });
    sync.attach();
    const heartbeat: SystemEvent = {
      event: 'sessions.heartbeat',
      data: {
        connectionId: 'c1',
        sessions: [{ id: 'a', status: 'running', title: 'A' }],
      },
    };
    conn.__fireSystem(heartbeat);
    await sync.getWriteQueue();
    await sync.getFetchQueue();
    qc.__triggerFetchReject(new Error('network down'));
    await sync.getFetchCompletion();
    conn.__fireSystem(heartbeat);
    await sync.getWriteQueue();
    await Promise.resolve();
    expect(queryFn).toHaveBeenCalledTimes(1);

    advance(10_000);
    conn.__fireSystem(heartbeat);
    await sync.getWriteQueue();
    await sync.getFetchQueue();
    expect(queryFn).toHaveBeenCalledTimes(2);
  });

  it('DB row appears only after the first attempt: cache ends enriched', async () => {
    const conn = makeConnection();
    const qc = makeFakeQueryClient();
    qc.__setCached({ sessions: [makeCached({ id: 'a' })] });
    const queryFn = vi.fn();
    queryFn.mockResolvedValueOnce({ sessions: [makeCached({ id: 'a' })] });
    queryFn.mockResolvedValueOnce({
      sessions: [makeCached({ id: 'a', createdOnPlatform: 'cli' })],
    });
    const { now, advance } = setupNow();
    const sync = new ActiveSessionsLiveSync({
      connection: conn,
      queryClient: qc,
      queryKey: QUERY_KEY,
      queryFn,
      now,
    });
    sync.attach();
    const heartbeat1: SystemEvent = {
      event: 'sessions.heartbeat',
      data: {
        connectionId: 'c1',
        sessions: [{ id: 'a', status: 'running', title: 'A' }],
      },
    };
    conn.__fireSystem(heartbeat1);
    await sync.getWriteQueue();
    await sync.getFetchQueue();
    qc.__triggerFetchResolve({ sessions: [makeCached({ id: 'a' })] });
    await sync.getFetchCompletion();
    expect(qc.__getCached()?.sessions[0]?.createdOnPlatform).toBeUndefined();
    // Advance past 10s; second heartbeat triggers a second enrichment.
    advance(10_001);
    const heartbeat2: SystemEvent = {
      event: 'sessions.heartbeat',
      data: {
        connectionId: 'c1',
        sessions: [{ id: 'a', status: 'running', title: 'A' }],
      },
    };
    conn.__fireSystem(heartbeat2);
    await sync.getWriteQueue();
    await sync.getFetchQueue();
    qc.__triggerFetchResolve({
      sessions: [makeCached({ id: 'a', createdOnPlatform: 'cli' })],
    });
    await sync.getFetchCompletion();
    expect(qc.__getCached()?.sessions[0]?.createdOnPlatform).toBe('cli');
  });

  it('heartbeat-after-empty-snapshot repopulates the cache (enrichment preserved)', async () => {
    const conn = makeConnection();
    const qc = makeFakeQueryClient();
    qc.__setCached({
      sessions: [makeCached({ id: 'a', createdOnPlatform: 'cli' })],
    });
    const queryFn = makeQueryFn();
    const sync = new ActiveSessionsLiveSync({
      connection: conn,
      queryClient: qc,
      queryKey: QUERY_KEY,
      queryFn,
    });
    sync.attach();
    // Empty snapshot arrives (degraded ingest path).
    const emptySnapshot: SystemEvent = {
      event: 'sessions.list',
      data: { sessions: [] },
    };
    conn.__fireSystem(emptySnapshot);
    await sync.getWriteQueue();
    expect(qc.__getCached()?.sessions).toEqual([]);
    // Next heartbeat repopulates.
    const heartbeat: SystemEvent = {
      event: 'sessions.heartbeat',
      data: {
        connectionId: 'c1',
        sessions: [{ id: 'a', status: 'running', title: 'A' }],
      },
    };
    conn.__fireSystem(heartbeat);
    await sync.getWriteQueue();
    await sync.getFetchQueue();
    qc.__triggerFetchResolve({
      sessions: [makeCached({ id: 'a', createdOnPlatform: 'cli' })],
    });
    await sync.getFetchCompletion();
    const cached = qc.__getCached();
    expect(cached?.sessions.map(s => s.id)).toEqual(['a']);
    expect(cached?.sessions[0]?.createdOnPlatform).toBe('cli');
  });
});

describe('merge enrichment — associatedPr preservation', () => {
  const associatedPr = {
    url: 'https://github.com/org/repo/pull/42',
    number: 42,
    state: 'open',
    title: 'Fix deploy',
    headSha: null,
    lastSyncedAt: '2026-01-01T00:00:00.000Z',
    reviewDecision: null,
    reviewDecisionPending: false,
    platform: 'github',
  };

  it('keeps associatedPr through heartbeat and snapshot merges', () => {
    const current = [makeCached({ id: 'a', createdOnPlatform: 'cli', associatedPr })];
    const afterHeartbeat = sessionsLive.mergeHeartbeatForActiveSessions(current, {
      connectionId: 'c1',
      sessions: [{ id: 'a', status: 'running', title: 'A' }],
    });
    const afterSnapshot = sessionsLive.mergeSnapshotForActiveSessions(current, [
      { id: 'a', status: 'running', title: 'A', connectionId: 'c1' },
    ]);
    expect(afterHeartbeat[0]?.associatedPr).toEqual(associatedPr);
    expect(afterSnapshot[0]?.associatedPr).toEqual(associatedPr);
  });
});
