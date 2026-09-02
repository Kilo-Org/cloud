/* eslint-disable typescript-eslint/no-deprecated -- DOM-free React Native hook integration */
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildActiveSessionsTrayInput } from '@/lib/active-sessions-live';
import { ActiveSessionsLiveSync } from '@/lib/active-sessions-live-sync';
import {
  createQueryProbe,
  deferred,
  flushQueryUpdates as flush,
  makeActiveSessionsQueryKey,
  makeCached,
  makeConnection,
  makeTestQueryClient,
  QUERY_KEY,
} from '@/lib/active-sessions-live-sync.test-helpers';
import { bumpAuthEpoch, currentAuthEpoch } from '@/lib/auth/auth-epoch';
import { isSignOutActive, setSignOutActive } from '@/lib/auth/sign-out-state';
import { useAgentSessions, useLiveAgentSessions } from '@/lib/hooks/use-agent-sessions';

const state = vi.hoisted(() => ({
  organizationId: null as string | null,
  active: vi.fn(),
  stored: vi.fn(),
  maintenance: [] as (() => void)[],
}));
const STORED_KEY = [['cliSessionsV2', 'list'], { type: 'infinite' }] as const;
vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: () => ({
    token: 'account',
    isLoading: false,
    isSigningOut: isSignOutActive(),
    authEpoch: currentAuthEpoch(),
  }),
}));
vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({ organizationId: state.organizationId, isLoaded: true }),
}));
vi.mock('@/lib/trpc', () => {
  const trpc = {
    activeSessions: {
      list: {
        queryKey: (input: unknown) => [['activeSessions', 'list'], { input, type: 'query' }],
        queryOptions: (input: unknown, options: object) => ({
          queryKey: [['activeSessions', 'list'], { input, type: 'query' }],
          queryFn: state.active,
          ...options,
        }),
      },
    },
    cliSessionsV2: {
      list: {
        infiniteQueryKey: () => STORED_KEY,
        pathFilter: () => ({ queryKey: [['cliSessionsV2', 'list']] }),
        infiniteQueryOptions: (_input: unknown, options: object) => ({
          queryKey: STORED_KEY,
          queryFn: state.stored,
          initialPageParam: null,
          ...options,
        }),
      },
    },
  };
  return { useTRPC: () => trpc };
});
vi.mock('@/lib/hooks/use-user-web-connection-state', () => ({
  useUserWebConnectionState: () => false,
}));
vi.mock('react-native', () => ({
  InteractionManager: {
    runAfterInteractions: (run: () => void) => {
      state.maintenance.push(run);
    },
  },
}));
vi.mock('@/components/agents/user-web-connection-provider', () => ({
  useUserWebConnection: vi.fn(),
}));

let client = makeTestQueryClient();
let latest: ReturnType<typeof useAgentSessions> | undefined = undefined;
let live: ReturnType<typeof useLiveAgentSessions> | undefined = undefined;
let owner: ActiveSessionsLiveSync | undefined = undefined;
function stored(title: string, sessionId = 'stored') {
  return {
    session_id: sessionId,
    title,
    created_at: '2026-08-28T00:00:00Z',
    updated_at: '2026-08-28T00:00:00Z',
  };
}
function history(title: string) {
  return { cliSessions: [stored(title)], nextCursor: null };
}
function Probe() {
  latest = useAgentSessions({ organizationId: state.organizationId });
  live = useLiveAgentSessions({ organizationId: state.organizationId });
  return null;
}
const { render, unmount } = createQueryProbe(Probe, () => client);
function combined() {
  if (!latest) {
    throw new Error('Missing combined hook');
  }
  return latest;
}
function attach(queryKey: readonly unknown[]) {
  owner = new ActiveSessionsLiveSync({
    connection: makeConnection(),
    queryClient: client,
    queryKey,
    queryFn: state.active,
  });
  owner.attach();
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setSignOutActive(false);
  state.organizationId = null;
  state.maintenance.length = 0;
  state.active.mockReset().mockResolvedValue({
    sessions: [makeCached({ id: 'fresh', createdOnPlatform: 'cli', organizationId: null })],
  });
  state.stored.mockReset().mockResolvedValue(history('New history'));
  client = makeTestQueryClient();
  client.setQueryData(QUERY_KEY, { sessions: [makeCached({ organizationId: null })] });
  client.setQueryData(STORED_KEY, { pages: [history('Old history')], pageParams: [null] });
});
afterEach(async () => {
  await act(async () => {
    unmount();
    owner?.detach();
    client.clear();
    await flush();
  });
  owner = undefined;
  latest = undefined;
  live = undefined;
  setSignOutActive(false);
});
async function refreshLive() {
  let accepted = false;
  await act(async () => {
    if (!live) {
      throw new Error('Missing live hook');
    }
    accepted = await live.refetch();
    await flush();
  });
  return accepted;
}

describe('combined and live refresh callers', () => {
  it('uses the live query fallback when an owner has another complete key', async () => {
    const otherKey = [
      ['activeSessions', 'list'],
      {
        input: { ...buildActiveSessionsTrayInput(null), includeCloudAgentSessions: false },
        type: 'query',
      },
    ];
    const other = { sessions: [makeCached({ id: 'other' })] };
    client.setQueryData(otherKey, other);
    attach(otherKey);
    state.active.mockResolvedValue({ sessions: [] });
    await render();
    expect(await refreshLive()).toBe(true);
    expect(live?.activeSessions).toEqual([]);
    expect(client.getQueryData(otherKey)).toEqual(other);
  });

  it('does not start a live fallback loop after a handled owner failure', async () => {
    attach(QUERY_KEY);
    await render();
    state.active.mockRejectedValue(new Error('offline'));
    expect(await refreshLive()).toBe(false);
    expect(state.active.mock.calls).toHaveLength(1);
    expect(owner?.getPendingReasons()).toContain('manual');
    expect(live?.terminalError?.kind).toBe('retryable');
    expect(live?.activeSessions.map(row => row.id)).toEqual(['a1']);
  });

  it.each(['matching', 'mismatched'] as const)(
    'waits for storedRefetch with a %s live owner',
    async scope => {
      const otherKey = makeActiveSessionsQueryKey('other-org');
      client.setQueryData(otherKey, { sessions: [makeCached({ id: 'other' })] });
      attach(scope === 'matching' ? QUERY_KEY : otherKey);
      await render();
      const storedRequest = deferred<ReturnType<typeof history>>();
      state.stored.mockReturnValueOnce(storedRequest.promise);
      let done = false;
      let pending: Promise<void> | undefined = undefined;
      await act(async () => {
        pending = (async () => {
          await combined().refetch();
          done = true;
        })();
        await flush();
      });
      expect(combined().activeSessions.map(row => row.id)).toEqual(['fresh']);
      expect(combined().storedSessions.map(row => row.title)).toEqual(['Old history']);
      expect(done).toBe(false);
      await act(async () => {
        storedRequest.resolve(history('New history'));
        await pending;
        await flush();
      });
      expect(done).toBe(true);
      expect(combined().storedSessions.map(row => row.title)).toEqual(['New history']);
      expect(client.getQueryData(otherKey)).toEqual({ sessions: [makeCached({ id: 'other' })] });
    }
  );

  it('keeps stored refetch behind an in-flight next page', async () => {
    client.setQueryData(STORED_KEY, {
      pages: [{ ...history('Old history'), nextCursor: 'next' }],
      pageParams: [null],
    });
    await render();
    const nextPage = deferred<ReturnType<typeof history>>();
    const firstPage = deferred<ReturnType<typeof history>>();
    state.stored.mockReturnValueOnce(nextPage.promise).mockReturnValueOnce(firstPage.promise);
    let page: Promise<void> | undefined = undefined;
    let refresh: Promise<void> | undefined = undefined;
    let finished = false;
    await act(async () => {
      page = combined().fetchNextPage();
      refresh = (async () => {
        await combined().refetch();
        finished = true;
      })();
      await flush();
    });
    expect(state.stored.mock.calls).toHaveLength(1);
    expect(finished).toBe(false);
    await act(async () => {
      nextPage.resolve({ cliSessions: [stored('Next page', 'next')], nextCursor: null });
      await page;
      await flush();
    });
    expect(state.stored.mock.calls).toHaveLength(2);
    expect(combined().storedSessions.map(row => row.title)).toEqual(['Old history', 'Next page']);
    await act(async () => {
      firstPage.resolve(history('New history'));
      await refresh;
      await flush();
    });
    expect(combined().storedSessions.map(row => row.title)).toEqual(['New history']);
    expect(finished).toBe(true);
  });

  it.each(['context', 'account', 'sign-out', 'reattach'] as const)(
    'does not publish old refresh or departure work after %s changes',
    async change => {
      attach(QUERY_KEY);
      await render();
      const network = deferred<{ sessions: ReturnType<typeof makeCached>[] }>();
      state.active.mockReturnValue(network.promise);
      let pending: Promise<void> | undefined = undefined;
      await act(async () => {
        pending = combined().refetch();
        await flush();
      });
      if (change === 'account') {
        await act(async () => {
          client.setQueryData(QUERY_KEY, { sessions: [] });
          await flush();
        });
        expect(state.maintenance.length).toBeGreaterThan(0);
        bumpAuthEpoch();
        client.clear();
      }
      if (change === 'context') {
        state.organizationId = 'org-b';
      }
      if (change === 'sign-out') {
        setSignOutActive(true);
      }
      if (change === 'reattach') {
        owner?.detach();
        owner?.attach();
      }
      const key = makeActiveSessionsQueryKey(state.organizationId);
      client.setQueryData(key, {
        sessions: [makeCached({ id: 'b', organizationId: state.organizationId })],
      });
      const historyB = { pages: [history('Account B')], pageParams: [null] };
      client.setQueryData(STORED_KEY, historyB);
      await render();
      await act(async () => {
        network.resolve({ sessions: [] });
        await pending;
        for (const run of state.maintenance.splice(0)) {
          run();
        }
        await flush();
      });
      expect(combined().activeSessions.map(row => row.id)).toEqual(
        change === 'sign-out' ? [] : ['b']
      );
      if (change === 'account') {
        expect(client.getQueryData(STORED_KEY)).toEqual(historyB);
      }
    }
  );
});
