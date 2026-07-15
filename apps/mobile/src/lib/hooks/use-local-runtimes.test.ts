import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as React from 'react';

type AppStateStatus = 'active' | 'background' | 'inactive';

type AppStateListener = (
  event: string,
  listener: (state: AppStateStatus) => void
) => { remove: () => void };

type SystemListener = (event: { event: string; data: unknown }) => void;
type ReconnectListener = () => void;

type ConnectionHandle = {
  retain?: ReturnType<typeof vi.fn<() => () => void>>;
  release: ReturnType<typeof vi.fn<() => void>>;
  onSystemEvent: ReturnType<typeof vi.fn<(listener: SystemListener) => () => void>>;
  offSystemEvent: () => void;
  onReconnect: ReturnType<typeof vi.fn<(listener: ReconnectListener) => () => void>>;
  offReconnect: () => void;
};

type ListenerHandles = Pick<
  ConnectionHandle,
  'onSystemEvent' | 'offSystemEvent' | 'onReconnect' | 'offReconnect'
>;

type TestState = {
  appStateListeners: ((state: AppStateStatus) => void)[];
  addAppStateListener: ReturnType<typeof vi.fn<AppStateListener>>;
  cleanups: (() => void)[];
  connection: ConnectionHandle | null;
  invalidatedKeys: unknown[];
  queryData: { runtimes: unknown[] } | undefined;
  queryError: Error | null;
  queryIsLoading: boolean;
  refetchCount: number;
  systemListeners: SystemListener[];
  reconnectListeners: ReconnectListener[];
};

const testState = vi.hoisted<TestState>(() => ({
  appStateListeners: [],
  addAppStateListener: vi.fn(),
  cleanups: [],
  connection: null,
  invalidatedKeys: [],
  queryData: undefined,
  queryError: null,
  queryIsLoading: false,
  refetchCount: 0,
  systemListeners: [],
  reconnectListeners: [],
}));

const mocks = vi.hoisted(() => ({
  useAppPresence: vi.fn<() => void>(),
  useUserWebConnection: vi.fn<() => ConnectionHandle | null>(),
  useQuery: vi.fn(),
  useQueryClient: vi.fn(),
}));

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof React>('react');
  return {
    ...actual,
    useEffect: (effect: () => (() => void) | undefined) => {
      const cleanup = effect();
      if (typeof cleanup === 'function') {
        testState.cleanups.push(cleanup);
      }
    },
  };
});

vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: { queryKey: unknown }) => {
    mocks.useQuery(options);
    return {
      data: testState.queryData,
      error: testState.queryError,
      isLoading: testState.queryIsLoading,
      refetch: () => {
        testState.refetchCount += 1;
      },
    };
  },
  useQueryClient: () => ({
    invalidateQueries: ({ queryKey }: { queryKey: unknown }) => {
      testState.invalidatedKeys.push(queryKey);
    },
  }),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    localRuntimeControl: {
      list: {
        queryKey: () => ['localRuntimeControl', 'list'],
        queryOptions: () => ({ queryKey: ['localRuntimeControl', 'list'] }),
      },
    },
  }),
}));

vi.mock('@/components/agents/user-web-connection-provider', () => ({
  useUserWebConnection: mocks.useUserWebConnection,
}));

vi.mock('@/components/kilo-chat/hooks/use-app-presence', () => ({
  useAppPresence: mocks.useAppPresence,
}));

vi.mock('react-native', () => ({
  AppState: {
    addEventListener: testState.addAppStateListener,
  },
}));

function makeListenerHandles(): ListenerHandles {
  const offSystem = vi.fn<() => void>();
  const offReconnect = vi.fn<() => void>();
  const onSystemEvent = vi.fn((listener: SystemListener) => {
    testState.systemListeners.push(listener);
    return () => {
      offSystem();
      testState.systemListeners = testState.systemListeners.filter(l => l !== listener);
    };
  });
  const onReconnect = vi.fn((listener: ReconnectListener) => {
    testState.reconnectListeners.push(listener);
    return () => {
      offReconnect();
      testState.reconnectListeners = testState.reconnectListeners.filter(l => l !== listener);
    };
  });
  return { onSystemEvent, offSystemEvent: offSystem, onReconnect, offReconnect };
}

function makeConnection(): ConnectionHandle {
  const release = vi.fn<() => void>();
  const retain = vi.fn<() => () => void>(() => release);
  return { ...makeListenerHandles(), retain, release };
}

function makeConnectionWithoutRetain(): ConnectionHandle {
  return { ...makeListenerHandles(), release: vi.fn<() => void>() };
}

beforeEach(() => {
  testState.appStateListeners = [];
  testState.cleanups = [];
  testState.connection = makeConnection();
  testState.invalidatedKeys = [];
  testState.queryData = undefined;
  testState.queryError = null;
  testState.queryIsLoading = false;
  testState.refetchCount = 0;
  testState.systemListeners = [];
  testState.reconnectListeners = [];
  vi.clearAllMocks();
  mocks.useAppPresence.mockReset();
  mocks.useUserWebConnection.mockReset();
  mocks.useQuery.mockReset();
  testState.addAppStateListener.mockReset();
  testState.addAppStateListener.mockImplementation(
    (event: string, listener: (state: AppStateStatus) => void): { remove: () => void } => {
      expect(event).toBe('change');
      testState.appStateListeners.push(listener);
      return {
        remove: () => {
          // subscription removed
        },
      };
    }
  );
  mocks.useUserWebConnection.mockImplementation(() => testState.connection);
});

afterEach(() => {
  for (const cleanup of testState.cleanups) {
    cleanup();
  }
  vi.clearAllMocks();
});

async function importHook() {
  const module = await import('./use-local-runtimes');
  return module;
}

describe('useLocalRuntimes', () => {
  it('returns the underlying query state unchanged', async () => {
    testState.queryData = { runtimes: [] };
    testState.queryError = new Error('boom');

    const { useLocalRuntimes } = await importHook();
    const result = useLocalRuntimes();

    expect(result.data).toBe(testState.queryData);
    expect(result.error).toBe(testState.queryError);
    expect(result.refetch).toBeTypeOf('function');
  });

  it('subscribes to the localRuntimeControl.list query', async () => {
    const { useLocalRuntimes } = await importHook();
    useLocalRuntimes();

    expect(mocks.useQuery).toHaveBeenCalledTimes(1);
    expect(mocks.useQuery.mock.calls[0]?.[0]).toMatchObject({
      queryKey: ['localRuntimeControl', 'list'],
    });
  });

  it('registers app presence', async () => {
    const { useLocalRuntimes } = await importHook();
    useLocalRuntimes();
    expect(mocks.useAppPresence).toHaveBeenCalledTimes(1);
  });

  it('retains the shared user-web connection and releases it on unmount', async () => {
    const { useLocalRuntimes } = await importHook();
    useLocalRuntimes();

    const connection = testState.connection;
    if (!connection || typeof connection.retain !== 'function') {
      throw new Error('Expected connection with retain');
    }
    expect(connection.retain).toHaveBeenCalledTimes(1);

    while (testState.cleanups.length > 0) {
      const cleanup = testState.cleanups.pop();
      cleanup?.();
    }
    expect(connection.release).toHaveBeenCalledTimes(1);
  });

  it('does not retain a second time when system events fire', async () => {
    const { useLocalRuntimes } = await importHook();
    useLocalRuntimes();
    const connection = testState.connection;
    if (!connection || typeof connection.retain !== 'function') {
      throw new Error('Expected connection with retain');
    }
    expect(connection.retain).toHaveBeenCalledTimes(1);

    testState.systemListeners[0]?.({ event: 'runtime.connected', data: { runtimeId: 'r-1' } });
    testState.systemListeners[0]?.({ event: 'runtimes.list', data: { runtimes: [] } });
    expect(connection.retain).toHaveBeenCalledTimes(1);
  });

  it('invalidates the list query on every supported runtime system event', async () => {
    const { useLocalRuntimes } = await importHook();
    useLocalRuntimes();

    const events = [
      'runtimes.list',
      'runtime.connected',
      'runtime.updated',
      'runtime.disconnected',
    ] as const;
    for (const event of events) {
      testState.systemListeners[0]?.({ event, data: {} });
    }

    expect(testState.invalidatedKeys).toEqual(events.map(() => ['localRuntimeControl', 'list']));
  });

  it('ignores unrelated system events without invalidating', async () => {
    const { useLocalRuntimes } = await importHook();
    useLocalRuntimes();

    testState.systemListeners[0]?.({ event: 'chat.message', data: {} });
    testState.systemListeners[0]?.({ event: 'session.status', data: {} });

    expect(testState.invalidatedKeys).toEqual([]);
  });

  it('refetches on user-web reconnect', async () => {
    const { useLocalRuntimes } = await importHook();
    useLocalRuntimes();
    expect(testState.refetchCount).toBe(0);

    testState.reconnectListeners[0]?.();
    expect(testState.refetchCount).toBe(1);
  });

  it('refetches on app resume (active state)', async () => {
    const { useLocalRuntimes } = await importHook();
    useLocalRuntimes();
    expect(testState.refetchCount).toBe(0);

    testState.appStateListeners[0]?.('background');
    expect(testState.refetchCount).toBe(0);

    testState.appStateListeners[0]?.('active');
    expect(testState.refetchCount).toBe(1);

    testState.appStateListeners[0]?.('active');
    expect(testState.refetchCount).toBe(2);
  });

  it('does not register system or reconnect listeners when the connection is missing', async () => {
    testState.connection = null;
    const { useLocalRuntimes } = await importHook();
    const result = useLocalRuntimes();

    expect(result).toBeDefined();
    expect(testState.systemListeners).toEqual([]);
    expect(testState.reconnectListeners).toEqual([]);
  });

  it('does not subscribe when the connection lacks retain and still returns the query', async () => {
    testState.connection = makeConnectionWithoutRetain();
    const { useLocalRuntimes } = await importHook();
    const result = useLocalRuntimes();

    expect(result).toBeDefined();
    expect(testState.systemListeners).toEqual([]);
    expect(testState.reconnectListeners).toEqual([]);
    expect(testState.connection.retain).toBeUndefined();
  });

  it('still listens to app resume when the connection is missing', async () => {
    testState.connection = null;
    const { useLocalRuntimes } = await importHook();
    useLocalRuntimes();

    testState.appStateListeners[0]?.('active');
    expect(testState.refetchCount).toBe(1);
  });
});
