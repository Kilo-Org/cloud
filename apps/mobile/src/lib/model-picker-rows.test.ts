import { describe, expect, it } from 'vitest';

import { type ModelOption } from '@/lib/hooks/use-available-models';
import { CLI_MODEL_ID } from 'cloud-agent-sdk/cli-model';

import { buildModelPickerRows } from './model-picker-rows';

const models: ModelOption[] = [
  {
    id: 'anthropic/claude-sonnet-4',
    name: 'Claude Sonnet 4',
    variants: ['low'],
    isPreferred: true,
  },
  {
    id: 'openai/gpt-5',
    name: 'GPT-5',
    variants: ['medium'],
    isPreferred: false,
  },
];

const noFavorites = new Set<string>();
const claudeFavorites = new Set<string>(['anthropic/claude-sonnet-4']);

const cliModel: ModelOption = {
  id: CLI_MODEL_ID,
  name: 'CLI model — anthropic/claude-sonnet-4',
  variants: [],
  isPreferred: false,
};

describe('buildModelPickerRows', () => {
  it('groups preferred models before all other models', () => {
    expect(buildModelPickerRows({ models, search: '', favoriteIds: noFavorites })).toEqual([
      { key: 'recommended', title: 'RECOMMENDED', type: 'header' },
      {
        key: 'model:anthropic/claude-sonnet-4',
        model: models[0],
        isFavorite: false,
        type: 'model',
      },
      { key: 'all', title: 'ALL MODELS', type: 'header' },
      { key: 'model:openai/gpt-5', model: models[1], isFavorite: false, type: 'model' },
    ]);
  });

  it('groups favorites above recommended when a model is favorited', () => {
    expect(buildModelPickerRows({ models, search: '', favoriteIds: claudeFavorites })).toEqual([
      { key: 'favorites', title: 'FAVORITES', type: 'header' },
      { key: 'model:anthropic/claude-sonnet-4', model: models[0], isFavorite: true, type: 'model' },
      { key: 'all', title: 'ALL MODELS', type: 'header' },
      { key: 'model:openai/gpt-5', model: models[1], isFavorite: false, type: 'model' },
    ]);
  });

  it('filters models by name', () => {
    expect(buildModelPickerRows({ models, search: 'Sonnet 4', favoriteIds: noFavorites })).toEqual([
      { key: 'recommended', title: 'RECOMMENDED', type: 'header' },
      {
        key: 'model:anthropic/claude-sonnet-4',
        model: models[0],
        isFavorite: false,
        type: 'model',
      },
    ]);
  });

  it('filters models by id', () => {
    expect(buildModelPickerRows({ models, search: 'openai/', favoriteIds: noFavorites })).toEqual([
      { key: 'all', title: 'ALL MODELS', type: 'header' },
      { key: 'model:openai/gpt-5', model: models[1], isFavorite: false, type: 'model' },
    ]);
  });

  it('keeps the CLI model row first before section headers', () => {
    expect(
      buildModelPickerRows({ models: [cliModel, ...models], search: '', favoriteIds: noFavorites })
    ).toEqual([
      { key: `model:${CLI_MODEL_ID}`, model: cliModel, isFavorite: false, type: 'model' },
      { key: 'recommended', title: 'RECOMMENDED', type: 'header' },
      {
        key: 'model:anthropic/claude-sonnet-4',
        model: models[0],
        isFavorite: false,
        type: 'model',
      },
      { key: 'all', title: 'ALL MODELS', type: 'header' },
      { key: 'model:openai/gpt-5', model: models[1], isFavorite: false, type: 'model' },
    ]);
  });

  it('keeps the CLI model row above favorites', () => {
    expect(
      buildModelPickerRows({
        models: [cliModel, ...models],
        search: '',
        favoriteIds: claudeFavorites,
      })
    ).toEqual([
      { key: `model:${CLI_MODEL_ID}`, model: cliModel, isFavorite: false, type: 'model' },
      { key: 'favorites', title: 'FAVORITES', type: 'header' },
      { key: 'model:anthropic/claude-sonnet-4', model: models[0], isFavorite: true, type: 'model' },
      { key: 'all', title: 'ALL MODELS', type: 'header' },
      { key: 'model:openai/gpt-5', model: models[1], isFavorite: false, type: 'model' },
    ]);
  });

  it('filters the CLI model row by name', () => {
    expect(
      buildModelPickerRows({
        models: [cliModel, ...models],
        search: 'CLI model',
        favoriteIds: noFavorites,
      })
    ).toEqual([
      { key: `model:${CLI_MODEL_ID}`, model: cliModel, isFavorite: false, type: 'model' },
    ]);
  });
});
