import { describe, expect, it } from '@jest/globals';
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

    expect(buildModelOptionGroups(options, [])).toEqual([
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
    const preferred = { id: 'provider/preferred-model', name: 'Preferred Gateway model' };
    const secondPreferred = { id: 'provider/second-model', name: 'A second preferred model' };
    const other = { id: 'provider/other-model', name: 'Other Gateway model' };

    expect(
      buildModelOptionGroups(
        [other, secondPreferred, preferred],
        [preferred.id, secondPreferred.id]
      )
    ).toEqual([
      { id: 'recommended', heading: 'Recommended', models: [preferred, secondPreferred] },
      { id: 'all-models', heading: 'All Models', models: [other] },
    ]);
    expect(getModelOptionKeywords(other)).toContain('provider/other-model');
  });

  it('pulls favorited models into a leading Favorites group across providers', () => {
    const providerModel = {
      id: 'remote-model-0',
      name: 'Workspace Claude',
      providerGroup: { id: 'anthropic-local', label: 'Anthropic Local' },
      modelRef: { providerID: 'anthropic-local', modelID: 'shared/model.id' },
      overrideSource: 'cli-catalog',
    } satisfies ModelOption;
    const gatewayModel = { id: 'openai/gpt-5', name: 'GPT 5' };
    const otherGatewayModel = { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4' };

    expect(
      buildModelOptionGroups(
        [gatewayModel, providerModel, otherGatewayModel],
        [otherGatewayModel.id],
        new Set(['remote:anthropic-local:shared/model.id', 'openai/gpt-5'])
      )
    ).toEqual([
      { id: 'favorites', heading: 'Favorites', models: [gatewayModel, providerModel] },
      { id: 'recommended', heading: 'Recommended', models: [otherGatewayModel] },
    ]);
  });

  it('matches favorites through the remote:kilo alias and leaves other grouping unchanged', () => {
    const kiloCliModel = {
      id: 'remote-model-0',
      name: 'Claude Sonnet 4',
      providerGroup: { id: 'kilo', label: 'Kilo' },
      modelRef: { providerID: 'kilo', modelID: 'anthropic/claude-sonnet-4' },
      overrideSource: 'cli-catalog',
    } satisfies ModelOption;
    const otherKiloModel = {
      id: 'remote-model-1',
      name: 'GPT 5',
      providerGroup: { id: 'kilo', label: 'Kilo' },
      modelRef: { providerID: 'kilo', modelID: 'openai/gpt-5' },
      overrideSource: 'cli-catalog',
    } satisfies ModelOption;

    expect(
      buildModelOptionGroups(
        [kiloCliModel, otherKiloModel],
        [],
        new Set(['remote:kilo:anthropic/claude-sonnet-4'])
      )
    ).toEqual([
      { id: 'favorites', heading: 'Favorites', models: [kiloCliModel] },
      { id: 'provider:kilo', heading: 'Kilo', models: [otherKiloModel] },
    ]);

    expect(buildModelOptionGroups([kiloCliModel, otherKiloModel], [])).toEqual([
      { id: 'provider:kilo', heading: 'Kilo', models: [kiloCliModel, otherKiloModel] },
    ]);
  });
});
