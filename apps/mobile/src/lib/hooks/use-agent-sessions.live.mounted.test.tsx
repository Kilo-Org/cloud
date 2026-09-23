/* eslint-disable max-lines -- DOM-free React Native hook integration; the mount gate matrix exceeds the default line limit */
import { createElement } from 'react';
import { onlineManager } from '@tanstack/react-query';
import { act } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type CachedActiveSessionsData } from '@/lib/active-sessions-live';
import { ActiveSessionsLiveSync } from '@/lib/active-sessions-live-sync';
import { ActiveSessionsLiveSyncMount } from '@/lib/active-sessions-live-sync-mount';
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
import { setSignOutActive } from '@/lib/auth/sign-out-state';
import { useLiveAgentSessions } from '@/lib/hooks/use-agent-sessions';

const state = vi.hoisted(() => ({
  auth: {
    token: 'account' as string | undefined,
    isLoading: false,
    isSigningOut: false,
    authEpoch: 0,
  },
  organization: { organizationId: null as string | null, isLoaded: true },
  request: vi.fn<() => Promise<CachedActiveSessionsData>>(),
  // The notification-preference row the mount subscribes to at app start.
  preferencesRequest: vi.fn<() => Promise<{ agentAttention: boolean }>>(),
  mountSync: false,
  pathname: '/(app)/(tabs)/(2_agents)',
  scheduleNotificationAsync: vi.fn<(request: { identifier: string }) => Promise<void>>(),
  dismissNotificationAsync: vi.fn<(identifier: string) => Promise<void>>(),
}));
vi.mock('@/lib/auth/auth-context', () => ({ useAuth: () => state.auth }));
vi.mock('@/lib/organization-context', () => ({ useOrganization: () => state.organization }));
function key(input: unknown) {
  return [['activeSessions', 'list'], { input, type: 'query' }];
}
/** The preferences row the Notifications screen edits; the mount reads it. */
function preferencesKey() {
  return [['user', 'getNotificationPreferences'], { type: 'query' }];
}
vi.mock('@/lib/trpc', () => {
  const trpc = {
    activeSessions: {
      list: {
        queryKey: key,
        queryOptions: (input: unknown, options: object) => ({
          queryKey: key(input),
          queryFn: state.request,
          ...options,
        }),
      },
    },
    user: {
      getNotificationPreferences: {
        queryOptions: () => ({
          queryKey: preferencesKey(),
          queryFn: state.preferencesRequest,
        }),
      },
    },
  };
  return { useTRPC: () => trpc };
});
vi.mock('@/lib/hooks/use-user-web-connection-state', () => ({
  useUserWebConnectionState: () => false,
}));
vi.mock('@/components/agents/user-web-connection-provider', () => ({
  useUserWebConnection: () => connection,
}));
// The app-level mount subscribes to foreground transitions; the mock exposes
// the same subscribe/remove contract as React Native.
vi.mock('react-native', () => ({
  InteractionManager: { runAfterInteractions: vi.fn() },
  AppState: { currentState: 'active', addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
}));
// The mount also derives the app-owned needs-input plan from the route and
// posts through expo-notifications; both are native-backed, so the mount test
// stubs them (their behavior is covered by needs-input-notification.test.ts).
vi.mock('expo-router', () => ({ usePathname: () => state.pathname }));
vi.mock('expo-notifications', () => ({
  scheduleNotificationAsync: state.scheduleNotificationAsync,
  dismissNotificationAsync: state.dismissNotificationAsync,
}));

let client = makeTestQueryClient();
let connection = makeConnection();
let leases = 0;
let latest: ReturnType<typeof useLiveAgentSessions> | undefined = undefined;
const owners: ActiveSessionsLiveSync[] = [];
const cached = { sessions: [makeCached({ organizationId: null })] };
function Probe() {
  latest = useLiveAgentSessions({ organizationId: state.organization.organizationId });
  return state.mountSync ? createElement(ActiveSessionsLiveSyncMount) : null;
}
const { render, unmount } = createQueryProbe(Probe, () => client);
function live() {
  if (!latest) {
    throw new Error('Missing live hook');
  }
  return latest;
}
async function startRefresh(): Promise<{ pending: Promise<boolean> | undefined }> {
  let pending: Promise<boolean> | undefined = undefined;
  await act(async () => {
    pending = live().refetch();
    await flush();
  });
  return { pending };
}
async function refresh() {
  const { pending } = await startRefresh();
  const result = await pending;
  return result;
}
async function finishRefresh(
  network: ReturnType<typeof deferred<CachedActiveSessionsData>>,
  pending: Promise<boolean> | undefined
) {
  await act(async () => {
    network.resolve({ sessions: [] });
    await pending;
    await flush();
  });
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setSignOutActive(false);
  onlineManager.setOnline(true);
  Object.assign(state.auth, {
    token: 'account',
    isLoading: false,
    isSigningOut: false,
    authEpoch: currentAuthEpoch(),
  });
  Object.assign(state.organization, { organizationId: null, isLoaded: true });
  state.request.mockReset().mockResolvedValue({ sessions: [] });
  state.preferencesRequest.mockReset().mockResolvedValue({ agentAttention: true });
  state.scheduleNotificationAsync.mockClear();
  state.dismissNotificationAsync.mockClear();
  state.mountSync = false;
  leases = 0;
  connection = makeConnection({
    retain: () => {
      leases += 1;
      return () => {
        leases -= 1;
      };
    },
  });
  client = makeTestQueryClient();
});
afterEach(async () => {
  await act(async () => {
    unmount();
    for (const owner of owners) {
      owner.detach();
    }
    client.clear();
    await flush();
  });
  latest = undefined;
  owners.length = 0;
  setSignOutActive(false);
  onlineManager.setOnline(true);
});

describe('live query presentation and refresh contracts', () => {
  it('keeps manual-only empty data unconfirmed until the fallback accepts a server result', async () => {
    client.setQueryData(QUERY_KEY, { sessions: [] });
    await render();
    expect(live().isLoading).toBe(false);
    expect(live().hasAcceptedSuccess).toBe(false);
    expect(await refresh()).toBe(true);
    expect(live().hasAcceptedSuccess).toBe(true);
    expect(live().activeSessions).toEqual([]);
  });

  it('exposes paused first load without treating isLoading false as empty success', async () => {
    onlineManager.setOnline(false);
    await render();
    expect(live().isLoading).toBe(false);
    expect(live().isPaused).toBe(true);
    expect(live().isFetching).toBe(false);
    expect(live().hasAcceptedSuccess).toBe(false);
  });

  it.each([
    ['retryable', new Error('offline')],
    ['non-retryable', Object.assign(new Error('denied'), { data: { code: 'FORBIDDEN' } })],
  ] as const)(
    'retains an initial %s failure across socket writes, remount, and retry',
    async (kind, error) => {
      state.request.mockRejectedValue(error);
      await render();
      expect(live().terminalError).toEqual({ error, kind });
      await act(async () => {
        client.setQueryData(QUERY_KEY, cached);
        await flush();
        unmount();
      });
      await render();
      expect(live().terminalError?.error).toBe(error);
      expect(live().hasAcceptedSuccess).toBe(false);
      expect(live().activeSessions.map(row => row.id)).toEqual(['a1']);
      const network = deferred<CachedActiveSessionsData>();
      state.request.mockReturnValue(network.promise);
      const { pending } = await startRefresh();
      expect(live().terminalError?.error).toBe(error);
      expect(live().isFetching).toBe(true);
      await finishRefresh(network, pending);
      expect(await pending).toBe(true);
      expect(live().terminalError).toBeNull();
      expect(live().hasAcceptedSuccess).toBe(true);
    }
  );

  it.each([null, 'org-a', 'org-b'])(
    'shows only rows attributed to the current context %s',
    async organizationId => {
      state.organization.organizationId = organizationId;
      client.setQueryData(makeActiveSessionsQueryKey(organizationId), {
        sessions: [
          makeCached({ id: 'personal', organizationId: null }),
          makeCached({ id: 'org-a', organizationId: 'org-a' }),
          makeCached({ id: 'org-b', organizationId: 'org-b' }),
          makeCached({ id: 'unattributed' }),
        ],
      });
      await render();
      expect(live().activeSessions.map(row => row.id)).toEqual([organizationId ?? 'personal']);
    }
  );

  it.each(['cancel', 'sign-out'])(
    'rejects a fallback result after %s without publishing late data',
    async boundary => {
      await client.query({ queryKey: QUERY_KEY, queryFn: () => cached });
      await render();
      const network = deferred<CachedActiveSessionsData>();
      state.request.mockReturnValue(network.promise);
      const { pending } = await startRefresh();
      if (boundary === 'cancel') {
        await act(async () => {
          await client.cancelQueries({ queryKey: QUERY_KEY, exact: true });
        });
      } else {
        setSignOutActive(true);
      }
      await finishRefresh(network, pending);
      expect(await pending).toBe(false);
      expect(client.getQueryData(QUERY_KEY)).toEqual(cached);
    }
  );

  it.each(['context', 'clear', 'sign-out', 'unmount', 'reattach'] as const)(
    'rejects a late owner result after %s',
    async change => {
      client.setQueryData(QUERY_KEY, cached);
      const owner = new ActiveSessionsLiveSync({
        connection,
        queryClient: client,
        queryKey: QUERY_KEY,
        queryFn: state.request,
      });
      owner.attach();
      owners.push(owner);
      await render();
      const network = deferred<CachedActiveSessionsData>();
      state.request.mockReturnValue(network.promise);
      const { pending } = await startRefresh();
      if (change === 'context') {
        state.organization.organizationId = 'org-b';
        client.setQueryData(makeActiveSessionsQueryKey('org-b'), {
          sessions: [makeCached({ id: 'b', organizationId: 'org-b' })],
        });
        await render();
        expect(live().activeSessions.map(row => row.id)).toEqual(['b']);
      } else if (change === 'clear') {
        await act(async () => {
          client.clear();
          bumpAuthEpoch();
          state.auth.authEpoch = currentAuthEpoch();
          client.setQueryData(QUERY_KEY, cached);
          await flush();
        });
        await render();
      } else if (change === 'sign-out') {
        setSignOutActive(true);
        state.auth.isSigningOut = true;
        await render();
        expect(live().activeSessions).toEqual([]);
      } else if (change === 'unmount') {
        await act(unmount);
      } else {
        owner.detach();
        owner.attach();
      }
      await finishRefresh(network, pending);
      expect(await pending).toBe(false);
    }
  );

  it('posts an app-owned needs-input notification from a cached raise and dismisses it when answered', async () => {
    state.mountSync = true;
    client.setQueryData(QUERY_KEY, {
      sessions: [makeCached({ id: 'ses_1', title: 'Fix the bug', status: 'question' })],
    });
    await render();
    expect(state.scheduleNotificationAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        identifier: 'needs-input:ses_1',
        content: expect.objectContaining({ categoryIdentifier: 'kilo-needs-input:question' }),
      })
    );
    expect(state.dismissNotificationAsync).not.toHaveBeenCalled();
    expect(state.scheduleNotificationAsync).toHaveBeenCalledTimes(1);

    // A refetch or heartbeat that leaves the raise waiting must not re-post:
    // the mount remembers the whole notified set, not the last plan's delta,
    // so a plan that publishes nothing cannot erase it.
    await act(async () => {
      client.setQueryData(QUERY_KEY, {
        sessions: [
          makeCached({ id: 'ses_1', title: 'Fix the bug', status: 'question' }),
          makeCached({ id: 'ses_2', status: 'running' }),
        ],
      });
      await flush();
    });
    expect(state.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
    expect(state.scheduleNotificationAsync.mock.calls.map(c => c[0].identifier)).toEqual([
      'needs-input:ses_1',
    ]);

    await act(async () => {
      client.setQueryData(QUERY_KEY, {
        sessions: [makeCached({ id: 'ses_1', title: 'Fix the bug', status: 'running' })],
      });
      await flush();
    });
    expect(state.dismissNotificationAsync).toHaveBeenCalledWith('needs-input:ses_1');
  });

  it('withholds the app-owned raise while the agentAttention preference is off', async () => {
    state.mountSync = true;
    state.preferencesRequest.mockResolvedValue({ agentAttention: false });
    client.setQueryData(preferencesKey(), { agentAttention: false });
    client.setQueryData(QUERY_KEY, {
      sessions: [makeCached({ id: 'ses_1', title: 'Fix the bug', status: 'question' })],
    });
    await render();
    expect(state.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('withholds the raise until the agentAttention row loads, then posts it', async () => {
    state.mountSync = true;
    // A cold start: the preferences query is still in flight, so the gate has
    // no row to read. It must not fall back to ON and post.
    const preferences = deferred<{ agentAttention: boolean }>();
    state.preferencesRequest.mockReturnValue(preferences.promise);
    client.setQueryData(QUERY_KEY, {
      sessions: [makeCached({ id: 'ses_1', title: 'Fix the bug', status: 'question' })],
    });
    await render();
    expect(state.scheduleNotificationAsync).not.toHaveBeenCalled();

    await act(async () => {
      preferences.resolve({ agentAttention: true });
      await flush();
    });
    expect(state.scheduleNotificationAsync).toHaveBeenCalledWith(
      expect.objectContaining({ identifier: 'needs-input:ses_1' })
    );
  });

  it('dismisses a posted raise when agentAttention is turned off', async () => {
    state.mountSync = true;
    client.setQueryData(QUERY_KEY, {
      sessions: [makeCached({ id: 'ses_1', title: 'Fix the bug', status: 'question' })],
    });
    await render();
    expect(state.scheduleNotificationAsync).toHaveBeenCalledTimes(1);

    await act(async () => {
      client.setQueryData(preferencesKey(), { agentAttention: false });
      await flush();
    });
    expect(state.dismissNotificationAsync).toHaveBeenCalledWith('needs-input:ses_1');
  });

  it('replaces a re-published raise in place so a later recompute does not re-post it', async () => {
    state.mountSync = true;
    client.setQueryData(QUERY_KEY, {
      sessions: [makeCached({ id: 'ses_1', title: 'Fix the bug', status: 'permission' })],
    });
    await render();
    expect(state.scheduleNotificationAsync.mock.calls.map(c => c[0].identifier)).toEqual([
      'needs-input:ses_1',
    ]);

    // The raise flips kind, so its standing notification is re-published with
    // the new action set under the same per-session identifier.
    await act(async () => {
      client.setQueryData(QUERY_KEY, {
        sessions: [makeCached({ id: 'ses_1', title: 'Fix the bug', status: 'question' })],
      });
      await flush();
    });
    expect(state.scheduleNotificationAsync.mock.calls.map(c => c[0].identifier)).toEqual([
      'needs-input:ses_1',
      'needs-input:ses_1',
    ]);

    // A later recompute that leaves the raise untouched must not post a third
    // time: the notified set carries the fresh row, so the next plan compares
    // the raise against the shape now on screen.
    await act(async () => {
      client.setQueryData(QUERY_KEY, {
        sessions: [
          makeCached({ id: 'ses_1', title: 'Fix the bug', status: 'question' }),
          makeCached({ id: 'ses_2', status: 'running' }),
        ],
      });
      await flush();
    });
    expect(state.scheduleNotificationAsync).toHaveBeenCalledTimes(2);
  });

  it.each(['token', 'bootstrap', 'sign-out', 'organization'] as const)(
    'gates cached reads and socket ownership on %s readiness',
    async gate => {
      client.setQueryData(QUERY_KEY, cached);
      state.mountSync = true;
      if (gate === 'token') {
        state.auth.token = undefined;
      }
      if (gate === 'bootstrap') {
        state.auth.isLoading = true;
      }
      if (gate === 'sign-out') {
        state.auth.isSigningOut = true;
        setSignOutActive(true);
      }
      if (gate === 'organization') {
        state.organization.isLoaded = false;
      }
      await render();
      expect(live().activeSessions).toEqual([]);
      expect(await refresh()).toBe(false);
      expect(leases).toBe(0);
      connection.__fireSystem({ event: 'sessions.list', data: { sessions: [] } });
      expect(client.getQueryData(QUERY_KEY)).toEqual(cached);
      Object.assign(state.auth, { token: 'account', isLoading: false, isSigningOut: false });
      state.organization.isLoaded = true;
      setSignOutActive(false);
      await render();
      expect(leases).toBe(2);
      expect(live().activeSessions.map(row => row.id)).toEqual(['a1']);
    }
  );
});
