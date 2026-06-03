import { describe, expect, it } from 'vitest';

import { type ModelOption } from '@/lib/hooks/use-available-models';

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
});
