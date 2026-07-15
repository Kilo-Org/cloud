import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as React from 'react';

import {
  type AppStateStatus,
  cleanupTestState,
  FENCE_A,
  FENCE_A_RECONNECTED,
  importHook,
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

describe('useLocalRuntimeCatalog query behavior', () => {
  it('returns the underlying query state unchanged', async () => {
    testState.queryData = { protocolVersion: 1 };
    testState.queryError = { data: { upstreamCode: 'RUNTIME_NOT_CONNECTED' } };

    const { useLocalRuntimeCatalog } = await importHook();
    const result = useLocalRuntimeCatalog(FENCE_A);

    expect(result.data).toBe(testState.queryData);
    expect(result.error).toBe(testState.queryError);
    expect(result.refetch).toBeTypeOf('function');
  });

  it('uses the exact (runtimeId, connectionId) fence as the query key', async () => {
    const { useLocalRuntimeCatalog } = await importHook();
    useLocalRuntimeCatalog(FENCE_A);

    expect(testState.lastQueryOptions?.queryKey).toEqual([
      'localRuntimeControl',
      'getCatalog',
      { runtimeId: FENCE_A.runtimeId, connectionId: FENCE_A.connectionId },
    ]);
    expect(testState.lastQueryOptions?.enabled).toBe(true);
  });

  it('produces a fresh query key when the connectionId changes (runtime reconnect)', async () => {
    const { useLocalRuntimeCatalog } = await importHook();
    useLocalRuntimeCatalog(FENCE_A);
    const firstKey = testState.lastQueryOptions?.queryKey;

    while (testState.cleanups.length > 0) {
      const cleanup = testState.cleanups.pop();
      cleanup?.();
    }

    useLocalRuntimeCatalog(FENCE_A_RECONNECTED);
    const secondKey = testState.lastQueryOptions?.queryKey;

    expect(firstKey).toBeDefined();
    expect(secondKey).toBeDefined();
    expect(secondKey).not.toEqual(firstKey);
    expect(secondKey).toEqual([
      'localRuntimeControl',
      'getCatalog',
      { runtimeId: FENCE_A_RECONNECTED.runtimeId, connectionId: FENCE_A_RECONNECTED.connectionId },
    ]);
  });

  it('disables the query when the fence is null', async () => {
    const { useLocalRuntimeCatalog } = await importHook();
    useLocalRuntimeCatalog(null);

    expect(testState.lastQueryOptions?.enabled).toBe(false);
  });

  it('preserves a thrown catalog error on the returned query state', async () => {
    const catalogError = { data: { upstreamCode: 'RUNTIME_FENCE_MISMATCH' } };
    testState.queryError = catalogError;

    const { useLocalRuntimeCatalog } = await importHook();
    const result = useLocalRuntimeCatalog(FENCE_A);

    expect(result.error).toBe(catalogError);
  });
});
