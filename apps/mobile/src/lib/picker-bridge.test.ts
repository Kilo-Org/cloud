import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  areModelPickerSelectionScopesEqual,
  clearModelPickerBridge,
  commitModelPickerSelection,
  getModelPickerBridge,
  resolveModelPickerSelection,
  setModelPickerBridge,
} from './picker-bridge';

const remoteOption = {
  id: 'remote-model-0',
  name: 'Workspace Claude',
  displayId: 'shared/model.id',
  variants: ['low', 'high'],
  isPreferred: false,
  provider: { id: 'anthropic-local', name: 'Anthropic Local' },
  modelRef: { providerID: 'anthropic-local', modelID: 'shared/model.id' },
  overrideSource: 'cli-catalog' as const,
  showGatewayMetadata: false,
};

const currentSelectionScope = {
  selectionScope: {
    sessionId: 'session-a',
    ownerConnectionId: 'owner-a',
    protocol: 'v1' as const,
    catalogGenerationIdentity: {},
  },
  isSelectionCurrent: () => true,
};

describe('model picker bridge', () => {
  beforeEach(() => {
    clearModelPickerBridge();
  });

  it('preserves exact model identity and override source while resetting an invalid variant', () => {
    const onSelect = vi.fn();
    setModelPickerBridge({
      ...currentSelectionScope,
      options: [remoteOption],
      currentValue: remoteOption.id,
      currentVariant: 'removed',
      onSelect: selection => {
        onSelect(selection);
      },
    });

    const bridge = getModelPickerBridge();
    expect(bridge).not.toBeNull();
    if (!bridge) {
      throw new Error('Expected model picker bridge');
    }

    const selection = resolveModelPickerSelection(bridge, remoteOption.id, 'removed');
    if (!selection) {
      throw new Error('Expected model picker selection');
    }
    expect(selection).toEqual({
      option: remoteOption,
      variant: 'low',
    });
    expect(selection.option.modelRef).toEqual({
      providerID: 'anthropic-local',
      modelID: 'shared/model.id',
    });
    expect(selection.option.overrideSource).toBe('cli-catalog');
  });

  it('treats session, owner, protocol, and catalog generation changes as stale scopes', () => {
    const catalogGenerationIdentity = {};
    const scope = {
      sessionId: 'session-a',
      ownerConnectionId: 'owner-a',
      protocol: 'v1' as const,
      catalogGenerationIdentity,
    };

    expect(areModelPickerSelectionScopesEqual(scope, scope)).toBe(true);
    expect(areModelPickerSelectionScopesEqual(scope, { ...scope, sessionId: 'session-b' })).toBe(
      false
    );
    expect(
      areModelPickerSelectionScopesEqual(scope, { ...scope, ownerConnectionId: 'owner-b' })
    ).toBe(false);
    expect(areModelPickerSelectionScopesEqual(scope, { ...scope, protocol: 'legacy' })).toBe(false);
    expect(
      areModelPickerSelectionScopesEqual(scope, { ...scope, catalogGenerationIdentity: {} })
    ).toBe(false);
  });

  it('discards a detached selection when its session catalog scope is stale', () => {
    const onSelect = vi.fn();
    const catalogGenerationIdentity = {};
    const bridge = {
      options: [remoteOption],
      currentValue: remoteOption.id,
      currentVariant: 'low',
      selectionScope: {
        sessionId: 'session-a',
        ownerConnectionId: 'owner-a',
        protocol: 'v1' as const,
        catalogGenerationIdentity,
      },
      isSelectionCurrent: vi.fn(() => false),
      onSelect,
    };

    expect(commitModelPickerSelection(bridge, remoteOption.id, 'high')).toBe(false);
    expect(bridge.isSelectionCurrent).toHaveBeenCalledWith(bridge.selectionScope);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('commits a detached selection while its session catalog scope is current', () => {
    const onSelect = vi.fn();
    const bridge = {
      options: [remoteOption],
      currentValue: remoteOption.id,
      currentVariant: 'low',
      selectionScope: {
        sessionId: 'session-a',
        ownerConnectionId: 'owner-a',
        protocol: 'v1' as const,
        catalogGenerationIdentity: {},
      },
      isSelectionCurrent: vi.fn(() => true),
      onSelect,
    };

    expect(commitModelPickerSelection(bridge, remoteOption.id, 'high')).toBe(true);
    expect(onSelect).toHaveBeenCalledWith({ option: remoteOption, variant: 'high' });
  });
});
