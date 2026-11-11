/* eslint-disable max-lines -- DOM-free mounted repro: the live Agents surface exercises the REAL hook chain (useLiveAgentSessions → useActiveSessions → ActiveSessionsLiveSync → query cache) under controlled socket events. */
import { createElement } from 'react';
import { onlineManager } from '@tanstack/react-query';
import { act } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type CachedActiveSessionsData } from '@/lib/active-sessions-live';
import { ActiveSessionsLiveSyncMount } from '@/lib/active-sessions-live-sync-mount';
import {
  createQueryProbe,
  deferred,
  flushQueryUpdates as flush,
  makeCached,
  makeConnection,
  makeTestQueryClient,
  QUERY_KEY,
} from '@/lib/active-sessions-live-sync.test-helpers';
import { currentAuthEpoch } from '@/lib/auth/auth-epoch';
import { setSignOutActive } from '@/lib/auth/sign-out-state';
import { useLiveAgentSessions } from '@/lib/hooks/use-agent-sessions';
import { liveSessionContent, type LiveSessionContext } from '@/components/home/live-session-state';

/** The screen's own admission context: signed in, org boundary resolved. */
const readyContext: LiveSessionContext = {
  organizationId: null,
  isReady: true,
  isResolving: false,
  isError: false,
  label: undefined,
  // The context is only read by `liveSessionContent`; the refetch is never
  // invoked here, so a no-op stub is enough to satisfy the exact query type.
  refetch: vi.fn(),
};

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
  pathname: '/(app)/(tabs)/(2_agents)',
  // The floor poll is scoped to the visible live-agents route, so the mount
  // reads the same segments a focused Agents tab reports.
  segments: ['(app)', '(tabs)', '(2_agents)'] as string[],
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
  AppState: { currentState: 'active', addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
}));
vi.mock('@/lib/query/schedule-cache-maintenance', () => ({
  scheduleCacheMaintenance: vi.fn(),
}));
// The mount also derives the app-owned needs-input plan from the route and
// posts through expo-notifications; both are native-backed, so this test stubs
// them (their behavior is covered by needs-input-notification.test.ts).
vi.mock('expo-router', () => ({
  usePathname: () => state.pathname,
  useSegments: () => state.segments,
}));
vi.mock('expo-notifications', () => ({
  PermissionStatus: { GRANTED: 'granted' },
  getPermissionsAsync: vi.fn().mockResolvedValue({ status: 'granted' }),
  scheduleNotificationAsync: state.scheduleNotificationAsync,
  dismissNotificationAsync: state.dismissNotificationAsync,
}));

let client = makeTestQueryClient();
let connection = makeConnection();
let latest: ReturnType<typeof useLiveAgentSessions> | undefined = undefined;
function Probe() {
  latest = useLiveAgentSessions({ organizationId: state.organization.organizationId });
  return createElement(ActiveSessionsLiveSyncMount);
}
const { render, unmount } = createQueryProbe(Probe, () => client);
function live() {
  if (!latest) {
    throw new Error('Missing live hook');
  }
  return latest;
}
function ids() {
  return live().activeSessions.map(row => row.id);
}
/**
 * Pump the live-sync's serialized fetch queue until the surface stops
 * fetching: its cancel, fetch, and outcome bookkeeping each cross a promise
 * turn, and the metadata notification flushes on a later act turn.
 */
async function settleFetch(): Promise<void> {
  await act(async () => {
    await flush();
    await flush();
    await flush();
    await flush();
    await flush();
    await flush();
  });
}
/** The CLI row the tray shows while its connection is alive. */
const liveRow = makeCached({ id: 'a1', organizationId: null, connectionId: 'c1' });

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
  state.pathname = '/(app)/(tabs)/(2_agents)';
  connection = makeConnection();
  client = makeTestQueryClient();
});
afterEach(async () => {
  await act(async () => {
    unmount();
    client.clear();
    await flush();
  });
  latest = undefined;
  setSignOutActive(false);
  onlineManager.setOnline(true);
});

describe('live Agents list across a transient socket empty', () => {
  it('keeps the rows while a CLI reconnect empties the live set', async () => {
    // First read sees the live row; every later read sees the CLI socket gone,
    // which is what the reconnect window looks like from the client.
    state.request
      .mockResolvedValueOnce({ sessions: [liveRow] })
      .mockResolvedValue({ sessions: [] });
    await render();
    expect(ids()).toEqual(['a1']);

    await act(async () => {
      connection.__fireSystem({ event: 'cli.disconnected', data: { connectionId: 'c1' } });
      await flush();
      await flush();
    });
    // The wire state really did empty the cache — this is the update that
    // blanked the surface.
    expect(client.getQueryData(QUERY_KEY)).toEqual({ sessions: [] });
    expect(ids()).toEqual(['a1']);
    // The screen's admission decision must keep the list, not paint the empty
    // state, for the reconnect window.
    expect(liveSessionContent(readyContext, live())).toBe('rows');
  });

  it('keeps the rows when a socket reconnect delivers an empty snapshot', async () => {
    state.request
      .mockResolvedValueOnce({ sessions: [liveRow] })
      .mockResolvedValue({ sessions: [] });
    await render();
    expect(ids()).toEqual(['a1']);

    await act(async () => {
      connection.__fireSystem({ event: 'sessions.list', data: { sessions: [] } });
      await flush();
    });
    expect(client.getQueryData(QUERY_KEY)).toEqual({ sessions: [] });
    expect(ids()).toEqual(['a1']);
    expect(liveSessionContent(readyContext, live())).toBe('rows');
  });

  it('still settles on the empty state when the live set was never populated', async () => {
    state.request.mockResolvedValue({ sessions: [] });
    await render();
    expect(ids()).toEqual([]);
    expect(live().hasAcceptedSuccess).toBe(true);
    expect(liveSessionContent(readyContext, live())).toBe('empty');
  });

  it('keeps the confirmed rows when a manual write empties the cache', async () => {
    // First answer delivers the running row. The manual write empties the
    // cache while the server's last answer still listed the row, and the
    // hook's confirmation fetch is left in flight so the test can hold the
    // unconfirmed window.
    state.request.mockResolvedValueOnce({ sessions: [liveRow] });
    const confirmation = deferred<CachedActiveSessionsData>();
    state.request.mockReturnValueOnce(confirmation.promise);
    await render();
    expect(ids()).toEqual(['a1']);

    await act(async () => {
      client.setQueryData(QUERY_KEY, { sessions: [] });
      await flush();
    });
    // The cache really is empty while the server's last answer listed the row.
    expect(client.getQueryData(QUERY_KEY)).toEqual({ sessions: [] });
    expect(ids()).toEqual(['a1']);
    expect(liveSessionContent(readyContext, live())).toBe('rows');
    expect(live().isFetching).toBe(true);

    // The confirmation fetch settles with the row and the surface keeps it.
    await act(async () => {
      confirmation.resolve({ sessions: [liveRow] });
      await flush();
    });
    await settleFetch();
    expect(ids()).toEqual(['a1']);
    expect(liveSessionContent(readyContext, live())).toBe('rows');
  });

  it('keeps the confirmed rows when the confirmation answer fails', async () => {
    state.request
      .mockResolvedValueOnce({ sessions: [liveRow] })
      .mockRejectedValue(new Error('worker unavailable'));
    await render();
    expect(ids()).toEqual(['a1']);

    await act(async () => {
      client.setQueryData(QUERY_KEY, { sessions: [] });
      await flush();
    });
    expect(ids()).toEqual(['a1']);

    await settleFetch();
    // A failed answer cannot confirm the emptiness either: the rows stay, and
    // the section reports its retryable failure beside them instead of the
    // zero state.
    expect(ids()).toEqual(['a1']);
    expect(live().terminalError?.kind).toBe('retryable');
    expect(liveSessionContent(readyContext, live())).toBe('rows');
  });

  it('accepts the emptiness once an accepted answer confirms it', async () => {
    state.request.mockResolvedValueOnce({ sessions: [liveRow] });
    const confirmation = deferred<CachedActiveSessionsData>();
    state.request.mockReturnValueOnce(confirmation.promise);
    await render();
    expect(ids()).toEqual(['a1']);

    await act(async () => {
      client.setQueryData(QUERY_KEY, { sessions: [] });
      await flush();
    });
    // Still held: the emptiness is unconfirmed.
    expect(ids()).toEqual(['a1']);
    expect(live().hasAcceptedSuccess).toBe(false);
    expect(liveSessionContent(readyContext, live())).toBe('rows');

    await act(async () => {
      confirmation.resolve({ sessions: [] });
      await flush();
    });
    await settleFetch();
    // The confirming answer is the accepted empty list, so the section accepts
    // the zero state; the existing reconnect window still holds the rows for
    // its grace period, and its release is covered by the render-hold tests.
    expect(live().hasAcceptedSuccess).toBe(true);
  });

  it('never reports nothing after a remount while the emptiness is unconfirmed', async () => {
    state.request.mockResolvedValue({ sessions: [liveRow] });
    await render();
    expect(ids()).toEqual(['a1']);

    // The redirect the finding reports: the app resets to Home while the cache
    // is empty, and the mount that follows is a fresh hook instance with no
    // retained rows. Its own fetch is held open so the test observes the state
    // a real gap (slow network, socket reconnect) leaves on screen.
    const answer = deferred<CachedActiveSessionsData>();
    state.request.mockReturnValue(answer.promise);
    await act(async () => {
      client.setQueryData(QUERY_KEY, { sessions: [] });
      unmount();
      await flush();
    });
    expect(client.getQueryData(QUERY_KEY)).toEqual({ sessions: [] });

    await render();
    // The fresh instance starts from the completed answer's ids: unresolved,
    // never the zero state.
    expect(live().hasAcceptedSuccess).toBe(false);
    expect(liveSessionContent(readyContext, live())).toBe('pending');

    // Its answer lists the row again, so the card returns.
    await act(async () => {
      answer.resolve({ sessions: [liveRow] });
      await flush();
    });
    await settleFetch();
    expect(ids()).toEqual(['a1']);
    expect(liveSessionContent(readyContext, live())).toBe('rows');
  });
});
