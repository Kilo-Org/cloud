import { describe, expect, it } from 'vitest';

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

describe('ActiveSessionsLiveSync — session.updated', () => {
  it('applies the ingest title onto the matching row', async () => {
    const conn = makeConnection();
    const qc = makeFakeQueryClient();
    qc.__setCached({
      sessions: [
        makeCached({
          id: 'ses-1',
          title: 'New session - 2026-01-01T00:00:00.000Z',
          createdOnPlatform: 'cli',
          createdAt: 'now',
          updatedAt: 'now',
        }),
      ],
    });
    const sync = new ActiveSessionsLiveSync({
      connection: conn,
      queryClient: qc,
      queryKey: QUERY_KEY,
      queryFn: makeQueryFn(),
    });
    sync.attach();
    conn.__fireSystem({
      event: 'session.updated',
      data: {
        source: 'v2',
        changedAt: 'now',
        session: {
          source: 'v2',
          sessionId: 'ses-1',
          createdAt: 'now',
          updatedAt: 'now',
          title: 'Fix login',
          createdOnPlatform: null,
          organizationId: null,
          gitUrl: null,
          gitBranch: null,
          parentSessionId: null,
          status: 'busy',
          statusUpdatedAt: 'now',
        },
      },
    });
    await sync.getWriteQueue();
    expect(qc.__getCached()?.sessions[0]?.title).toBe('Fix login');
  });
});
