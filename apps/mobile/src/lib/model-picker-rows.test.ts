/* eslint-disable max-lines -- Favorite-id helpers cover every representation. */
import { describe, expect, it } from 'vitest';

import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';

import {
  buildModelPickerRows,
  canonicalFavoriteId,
  favoriteKeysForOption,
  favoriteToggleAction,
  isFavoriteOption,
  modelPickerFavoriteId,
} from './model-picker-rows';

const noFavorites = new Set<string>();

const gatewayClaude: SessionModelOption = {
  id: 'anthropic/claude-sonnet-4',
  name: 'Claude Sonnet 4',
  displayId: 'anthropic/claude-sonnet-4',
  variants: ['low'],
  isPreferred: true,
  showGatewayMetadata: true,
};

const gatewayGpt5: SessionModelOption = {
  id: 'openai/gpt-5',
  name: 'GPT-5',
  displayId: 'openai/gpt-5',
  variants: ['medium'],
  isPreferred: false,
  showGatewayMetadata: true,
};

const gatewayModels: SessionModelOption[] = [gatewayClaude, gatewayGpt5];

const remoteWorkspaceClaude: SessionModelOption = {
  id: 'remote-model-0',
  name: 'Workspace Claude',
  displayId: 'shared/model.id',
  variants: ['low', 'high'],
  isPreferred: false,
  provider: { id: 'anthropic-local', name: 'Anthropic Local' },
  modelRef: { providerID: 'anthropic-local', modelID: 'shared/model.id' },
  overrideSource: 'cli-catalog',
  showGatewayMetadata: false,
};

const remoteInternalDeployment: SessionModelOption = {
  id: 'remote-model-1',
  name: 'Internal Deployment',
  displayId: 'shared/model.id',
  variants: [],
  isPreferred: false,
  provider: { id: 'custom-openai', name: 'Custom OpenAI' },
  modelRef: { providerID: 'custom-openai', modelID: 'shared/model.id' },
  overrideSource: 'cli-catalog',
  showGatewayMetadata: false,
};

const remoteKiloClaude: SessionModelOption = {
  id: 'remote-model-kilo',
  name: 'Claude Sonnet 4',
  displayId: 'anthropic/claude-sonnet-4',
  variants: [],
  isPreferred: false,
  provider: { id: 'kilo', name: 'Kilo' },
  modelRef: { providerID: 'kilo', modelID: 'anthropic/claude-sonnet-4' },
  overrideSource: 'cli-catalog',
  showGatewayMetadata: false,
};

const remoteModels: SessionModelOption[] = [remoteWorkspaceClaude, remoteInternalDeployment];

describe('buildModelPickerRows', () => {
  it('preserves Recommended and All groups for Gateway models', () => {
    expect(
      buildModelPickerRows({ models: gatewayModels, search: '', favoriteIds: noFavorites })
    ).toEqual([
      { key: 'recommended', title: 'RECOMMENDED', type: 'header' },
      {
        key: 'model:anthropic/claude-sonnet-4',
        model: gatewayModels[0],
        isFavorite: false,
        type: 'model',
      },
      { key: 'all', title: 'ALL MODELS', type: 'header' },
      { key: 'model:openai/gpt-5', model: gatewayModels[1], isFavorite: false, type: 'model' },
    ]);
  });

  it('filters Gateway models by display name and id', () => {
    expect(
      buildModelPickerRows({ models: gatewayModels, search: 'Sonnet 4', favoriteIds: noFavorites })
    ).toEqual([
      { key: 'recommended', title: 'RECOMMENDED', type: 'header' },
      {
        key: 'model:anthropic/claude-sonnet-4',
        model: gatewayModels[0],
        isFavorite: false,
        type: 'model',
      },
    ]);
    expect(
      buildModelPickerRows({ models: gatewayModels, search: 'openai/', favoriteIds: noFavorites })
    ).toEqual([
      { key: 'all', title: 'ALL MODELS', type: 'header' },
      { key: 'model:openai/gpt-5', model: gatewayModels[1], isFavorite: false, type: 'model' },
    ]);
  });

  it('pulls a favorited model into its own FAVORITES group ahead of everything else', () => {
    const favoriteIds = new Set(['openai/gpt-5']);
    expect(buildModelPickerRows({ models: gatewayModels, search: '', favoriteIds })).toEqual([
      { key: 'favorites', title: 'FAVORITES', type: 'header' },
      { key: 'model:openai/gpt-5', model: gatewayModels[1], isFavorite: true, type: 'model' },
      { key: 'recommended', title: 'RECOMMENDED', type: 'header' },
      {
        key: 'model:anthropic/claude-sonnet-4',
        model: gatewayModels[0],
        isFavorite: false,
        type: 'model',
      },
    ]);
  });

  it('groups CLI models by provider and searches provider/model display data, never opaque keys', () => {
    expect(
      buildModelPickerRows({ models: remoteModels, search: '', favoriteIds: noFavorites })
    ).toEqual([
      { key: 'provider:anthropic-local', title: 'ANTHROPIC LOCAL', type: 'header' },
      { key: 'model:remote-model-0', model: remoteModels[0], isFavorite: false, type: 'model' },
      { key: 'provider:custom-openai', title: 'CUSTOM OPENAI', type: 'header' },
      { key: 'model:remote-model-1', model: remoteModels[1], isFavorite: false, type: 'model' },
    ]);
    expect(
      buildModelPickerRows({
        models: remoteModels,
        search: 'custom-openai',
        favoriteIds: noFavorites,
      })
    ).toEqual([
      { key: 'provider:custom-openai', title: 'CUSTOM OPENAI', type: 'header' },
      { key: 'model:remote-model-1', model: remoteModels[1], isFavorite: false, type: 'model' },
    ]);
    expect(
      buildModelPickerRows({
        models: remoteModels,
        search: 'shared/model.id',
        favoriteIds: noFavorites,
      })
    ).toHaveLength(4);
    expect(
      buildModelPickerRows({
        models: remoteModels,
        search: 'remote-model-0',
        favoriteIds: noFavorites,
      })
    ).toEqual([]);
  });

  it('keeps a favorited remote model out of its provider group', () => {
    const favoriteIds = new Set(['remote:custom-openai:shared/model.id']);
    expect(buildModelPickerRows({ models: remoteModels, search: '', favoriteIds })).toEqual([
      { key: 'favorites', title: 'FAVORITES', type: 'header' },
      { key: 'model:remote-model-1', model: remoteModels[1], isFavorite: true, type: 'model' },
      { key: 'provider:anthropic-local', title: 'ANTHROPIC LOCAL', type: 'header' },
      { key: 'model:remote-model-0', model: remoteModels[0], isFavorite: false, type: 'model' },
    ]);
  });

  it('matches remote favorites by CLI identity even when catalog order changes', () => {
    const favoriteIds = new Set(['remote:custom-openai:shared/model.id']);
    // Same catalog, reordered: the favorited model now sits at index 0 and
    // its order-based id changed, but the favorite must follow the model.
    const reordered: SessionModelOption[] = [
      { ...remoteInternalDeployment, id: 'remote-model-0' },
      { ...remoteWorkspaceClaude, id: 'remote-model-1' },
    ];
    expect(buildModelPickerRows({ models: reordered, search: '', favoriteIds })).toEqual([
      { key: 'favorites', title: 'FAVORITES', type: 'header' },
      { key: 'model:remote-model-0', model: reordered[0], isFavorite: true, type: 'model' },
      { key: 'provider:anthropic-local', title: 'ANTHROPIC LOCAL', type: 'header' },
      { key: 'model:remote-model-1', model: reordered[1], isFavorite: false, type: 'model' },
    ]);
  });
});

describe('modelPickerFavoriteId', () => {
  it('keys CLI catalog options by provider and model identity, not the opaque id', () => {
    expect(modelPickerFavoriteId(remoteWorkspaceClaude)).toBe(
      'remote:anthropic-local:shared/model.id'
    );
    expect(modelPickerFavoriteId(remoteInternalDeployment)).toBe(
      'remote:custom-openai:shared/model.id'
    );
  });

  it('keys Gateway options by their Gateway model id', () => {
    const gatewayOption: SessionModelOption = {
      id: 'anthropic/claude-sonnet-4',
      name: 'Claude Sonnet 4',
      displayId: 'anthropic/claude-sonnet-4',
      variants: [],
      isPreferred: false,
      showGatewayMetadata: true,
    };
    expect(modelPickerFavoriteId(gatewayOption)).toBe('anthropic/claude-sonnet-4');
  });

  it('keeps legacy Gateway options on the Gateway model id shared with Gateway favorites', () => {
    const legacyOption: SessionModelOption = {
      id: 'anthropic/claude-sonnet-4',
      name: 'Claude Sonnet 4',
      displayId: 'anthropic/claude-sonnet-4',
      variants: [],
      isPreferred: false,
      modelRef: { providerID: 'kilo', modelID: 'anthropic/claude-sonnet-4' },
      overrideSource: 'legacy-gateway',
      showGatewayMetadata: true,
    };
    expect(modelPickerFavoriteId(legacyOption)).toBe('anthropic/claude-sonnet-4');
  });
});

describe('canonicalFavoriteId', () => {
  it('keys a Gateway option by its Gateway model id', () => {
    expect(canonicalFavoriteId(gatewayGpt5)).toBe('openai/gpt-5');
  });

  it('keys a kilo CLI option by its Gateway model id, not remote:kilo', () => {
    expect(canonicalFavoriteId(remoteKiloClaude)).toBe('anthropic/claude-sonnet-4');
  });

  it('keys a non-kilo CLI option by remote:provider:model', () => {
    expect(canonicalFavoriteId(remoteInternalDeployment)).toBe(
      'remote:custom-openai:shared/model.id'
    );
  });

  it('keys a legacy-gateway option by its id', () => {
    const legacyOption: SessionModelOption = {
      id: 'anthropic/claude-sonnet-4',
      name: 'Claude Sonnet 4',
      displayId: 'anthropic/claude-sonnet-4',
      variants: [],
      isPreferred: false,
      modelRef: { providerID: 'kilo', modelID: 'anthropic/claude-sonnet-4' },
      overrideSource: 'legacy-gateway',
      showGatewayMetadata: true,
    };
    expect(canonicalFavoriteId(legacyOption)).toBe('anthropic/claude-sonnet-4');
  });
});

describe('isFavoriteOption', () => {
  it('matches a kilo CLI option by its Gateway id', () => {
    expect(isFavoriteOption(remoteKiloClaude, new Set(['anthropic/claude-sonnet-4']))).toBe(true);
  });

  it('matches a kilo CLI option by its remote:kilo alias', () => {
    expect(
      isFavoriteOption(remoteKiloClaude, new Set(['remote:kilo:anthropic/claude-sonnet-4']))
    ).toBe(true);
  });

  it('matches a Gateway option by its Gateway id', () => {
    expect(isFavoriteOption(gatewayClaude, new Set(['anthropic/claude-sonnet-4']))).toBe(true);
  });

  it('matches a Gateway option by its remote:kilo alias', () => {
    expect(
      isFavoriteOption(gatewayClaude, new Set(['remote:kilo:anthropic/claude-sonnet-4']))
    ).toBe(true);
  });

  it('does not match a Gateway option by an unrelated remote key', () => {
    expect(isFavoriteOption(gatewayGpt5, new Set(['remote:custom-openai:shared/model.id']))).toBe(
      false
    );
  });
});

describe('favoriteKeysForOption', () => {
  it('includes both the Gateway id and the remote:kilo alias for a kilo CLI option', () => {
    expect(favoriteKeysForOption(remoteKiloClaude).toSorted()).toEqual([
      'anthropic/claude-sonnet-4',
      'remote:kilo:anthropic/claude-sonnet-4',
    ]);
  });

  it('includes both the Gateway id and the remote:kilo alias for a Gateway option', () => {
    expect(favoriteKeysForOption(gatewayClaude).toSorted()).toEqual([
      'anthropic/claude-sonnet-4',
      'remote:kilo:anthropic/claude-sonnet-4',
    ]);
  });
});

describe('favoriteToggleAction', () => {
  it('removes only the stored remote:kilo alias', () => {
    expect(favoriteToggleAction(gatewayClaude, ['remote:kilo:anthropic/claude-sonnet-4'])).toEqual({
      type: 'remove',
      models: ['remote:kilo:anthropic/claude-sonnet-4'],
    });
  });

  it('removes both stored keys in any order', () => {
    const action = favoriteToggleAction(gatewayClaude, [
      'anthropic/claude-sonnet-4',
      'remote:kilo:anthropic/claude-sonnet-4',
    ]);
    expect(action.type).toBe('remove');
    if (action.type === 'remove') {
      expect(action.models.toSorted()).toEqual([
        'anthropic/claude-sonnet-4',
        'remote:kilo:anthropic/claude-sonnet-4',
      ]);
    }
  });

  it('adds the canonical id for an unstarred kilo CLI option', () => {
    expect(favoriteToggleAction(remoteKiloClaude, [])).toEqual({
      type: 'add',
      model: 'anthropic/claude-sonnet-4',
    });
  });

  it('removes a stored non-kilo remote key', () => {
    expect(
      favoriteToggleAction(remoteInternalDeployment, ['remote:custom-openai:shared/model.id'])
    ).toEqual({
      type: 'remove',
      models: ['remote:custom-openai:shared/model.id'],
    });
  });
});

describe('favorite grouping across representations', () => {
  it('puts only the Gateway Claude in FAVORITES for a Gateway-only list', () => {
    const favoriteIds = new Set([
      'anthropic/claude-sonnet-4',
      'remote:custom-openai:shared/model.id',
    ]);
    const rows = buildModelPickerRows({ models: gatewayModels, search: '', favoriteIds });
    const favoriteRows = rows.filter(row => row.type === 'model' && row.isFavorite);
    expect(favoriteRows.map(row => (row.type === 'model' ? row.model.id : ''))).toEqual([
      'anthropic/claude-sonnet-4',
    ]);
  });

  it('puts both the kilo CLI and custom CLI rows in FAVORITES for a CLI list', () => {
    const favoriteIds = new Set([
      'anthropic/claude-sonnet-4',
      'remote:custom-openai:shared/model.id',
    ]);
    const rows = buildModelPickerRows({
      models: [remoteKiloClaude, remoteInternalDeployment],
      search: '',
      favoriteIds,
    });
    const favoriteRows = rows.filter(row => row.type === 'model' && row.isFavorite);
    expect(favoriteRows.map(row => (row.type === 'model' ? row.model.id : ''))).toEqual([
      'remote-model-kilo',
      'remote-model-1',
    ]);
  });

  it('keeps the write id unchanged when BYOK is available on a Gateway option', () => {
    const byokGateway: SessionModelOption = {
      ...gatewayClaude,
      hasUserByokAvailable: true,
    };
    expect(canonicalFavoriteId(byokGateway)).toBe('anthropic/claude-sonnet-4');
  });

  it('keeps the write id unchanged when BYOK is available on a custom CLI option', () => {
    const byokCustom: SessionModelOption = {
      ...remoteInternalDeployment,
      hasUserByokAvailable: true,
    };
    expect(canonicalFavoriteId(byokCustom)).toBe('remote:custom-openai:shared/model.id');
  });
});
