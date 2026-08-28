import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bumpAuthEpoch } from '@/lib/auth/auth-epoch';
import { beginAuthenticatedOwner, confirmAuthenticatedOwner } from '@/lib/context-scope';
import { lockLocalAccess } from '@/lib/local-access';
import { ActiveSessionsLiveSync } from './active-sessions-live-sync';
import {
  type CachedActiveSessionsData,
  deferred,
  makeCached,
  makeConnection,
  QUERY_KEY,
} from './active-sessions-live-sync.test-helpers';

const releases: (() => void)[] = [];
beforeEach(() => {
  confirmAuthenticatedOwner(beginAuthenticatedOwner(), 'A');
});
afterEach(() => {
  for (const release of releases.splice(0)) {
    release();
  }
});
function replace() {
  bumpAuthEpoch();
  confirmAuthenticatedOwner(beginAuthenticatedOwner(), 'B');
}
function setup(
  queryFn = async (): Promise<CachedActiveSessionsData> => {
    await Promise.resolve();
    return { sessions: [] };
  },
  connection = makeConnection()
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const sync = new ActiveSessionsLiveSync({
    connection,
    queryClient,
    queryKey: QUERY_KEY,
    queryFn,
    owner: connection.owner,
  });
  releases.push(sync.attach(), () => {
    queryClient.clear();
  });
  return { connection, queryClient, sync };
}
const heartbeat = {
  event: 'sessions.heartbeat' as const,
  data: { connectionId: 'cli-A', sessions: [{ id: 'A', status: 'running', title: 'late A' }] },
};

describe('active session publication ownership', () => {
  it('cannot give a retained A connection B authority when live sync mounts after replacement', async () => {
    const connection = makeConnection();
    connection.__setConnected(true);
    releases.push(connection.retain());
    replace();

    const h = setup(undefined, connection);
    const replacement = { sessions: [makeCached({ id: 'B', title: 'B cache' })] };
    h.queryClient.setQueryData(QUERY_KEY, replacement);
    connection.__fireSystem(heartbeat);
    await h.sync.getWriteQueue();

    expect(h.queryClient.getQueryData(QUERY_KEY)).toEqual(replacement);
    expect(await h.sync.refreshNow()).toBe(false);
  });
  it('drops an A write held in cancelQueries and ignores late A events after replacement', async () => {
    const h = setup();
    const cancellation = deferred<undefined>();
    const cancel = vi.spyOn(h.queryClient, 'cancelQueries').mockImplementationOnce(async () => {
      await cancellation.promise;
    });
    h.connection.__fireSystem(heartbeat);
    await vi.waitFor(() => {
      expect(cancel).toHaveBeenCalled();
    });
    replace();
    const replacement = { sessions: [makeCached({ id: 'B', title: 'B cache' })] };
    h.queryClient.setQueryData(QUERY_KEY, replacement);
    cancellation.resolve(undefined);
    h.connection.__fireSystem(heartbeat);
    await h.sync.getWriteQueue();
    expect(h.queryClient.getQueryData(QUERY_KEY)).toEqual(replacement);
    expect(await h.sync.refreshNow()).toBe(false);
  });
  it('cannot refill the shared cache from an A fetch after B has published', async () => {
    const page = deferred<CachedActiveSessionsData>();
    const h = setup(async () => {
      const result = await page.promise;
      return result;
    });
    const refresh = h.sync.refreshNow();
    await h.sync.getFetchQueue();
    replace();
    const replacement = { sessions: [makeCached({ id: 'B', title: 'B cache' })] };
    h.queryClient.setQueryData(QUERY_KEY, replacement);
    page.resolve({ sessions: [makeCached({ id: 'A', title: 'late A' })] });
    await refresh;
    expect(h.queryClient.getQueryData(QUERY_KEY)).toEqual(replacement);
  });
  it('keeps same-owner live writes and refresh completion independent from the local lock', async () => {
    const fetched = { sessions: [makeCached({ id: 'A', title: 'accepted server row' })] };
    const h = setup(async () => {
      await Promise.resolve();
      return fetched;
    });
    lockLocalAccess();
    h.connection.__fireSystem(heartbeat);
    await h.sync.getWriteQueue();
    await h.sync.refreshNow();
    expect(h.queryClient.getQueryData(QUERY_KEY)).toEqual(fetched);
    expect(h.sync.getPendingReasons()).toEqual(new Set());
  });
});
