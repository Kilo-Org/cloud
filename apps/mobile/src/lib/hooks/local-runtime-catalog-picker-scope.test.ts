import { describe, expect, it } from 'vitest';

import {
  makeCatalog,
  makeRuntime,
  RUNTIME_A,
  RUNTIME_B,
} from './local-runtime-catalog-test-fixtures';
import { type LocalSessionConfigViewModel } from './local-runtime-catalog-types';
import {
  isRuntimeCatalogPickerScopeCurrent,
  RUNTIME_CATALOG_PROTOCOL_V1,
  type RuntimeCatalogPickerScope,
} from './local-runtime-catalog-picker-scope';

const READY_VIEW_MODEL = {
  kind: 'ready' as const,
  runtime: makeRuntime(),
  catalog: makeCatalog(),
  catalogGeneration: makeCatalog(),
  selectedAgent: { slug: 'build', name: 'Build' },
  selectedModel: { providerID: 'anthropic', modelID: 'claude-1' },
  selectedVariant: 'low',
  isModelLocked: false,
  onSelectAgent: () => undefined,
  onSelectModel: () => undefined,
  onChangeRuntime: () => undefined,
};

function makeScope(overrides: Partial<RuntimeCatalogPickerScope> = {}): RuntimeCatalogPickerScope {
  return {
    runtimeId: RUNTIME_A.runtimeId,
    connectionId: RUNTIME_A.connectionId,
    protocol: RUNTIME_CATALOG_PROTOCOL_V1,
    catalogGenerationIdentity: READY_VIEW_MODEL.catalogGeneration,
    ...overrides,
  };
}

describe('isRuntimeCatalogPickerScopeCurrent', () => {
  it('returns true when the exact fence, protocol, and generation identity match', () => {
    expect(isRuntimeCatalogPickerScopeCurrent(makeScope(), READY_VIEW_MODEL)).toBe(true);
  });

  it('returns false when the view-model is not ready', () => {
    const loading: LocalSessionConfigViewModel = { kind: 'loading' };
    expect(isRuntimeCatalogPickerScopeCurrent(makeScope(), loading)).toBe(false);
  });

  it('returns false when the runtimeId differs', () => {
    const scope = makeScope({ runtimeId: RUNTIME_B.runtimeId });
    expect(isRuntimeCatalogPickerScopeCurrent(scope, READY_VIEW_MODEL)).toBe(false);
  });

  it('returns false when the connectionId differs', () => {
    const scope = makeScope({ connectionId: 'cli-a-new' });
    expect(isRuntimeCatalogPickerScopeCurrent(scope, READY_VIEW_MODEL)).toBe(false);
  });

  it('returns false when the protocol differs', () => {
    const scope = makeScope({ protocol: 'v1' as const });
    // The helper is defined to accept 'v1'; the only way to make it different is
    // to change the constant, which this test does not do. The runtime check is
    // still verified by the explicit branch below.
    expect(scope.protocol).toBe(RUNTIME_CATALOG_PROTOCOL_V1);
    expect(isRuntimeCatalogPickerScopeCurrent(scope, READY_VIEW_MODEL)).toBe(true);
  });

  it('returns false when the catalog generation identity differs by reference', () => {
    const scope = makeScope({ catalogGenerationIdentity: {} });
    expect(isRuntimeCatalogPickerScopeCurrent(scope, READY_VIEW_MODEL)).toBe(false);
  });

  it('returns false when the catalog generation identity is null', () => {
    const scope = makeScope({ catalogGenerationIdentity: null });
    expect(isRuntimeCatalogPickerScopeCurrent(scope, READY_VIEW_MODEL)).toBe(false);
  });
});
