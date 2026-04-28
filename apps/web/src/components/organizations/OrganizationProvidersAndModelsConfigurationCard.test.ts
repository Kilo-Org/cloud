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
    });

    expect(selections).toEqual([
      {
        slug: 'openai',
        models: ['openai/gpt-4'],
      },
    ]);
  });

  test('modelDenyList excludes denied models but not newly synced models', () => {
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
    });

    expect(selections).toEqual([
      {
        slug: 'anthropic',
        models: ['anthropic/claude-3-sonnet'],
      },
    ]);
  });

  test('combined provider allow and model deny lists apply both filters', () => {
    const openRouterProviders = [
      {
        slug: 'openai',
        models: [{ slug: 'openai/gpt-4', endpoint: 'chat' }],
      },
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
      providerAllowList: ['anthropic'],
      modelDenyList: ['anthropic/claude-3-opus'],
    });

    expect(selections).toEqual([
      {
        slug: 'anthropic',
        models: ['anthropic/claude-3-sonnet'],
      },
    ]);
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
    });

    expect(selections).toEqual([
      {
        slug: 'anthropic',
        models: ['anthropic/claude-3-opus'],
      },
    ]);
  });
});
