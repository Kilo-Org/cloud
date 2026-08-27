import { describe, expect, it, vi } from 'vitest';

import {
  areModelPickerSelectionScopesEqual,
  commitModelPickerSelection,
  getRepoOptionKey,
  resolveModelPickerSelection,
  resolveRepoOptionByKey,
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
  it('preserves exact model identity and override source while resetting an invalid variant', () => {
    const bridge = {
      ...currentSelectionScope,
      options: [remoteOption],
      currentValue: remoteOption.id,
      currentVariant: 'removed',
      onSelect: vi.fn(),
    };

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

describe('repository picker identity', () => {
  const repository = {
    platform: 'github' as const,
    fullName: 'owner/repo',
  };

  it('distinguishes duplicate GitHub repositories across integrations', () => {
    expect(getRepoOptionKey({ ...repository, platformIntegrationId: 'integration-1' })).not.toBe(
      getRepoOptionKey({ ...repository, platformIntegrationId: 'integration-2' })
    );
  });

  it('keeps the existing platform-qualified key when provenance is absent', () => {
    expect(getRepoOptionKey(repository)).toBe('github:owner/repo');
  });

  it('returns null instead of binding a stale or unknown key', () => {
    const repositories = [
      { ...repository, isPrivate: false, platformIntegrationId: 'integration-1' },
    ];

    expect(resolveRepoOptionByKey(repositories, 'github:integration-2:owner/repo')).toBeNull();
    expect(resolveRepoOptionByKey(repositories, 'github:owner/repo')).toBeNull();
  });
});
