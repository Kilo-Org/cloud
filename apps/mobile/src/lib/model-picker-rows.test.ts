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

const cliModel: ModelOption = {
  id: CLI_MODEL_ID,
  name: 'CLI model — anthropic/claude-sonnet-4',
  variants: [],
  isPreferred: false,
};

describe('buildModelPickerRows', () => {
  it('groups preferred models before all other models', () => {
    expect(buildModelPickerRows({ models, search: '' })).toEqual([
      { key: 'recommended', title: 'RECOMMENDED', type: 'header' },
      { key: 'model:anthropic/claude-sonnet-4', model: models[0], type: 'model' },
      { key: 'all', title: 'ALL MODELS', type: 'header' },
      { key: 'model:openai/gpt-5', model: models[1], type: 'model' },
    ]);
  });

  it('filters models by name', () => {
    expect(buildModelPickerRows({ models, search: 'Sonnet 4' })).toEqual([
      { key: 'recommended', title: 'RECOMMENDED', type: 'header' },
      { key: 'model:anthropic/claude-sonnet-4', model: models[0], type: 'model' },
    ]);
  });

  it('filters models by id', () => {
    expect(buildModelPickerRows({ models, search: 'openai/' })).toEqual([
      { key: 'all', title: 'ALL MODELS', type: 'header' },
      { key: 'model:openai/gpt-5', model: models[1], type: 'model' },
    ]);
  });

  it('keeps the CLI model row first before section headers', () => {
    expect(buildModelPickerRows({ models: [cliModel, ...models], search: '' })).toEqual([
      { key: `model:${CLI_MODEL_ID}`, model: cliModel, type: 'model' },
      { key: 'recommended', title: 'RECOMMENDED', type: 'header' },
      { key: 'model:anthropic/claude-sonnet-4', model: models[0], type: 'model' },
      { key: 'all', title: 'ALL MODELS', type: 'header' },
      { key: 'model:openai/gpt-5', model: models[1], type: 'model' },
    ]);
  });

  it('filters the CLI model row by name', () => {
    expect(buildModelPickerRows({ models: [cliModel, ...models], search: 'CLI model' })).toEqual([
      { key: `model:${CLI_MODEL_ID}`, model: cliModel, type: 'model' },
    ]);
  });
});
