/* eslint-disable typescript-eslint/no-deprecated -- DOM-free mounted query fixtures */
import { createElement, type ReactNode } from 'react';
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, vi } from 'vitest';
import { createKiloAppQueryClient } from '@/lib/query-client';
import { bumpAuthEpoch } from '@/lib/auth/auth-epoch';
import { setSignOutActive } from '@/lib/auth/sign-out-state';

import {
  ActiveSessionsLiveSync,
  type LiveSyncConnection,
  type LiveSyncQueryClient,
} from '@/lib/active-sessions-live-sync';
import {
  buildActiveSessionsTrayInput,
  type CachedActiveSession,
  type CachedActiveSessionsData,
} from '@/lib/active-sessions-live';
import { type UserWebSystemEvent } from '@kilocode/cloud-agent-sdk';

export type { CachedActiveSessionsData };

type SystemEvent = UserWebSystemEvent;
export type { SystemEvent };

type FakeConnection = LiveSyncConnection & {
  __setConnected: (value: boolean) => void;
  __fireSystem: (event: SystemEvent) => void;
  __fireConnection: (value: boolean) => void;
};

export function makeConnection(over: Partial<LiveSyncConnection> = {}): FakeConnection {
  const systemListeners = new Set<(event: SystemEvent) => void>();
  const connectionListeners = new Set<(connected: boolean) => void>();
  let connected = false;
  const base: LiveSyncConnection = {
    retain: vi.fn(() => () => undefined),
    isConnected: vi.fn(() => connected),
    onSystemEvent: vi.fn((listener: (event: SystemEvent) => void) => {
      systemListeners.add(listener);
      return () => {
        systemListeners.delete(listener);
      };
    }),
    onConnectionChange: vi.fn((listener: (connected: boolean) => void) => {
      connectionListeners.add(listener);
      return () => {
        connectionListeners.delete(listener);
      };
    }),
    ...over,
  };
  return Object.assign(base, {
    __setConnected(value: boolean) {
      connected = value;
    },
    __fireSystem(event: SystemEvent) {
      for (const l of systemListeners) {
        l(event);
      }
    },
    __fireConnection(value: boolean) {
      connected = value;
      for (const l of connectionListeners) {
        l(value);
      }
    },
  });
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
};

export function deferred<T>(): Deferred<T> {
  // Standard deferred promise: the callbacks are supplied by the Promise
  // executor and then exposed. Placeholders are initialized so TypeScript
  // and the linter never see an uninitialized variable; they are replaced
  // before any caller can invoke them.
  const callbacks: {
    resolve: (value: T) => void;
    reject: (reason: Error) => void;
  } = {
    resolve: () => undefined,
    reject: () => undefined,
  };
  const promise = new Promise<T>((resolve, reject) => {
    Object.assign(callbacks, { resolve, reject });
  });
  return {
    promise,
    resolve: value => {
      callbacks.resolve(value);
    },
    reject: reason => {
      callbacks.reject(reason);
    },
  };
}

type FakeQueryClient = LiveSyncQueryClient & {
  fetchQueryCalls: number;
  cancelQueriesCalls: number;
  __setCached: (data: CachedActiveSessionsData | undefined) => void;
  __triggerFetchResolve: (data: CachedActiveSessionsData) => void;
  __triggerFetchReject: (error: Error) => void;
  __hasPendingFetch: () => boolean;
  __getCached: () => CachedActiveSessionsData | undefined;
};

const emptySessionsData = (): CachedActiveSessionsData => ({ sessions: [] });

/** Real QueryClient cancellation/provenance with a controlled network result. */
export function makeFakeQueryClient(
  initial: CachedActiveSessionsData = emptySessionsData()
): FakeQueryClient {
  const qc = makeTestQueryClient();
  const seed = qc.setQueryData.bind(qc);
  seed(QUERY_KEY, initial);
  let pendingFetch: Deferred<CachedActiveSessionsData> | null = null;
  const fetch = qc.fetchQuery.bind(qc);
  const cancel = qc.cancelQueries.bind(qc);
  const fetchSpy = vi.spyOn(qc, 'fetchQuery').mockImplementation(async options => {
    const queryFn = options.queryFn;
    if (typeof queryFn !== 'function') {
      throw new TypeError('Expected a query function');
    }
    const result = await fetch({
      ...options,
      queryFn: async context => {
        const pending = deferred<CachedActiveSessionsData>();
        pendingFetch = pending;
        try {
          await queryFn(context);
          return await pending.promise;
        } finally {
          if (pendingFetch === pending) {
            pendingFetch = null;
          }
        }
      },
    });
    return result;
  });
  const cancelSpy = vi.spyOn(qc, 'cancelQueries').mockImplementation(async (...args) => {
    pendingFetch = null;
    await cancel(...args);
  });
  vi.spyOn(qc, 'setQueryData');
  Object.assign(qc, {
    __setCached(data: CachedActiveSessionsData | undefined) {
      if (data === undefined) {
        qc.removeQueries({ queryKey: QUERY_KEY, exact: true });
      } else {
        seed(QUERY_KEY, data);
      }
    },
    __triggerFetchResolve(data: CachedActiveSessionsData) {
      pendingFetch?.resolve(data);
    },
    __triggerFetchReject(error: Error) {
      pendingFetch?.reject(error);
    },
    __hasPendingFetch() {
      return pendingFetch !== null;
    },
    __getCached() {
      return qc.getQueryData<CachedActiveSessionsData>(QUERY_KEY);
    },
  });
  Object.defineProperties(qc, {
    fetchQueryCalls: { get: () => fetchSpy.mock.calls.length },
    cancelQueriesCalls: { get: () => cancelSpy.mock.calls.length },
  });
  return qc as FakeQueryClient;
}

export const QUERY_KEY = [
  ['activeSessions', 'list'],
  { input: buildActiveSessionsTrayInput(null), type: 'query' },
] as const;

export function makeQueryFn(response: CachedActiveSessionsData = emptySessionsData()) {
  return vi.fn(async () => {
    const resolved = await Promise.resolve(response);
    return resolved;
  });
}

export function makeCached(over: Partial<CachedActiveSession> = {}): CachedActiveSession {
  return {
    id: 'a1',
    status: 'running',
    title: 'test',
    connectionId: 'c1',
    ...over,
  };
}

export function setupNow() {
  let now = 1_000_000;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

export function setupTimers(): void {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
}

export function makeActiveSessionsQueryKey(organizationId: string | null = null) {
  return [
    ['activeSessions', 'list'],
    { input: buildActiveSessionsTrayInput(organizationId), type: 'query' },
  ] as const;
}

export async function flushQueryUpdates(): Promise<void> {
  await new Promise<void>(resolve => {
    setTimeout(resolve, 0);
  });
  await new Promise<void>(resolve => {
    setTimeout(resolve, 0);
  });
}

/** Reuse the DOM-free query-provider lifecycle without sharing query clients. */
export function createQueryProbe(Probe: () => ReactNode, getClient: () => QueryClient) {
  let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
  return {
    render: async () => {
      await act(async () => {
        const tree = createElement(
          QueryClientProvider,
          { client: getClient() },
          createElement(Probe)
        );
        if (renderer) {
          renderer.update(tree);
        } else {
          renderer = TestRenderer.create(tree);
        }
        await flushQueryUpdates();
      });
    },
    unmount: () => {
      renderer?.unmount();
      renderer = undefined;
    },
  };
}

export function makeTestQueryClient(): QueryClient {
  const client = createKiloAppQueryClient();
  client.setDefaultOptions({
    queries: { retry: false, gcTime: Infinity },
    mutations: { retry: false, gcTime: Infinity },
  });
  return client;
}

export function seedMutationSessions(
  client: QueryClient,
  listKey: readonly unknown[],
  title = 'Old'
) {
  const cliSessions = [
    { session_id: 's1', title },
    { session_id: 's2', title: 'Other' },
  ];
  client.setQueryData(listKey, { pages: [{ cliSessions }], pageParams: [null] });
  client.setQueryData(QUERY_KEY, { sessions: [makeCached({ id: 's1', title })] });
}

export function mutationStoredTitles(client: QueryClient, listKey: readonly unknown[]) {
  return client
    .getQueryData<{ pages: { cliSessions: { title: string }[] }[] }>(listKey)
    ?.pages.flatMap(page => page.cliSessions.map(session => session.title));
}

export function mutationActiveTitle(client: QueryClient) {
  return client.getQueryData<CachedActiveSessionsData>(QUERY_KEY)?.sessions[0]?.title;
}

export function replaceMutationAccount(client: QueryClient, listKey: readonly unknown[]) {
  setSignOutActive(true);
  bumpAuthEpoch();
  client.clear();
  setSignOutActive(false);
  seedMutationSessions(client, listKey, 'Account B');
}

export { ActiveSessionsLiveSync };
