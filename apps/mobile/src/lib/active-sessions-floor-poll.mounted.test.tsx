/* eslint-disable max-lines -- DOM-free mounted repro: the floor poll's timer matrix needs one case per tick outcome. */
import { createElement } from 'react';
import { QueryClient } from '@tanstack/react-query';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type CachedActiveSessionsData } from '@/lib/active-sessions-live';
import { useActiveSessionsFloorPoll } from '@/lib/active-sessions-floor-poll';

const state = vi.hoisted(() => ({
  authEpoch: 0,
  appState: 'active' as string,
}));

vi.mock('@/lib/auth/auth-context', () => ({ useAuth: () => ({ authEpoch: state.authEpoch }) }));
vi.mock('react-native', () => ({
  AppState: {
    get currentState() {
      return state.appState;
    },
  },
}));

const QUERY_KEY = [['activeSessions', 'list'], { input: { organizationId: null }, type: 'query' }];

type QueryFn = () => Promise<CachedActiveSessionsData>;

function session(id: string, status: string): CachedActiveSessionsData['sessions'][number] {
  return { id, status, title: `Session ${id}`, connectionId: 'connection-1' };
}

function payload(id: string, status: string): CachedActiveSessionsData {
  return { sessions: [session(id, status)] };
}

let client = new QueryClient();

type ProbeProps = {
  enabled: boolean;
  visible: boolean;
  connected: boolean;
  queryFn: QueryFn;
};

function Probe({ enabled, visible, connected, queryFn }: ProbeProps) {
  useActiveSessionsFloorPoll({
    enabled,
    visible,
    connected,
    queryClient: client,
    queryKey: QUERY_KEY,
    queryFn,
  });
  return null;
}

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

async function render(props: ProbeProps): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    const element = createElement(Probe, props);
    if (renderer) {
      renderer.update(element);
    } else {
      renderer = TestRenderer.create(element);
    }
  });
}

async function advanceBy(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function subscribeToCacheEvents(): { events: unknown[]; unsubscribe: () => void } {
  const events: unknown[] = [];
  const unsubscribe = client.getQueryCache().subscribe(event => {
    events.push(event);
  });
  return { events, unsubscribe };
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.appState = 'active';
  state.authEpoch = 0;
  vi.useFakeTimers();
  vi.stubGlobal('__DEV__', false);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
});

afterEach(() => {
  act(() => {
    renderer?.unmount();
  });
  renderer = undefined;
  client.clear();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useActiveSessionsFloorPoll', () => {
  it('never polls while the live-agents surface is not visible', async () => {
    const queryFn = vi.fn<QueryFn>().mockResolvedValue(payload('a', 'running'));
    client.setQueryData(QUERY_KEY, payload('a', 'running'));
    await render({ enabled: true, visible: false, connected: true, queryFn });
    await advanceBy(60_000);
    expect(queryFn).not.toHaveBeenCalled();
  });

  it('never polls while reading is disabled', async () => {
    const queryFn = vi.fn<QueryFn>().mockResolvedValue(payload('a', 'running'));
    client.setQueryData(QUERY_KEY, payload('a', 'running'));
    await render({ enabled: false, visible: true, connected: true, queryFn });
    await advanceBy(60_000);
    expect(queryFn).not.toHaveBeenCalled();
  });

  it('polls after 30s while visible and connected, and not before', async () => {
    const queryFn = vi.fn<QueryFn>().mockResolvedValue(payload('a', 'running'));
    client.setQueryData(QUERY_KEY, payload('a', 'running'));
    await render({ enabled: true, visible: true, connected: true, queryFn });
    await advanceBy(29_000);
    expect(queryFn).not.toHaveBeenCalled();
    await advanceBy(1000);
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it('polls after 10s while the socket is not connected', async () => {
    const queryFn = vi.fn<QueryFn>().mockResolvedValue(payload('a', 'running'));
    client.setQueryData(QUERY_KEY, payload('a', 'running'));
    await render({ enabled: true, visible: true, connected: false, queryFn });
    await advanceBy(10_000);
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it('re-arms the interval when the connection state flips', async () => {
    const queryFn = vi.fn<QueryFn>().mockResolvedValue(payload('a', 'running'));
    client.setQueryData(QUERY_KEY, payload('a', 'running'));
    await render({ enabled: true, visible: true, connected: true, queryFn });
    await advanceBy(29_000);
    await render({ enabled: true, visible: true, connected: false, queryFn });
    await advanceBy(10_000);
    expect(queryFn).toHaveBeenCalledTimes(1);
    await advanceBy(20_000);
    expect(queryFn).toHaveBeenCalledTimes(3);
  });

  it('never polls before a payload is in the cache', async () => {
    const queryFn = vi.fn<QueryFn>().mockResolvedValue(payload('a', 'running'));
    await render({ enabled: true, visible: true, connected: true, queryFn });
    await advanceBy(60_000);
    expect(queryFn).not.toHaveBeenCalled();
  });

  it('does not write or notify when the polled payload is unchanged', async () => {
    client.setQueryData(QUERY_KEY, payload('a', 'running'));
    const queryFn = vi.fn<QueryFn>().mockResolvedValue(payload('a', 'running'));
    const setData = vi.spyOn(client, 'setQueryData');
    const { events, unsubscribe } = subscribeToCacheEvents();
    await render({ enabled: true, visible: true, connected: true, queryFn });
    await advanceBy(30_000);
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(setData).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
    unsubscribe();
  });

  it('writes a changed payload into the cache', async () => {
    client.setQueryData(QUERY_KEY, payload('a', 'running'));
    const changed = payload('a', 'idle');
    const queryFn = vi.fn<QueryFn>().mockResolvedValue(changed);
    await render({ enabled: true, visible: true, connected: true, queryFn });
    await advanceBy(30_000);
    expect(client.getQueryData(QUERY_KEY)).toEqual(changed);
  });

  it('does not poll while the app is not foregrounded', async () => {
    state.appState = 'background';
    const queryFn = vi.fn<QueryFn>().mockResolvedValue(payload('a', 'running'));
    client.setQueryData(QUERY_KEY, payload('a', 'running'));
    await render({ enabled: true, visible: true, connected: true, queryFn });
    await advanceBy(30_000);
    expect(queryFn).not.toHaveBeenCalled();
  });

  it('swallows a rejected poll without writing or notifying', async () => {
    client.setQueryData(QUERY_KEY, payload('a', 'running'));
    const queryFn = vi.fn<QueryFn>().mockRejectedValue(new Error('offline'));
    const setData = vi.spyOn(client, 'setQueryData');
    const { events, unsubscribe } = subscribeToCacheEvents();
    await render({ enabled: true, visible: true, connected: true, queryFn });
    await advanceBy(30_000);
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(setData).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
    expect(client.getQueryData(QUERY_KEY)).toEqual(payload('a', 'running'));
    unsubscribe();
  });
});
