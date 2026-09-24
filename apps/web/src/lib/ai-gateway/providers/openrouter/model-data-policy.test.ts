import { describe, expect, test } from '@jest/globals';
import {
  buildModelDataPolicies,
  modelRetainsPrompts,
  modelTrains,
  withWorstProviderDataPolicy,
} from '@/lib/ai-gateway/providers/openrouter/model-data-policy';
import { OpenRouterSearchResponse } from '@/lib/ai-gateway/providers/openrouter/openrouter-types';
import type {
  NormalizedOpenRouterResponse,
  NormalizedProvider,
  OpenRouterModel,
} from '@/lib/ai-gateway/providers/openrouter/openrouter-types';

const baseModel = {
  slug: 'anthropic/claude-fable-5',
  name: 'Claude Fable 5',
  author: 'anthropic',
  description: '',
  context_length: 200_000,
  input_modalities: ['text'],
  output_modalities: ['text'],
  group: 'Claude Fable',
  updated_at: '2026-06-09T00:00:00Z',
};

describe('model data policy', () => {
  test('reports prompt retention when a provider offers both standard and ZDR routes', () => {
    const response = OpenRouterSearchResponse.parse({
      data: {
        models: [
          {
            ...baseModel,
            endpoint: {
              provider_display_name: 'SpaceXAI (ZDR)',
              is_free: false,
              pricing: { prompt: '0.000002', completion: '0.000006' },
              data_policy: {
                training: false,
                retainsPrompts: false,
              },
            },
          },
        ],
      },
    });

    const model = response.data.models[0];
    if (!model) throw new Error('expected model');
    const normalizedModel = withWorstProviderDataPolicy(model, {
      training: false,
      retainsPrompts: true,
    });

    expect(normalizedModel.endpoint?.data_policy).toEqual({
      training: false,
      retainsPrompts: true,
    });
    expect(model.endpoint?.data_policy).toEqual({
      training: false,
      retainsPrompts: false,
    });
  });

  test('preserves data collection reported by a model route', () => {
    const response = OpenRouterSearchResponse.parse({
      data: {
        models: [
          {
            ...baseModel,
            endpoint: {
              provider_display_name: 'Test Provider',
              is_free: false,
              pricing: { prompt: '0.000002', completion: '0.000006' },
              data_policy: {
                training: true,
                retainsPrompts: true,
              },
            },
          },
        ],
      },
    });

    const model = response.data.models[0];
    if (!model) throw new Error('expected model');
    const normalizedModel = withWorstProviderDataPolicy(model, {
      training: false,
      retainsPrompts: false,
    });

    expect(normalizedModel.endpoint?.data_policy).toEqual({
      training: true,
      retainsPrompts: true,
    });
  });

  test('preserves and uses model endpoint policy overrides', () => {
    const response = OpenRouterSearchResponse.parse({
      data: {
        models: [
          {
            ...baseModel,
            endpoint: {
              provider_display_name: 'Amazon Bedrock (BYOK Only)',
              is_free: false,
              pricing: { prompt: '0.000005', completion: '0.000025' },
              data_policy: {
                training: false,
                retainsPrompts: true,
                retentionDays: 30,
              },
            },
          },
        ],
      },
    });

    const model = response.data.models[0];
    expect(model?.endpoint?.data_policy).toEqual({ training: false, retainsPrompts: true });
    expect(model && modelTrains(model, true)).toBe(false);
    expect(model && modelRetainsPrompts(model, false)).toBe(true);
  });

  test('falls back to the provider policy for snapshots without endpoint policy', () => {
    const response = OpenRouterSearchResponse.parse({
      data: {
        models: [
          {
            ...baseModel,
            endpoint: {
              provider_display_name: 'Amazon Bedrock',
              is_free: false,
              pricing: { prompt: '0.000005', completion: '0.000025' },
            },
          },
        ],
      },
    });

    const model = response.data.models[0];
    expect(model && modelTrains(model, true)).toBe(true);
    expect(model && modelRetainsPrompts(model, true)).toBe(true);
  });
});

describe('buildModelDataPolicies', () => {
  const provider: NormalizedProvider = {
    name: 'Meta',
    displayName: 'Meta',
    slug: 'meta',
    dataPolicy: { training: false, retainsPrompts: true, canPublish: false },
    models: [],
  };
  const contributor = {
    ...baseModel,
    slug: 'meta/muse-spark-1.3-contributor',
    endpoint: {
      provider_display_name: 'Meta',
      is_free: false,
      pricing: { prompt: '0.000002', completion: '0.000006' },
      data_policy: { training: true, retainsPrompts: true },
    },
  } satisfies OpenRouterModel;

  function build(providers: NormalizedProvider[]) {
    const snapshot: NormalizedOpenRouterResponse = {
      providers,
      total_providers: providers.length,
      total_models: providers.reduce((total, item) => total + item.models.length, 0),
      generated_at: '2026-09-24T00:00:00Z',
    };
    return buildModelDataPolicies(snapshot, model => model.slug);
  }

  test('uses paid Contributor training metadata without treating retention as training', () => {
    const nonContributor = {
      ...contributor,
      slug: 'meta/muse-spark-1.3',
      endpoint: {
        ...contributor.endpoint,
        data_policy: { training: false, retainsPrompts: true },
      },
    };
    const policies = build([{ ...provider, models: [contributor, nonContributor] }]);

    expect(policies.get(contributor.slug)).toEqual([
      { providerSlug: 'meta', training: true, retainsPrompts: true },
    ]);
    expect(policies.get(nonContributor.slug)).toEqual([
      { providerSlug: 'meta', training: false, retainsPrompts: true },
    ]);
  });

  test('keeps policies from every provider serving the same model', () => {
    const policies = build([
      {
        ...provider,
        slug: 'private',
        dataPolicy: { training: false, retainsPrompts: false, canPublish: false },
        models: [{ ...contributor, endpoint: null }],
      },
      { ...provider, models: [contributor] },
    ]);

    expect(policies.get(contributor.slug)).toEqual([
      { providerSlug: 'private', training: false, retainsPrompts: false },
      { providerSlug: 'meta', training: true, retainsPrompts: true },
    ]);
  });

  test.each([null, undefined, {}])(
    'falls back to provider policy without endpoint policy %p',
    policy => {
      const policies = build([
        {
          ...provider,
          dataPolicy: { training: true, retainsPrompts: true, canPublish: false },
          models: [{ ...contributor, endpoint: { ...contributor.endpoint, data_policy: policy } }],
        },
      ]);

      expect(policies.get(contributor.slug)).toEqual([
        { providerSlug: 'meta', training: true, retainsPrompts: true },
      ]);
    }
  );

  test('preserves conservative provider policies when an endpoint reports no collection', () => {
    const policies = build([
      {
        ...provider,
        dataPolicy: { training: true, retainsPrompts: true, canPublish: false },
        models: [
          {
            ...contributor,
            endpoint: {
              ...contributor.endpoint,
              data_policy: { training: false, retainsPrompts: false },
            },
          },
        ],
      },
    ]);

    expect(policies.get(contributor.slug)).toEqual([
      { providerSlug: 'meta', training: true, retainsPrompts: true },
    ]);
  });

  test('returns no policies for a missing snapshot', () => {
    expect(buildModelDataPolicies(undefined, model => model.slug)).toEqual(new Map());
  });
});
