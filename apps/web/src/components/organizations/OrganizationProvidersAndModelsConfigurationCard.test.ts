import { describe, test, expect } from '@jest/globals';
import { computeProviderSelectionsForSummaryCard } from './OrganizationProvidersAndModelsConfigurationCard';

describe('computeProviderSelectionsForSummaryCard', () => {
  test('undefined provider allow and model deny lists return null (all providers and models)', () => {
    const openRouterProviders = [
      {
        slug: 'anthropic',
        models: [
          { slug: 'anthropic/claude-3-opus', endpoint: 'chat' },
          { slug: 'anthropic/claude-3-sonnet', endpoint: 'chat' },
        ],
      },
    ];

    const selections = computeProviderSelectionsForSummaryCard({
      openRouterProviders,
      providerAllowList: undefined,
      modelDenyList: undefined,
      availableModelIds: ['anthropic/claude-3-opus', 'anthropic/claude-3-sonnet'],
    });

    expect(selections).toBeNull();
  });

  test('empty model deny list without provider policy returns null', () => {
    const openRouterProviders = [
      {
        slug: 'anthropic',
        models: [{ slug: 'anthropic/claude-3-opus', endpoint: 'chat' }],
      },
    ];

    const selections = computeProviderSelectionsForSummaryCard({
      openRouterProviders,
      providerAllowList: undefined,
      modelDenyList: [],
      availableModelIds: ['anthropic/claude-3-opus'],
    });

    expect(selections).toBeNull();
  });

  test('providerAllowList excludes newly synced providers not listed', () => {
    const openRouterProviders = [
      {
        slug: 'openai',
        models: [{ slug: 'openai/gpt-4', endpoint: 'chat' }],
      },
      {
        slug: 'baidu-qianfan',
        models: [{ slug: 'baidu/ernie', endpoint: 'chat' }],
      },
    ];

    const selections = computeProviderSelectionsForSummaryCard({
      openRouterProviders,
      providerAllowList: ['openai'],
      modelDenyList: undefined,
      availableModelIds: ['openai/gpt-4'],
    });

    expect(selections).toEqual([
      {
        slug: 'openai',
        models: ['openai/gpt-4'],
      },
    ]);
  });

  test('lists only models in the available model list', () => {
    const openRouterProviders = [
      {
        slug: 'anthropic',
        models: [
          { slug: 'anthropic/claude-3-opus', endpoint: 'chat' },
          { slug: 'anthropic/claude-3-sonnet', endpoint: 'chat' },
        ],
      },
    ];

    const selections = computeProviderSelectionsForSummaryCard({
      openRouterProviders,
      providerAllowList: undefined,
      modelDenyList: ['anthropic/claude-3-opus'],
      availableModelIds: ['anthropic/claude-3-sonnet'],
    });

    expect(selections).toEqual([
      {
        slug: 'anthropic',
        models: ['anthropic/claude-3-sonnet'],
      },
    ]);
  });

  test('snapshot models Kilo does not offer are not listed under an allowed provider', () => {
    const openRouterProviders = [
      {
        slug: 'elevenlabs',
        models: [{ slug: 'elevenlabs/eleven-v3', endpoint: 'speech' }],
      },
      {
        slug: 'openai',
        models: [
          { slug: 'openai/gpt-4', endpoint: 'chat' },
          { slug: 'openai/text-embedding-3-small', endpoint: 'embeddings' },
        ],
      },
    ];

    const selections = computeProviderSelectionsForSummaryCard({
      openRouterProviders,
      providerAllowList: ['elevenlabs', 'openai'],
      modelDenyList: undefined,
      availableModelIds: ['openai/gpt-4', 'kilo-auto/balanced'],
    });

    expect(selections).toEqual([{ slug: 'openai', models: ['openai/gpt-4'] }]);
  });

  test('lists an available model under every allowed provider that serves it', () => {
    const openRouterProviders = [
      { slug: 'anthropic', models: [{ slug: 'anthropic/claude-3-opus', endpoint: 'chat' }] },
      { slug: 'amazon-bedrock', models: [{ slug: 'anthropic/claude-3-opus', endpoint: 'chat' }] },
    ];

    const selections = computeProviderSelectionsForSummaryCard({
      openRouterProviders,
      providerAllowList: ['anthropic', 'amazon-bedrock'],
      modelDenyList: undefined,
      availableModelIds: ['anthropic/claude-3-opus'],
    });

    expect(selections).toEqual([
      { slug: 'anthropic', models: ['anthropic/claude-3-opus'] },
      { slug: 'amazon-bedrock', models: ['anthropic/claude-3-opus'] },
    ]);
  });

  test('matches available variant ids to the unsuffixed snapshot slug', () => {
    const openRouterProviders = [
      { slug: 'nvidia', models: [{ slug: 'nvidia/nemotron', endpoint: 'chat' }] },
    ];

    const selections = computeProviderSelectionsForSummaryCard({
      openRouterProviders,
      providerAllowList: ['nvidia'],
      modelDenyList: undefined,
      availableModelIds: ['nvidia/nemotron:free'],
    });

    expect(selections).toEqual([{ slug: 'nvidia', models: ['nvidia/nemotron'] }]);
  });

  test('returns empty array when no explicitly allowed providers survive', () => {
    const openRouterProviders = [
      {
        slug: 'openai',
        models: [{ slug: 'openai/gpt-4', endpoint: 'chat' }],
      },
    ];

    const selections = computeProviderSelectionsForSummaryCard({
      openRouterProviders,
      providerAllowList: [],
      modelDenyList: undefined,
      availableModelIds: [],
    });

    expect(selections).toEqual([]);
  });

  test('models without endpoint are excluded', () => {
    const openRouterProviders = [
      {
        slug: 'anthropic',
        models: [
          { slug: 'anthropic/claude-3-opus', endpoint: 'chat' },
          { slug: 'anthropic/disabled-model' },
        ],
      },
    ];

    const selections = computeProviderSelectionsForSummaryCard({
      openRouterProviders,
      providerAllowList: ['anthropic'],
      modelDenyList: [],
      availableModelIds: ['anthropic/claude-3-opus', 'anthropic/disabled-model'],
    });

    expect(selections).toEqual([
      {
        slug: 'anthropic',
        models: ['anthropic/claude-3-opus'],
      },
    ]);
  });
});
