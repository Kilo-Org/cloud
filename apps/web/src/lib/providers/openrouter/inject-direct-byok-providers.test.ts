import { describe, expect, test } from '@jest/globals';
import type * as DirectByok from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import type { GatewayModelMap } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-model-metadata';
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
  findDirectByokProvider: (providerId: string) => ({ id: providerId }),
  listDirectByokCatalogModels: (provider: { id: string }) => mockListCatalogModels(provider.id),
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

const storedModels: GatewayModelMap = {
  'moonshotai/kimi-k2.6': { id: 'moonshotai/kimi-k2.6', name: 'Kimi K2.6', endpoints: [] },
};

describe('injectDirectByokProviders', () => {
  test('appends listed providers as BYOK only with the snapshot models they serve', async () => {
    const result = await injectDirectByokProviders(providers, storedModels);
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
    const slugs = (await injectDirectByokProviders(providers, storedModels)).map(
      provider => provider.slug
    );

    expect(slugs.filter(slug => slug === 'edenai')).toHaveLength(1);
    expect(slugs).not.toContain('martian');
    expect(slugs).not.toContain('neuralwatt');
    expect(slugs).not.toContain('zai-coding');
  });

  test('lists the snapshot latest aliases of the models a listing serves like their target', async () => {
    const aliasedProviders = [
      ...providers,
      snapshotProvider('moonshotai', [snapshotModel('~moonshotai/kimi-latest', 'Kimi Latest')]),
      snapshotProvider('z-ai', [snapshotModel('~z-ai/glm-latest', 'GLM Latest')]),
    ];
    const aliasedStoredModels: GatewayModelMap = {
      ...storedModels,
      '~moonshotai/kimi-latest': {
        id: '~moonshotai/kimi-latest',
        name: 'Kimi Latest',
        endpoints: [],
        alias_target: { slug: 'moonshotai/kimi-k2.6' },
      },
      '~z-ai/glm-latest': {
        id: '~z-ai/glm-latest',
        name: 'GLM Latest',
        endpoints: [],
        alias_target: { slug: 'z-ai/glm-6' },
      },
      '~example/not-in-snapshot-latest': {
        id: '~example/not-in-snapshot-latest',
        name: 'Not in snapshot',
        endpoints: [],
        alias_target: { slug: 'moonshotai/kimi-k2.6' },
      },
    };

    const synthetic = (await injectDirectByokProviders(aliasedProviders, aliasedStoredModels)).find(
      provider => provider.slug === 'synthetic'
    );
    const alias = synthetic?.models.find(model => model.slug === '~moonshotai/kimi-latest');
    const target = synthetic?.models.find(model => model.slug === 'moonshotai/kimi-k2.6');

    expect(synthetic?.models.map(model => model.slug)).toEqual([
      'z-ai/glm-5.2',
      'moonshotai/kimi-k2.6',
      '~moonshotai/kimi-latest',
    ]);
    expect(alias).toEqual({ ...target, slug: '~moonshotai/kimi-latest', name: 'Kimi Latest' });
  });
});
