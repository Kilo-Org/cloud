import { afterEach, beforeEach, vi } from 'vitest';
import { type QueryFunction, type QueryKey } from '@tanstack/react-query';

import {
  ActiveSessionsLiveSync,
  type LiveSyncConnection,
  type LiveSyncQueryClient,
} from '@/lib/active-sessions-live-sync';
import {
  type CachedActiveSession,
  type CachedActiveSessionsData,
} from '@/lib/active-sessions-live';
import { type UserWebSystemEvent } from '@kilocode/cloud-agent-sdk';
import {
  type AuthenticatedOwner,
  beginAuthenticatedOwner,
  confirmAuthenticatedOwner,
  getAuthenticatedOwner,
} from '@/lib/context-scope';

export type { CachedActiveSessionsData };

type SystemEvent = UserWebSystemEvent;
export type { SystemEvent };

type FakeConnection = LiveSyncConnection & {
  readonly owner: AuthenticatedOwner;
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
    owner: getAuthenticatedOwner(),
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

export function makeFakeQueryClient(
  initial: CachedActiveSessionsData = emptySessionsData()
): FakeQueryClient {
  let cache: CachedActiveSessionsData | undefined = initial;
  let pendingFetch: Deferred<CachedActiveSessionsData> | null = null;
  let fetchQueryCalls = 0;
  let cancelQueriesCalls = 0;
  const qc = {
    cancelQueries: vi.fn(async () => {
      cancelQueriesCalls += 1;
      if (pendingFetch) {
        const d = pendingFetch;
        pendingFetch = null;
        d.reject(new Error('canceled'));
      }
      await Promise.resolve();
    }),
    setQueryData: vi.fn((_key: QueryKey, updater: unknown): unknown => {
      const next =
        typeof updater === 'function'
          ? (updater as (old: CachedActiveSessionsData | undefined) => unknown)(cache)
          : updater;
      cache = next as CachedActiveSessionsData;
      return next;
    }),
    getQueryData: vi.fn((_key: QueryKey) => cache as unknown),
    fetchQuery: vi.fn(
      async (opts: {
        queryKey: QueryKey;
        queryFn: QueryFunction<CachedActiveSessionsData>;
        staleTime?: number;
      }): Promise<CachedActiveSessionsData> => {
        fetchQueryCalls += 1;
        // Register cancellation before the guarded queryFn yields. Publish only
        // after both the queryFn and the test-controlled response settle.
        const d = deferred<CachedActiveSessionsData>();
        pendingFetch = d;
        try {
          const [, result] = await Promise.all([
            (opts.queryFn as unknown as () => Promise<unknown>)(),
            d.promise,
          ]);
          cache = result;
          return result;
        } finally {
          if (pendingFetch === d) {
            pendingFetch = null;
          }
        }
      }
    ),
    fetchQueryCalls: 0,
    cancelQueriesCalls: 0,
    __setCached(data: CachedActiveSessionsData | undefined) {
      cache = data;
    },
    __triggerFetchResolve(data: CachedActiveSessionsData) {
      if (pendingFetch) {
        const d = pendingFetch;
        pendingFetch = null;
        d.resolve(data);
      }
    },
    __triggerFetchReject(error: Error) {
      if (pendingFetch) {
        const d = pendingFetch;
        pendingFetch = null;
        d.reject(error);
      }
    },
    __hasPendingFetch() {
      return pendingFetch !== null;
    },
    __getCached() {
      return cache;
    },
  };
  Object.defineProperty(qc, 'fetchQueryCalls', {
    get() {
      return fetchQueryCalls;
    },
  });
  Object.defineProperty(qc, 'cancelQueriesCalls', {
    get() {
      return cancelQueriesCalls;
    },
  });
  return qc as unknown as FakeQueryClient;
}

export const QUERY_KEY = ['activeSessions', 'list'] as const;

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

export function setupLiveSync(): void {
  beforeEach(() => {
    vi.useRealTimers();
    confirmAuthenticatedOwner(beginAuthenticatedOwner(), 'A');
  });
  afterEach(() => {
    beginAuthenticatedOwner();
    vi.useRealTimers();
  });
}

export { ActiveSessionsLiveSync };
