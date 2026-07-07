import { describe, expect, it } from '@jest/globals';
import { preferredModels } from '@/lib/ai-gateway/models';
import type { ModelOption } from './ModelCombobox';
import { buildModelOptionGroups, getModelOptionKeywords } from './model-combobox-options';

describe('model combobox options', () => {
  it('groups CLI options by provider and searches provider/model names and exact ids', () => {
    const options = [
      {
        id: 'remote-model-0',
        name: 'Workspace Claude',
        displayId: 'shared/model.id',
        providerGroup: { id: 'anthropic-local', label: 'Anthropic Local' },
        searchTerms: ['anthropic-local', 'Anthropic Local', 'shared/model.id'],
        showGatewayMetadata: false,
      },
      {
        id: 'remote-model-1',
        name: 'Internal Deployment',
        displayId: 'shared/model.id',
        providerGroup: { id: 'custom-openai', label: 'Custom OpenAI' },
        searchTerms: ['custom-openai', 'Custom OpenAI', 'shared/model.id'],
        showGatewayMetadata: false,
      },
    ] satisfies ModelOption[];

    expect(buildModelOptionGroups(options)).toEqual([
      { id: 'provider:anthropic-local', heading: 'Anthropic Local', models: [options[0]] },
      { id: 'provider:custom-openai', heading: 'Custom OpenAI', models: [options[1]] },
    ]);
    expect(getModelOptionKeywords(options[0])).toEqual(
      expect.arrayContaining([
        'Workspace Claude',
        'shared/model.id',
        'anthropic-local',
        'Anthropic Local',
      ])
    );
    expect(getModelOptionKeywords(options[0])).not.toContain('remote-model-0');
  });

  it('keeps existing Gateway options in Recommended and All Models groups', () => {
    const preferred = { id: preferredModels[0], name: 'Preferred Gateway model' };
    const other = { id: 'provider/other-model', name: 'Other Gateway model' };

    expect(buildModelOptionGroups([other, preferred])).toEqual([
      { id: 'recommended', heading: 'Recommended', models: [preferred] },
      { id: 'all-models', heading: 'All Models', models: [other] },
    ]);
    expect(getModelOptionKeywords(other)).toContain('provider/other-model');
  });
});
