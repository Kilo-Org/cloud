import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as React from 'react';

import { type LocalRuntimeFence } from '@/lib/hooks/local-runtime-catalog-types';
import { RUNTIME_A } from './local-runtime-catalog-test-fixtures';
import {
  buildLocalRuntimeCatalogState,
  type LocalSessionConfigController,
  useLocalSessionConfigController,
} from './use-local-session-config-controller';
import { type LocalRuntimeCatalog } from './local-runtime-catalog-types';

const FENCE_A: LocalRuntimeFence = {
  runtimeId: RUNTIME_A.runtimeId,
  connectionId: RUNTIME_A.connectionId,
};

const CATALOG: LocalRuntimeCatalog = {
  protocolVersion: 1,
  models: {
    protocolVersion: 1,
    providers: [
      {
        id: 'anthropic',
        name: 'Anthropic',
        models: [{ id: 'claude-1', name: 'Claude 1', variants: ['low', 'high'] }],
      },
    ],
    defaultModel: { providerID: 'anthropic', modelID: 'claude-1' },
    truncated: false,
  },
  agents: [{ slug: 'build', name: 'Build' }],
  defaultAgent: 'build',
};

let capturedFence: LocalRuntimeFence | null = null;
let selectionState = {
  selectedFence: null as LocalRuntimeFence | null,
  agentOverride: null,
  modelOverride: null,
};
const dispatch = vi.fn();

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof React>('react');
  return {
    ...actual,
    useEffect: () => undefined,
    useMemo: <T>(fn: () => T) => fn(),
    useCallback: <T>(fn: T) => fn,
    useReducer: () => [selectionState, dispatch] as const,
  };
});

vi.mock('@/components/agents/user-web-connection-provider', () => ({
  useUserWebConnection: () => null,
}));

vi.mock('./use-local-runtimes', () => ({
  useLocalRuntimes: () => ({
    data: { runtimes: [RUNTIME_A] },
    isError: false,
    refetch: () => undefined,
  }),
}));

vi.mock('./use-local-runtime-catalog', () => ({
  useLocalRuntimeCatalog: (fence: LocalRuntimeFence | null) => {
    capturedFence = fence;
    return {
      data: undefined,
      error: null,
      refetch: () => undefined,
    };
  },
}));

beforeEach(() => {
  capturedFence = null;
  selectionState = { selectedFence: null, agentOverride: null, modelOverride: null };
  dispatch.mockReset();
});

describe('buildLocalRuntimeCatalogState', () => {
  it('returns idle when no fence is selected', () => {
    const state = buildLocalRuntimeCatalogState(null, {
      data: undefined,
      error: null,
      refetch: () => undefined,
    });
    expect(state.kind).toBe('idle');
  });

  it('returns loading when a fence is selected and the query has no data yet', () => {
    const state = buildLocalRuntimeCatalogState(FENCE_A, {
      data: undefined,
      error: null,
      refetch: () => undefined,
    });
    expect(state.kind).toBe('loading');
    if (state.kind !== 'loading') {
      throw new Error('expected loading');
    }
    expect(state.runtime.runtimeId).toBe(FENCE_A.runtimeId);
    expect(state.runtime.connectionId).toBe(FENCE_A.connectionId);
  });

  it('returns error with a refetch callback when the query has errored', () => {
    const error = { data: { upstreamCode: 'RUNTIME_NOT_CONNECTED' } };
    const refetch = vi.fn<() => void>();
    const state = buildLocalRuntimeCatalogState(FENCE_A, {
      data: undefined,
      error,
      refetch,
    });
    expect(state.kind).toBe('error');
    if (state.kind !== 'error') {
      throw new Error('expected error');
    }
    expect(state.error).toBe(error);
    state.refetch();
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('returns ready with the exact catalog data and a matching generation identity', () => {
    const refetch = vi.fn<() => void>();
    const state = buildLocalRuntimeCatalogState(FENCE_A, {
      data: CATALOG,
      error: null,
      refetch,
    });
    expect(state.kind).toBe('ready');
    if (state.kind !== 'ready') {
      throw new Error('expected ready');
    }
    expect(state.catalog).toBe(CATALOG);
    expect(state.catalogGeneration).toBe(CATALOG);
  });

  it('carries the exact fence in every non-idle branch', () => {
    const loading = buildLocalRuntimeCatalogState(FENCE_A, {
      data: undefined,
      error: null,
      refetch: () => undefined,
    });
    const error = buildLocalRuntimeCatalogState(FENCE_A, {
      data: undefined,
      error: { data: { upstreamCode: 'RUNTIME_NOT_CONNECTED' } },
      refetch: () => undefined,
    });
    const ready = buildLocalRuntimeCatalogState(FENCE_A, {
      data: CATALOG,
      error: null,
      refetch: () => undefined,
    });
    if (loading.kind !== 'loading' || error.kind !== 'error' || ready.kind !== 'ready') {
      throw new Error('expected loading, error, and ready');
    }
    expect(loading.runtime).toEqual(error.runtime);
    expect(error.runtime).toEqual(ready.runtime);
    expect(ready.runtime).toMatchObject({
      runtimeId: FENCE_A.runtimeId,
      connectionId: FENCE_A.connectionId,
      protocolVersion: 1,
    });
  });
});

describe('useLocalSessionConfigController composition', () => {
  it('passes the exact selected fence to the catalog hook', () => {
    selectionState = { selectedFence: FENCE_A, agentOverride: null, modelOverride: null };
    useLocalSessionConfigController();
    expect(capturedFence).toBe(FENCE_A);
    expect(capturedFence).toEqual({
      runtimeId: RUNTIME_A.runtimeId,
      connectionId: RUNTIME_A.connectionId,
    });
  });

  it('exposes a controller with no submit/prompt/attachment/create surface', () => {
    const controller = useLocalSessionConfigController();
    expect(Object.keys(controller)).toEqual([
      'selection',
      'runtimesState',
      'catalogState',
      'onSelectFence',
      'onClearFence',
      'onSelectAgent',
      'onSelectModel',
      'onResetOverrides',
    ]);
    expect(controller).not.toHaveProperty('onSubmit');
    expect(controller).not.toHaveProperty('onSendPrompt');
    expect(controller).not.toHaveProperty('onAddAttachment');
    expect(controller).not.toHaveProperty('onCreateSession');
  });
});

// Static type assertion: the controller type does not expose session-creation
// APIs. If the type ever gains one of these methods, this assertion will fail
// to compile.
type ForbiddenControllerKeys = 'onSubmit' | 'onSendPrompt' | 'onAddAttachment' | 'onCreateSession';
type AssertNoForbiddenControllerKeys = ForbiddenControllerKeys &
  keyof LocalSessionConfigController extends never
  ? true
  : false;
const _controllerShapeAssertion: AssertNoForbiddenControllerKeys = true;
void _controllerShapeAssertion;
