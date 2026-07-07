import { describe, expect, it } from 'vitest';

import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';

import { buildModelPickerRows, modelPickerFavoriteId } from './model-picker-rows';

const noFavorites = new Set<string>();

const gatewayModels: SessionModelOption[] = [
  {
    id: 'anthropic/claude-sonnet-4',
    name: 'Claude Sonnet 4',
    displayId: 'anthropic/claude-sonnet-4',
    variants: ['low'],
    isPreferred: true,
    showGatewayMetadata: true,
  },
  {
    id: 'openai/gpt-5',
    name: 'GPT-5',
    displayId: 'openai/gpt-5',
    variants: ['medium'],
    isPreferred: false,
    showGatewayMetadata: true,
  },
];

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
