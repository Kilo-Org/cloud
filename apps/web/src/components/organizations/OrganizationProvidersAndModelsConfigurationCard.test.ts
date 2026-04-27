import { describe, test, expect } from '@jest/globals';
import { computeProviderSelectionsForSummaryCard } from './OrganizationProvidersAndModelsConfigurationCard';

describe('computeProviderSelectionsForSummaryCard', () => {
  test('undefined allow lists return null (all providers and models)', () => {
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
      modelAllowList: undefined,
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
      modelAllowList: undefined,
    });

    expect(selections).toEqual([
      {
        slug: 'openai',
        models: ['openai/gpt-4'],
      },
    ]);
  });

  test('modelAllowList excludes newly synced models not listed', () => {
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
      modelAllowList: ['anthropic/claude-3-sonnet'],
    });

    expect(selections).toEqual([
      {
        slug: 'anthropic',
        models: ['anthropic/claude-3-sonnet'],
      },
    ]);
  });

  test('combined allow lists include only matching providers and models', () => {
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
      modelAllowList: ['anthropic/claude-3-sonnet'],
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
      modelAllowList: undefined,
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
      providerAllowList: undefined,
      modelAllowList: ['anthropic/disabled-model'],
    });

    expect(selections).toEqual([]);
  });
});
