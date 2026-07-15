import { describe, expect, it, vi } from 'vitest';

import { RUNTIME_DISCOVERY_COPY } from '@/lib/hooks/runtime-discovery-logic';

import { buildLocalSessionConfigViewModel } from './local-runtime-catalog-view-model';
import { type LocalRuntimeFence } from './local-runtime-catalog-types';
import {
  makeCatalog,
  makeRuntime,
  RUNTIME_A,
  RUNTIME_B,
  RUNTIME_INCAPABLE,
} from './local-runtime-catalog-test-fixtures';

describe('buildLocalSessionConfigViewModel', () => {
  it('returns loading when the runtimes query has no data and is not in error', () => {
    const vm = buildLocalSessionConfigViewModel({
      runtimesState: { data: undefined, isError: false, refetch: vi.fn<() => void>() },
      selectedFence: null,
      onSelectFence: vi.fn<(fence: LocalRuntimeFence) => void>(),
      onClearFence: vi.fn<() => void>(),
      catalogState: { kind: 'idle' },
    });
    expect(vm.kind).toBe('loading');
  });

  it('returns empty with the Slice 1 copy and retry when the list is empty', () => {
    const refetch = vi.fn<() => void>();
    const vm = buildLocalSessionConfigViewModel({
      runtimesState: { data: { runtimes: [] }, isError: false, refetch },
      selectedFence: null,
      onSelectFence: vi.fn<(fence: LocalRuntimeFence) => void>(),
      onClearFence: vi.fn<() => void>(),
      catalogState: { kind: 'idle' },
    });
    expect(vm.kind).toBe('empty');
    if (vm.kind !== 'empty') {
      throw new Error('expected empty');
    }
    expect(vm.title).toBe(RUNTIME_DISCOVERY_COPY.empty.title);
    expect(vm.message).toBe(RUNTIME_DISCOVERY_COPY.empty.message);
    vm.retry();
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('returns selecting-runtime when no fence is set and multiple capable runtimes are present', () => {
    const onSelectFence = vi.fn<(fence: LocalRuntimeFence) => void>();
    const vm = buildLocalSessionConfigViewModel({
      runtimesState: {
        data: { runtimes: [makeRuntime(), makeRuntime(RUNTIME_B)] },
        isError: false,
        refetch: vi.fn<() => void>(),
      },
      selectedFence: null,
      onSelectFence,
      onClearFence: vi.fn<() => void>(),
      catalogState: { kind: 'idle' },
    });
    expect(vm.kind).toBe('selecting-runtime');
    if (vm.kind !== 'selecting-runtime') {
      throw new Error('expected selecting-runtime');
    }
    expect(vm.runtimes).toHaveLength(2);
    expect(vm.currentFence).toBeNull();
  });

  it('auto-selects and returns ready when one capable runtime is present', () => {
    const onSelectFence = vi.fn<(fence: LocalRuntimeFence) => void>();
    const catalog = makeCatalog();
    const vm = buildLocalSessionConfigViewModel({
      runtimesState: {
        data: { runtimes: [makeRuntime()] },
        isError: false,
        refetch: vi.fn<() => void>(),
      },
      selectedFence: null,
      onSelectFence,
      onClearFence: vi.fn<() => void>(),
      catalogState: {
        kind: 'ready',
        runtime: makeRuntime(),
        catalog,
        catalogGeneration: catalog,
      },
    });
    expect(vm.kind).toBe('ready');
    if (vm.kind !== 'ready') {
      throw new Error('expected ready');
    }
    expect(onSelectFence).not.toHaveBeenCalled();
  });

  it('returns incapable when the only listed runtime lacks catalog.v1', () => {
    const vm = buildLocalSessionConfigViewModel({
      runtimesState: {
        data: { runtimes: [makeRuntime(RUNTIME_INCAPABLE)] },
        isError: false,
        refetch: vi.fn<() => void>(),
      },
      selectedFence: null,
      onSelectFence: vi.fn<(fence: LocalRuntimeFence) => void>(),
      onClearFence: vi.fn<() => void>(),
      catalogState: { kind: 'idle' },
    });
    expect(vm.kind).toBe('incapable');
  });

  it('returns catalog-loading when a fence is set and the catalog is still fetching', () => {
    const vm = buildLocalSessionConfigViewModel({
      runtimesState: {
        data: { runtimes: [makeRuntime()] },
        isError: false,
        refetch: vi.fn<() => void>(),
      },
      selectedFence: { runtimeId: RUNTIME_A.runtimeId, connectionId: RUNTIME_A.connectionId },
      onSelectFence: vi.fn<(fence: LocalRuntimeFence) => void>(),
      onClearFence: vi.fn<() => void>(),
      catalogState: { kind: 'loading', runtime: makeRuntime() },
    });
    expect(vm.kind).toBe('catalog-loading');
  });

  it('returns the retryable error view-model with the exact copy and a retry callback', () => {
    const refetchCatalog = vi.fn<() => void>();
    const onClearFence = vi.fn<() => void>();
    const vm = buildLocalSessionConfigViewModel({
      runtimesState: {
        data: { runtimes: [makeRuntime()] },
        isError: false,
        refetch: vi.fn<() => void>(),
      },
      selectedFence: { runtimeId: RUNTIME_A.runtimeId, connectionId: RUNTIME_A.connectionId },
      onSelectFence: vi.fn<(fence: LocalRuntimeFence) => void>(),
      onClearFence,
      catalogState: {
        kind: 'error',
        runtime: makeRuntime(),
        error: { data: { upstreamCode: 'RUNTIME_NOT_CONNECTED' } },
        refetch: refetchCatalog,
      },
    });
    expect(vm.kind).toBe('catalog-error-retryable');
    if (vm.kind !== 'catalog-error-retryable') {
      throw new Error('expected retryable error');
    }
    expect(vm.title).toBe("Couldn't load runtime catalog");
    expect(vm.message).toBe('Check that kilo remote is still connected, then try again.');
    vm.retry();
    expect(refetchCatalog).toHaveBeenCalledTimes(1);
    vm.onChangeRuntime();
    expect(onClearFence).toHaveBeenCalledTimes(1);
  });

  it('returns the non-retryable capability view-model without a retry callback for CLI_UPGRADE_REQUIRED', () => {
    const onClearFence = vi.fn<() => void>();
    const vm = buildLocalSessionConfigViewModel({
      runtimesState: {
        data: { runtimes: [makeRuntime()] },
        isError: false,
        refetch: vi.fn<() => void>(),
      },
      selectedFence: { runtimeId: RUNTIME_A.runtimeId, connectionId: RUNTIME_A.connectionId },
      onSelectFence: vi.fn<(fence: LocalRuntimeFence) => void>(),
      onClearFence,
      catalogState: {
        kind: 'error',
        runtime: makeRuntime(),
        error: { data: { upstreamCode: 'CLI_UPGRADE_REQUIRED' } },
        refetch: vi.fn<() => void>(),
      },
    });
    expect(vm.kind).toBe('catalog-error-non-retryable');
    if (vm.kind !== 'catalog-error-non-retryable') {
      throw new Error('expected non-retryable');
    }
    expect(vm.title).toBe('Update Kilo CLI');
    expect(vm.message).toBe('Update Kilo CLI and reconnect.');
    expect('retry' in vm).toBe(false);
  });

  it('returns the non-retryable malformed view-model for an INVALID_RUNTIME_RESPONSE', () => {
    const vm = buildLocalSessionConfigViewModel({
      runtimesState: {
        data: { runtimes: [makeRuntime()] },
        isError: false,
        refetch: vi.fn<() => void>(),
      },
      selectedFence: { runtimeId: RUNTIME_A.runtimeId, connectionId: RUNTIME_A.connectionId },
      onSelectFence: vi.fn<(fence: LocalRuntimeFence) => void>(),
      onClearFence: vi.fn<() => void>(),
      catalogState: {
        kind: 'error',
        runtime: makeRuntime(),
        error: { data: { upstreamCode: 'INVALID_RUNTIME_RESPONSE' } },
        refetch: vi.fn<() => void>(),
      },
    });
    expect(vm.kind).toBe('catalog-error-non-retryable');
    if (vm.kind !== 'catalog-error-non-retryable') {
      throw new Error('expected non-retryable');
    }
    expect(vm.message).toBe("This runtime can't provide a usable catalog.");
  });

  it('downgrades a malformed-shape success to the non-retryable error path', () => {
    const catalog = makeCatalog({ defaultAgent: 'ghost' });
    const vm = buildLocalSessionConfigViewModel({
      runtimesState: {
        data: { runtimes: [makeRuntime()] },
        isError: false,
        refetch: vi.fn<() => void>(),
      },
      selectedFence: { runtimeId: RUNTIME_A.runtimeId, connectionId: RUNTIME_A.connectionId },
      onSelectFence: vi.fn<(fence: LocalRuntimeFence) => void>(),
      onClearFence: vi.fn<() => void>(),
      catalogState: {
        kind: 'ready',
        runtime: makeRuntime(),
        catalog,
        catalogGeneration: catalog,
      },
    });
    expect(vm.kind).toBe('catalog-error-non-retryable');
    if (vm.kind !== 'catalog-error-non-retryable') {
      throw new Error('expected non-retryable');
    }
    expect(vm.message).toBe("This runtime can't provide a usable catalog.");
  });

  it('returns ready with the default agent and pinned model pre-selected', () => {
    const onSelectAgent = vi.fn<(slug: string) => void>();
    const onSelectModel =
      vi.fn<(selection: { providerID: string; modelID: string; variant: string }) => void>();
    const catalog = makeCatalog();
    const vm = buildLocalSessionConfigViewModel({
      runtimesState: {
        data: { runtimes: [makeRuntime()] },
        isError: false,
        refetch: vi.fn<() => void>(),
      },
      selectedFence: { runtimeId: RUNTIME_A.runtimeId, connectionId: RUNTIME_A.connectionId },
      onSelectFence: vi.fn<(fence: LocalRuntimeFence) => void>(),
      onClearFence: vi.fn<() => void>(),
      catalogState: {
        kind: 'ready',
        runtime: makeRuntime(),
        catalog,
        catalogGeneration: catalog,
      },
    });
    expect(vm.kind).toBe('ready');
    if (vm.kind !== 'ready') {
      throw new Error('expected ready');
    }
    expect(vm.selectedAgent.slug).toBe('build');
    expect(vm.selectedModel.modelID).toBe('claude-1');
    expect(vm.selectedVariant).toBe('low');
    expect(vm.isModelLocked).toBe(false);
    expect(vm.catalogGeneration).toBe(vm.catalog);
    vm.onSelectAgent('plan');
    expect(onSelectAgent).not.toHaveBeenCalled();
    void onSelectAgent;
    void onSelectModel;
  });

  it('marks isModelLocked when the default agent pins its model', () => {
    const pinnedCatalog = makeCatalog({
      agents: [
        {
          slug: 'build',
          name: 'Build',
          model: { providerID: 'anthropic', modelID: 'claude-1' },
          variant: 'high',
        },
        { slug: 'plan', name: 'Plan' },
      ],
    });
    const vm = buildLocalSessionConfigViewModel({
      runtimesState: {
        data: { runtimes: [makeRuntime()] },
        isError: false,
        refetch: vi.fn<() => void>(),
      },
      selectedFence: { runtimeId: RUNTIME_A.runtimeId, connectionId: RUNTIME_A.connectionId },
      onSelectFence: vi.fn<(fence: LocalRuntimeFence) => void>(),
      onClearFence: vi.fn<() => void>(),
      catalogState: {
        kind: 'ready',
        runtime: makeRuntime(),
        catalog: pinnedCatalog,
        catalogGeneration: pinnedCatalog,
      },
    });
    expect(vm.kind).toBe('ready');
    if (vm.kind !== 'ready') {
      throw new Error('expected ready');
    }
    expect(vm.isModelLocked).toBe(true);
    expect(vm.selectedVariant).toBe('high');
  });
});
