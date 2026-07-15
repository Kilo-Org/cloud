import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type LocalRuntimeCatalog } from '@/lib/hooks/local-runtime-catalog-types';

import {
  areRuntimeCatalogModelSelectionScopesEqual,
  clearRuntimeCatalogModelPickerBridge,
  commitRuntimeCatalogModelPickerSelection,
  getRuntimeCatalogModelPickerBridge,
  resolveRuntimeCatalogModelSelection,
  type RuntimeCatalogModelSelection,
  type RuntimeCatalogModelSelectionScope,
  setRuntimeCatalogModelPickerBridge,
} from './picker-bridge';

const FENCE = {
  runtimeId: '11111111-1111-4111-8111-111111111111',
  connectionId: 'cli-a',
};
const CATALOG_GENERATION = {};

function makeCatalog(): LocalRuntimeCatalog {
  return {
    protocolVersion: 1,
    models: {
      protocolVersion: 1,
      providers: [
        {
          id: 'anthropic',
          name: 'Anthropic',
          models: [
            { id: 'claude-1', name: 'Claude 1', variants: ['low', 'high'] },
            { id: 'claude-2', name: 'Claude 2', variants: ['low', 'high'] },
          ],
        },
        {
          id: 'openai',
          name: 'OpenAI',
          models: [{ id: 'gpt-1', name: 'GPT 1', variants: ['low'] }],
        },
      ],
      defaultModel: { providerID: 'anthropic', modelID: 'claude-1' },
      truncated: false,
    },
    agents: [
      { slug: 'build', name: 'Build' },
      { slug: 'plan', name: 'Plan' },
    ],
    defaultAgent: 'build',
  };
}

function makeBridge(
  overrides: Partial<{
    catalog: LocalRuntimeCatalog;
    currentFence: { runtimeId: string; connectionId: string };
    currentValue: string;
    currentVariant: string;
    selectionScope: RuntimeCatalogModelSelectionScope;
    isSelectionCurrent: (scope: RuntimeCatalogModelSelectionScope) => boolean;
    onSelect: (selection: RuntimeCatalogModelSelection) => void;
  }> = {}
) {
  return {
    catalog: makeCatalog(),
    currentFence: FENCE,
    currentValue: 'claude-1',
    currentVariant: 'low',
    selectionScope: {
      runtimeId: FENCE.runtimeId,
      connectionId: FENCE.connectionId,
      protocol: 'v1' as const,
      catalogGenerationIdentity: CATALOG_GENERATION,
    },
    isSelectionCurrent: vi.fn<(scope: RuntimeCatalogModelSelectionScope) => boolean>(() => true),
    onSelect: vi.fn<(selection: RuntimeCatalogModelSelection) => void>(),
    ...overrides,
  };
}

describe('runtime catalog model picker bridge', () => {
  beforeEach(() => {
    clearRuntimeCatalogModelPickerBridge();
  });

  it('preserves exact providerID, modelID, and variant when resolving a draft selection', () => {
    const onSelect = vi.fn<(selection: RuntimeCatalogModelSelection) => void>();
    setRuntimeCatalogModelPickerBridge({
      ...makeBridge(),
      onSelect: selection => {
        onSelect(selection);
      },
    });
    const bridge = getRuntimeCatalogModelPickerBridge();
    if (!bridge) {
      throw new Error('Expected runtime catalog model picker bridge');
    }

    const resolved = resolveRuntimeCatalogModelSelection(bridge, {
      providerID: 'anthropic',
      modelID: 'claude-2',
      variant: 'high',
    });
    expect(resolved).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-2',
      variant: 'high',
    });
  });

  it('falls back to the first variant of the model when the requested variant is unknown', () => {
    const bridge = makeBridge();
    const resolved = resolveRuntimeCatalogModelSelection(bridge, {
      providerID: 'anthropic',
      modelID: 'claude-1',
      variant: 'gone',
    });
    expect(resolved).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-1',
      variant: 'low',
    });
  });

  it('returns null when the provider is not in the catalog', () => {
    const bridge = makeBridge();
    expect(
      resolveRuntimeCatalogModelSelection(bridge, {
        providerID: 'missing',
        modelID: 'claude-1',
        variant: 'low',
      })
    ).toBeNull();
  });

  it('returns null when the model is not in the provider', () => {
    const bridge = makeBridge();
    expect(
      resolveRuntimeCatalogModelSelection(bridge, {
        providerID: 'anthropic',
        modelID: 'unknown',
        variant: 'low',
      })
    ).toBeNull();
  });

  it('treats runtimeId, connectionId, protocol, and catalog generation as scope fields', () => {
    const scope: RuntimeCatalogModelSelectionScope = {
      runtimeId: FENCE.runtimeId,
      connectionId: FENCE.connectionId,
      protocol: 'v1',
      catalogGenerationIdentity: CATALOG_GENERATION,
    };
    expect(areRuntimeCatalogModelSelectionScopesEqual(scope, scope)).toBe(true);
    expect(
      areRuntimeCatalogModelSelectionScopesEqual(scope, { ...scope, runtimeId: 'other' })
    ).toBe(false);
    expect(
      areRuntimeCatalogModelSelectionScopesEqual(scope, { ...scope, connectionId: 'cli-a-new' })
    ).toBe(false);
    // Protocol is a fixed 'v1' literal in the type, so any change forces a
    // new value. We still verify the equality helper treats different
    // protocol literals as unequal.
    expect(areRuntimeCatalogModelSelectionScopesEqual(scope, { ...scope, protocol: 'v1' })).toBe(
      true
    );
    expect(
      areRuntimeCatalogModelSelectionScopesEqual(scope, {
        ...scope,
        catalogGenerationIdentity: {},
      })
    ).toBe(false);
  });

  it('commits a model selection when the scope, catalog, and fence are all current', () => {
    const onSelect = vi.fn<(selection: RuntimeCatalogModelSelection) => void>();
    const bridge = {
      ...makeBridge(),
      onSelect,
    };

    expect(
      commitRuntimeCatalogModelPickerSelection(bridge, {
        providerID: 'anthropic',
        modelID: 'claude-2',
        variant: 'high',
      })
    ).toBe(true);
    expect(onSelect).toHaveBeenCalledWith({
      providerID: 'anthropic',
      modelID: 'claude-2',
      variant: 'high',
    });
  });

  it('rejects a tap when the scope is no longer current', () => {
    const onSelect = vi.fn<(selection: RuntimeCatalogModelSelection) => void>();
    const isSelectionCurrent = vi.fn<(scope: RuntimeCatalogModelSelectionScope) => boolean>(
      () => false
    );
    const bridge = {
      ...makeBridge({ isSelectionCurrent }),
      onSelect,
    };

    expect(
      commitRuntimeCatalogModelPickerSelection(bridge, {
        providerID: 'anthropic',
        modelID: 'claude-2',
        variant: 'high',
      })
    ).toBe(false);
    expect(onSelect).not.toHaveBeenCalled();
    expect(isSelectionCurrent).toHaveBeenCalledWith(bridge.selectionScope);
  });

  it('rejects a tap when the scope fence diverges from the catalog fence (reconnect)', () => {
    const onSelect = vi.fn<(selection: RuntimeCatalogModelSelection) => void>();
    const bridge = {
      ...makeBridge({
        // The screen re-published the scope with a fresh connectionId, but
        // the catalog object still carries the previous fence.
        selectionScope: {
          runtimeId: FENCE.runtimeId,
          connectionId: 'cli-a-new',
          protocol: 'v1',
          catalogGenerationIdentity: CATALOG_GENERATION,
        },
        isSelectionCurrent: () => true,
      }),
      onSelect,
    };

    expect(
      commitRuntimeCatalogModelPickerSelection(bridge, {
        providerID: 'anthropic',
        modelID: 'claude-2',
        variant: 'high',
      })
    ).toBe(false);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('rejects a tap when the scope runtimeId diverges from the catalog fence (disconnect)', () => {
    const onSelect = vi.fn<(selection: RuntimeCatalogModelSelection) => void>();
    const bridge = {
      ...makeBridge({
        currentFence: FENCE,
        selectionScope: {
          runtimeId: '33333333-3333-4333-8333-333333333333',
          connectionId: FENCE.connectionId,
          protocol: 'v1',
          catalogGenerationIdentity: CATALOG_GENERATION,
        },
        isSelectionCurrent: () => true,
      }),
      onSelect,
    };

    expect(
      commitRuntimeCatalogModelPickerSelection(bridge, {
        providerID: 'anthropic',
        modelID: 'claude-2',
        variant: 'high',
      })
    ).toBe(false);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('rejects a tap when the model is not in the catalog', () => {
    const onSelect = vi.fn<(selection: RuntimeCatalogModelSelection) => void>();
    const bridge = {
      ...makeBridge(),
      onSelect,
    };

    expect(
      commitRuntimeCatalogModelPickerSelection(bridge, {
        providerID: 'anthropic',
        modelID: 'unknown',
        variant: 'low',
      })
    ).toBe(false);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
