import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type LocalRuntimeCatalog } from '@/lib/hooks/local-runtime-catalog-types';

import {
  areRuntimeCatalogAgentSelectionScopesEqual,
  clearRuntimeCatalogAgentPickerBridge,
  commitRuntimeCatalogAgentPickerSelection,
  getRuntimeCatalogAgentPickerBridge,
  resolveRuntimeCatalogAgentSelection,
  type RuntimeCatalogAgentSelection,
  type RuntimeCatalogAgentSelectionScope,
  setRuntimeCatalogAgentPickerBridge,
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
          models: [{ id: 'claude-1', name: 'Claude 1', variants: ['low', 'high'] }],
        },
      ],
      defaultModel: { providerID: 'anthropic', modelID: 'claude-1' },
      truncated: false,
    },
    agents: [
      { slug: 'build', name: 'Build', description: 'Plans and writes code.' },
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
    selectionScope: RuntimeCatalogAgentSelectionScope;
    isSelectionCurrent: (scope: RuntimeCatalogAgentSelectionScope) => boolean;
    onSelect: (selection: RuntimeCatalogAgentSelection) => void;
  }> = {}
) {
  return {
    catalog: makeCatalog(),
    currentFence: FENCE,
    currentValue: 'build',
    selectionScope: {
      runtimeId: FENCE.runtimeId,
      connectionId: FENCE.connectionId,
      protocol: 'v1' as const,
      catalogGenerationIdentity: CATALOG_GENERATION,
    },
    isSelectionCurrent: vi.fn<(scope: RuntimeCatalogAgentSelectionScope) => boolean>(() => true),
    onSelect: vi.fn<(selection: RuntimeCatalogAgentSelection) => void>(),
    ...overrides,
  };
}

describe('runtime catalog agent picker bridge', () => {
  beforeEach(() => {
    clearRuntimeCatalogAgentPickerBridge();
  });

  it('preserves the exact slug, name, and description when resolving a draft selection', () => {
    const onSelect = vi.fn<(selection: RuntimeCatalogAgentSelection) => void>();
    setRuntimeCatalogAgentPickerBridge({
      ...makeBridge(),
      onSelect: selection => {
        onSelect(selection);
      },
    });
    const bridge = getRuntimeCatalogAgentPickerBridge();
    if (!bridge) {
      throw new Error('Expected runtime catalog agent picker bridge');
    }

    const resolved = resolveRuntimeCatalogAgentSelection(bridge, { slug: 'build' });
    expect(resolved).toEqual({
      slug: 'build',
      name: 'Build',
      description: 'Plans and writes code.',
    });

    const noDescription = resolveRuntimeCatalogAgentSelection(bridge, { slug: 'plan' });
    if (!noDescription) {
      throw new Error('Expected noDescription to be non-null');
    }
    expect(noDescription).toEqual({
      slug: 'plan',
      name: 'Plan',
    });
    expect('description' in noDescription).toBe(false);
  });

  it('returns null when the slug is not in the catalog', () => {
    const bridge = makeBridge();
    expect(resolveRuntimeCatalogAgentSelection(bridge, { slug: 'unknown' })).toBeNull();
  });

  it('treats runtimeId, connectionId, and catalog generation as scope fields', () => {
    const scope: RuntimeCatalogAgentSelectionScope = {
      runtimeId: FENCE.runtimeId,
      connectionId: FENCE.connectionId,
      protocol: 'v1',
      catalogGenerationIdentity: CATALOG_GENERATION,
    };
    expect(areRuntimeCatalogAgentSelectionScopesEqual(scope, scope)).toBe(true);
    expect(
      areRuntimeCatalogAgentSelectionScopesEqual(scope, { ...scope, runtimeId: 'other' })
    ).toBe(false);
    expect(
      areRuntimeCatalogAgentSelectionScopesEqual(scope, { ...scope, connectionId: 'cli-a-new' })
    ).toBe(false);
    expect(
      areRuntimeCatalogAgentSelectionScopesEqual(scope, { ...scope, catalogGenerationIdentity: {} })
    ).toBe(false);
  });

  it('commits an agent selection when the scope, catalog, and fence are all current', () => {
    const onSelect = vi.fn<(selection: RuntimeCatalogAgentSelection) => void>();
    const bridge = { ...makeBridge(), onSelect };

    expect(commitRuntimeCatalogAgentPickerSelection(bridge, { slug: 'plan' })).toBe(true);
    expect(onSelect).toHaveBeenCalledWith({ slug: 'plan', name: 'Plan' });
  });

  it('rejects a tap when the scope is no longer current', () => {
    const onSelect = vi.fn<(selection: RuntimeCatalogAgentSelection) => void>();
    const isSelectionCurrent = vi.fn<(scope: RuntimeCatalogAgentSelectionScope) => boolean>(
      () => false
    );
    const bridge = { ...makeBridge({ isSelectionCurrent }), onSelect };

    expect(commitRuntimeCatalogAgentPickerSelection(bridge, { slug: 'plan' })).toBe(false);
    expect(onSelect).not.toHaveBeenCalled();
    expect(isSelectionCurrent).toHaveBeenCalledWith(bridge.selectionScope);
  });

  it('rejects a tap when the scope fence diverges from the catalog fence (reconnect)', () => {
    const onSelect = vi.fn<(selection: RuntimeCatalogAgentSelection) => void>();
    const bridge = {
      ...makeBridge({
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

    expect(commitRuntimeCatalogAgentPickerSelection(bridge, { slug: 'plan' })).toBe(false);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('rejects a tap when the scope runtimeId diverges from the catalog fence (disconnect)', () => {
    const onSelect = vi.fn<(selection: RuntimeCatalogAgentSelection) => void>();
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

    expect(commitRuntimeCatalogAgentPickerSelection(bridge, { slug: 'plan' })).toBe(false);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('rejects a tap when the slug is not in the catalog', () => {
    const onSelect = vi.fn<(selection: RuntimeCatalogAgentSelection) => void>();
    const bridge = { ...makeBridge(), onSelect };

    expect(commitRuntimeCatalogAgentPickerSelection(bridge, { slug: 'unknown' })).toBe(false);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
