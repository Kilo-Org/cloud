import { describe, expect, test } from '@jest/globals';
import type * as DirectByok from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import type {
  NormalizedOpenRouterResponse,
  OpenRouterModel,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/openrouter-types';
import {
  getDirectByokPolicyProviders,
  withDirectByokPolicyProviders,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/policy-providers';

jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/direct-byok', () => ({
  getDirectByokProviderListings: jest.requireActual<typeof DirectByok>(
    '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok'
  ).getDirectByokProviderListings,
  listDirectByokCatalogModels: jest.fn(async (providerId: string) =>
    providerId === 'synthetic' || providerId === 'edenai'
      ? [
          { catalogModelId: 'moonshotai/kimi-k2.6', model: {} },
          { catalogModelId: 'example/unlisted', model: {} },
        ]
      : []
  ),
}));

function snapshotModel(slug: string): OpenRouterModel {
  return {
    slug,
    name: slug,
    author: 'author',
    description: 'description',
    context_length: 1000,
    input_modalities: ['text'],
    output_modalities: ['text'],
    group: 'group',
    updated_at: '2026-10-01',
    endpoint: {
      provider_display_name: 'Moonshot AI',
      variant: 'standard',
      is_free: false,
      pricing: { prompt: '0.000001', completion: '0.000002' },
      data_policy: { training: true },
    },
  };
}

function snapshotProvider(slug: string, models: OpenRouterModel[]) {
  return {
    name: slug,
    displayName: slug,
    slug,
    dataPolicy: { training: false, retainsPrompts: false, canPublish: false },
    models,
  };
}

const snapshot: NormalizedOpenRouterResponse = {
  providers: [
    snapshotProvider('moonshotai', [snapshotModel('moonshotai/kimi-k2.6')]),
    snapshotProvider('edenai', []),
  ],
  total_providers: 2,
  total_models: 1,
  generated_at: '2026-10-30T00:00:00.000Z',
};

describe('getDirectByokPolicyProviders', () => {
  test('lists direct BYOK listings with the snapshot models their keys serve in catalog mode', async () => {
    const providers = await getDirectByokPolicyProviders(snapshot);
    const synthetic = providers.find(provider => provider.slug === 'synthetic');

    expect(synthetic).toMatchObject({ name: 'Synthetic', displayName: 'Synthetic' });
    expect(synthetic?.dataPolicy.termsOfServiceURL).toMatch(/^https:\/\//);
    expect(synthetic?.models).toEqual([
      {
        ...snapshotModel('moonshotai/kimi-k2.6'),
        endpoint: {
          provider_display_name: 'Synthetic',
          variant: null,
          is_free: false,
          pricing: { prompt: '0', completion: '0' },
          data_policy: null,
        },
      },
    ]);
    expect(providers.find(provider => provider.slug === 'martian')?.models).toEqual([]);
  });

  test('leaves out listings the snapshot already has and providers with a counterpart', async () => {
    const slugs = (await getDirectByokPolicyProviders(snapshot)).map(provider => provider.slug);

    expect(slugs).not.toContain('edenai');
    expect(slugs).not.toContain('zai-coding');
    expect(slugs).not.toContain('z-ai');
  });
});

describe('withDirectByokPolicyProviders', () => {
  test('appends the direct BYOK listings to the snapshot providers', async () => {
    const catalog = await withDirectByokPolicyProviders(snapshot);

    expect(catalog.providers.slice(0, 2)).toEqual(snapshot.providers);
    expect(catalog.providers.map(provider => provider.slug)).toContain('synthetic');
    expect(catalog.total_providers).toBe(catalog.providers.length);
    expect(catalog.total_models).toBe(1);
  });
});
