import { describe, expect, test } from '@jest/globals';
import type * as DirectByok from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import type {
  NormalizedProvider,
  OpenRouterModel,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/openrouter-types';
import { injectDirectByokProviders } from '@/lib/providers/openrouter/inject-direct-byok-providers';

const mockListCatalogModels = jest.fn(async (providerId: string) => {
  switch (providerId) {
    case 'synthetic':
      return [
        { catalogModelId: 'moonshotai/kimi-k2.6', model: {} },
        { catalogModelId: 'example/not-in-snapshot', model: {} },
        { catalogModelId: 'z-ai/glm-5.2', model: {} },
      ];
    case 'martian':
      throw new Error('models.dev unavailable');
    default:
      return [];
  }
});

jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/direct-byok', () => ({
  getDirectByokProviderListings: jest.requireActual<typeof DirectByok>(
    '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok'
  ).getDirectByokProviderListings,
  listDirectByokCatalogModels: (providerId: string) => mockListCatalogModels(providerId),
}));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

function snapshotModel(slug: string, name: string): OpenRouterModel {
  return {
    slug,
    name,
    author: 'author',
    description: 'description',
    context_length: 1000,
    input_modalities: ['text'],
    output_modalities: ['text'],
    group: 'group',
    updated_at: '2026-10-01',
    endpoint: {
      provider_display_name: 'Upstream',
      variant: 'standard',
      is_free: false,
      pricing: { prompt: '0.000001', completion: '0.000002' },
      data_policy: { training: true },
    },
  };
}

function snapshotProvider(slug: string, models: OpenRouterModel[]): NormalizedProvider {
  return {
    name: slug,
    displayName: slug,
    slug,
    dataPolicy: { training: false, retainsPrompts: false, canPublish: false },
    models,
  };
}

const providers = [
  snapshotProvider('moonshotai', [snapshotModel('moonshotai/kimi-k2.6', 'Kimi K2.6')]),
  snapshotProvider('z-ai', [snapshotModel('z-ai/glm-5.2', 'GLM 5.2')]),
  snapshotProvider('edenai', [snapshotModel('moonshotai/kimi-k2.6', 'Kimi K2.6')]),
];

describe('injectDirectByokProviders', () => {
  test('appends listed providers as BYOK only with the snapshot models they serve', async () => {
    const result = await injectDirectByokProviders(providers);
    const synthetic = result.find(provider => provider.slug === 'synthetic');

    expect(result.slice(0, providers.length)).toEqual(providers);
    expect(synthetic).toMatchObject({ displayName: 'Synthetic', byokOnly: true });
    expect(synthetic?.dataPolicy.termsOfServiceURL).toMatch(/^https:\/\//);
    expect(synthetic?.models.map(model => model.slug)).toEqual([
      'z-ai/glm-5.2',
      'moonshotai/kimi-k2.6',
    ]);
    expect(synthetic?.models[0]?.endpoint).toEqual({
      provider_display_name: 'Synthetic',
      variant: null,
      is_free: false,
      pricing: { prompt: '0', completion: '0' },
      data_policy: null,
    });
  });

  test('leaves out listings the snapshot already has, without catalog models, or that fail', async () => {
    const slugs = (await injectDirectByokProviders(providers)).map(provider => provider.slug);

    expect(slugs.filter(slug => slug === 'edenai')).toHaveLength(1);
    expect(slugs).not.toContain('martian');
    expect(slugs).not.toContain('neuralwatt');
    expect(slugs).not.toContain('zai-coding');
  });
});
