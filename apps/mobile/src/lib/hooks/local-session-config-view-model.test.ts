import { describe, expect, it, vi } from 'vitest';

import {
  type LocalRuntimeFence,
  type LocalSessionConfigViewModel,
} from './local-runtime-catalog-types';
import { makeCatalog, makeRuntime, RUNTIME_A } from './local-runtime-catalog-test-fixtures';
import { INITIAL_LOCAL_SESSION_CONFIG_SELECTION } from './local-session-config-selection';
import {
  applyLocalSessionConfigSelection,
  type LocalSessionConfigControllerHandlers,
} from './local-session-config-view-model';
import { buildLocalSessionConfigViewModel } from './local-runtime-catalog-view-model';

const FENCE_A: LocalRuntimeFence = {
  runtimeId: RUNTIME_A.runtimeId,
  connectionId: RUNTIME_A.connectionId,
};

function makeHandlers(): LocalSessionConfigControllerHandlers & {
  onSelectAgent: ReturnType<typeof vi.fn<(slug: string) => void>>;
  onSelectModel: ReturnType<
    typeof vi.fn<(selection: { providerID: string; modelID: string; variant: string }) => void>
  >;
  onChangeRuntime: ReturnType<typeof vi.fn<() => void>>;
} {
  return {
    onSelectAgent: vi.fn<(slug: string) => void>(),
    onSelectModel:
      vi.fn<(selection: { providerID: string; modelID: string; variant: string }) => void>(),
    onChangeRuntime: vi.fn<() => void>(),
  };
}

function buildReadyViewModel(): Extract<LocalSessionConfigViewModel, { kind: 'ready' }> {
  const refetch = vi.fn<() => void>();
  const catalog = makeCatalog();
  const vm = buildLocalSessionConfigViewModel({
    runtimesState: {
      data: { runtimes: [makeRuntime()] },
      isError: false,
      refetch,
    },
    selectedFence: FENCE_A,
    onSelectFence: vi.fn<(fence: LocalRuntimeFence) => void>(),
    onClearFence: vi.fn<() => void>(),
    catalogState: {
      kind: 'ready',
      runtime: makeRuntime(),
      catalog,
      catalogGeneration: catalog,
    },
  });
  if (vm.kind !== 'ready') {
    throw new Error('expected ready view-model');
  }
  return vm;
}

describe('applyLocalSessionConfigSelection', () => {
  it('returns the base view-model unchanged for non-ready branches', () => {
    const loadingVm: LocalSessionConfigViewModel = { kind: 'loading' };
    const handlers = makeHandlers();
    expect(
      applyLocalSessionConfigSelection({
        viewModel: loadingVm,
        selection: INITIAL_LOCAL_SESSION_CONFIG_SELECTION,
        handlers,
      })
    ).toBe(loadingVm);
  });

  it('passes through the ready view-model defaults when no controller overrides are set', () => {
    const base = buildReadyViewModel();
    const handlers = makeHandlers();
    const applied = applyLocalSessionConfigSelection({
      viewModel: base,
      selection: INITIAL_LOCAL_SESSION_CONFIG_SELECTION,
      handlers,
    });
    if (applied.kind !== 'ready') {
      throw new Error('expected ready');
    }
    expect(applied.selectedAgent.slug).toBe('build');
    expect(applied.selectedModel.modelID).toBe('claude-1');
    expect(applied.selectedVariant).toBe('low');
    expect(applied.isModelLocked).toBe(false);
    expect(applied.onSelectAgent).toBe(handlers.onSelectAgent);
    expect(applied.onSelectModel).toBe(handlers.onSelectModel);
    expect(applied.onChangeRuntime).toBe(handlers.onChangeRuntime);
  });

  it('applies the controller agent override and pins the model when the agent pins', () => {
    const base = buildReadyViewModel();
    const handlers = makeHandlers();
    const applied = applyLocalSessionConfigSelection({
      viewModel: base,
      selection: {
        selectedFence: FENCE_A,
        agentOverride: 'plan',
        modelOverride: null,
      },
      handlers,
    });
    if (applied.kind !== 'ready') {
      throw new Error('expected ready');
    }
    expect(applied.selectedAgent.slug).toBe('plan');
    expect(applied.isModelLocked).toBe(false);
  });

  it('applies the controller model override to the model+variant when unpinned', () => {
    const base = buildReadyViewModel();
    const handlers = makeHandlers();
    const applied = applyLocalSessionConfigSelection({
      viewModel: base,
      selection: {
        selectedFence: FENCE_A,
        agentOverride: null,
        modelOverride: { providerID: 'anthropic', modelID: 'claude-1', variant: 'high' },
      },
      handlers,
    });
    if (applied.kind !== 'ready') {
      throw new Error('expected ready');
    }
    expect(applied.selectedVariant).toBe('high');
    expect(applied.isModelLocked).toBe(false);
  });

  it('forwards a selection tap from the ready view-model to the controller handler', () => {
    const base = buildReadyViewModel();
    const handlers = makeHandlers();
    const applied = applyLocalSessionConfigSelection({
      viewModel: base,
      selection: INITIAL_LOCAL_SESSION_CONFIG_SELECTION,
      handlers,
    });
    if (applied.kind !== 'ready') {
      throw new Error('expected ready');
    }
    applied.onSelectModel({ providerID: 'anthropic', modelID: 'claude-1', variant: 'high' });
    expect(handlers.onSelectModel).toHaveBeenCalledWith({
      providerID: 'anthropic',
      modelID: 'claude-1',
      variant: 'high',
    });
  });

  it('forwards a change-runtime tap to the controller handler', () => {
    const base = buildReadyViewModel();
    const handlers = makeHandlers();
    const applied = applyLocalSessionConfigSelection({
      viewModel: base,
      selection: INITIAL_LOCAL_SESSION_CONFIG_SELECTION,
      handlers,
    });
    if (applied.kind !== 'ready') {
      throw new Error('expected ready');
    }
    applied.onChangeRuntime();
    expect(handlers.onChangeRuntime).toHaveBeenCalledTimes(1);
  });

  it('returns a new ready object with the exact runtime and catalog fields copied', () => {
    const base = buildReadyViewModel();
    const handlers = makeHandlers();
    const applied = applyLocalSessionConfigSelection({
      viewModel: base,
      selection: INITIAL_LOCAL_SESSION_CONFIG_SELECTION,
      handlers,
    });
    expect(applied).not.toBe(base);
    if (applied.kind !== 'ready') {
      throw new Error('expected ready');
    }
    expect(applied.runtime).toBe(base.runtime);
    expect(applied.catalog).toBe(base.catalog);
    expect(applied.catalogGeneration).toBe(base.catalogGeneration);
    expect(applied.selectedAgent).toBe(base.selectedAgent);
    expect(applied.selectedVariant).toBe(base.selectedVariant);
  });

  it('preserves the locked model when the catalog agent definition already pins it', () => {
    const refetch = vi.fn<() => void>();
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
        refetch,
      },
      selectedFence: FENCE_A,
      onSelectFence: vi.fn<(fence: LocalRuntimeFence) => void>(),
      onClearFence: vi.fn<() => void>(),
      catalogState: {
        kind: 'ready',
        runtime: makeRuntime(),
        catalog: pinnedCatalog,
        catalogGeneration: pinnedCatalog,
      },
    });
    if (vm.kind !== 'ready') {
      throw new Error('expected ready');
    }
    const handlers = makeHandlers();
    const applied = applyLocalSessionConfigSelection({
      viewModel: vm,
      selection: INITIAL_LOCAL_SESSION_CONFIG_SELECTION,
      handlers,
    });
    if (applied.kind !== 'ready') {
      throw new Error('expected ready');
    }
    expect(applied.isModelLocked).toBe(true);
    expect(applied.selectedVariant).toBe('high');
  });
});
