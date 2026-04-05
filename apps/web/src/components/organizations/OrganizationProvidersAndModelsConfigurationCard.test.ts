import { describe, test, expect } from '@jest/globals';
import { computeProviderSelectionsForSummaryCard } from './OrganizationProvidersAndModelsConfigurationCard';

describe('computeProviderSelectionsForSummaryCard', () => {
  test('both deny lists empty returns null (all providers and models)', () => {
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
      providerDenyList: [],
      modelDenyList: [],
    });

    expect(selections).toBeNull();
  });

  test('providerDenyList excludes denied providers', () => {
    const openRouterProviders = [
      {
        slug: 'openai',
        models: [{ slug: 'openai/gpt-4', endpoint: 'chat' }],
      },
      {
        slug: 'anthropic',
        models: [{ slug: 'anthropic/claude-3-opus', endpoint: 'chat' }],
      },
    ];

    const selections = computeProviderSelectionsForSummaryCard({
      openRouterProviders,
      providerDenyList: ['openai'],
      modelDenyList: [],
    });

    expect(selections).toEqual([
      {
        slug: 'anthropic',
        models: ['anthropic/claude-3-opus'],
      },
    ]);
  });

  test('modelDenyList excludes denied models', () => {
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
      providerDenyList: [],
      modelDenyList: ['anthropic/claude-3-opus'],
    });

    expect(selections).toEqual([
      {
        slug: 'anthropic',
        models: ['anthropic/claude-3-sonnet'],
      },
    ]);
  });

  test('combined deny lists exclude both providers and models', () => {
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
      providerDenyList: ['openai'],
      modelDenyList: ['anthropic/claude-3-opus'],
    });

    expect(selections).toEqual([
      {
        slug: 'anthropic',
        models: ['anthropic/claude-3-sonnet'],
      },
    ]);
  });

  test('returns empty array when all providers are denied (distinct from null which means no restrictions)', () => {
    const openRouterProviders = [
      {
        slug: 'openai',
        models: [{ slug: 'openai/gpt-4', endpoint: 'chat' }],
      },
    ];

    const selections = computeProviderSelectionsForSummaryCard({
      openRouterProviders,
      providerDenyList: ['openai'],
      modelDenyList: [],
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
      providerDenyList: [],
      modelDenyList: ['anthropic/claude-3-opus'],
    });

    // Both models are excluded (one by deny list, one by no endpoint); deny list is non-empty so [] not null
    expect(selections).toEqual([]);
  });
});
