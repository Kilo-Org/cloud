import { describe, expect, it, type Mock } from 'vitest';

import {
  ActiveSessionsLiveSync,
  makeCached,
  makeConnection,
  makeFakeQueryClient,
  makeQueryFn,
  QUERY_KEY,
  setupTimers,
} from '@/lib/active-sessions-live-sync.test-helpers';

setupTimers();

describe('ActiveSessionsLiveSync — session.status.updated', () => {
  it('applies the lightweight sessionId payload and clears attention', async () => {
    const conn = makeConnection();
    const qc = makeFakeQueryClient();
    qc.__setCached({
      sessions: [makeCached({ id: 'ses-1', status: 'question', connectionId: 'c1' })],
    });
    const sync = new ActiveSessionsLiveSync({
      connection: conn,
      queryClient: qc,
      queryKey: QUERY_KEY,
      queryFn: makeQueryFn(),
    });
    sync.attach();
    conn.__fireSystem({
      event: 'session.status.updated',
      data: {
        source: 'v2',
        sessionId: 'ses-1',
        previousStatus: 'question',
        status: 'idle',
        statusUpdatedAt: 'now',
        changedAt: 'now',
      },
    });
    await sync.getWriteQueue();
    expect(qc.__getCached()?.sessions[0]?.status).toBe('idle');
  });

  it('applies the full session-row payload into attention', async () => {
    const conn = makeConnection();
    const qc = makeFakeQueryClient();
    qc.__setCached({
      sessions: [makeCached({ id: 'ses-2', status: 'busy', connectionId: 'c1' })],
    });
    const sync = new ActiveSessionsLiveSync({
      connection: conn,
      queryClient: qc,
      queryKey: QUERY_KEY,
      queryFn: makeQueryFn(),
    });
    sync.attach();
    conn.__fireSystem({
      event: 'session.status.updated',
      data: {
        source: 'v2',
        session: {
          source: 'v2',
          sessionId: 'ses-2',
          createdAt: 'now',
          updatedAt: 'now',
          title: 't',
          createdOnPlatform: null,
          organizationId: null,
          gitUrl: null,
          gitBranch: null,
          parentSessionId: null,
          status: 'permission',
          statusUpdatedAt: 'now',
        },
        previousStatus: 'busy',
        status: 'permission',
        statusUpdatedAt: 'now',
        changedAt: 'now',
      },
    });
    await sync.getWriteQueue();
    expect(qc.__getCached()?.sessions[0]?.status).toBe('permission');
  });

  it('ignores a malformed status payload', async () => {
    const conn = makeConnection();
    const qc = makeFakeQueryClient();
    qc.__setCached({
      sessions: [makeCached({ id: 'ses-1', status: 'question' })],
    });
    const setQueryDataCalls = qc.setQueryData as Mock;
    setQueryDataCalls.mockClear();
    const sync = new ActiveSessionsLiveSync({
      connection: conn,
      queryClient: qc,
      queryKey: QUERY_KEY,
      queryFn: makeQueryFn(),
    });
    sync.attach();
    conn.__fireSystem({
      event: 'session.status.updated',
      data: { sessionId: 'ses-1' },
    });
    await Promise.resolve();
    expect(setQueryDataCalls).not.toHaveBeenCalled();
    expect(qc.__getCached()?.sessions[0]?.status).toBe('question');
  });

  it('keeps attention sticky across a busy heartbeat after status.updated sets it', async () => {
    const conn = makeConnection();
    const qc = makeFakeQueryClient();
    qc.__setCached({
      sessions: [makeCached({ id: 'ses-1', status: 'busy', connectionId: 'c1', title: 'A' })],
    });
    const sync = new ActiveSessionsLiveSync({
      connection: conn,
      queryClient: qc,
      queryKey: QUERY_KEY,
      queryFn: makeQueryFn(),
    });
    sync.attach();
    conn.__fireSystem({
      event: 'session.status.updated',
      data: {
        source: 'v2',
        sessionId: 'ses-1',
        previousStatus: 'busy',
        status: 'question',
        statusUpdatedAt: 'now',
        changedAt: 'now',
      },
    });
    await sync.getWriteQueue();
    conn.__fireSystem({
      event: 'sessions.heartbeat',
      data: {
        connectionId: 'c1',
        sessions: [{ id: 'ses-1', status: 'busy', title: 'A' }],
      },
    });
    await sync.getWriteQueue();
    expect(qc.__getCached()?.sessions[0]?.status).toBe('question');
  });
});
