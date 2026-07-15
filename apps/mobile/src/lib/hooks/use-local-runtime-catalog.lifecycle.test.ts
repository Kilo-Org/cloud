import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as React from 'react';

import {
  type AppStateStatus,
  cleanupTestState,
  FENCE_A,
  importHook,
  makeConnectionWithoutRetain,
  mocks,
  type QueryShape,
  resetTestState,
  testState,
} from './use-local-runtime-catalog.test-harness';

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
    useRef: <T>(initial: T) => ({ current: initial }),
  };
});

vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: { queryKey: unknown; enabled?: boolean }) => {
    testState.lastQueryOptions = options;
    mocks.useQuery(options);
    const result: QueryShape = {
      data: testState.queryData,
      error: testState.queryError,
      isLoading: testState.queryIsLoading,
      refetch: () => {
        testState.refetchCount += 1;
      },
    };
    return result;
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
      getCatalog: {
        queryKey: (input: { runtimeId: string; connectionId: string }) => [
          'localRuntimeControl',
          'getCatalog',
          { runtimeId: input.runtimeId, connectionId: input.connectionId },
        ],
        queryOptions: (
          input: { runtimeId: string; connectionId: string },
          opts?: { staleTime?: number; enabled?: boolean }
        ) => ({
          queryKey: [
            'localRuntimeControl',
            'getCatalog',
            { runtimeId: input.runtimeId, connectionId: input.connectionId },
          ],
          staleTime: opts?.staleTime,
          enabled: opts?.enabled,
        }),
      },
    },
  }),
}));

vi.mock('@/components/agents/user-web-connection-provider', () => ({
  useUserWebConnection: () => mocks.useUserWebConnection(),
}));

vi.mock('@/components/kilo-chat/hooks/use-app-presence', () => ({
  useAppPresence: () => {
    mocks.useAppPresence();
  },
}));

vi.mock('react-native', () => ({
  AppState: {
    addEventListener: (event: string, listener: (state: AppStateStatus) => void) => {
      expect(event).toBe('change');
      testState.appStateListeners.push(listener);
      return {
        remove: () => {
          // subscription removed
        },
      };
    },
  },
}));

beforeEach(resetTestState);
afterEach(cleanupTestState);

describe('useLocalRuntimeCatalog lifecycle', () => {
  it('registers app presence', async () => {
    const { useLocalRuntimeCatalog } = await importHook();
    useLocalRuntimeCatalog(FENCE_A);
    expect(mocks.useAppPresence).toHaveBeenCalledTimes(1);
  });

  it('retains the shared user-web connection and releases it on unmount', async () => {
    const { useLocalRuntimeCatalog } = await importHook();
    useLocalRuntimeCatalog(FENCE_A);

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
    const { useLocalRuntimeCatalog } = await importHook();
    useLocalRuntimeCatalog(FENCE_A);
    const connection = testState.connection;
    if (!connection || typeof connection.retain !== 'function') {
      throw new Error('Expected connection with retain');
    }
    expect(connection.retain).toHaveBeenCalledTimes(1);

    testState.systemListeners[0]?.({
      event: 'runtime.updated',
      data: { runtimeId: FENCE_A.runtimeId },
    });
    testState.systemListeners[0]?.({
      event: 'runtime.disconnected',
      data: { runtimeId: FENCE_A.runtimeId },
    });
    expect(connection.retain).toHaveBeenCalledTimes(1);
  });

  it('invalidates the getCatalog query on runtime.updated and runtime.disconnected', async () => {
    const { useLocalRuntimeCatalog } = await importHook();
    useLocalRuntimeCatalog(FENCE_A);

    testState.systemListeners[0]?.({
      event: 'runtime.updated',
      data: { runtimeId: FENCE_A.runtimeId },
    });
    testState.systemListeners[0]?.({
      event: 'runtime.disconnected',
      data: { runtimeId: FENCE_A.runtimeId },
    });

    expect(testState.invalidatedKeys).toHaveLength(2);
    for (const key of testState.invalidatedKeys) {
      expect(key).toEqual(['localRuntimeControl', 'getCatalog']);
    }
  });

  it('ignores unrelated system events without invalidating', async () => {
    const { useLocalRuntimeCatalog } = await importHook();
    useLocalRuntimeCatalog(FENCE_A);

    testState.systemListeners[0]?.({ event: 'runtimes.list', data: {} });
    testState.systemListeners[0]?.({ event: 'runtime.connected', data: {} });
    testState.systemListeners[0]?.({ event: 'chat.message', data: {} });
    testState.systemListeners[0]?.({ event: 'session.status', data: {} });

    expect(testState.invalidatedKeys).toEqual([]);
  });

  it('refetches on user-web reconnect', async () => {
    const { useLocalRuntimeCatalog } = await importHook();
    useLocalRuntimeCatalog(FENCE_A);
    expect(testState.refetchCount).toBe(0);

    testState.reconnectListeners[0]?.();
    expect(testState.refetchCount).toBe(1);
  });

  it('refetches on app resume (active state)', async () => {
    const { useLocalRuntimeCatalog } = await importHook();
    useLocalRuntimeCatalog(FENCE_A);
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
    const { useLocalRuntimeCatalog } = await importHook();
    const result = useLocalRuntimeCatalog(FENCE_A);

    expect(result).toBeDefined();
    expect(testState.systemListeners).toEqual([]);
    expect(testState.reconnectListeners).toEqual([]);
  });

  it('does not subscribe when the connection lacks retain and still returns the query', async () => {
    testState.connection = makeConnectionWithoutRetain();
    const { useLocalRuntimeCatalog } = await importHook();
    const result = useLocalRuntimeCatalog(FENCE_A);

    expect(result).toBeDefined();
    expect(testState.systemListeners).toEqual([]);
    expect(testState.reconnectListeners).toEqual([]);
    expect(testState.connection.retain).toBeUndefined();
  });

  it('still listens to app resume when the connection is missing', async () => {
    testState.connection = null;
    const { useLocalRuntimeCatalog } = await importHook();
    useLocalRuntimeCatalog(FENCE_A);

    testState.appStateListeners[0]?.('active');
    expect(testState.refetchCount).toBe(1);
  });
});
