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

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  const resolvers: ((value: T) => void)[] = [];
  const promise = new Promise<T>(resolve => {
    resolvers.push(resolve);
  });
  return {
    promise,
    resolve: value => {
      resolvers[0]?.(value);
    },
  };
}

/** Flushes the microtasks a resolved poll fetch schedules. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
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

  it('never overwrites a payload a writer landed while the poll was in flight', async () => {
    // The poll bypasses React Query's fetch path, so it is not covered by the
    // live-sync writer's `cancelQueries`. A socket write / pull-to-refresh that
    // resolves first owns the cache; the poll's older snapshot must yield.
    const initial = payload('a', 'running');
    client.setQueryData(QUERY_KEY, initial);
    const pending = deferred<CachedActiveSessionsData>();
    const queryFn = vi.fn<QueryFn>().mockReturnValue(pending.promise);
    await render({ enabled: true, visible: true, connected: true, queryFn });
    await advanceBy(30_000);
    expect(queryFn).toHaveBeenCalledTimes(1);

    const newer = payload('a', 'question');
    client.setQueryData(QUERY_KEY, newer);
    // React Query's structural sharing stores its own object, so compare
    // against the reference the cache actually holds after the write.
    const written = client.getQueryData(QUERY_KEY);
    const { events, unsubscribe } = subscribeToCacheEvents();

    // The poll's response arrives last, carrying the older snapshot.
    pending.resolve(payload('a', 'idle'));
    await settle();

    expect(client.getQueryData(QUERY_KEY)).toBe(written);
    expect(events).toHaveLength(0);
    unsubscribe();
  });

  it('aborts the in-flight request when the surface is left, and the stale tick writes nothing', async () => {
    const initial = payload('a', 'running');
    client.setQueryData(QUERY_KEY, initial);
    const pending = deferred<CachedActiveSessionsData>();
    const signals: (AbortSignal | undefined)[] = [];
    const queryFn = (async (context: { signal?: AbortSignal }) => {
      signals.push(context.signal);
      const snapshot = await pending.promise;
      return snapshot;
    }) as unknown as QueryFn;
    await render({ enabled: true, visible: true, connected: true, queryFn });
    await advanceBy(30_000);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);

    await render({ enabled: true, visible: false, connected: true, queryFn });
    expect(signals[0]?.aborted).toBe(true);

    const { events, unsubscribe } = subscribeToCacheEvents();
    pending.resolve(payload('a', 'idle'));
    await settle();

    expect(client.getQueryData(QUERY_KEY)).toBe(initial);
    expect(events).toHaveLength(0);
    unsubscribe();
  });

  it('re-arms cleanly after an aborted in-flight tick', async () => {
    // The aborted tick must not leave the in-flight flag set, or the interval
    // the next effect arms would skip its ticks until the stale request
    // settled.
    const initial = payload('a', 'running');
    client.setQueryData(QUERY_KEY, initial);
    const pending = deferred<CachedActiveSessionsData>();
    const queryFn = vi.fn<QueryFn>().mockReturnValue(pending.promise);
    await render({ enabled: true, visible: true, connected: true, queryFn });
    await advanceBy(30_000);
    expect(queryFn).toHaveBeenCalledTimes(1);

    await render({ enabled: true, visible: false, connected: true, queryFn });
    await render({ enabled: true, visible: true, connected: true, queryFn });
    await advanceBy(30_000);

    expect(queryFn).toHaveBeenCalledTimes(2);
  });
});
