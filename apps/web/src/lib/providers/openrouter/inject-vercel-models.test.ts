import { describe, expect, test } from '@jest/globals';
import { injectVercelModels } from '@/lib/providers/openrouter/inject-vercel-models';
import { parseVercelCatalog } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/vercel-catalog';
import {
  modelRetainsPrompts,
  modelTrains,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/model-data-policy';
import type {
  OpenRouterModel,
  OpenRouterProvider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/openrouter-types';
import type { StoredModel } from '@kilocode/db/schema-types';

const MODEL_SLUG = 'nvidia/nemotron-3-super-120b-a12b';

type ProviderModelData = Parameters<typeof injectVercelModels>[0]['providerModelData'];

/** Injects Vercel endpoints of snapshot models; the fixtures have no Vercel-only models. */
function injectSnapshotModels(
  vercelModels: Record<string, StoredModel>,
  providerModelData: ProviderModelData,
  vercelModelIdOverrides: ReadonlyMap<string, string> = new Map()
) {
  injectVercelModels({
    vercelModels,
    vercelCatalog: new Map(),
    openRouterCatalogModels: [],
    openRouterModelIds: providerModelData.flatMap(({ models }) => models.map(m => m.slug)),
    providerModelData,
    vercelModelIdOverrides,
    updatedAt: '2026-11-02T00:00:00.000Z',
  });
}

function provider(
  slug: string,
  displayName: string,
  dataPolicy: OpenRouterProvider['dataPolicy']
): OpenRouterProvider {
  return {
    name: displayName,
    displayName,
    slug,
    dataPolicy,
  };
}

function nvidiaModel(): OpenRouterModel {
  return {
    slug: MODEL_SLUG,
    name: 'NVIDIA: Nemotron 3 Super',
    author: 'nvidia',
    description: '',
    context_length: 256_000,
    input_modalities: ['text'],
    output_modalities: ['text'],
    group: 'Nemotron',
    updated_at: '2026-08-09T00:00:00.000Z',
    endpoint: {
      provider_display_name: 'NVIDIA',
      is_free: true,
      pricing: { prompt: '0', completion: '0' },
      data_policy: { training: true, retainsPrompts: true },
    },
  };
}

describe('injectVercelModels under OpenRouter providers', () => {
  test('does not copy the source provider data policy onto injected offerings', () => {
    const nvidia = nvidiaModel();
    const providerModelData = [
      {
        provider: provider('nvidia', 'NVIDIA', {
          training: true,
          retainsPrompts: true,
          canPublish: false,
        }),
        models: [nvidia],
      },
      {
        provider: provider('amazon-bedrock', 'Amazon Bedrock', {
          training: false,
          retainsPrompts: false,
          canPublish: false,
        }),
        models: [] as OpenRouterModel[],
      },
    ];
    const vercelModels: Record<string, StoredModel> = {
      [MODEL_SLUG]: {
        id: MODEL_SLUG,
        name: 'NVIDIA Nemotron 3 Super',
        endpoints: [
          {
            provider_name: 'nvidia',
            pricing: { prompt: '0', completion: '0' },
          },
          {
            provider_name: 'bedrock',
            context_length: 256_000,
            pricing: { prompt: '0.15', completion: '0.65' },
          },
        ],
      },
    };

    injectSnapshotModels(vercelModels, providerModelData);

    const injected = providerModelData[1]?.models[0];
    expect(injected?.slug).toBe(MODEL_SLUG);
    expect(injected?.endpoint).toEqual({
      provider_display_name: 'Amazon Bedrock',
      is_free: false,
      pricing: { prompt: '0.15', completion: '0.65' },
    });
    expect(injected && modelTrains(injected, false)).toBe(false);
    expect(injected && modelRetainsPrompts(injected, false)).toBe(false);
    expect(nvidia.endpoint?.data_policy).toEqual({ training: true, retainsPrompts: true });
    expect(modelTrains(nvidia, true)).toBe(true);
    expect(modelRetainsPrompts(nvidia, true)).toBe(true);
  });

  test('injects offerings for providers outside the known provider registry', () => {
    const model = nvidiaModel();
    const providerModelData = [
      {
        provider: provider('nvidia', 'NVIDIA', {
          training: true,
          retainsPrompts: true,
          canPublish: false,
        }),
        models: [model],
      },
      {
        provider: provider('future-provider', 'Future Provider', {
          training: false,
          retainsPrompts: false,
          canPublish: false,
        }),
        models: [] as OpenRouterModel[],
      },
    ];
    const vercelModels: Record<string, StoredModel> = {
      [MODEL_SLUG]: {
        id: MODEL_SLUG,
        name: model.name,
        endpoints: [
          { provider_name: 'nvidia' },
          { provider_name: 'future-provider', context_length: 128_000 },
        ],
      },
    };

    injectSnapshotModels(vercelModels, providerModelData);

    expect(providerModelData[1]?.models[0]?.slug).toBe(MODEL_SLUG);
    expect(providerModelData[1]?.models[0]?.context_length).toBe(128_000);
  });

  test('looks up the Vercel model through a model ID override', () => {
    const model = nvidiaModel();
    const providerModelData = [
      {
        provider: provider('nvidia', 'NVIDIA', {
          training: true,
          retainsPrompts: true,
          canPublish: false,
        }),
        models: [model],
      },
      {
        provider: provider('future-provider', 'Future Provider', {
          training: false,
          retainsPrompts: false,
          canPublish: false,
        }),
        models: [] as OpenRouterModel[],
      },
    ];
    const vercelModelId = 'nvidia/nemotron-3-super';
    const vercelModels: Record<string, StoredModel> = {
      [vercelModelId]: {
        id: vercelModelId,
        name: model.name,
        endpoints: [{ provider_name: 'nvidia' }, { provider_name: 'future-provider' }],
      },
    };

    injectSnapshotModels(vercelModels, providerModelData);
    expect(providerModelData[1]?.models).toEqual([]);

    injectSnapshotModels(vercelModels, providerModelData, new Map([[MODEL_SLUG, vercelModelId]]));
    expect(providerModelData[1]?.models[0]?.slug).toBe(MODEL_SLUG);
  });
});

describe('injectVercelModels with providers only Vercel lists', () => {
  function nvidiaProviderModelData() {
    return [
      {
        provider: provider('nvidia', 'NVIDIA', {
          training: true,
          retainsPrompts: true,
          canPublish: false,
        }),
        models: [nvidiaModel()],
      },
      {
        provider: provider('amazon-bedrock', 'Amazon Bedrock', {
          training: false,
          retainsPrompts: false,
          canPublish: false,
        }),
        models: [] as OpenRouterModel[],
      },
    ];
  }

  test('adds providers that only serve snapshot models through Vercel', () => {
    const providerModelData = nvidiaProviderModelData();
    const vercelModels: Record<string, StoredModel> = {
      [MODEL_SLUG]: {
        id: MODEL_SLUG,
        name: 'NVIDIA Nemotron 3 Super',
        endpoints: [
          { provider_name: 'nvidia', has_zdr: false, has_no_training: false },
          { provider_name: 'bedrock', has_zdr: true, has_no_training: true },
          {
            provider_name: 'runinfra',
            context_length: 128_000,
            pricing: { prompt: '0.0000001', completion: '0.0000004' },
            has_zdr: true,
            has_no_training: true,
          },
        ],
      },
    };

    injectSnapshotModels(vercelModels, providerModelData);

    expect(providerModelData.map(({ provider }) => provider.slug)).toEqual([
      'nvidia',
      'amazon-bedrock',
      'runinfra',
    ]);
    const runinfra = providerModelData[2];
    expect(runinfra?.provider).toEqual({
      name: 'RunInfra',
      displayName: 'RunInfra',
      slug: 'runinfra',
      dataPolicy: {
        training: false,
        retainsPrompts: false,
        canPublish: false,
        termsOfServiceURL: 'https://runinfra.ai/terms-of-service',
        privacyPolicyURL: 'https://runinfra.ai/privacy-policy',
      },
      icon: { url: 'https://placehold.co/100?text=RU&font=roboto', className: 'rounded-sm' },
    });
    expect(runinfra?.models).toHaveLength(1);
    expect(runinfra?.models[0]?.slug).toBe(MODEL_SLUG);
    expect(runinfra?.models[0]?.context_length).toBe(128_000);
    expect(runinfra?.models[0]?.endpoint).toEqual({
      provider_display_name: 'RunInfra',
      is_free: false,
      pricing: { prompt: '0.0000001', completion: '0.0000004' },
      data_policy: { training: false, retainsPrompts: false },
    });
  });

  test.each([
    ['meituan', 'Meituan LongCat'],
    ['deepinfra', 'DeepInfra'],
    ['future-provider', 'Future Provider'],
    ['future_provider', 'Future Provider'],
    ['future--__provider', 'Future Provider'],
  ])('beautifies the synthesized provider %s', (providerId, displayName) => {
    const providerModelData = nvidiaProviderModelData();
    const vercelModels: Record<string, StoredModel> = {
      [MODEL_SLUG]: {
        id: MODEL_SLUG,
        name: 'NVIDIA Nemotron 3 Super',
        endpoints: [{ provider_name: providerId }],
      },
    };

    injectSnapshotModels(vercelModels, providerModelData);

    const synthesized = providerModelData.find(({ provider }) => provider.slug === providerId);
    expect(synthesized?.provider).toMatchObject({
      name: displayName,
      displayName,
      slug: providerId,
    });
    expect(synthesized?.models[0]?.endpoint?.provider_display_name).toBe(displayName);
  });

  test('derives a display name without policy links for unknown providers', () => {
    const providerModelData = nvidiaProviderModelData();
    const vercelModels: Record<string, StoredModel> = {
      [MODEL_SLUG]: {
        id: MODEL_SLUG,
        name: 'NVIDIA Nemotron 3 Super',
        endpoints: [{ provider_name: 'nvidia' }, { provider_name: 'future-provider' }],
      },
    };

    injectSnapshotModels(vercelModels, providerModelData);

    const futureProvider = providerModelData.find(
      ({ provider }) => provider.slug === 'future-provider'
    )?.provider;
    expect(futureProvider?.displayName).toBe('Future Provider');
    expect(futureProvider?.dataPolicy).toEqual({
      training: true,
      retainsPrompts: true,
      canPublish: false,
    });
  });

  test('treats missing Vercel data policy guarantees as training and retaining prompts', () => {
    const providerModelData = nvidiaProviderModelData();
    const vercelModels: Record<string, StoredModel> = {
      [MODEL_SLUG]: {
        id: MODEL_SLUG,
        name: 'NVIDIA Nemotron 3 Super',
        endpoints: [
          { provider_name: 'nvidia' },
          { provider_name: 'boundless', has_zdr: true, has_no_training: false },
        ],
      },
    };

    injectSnapshotModels(vercelModels, providerModelData);

    const boundless = providerModelData.find(({ provider }) => provider.slug === 'boundless');
    expect(boundless?.provider.dataPolicy).toEqual({
      training: true,
      retainsPrompts: false,
      canPublish: false,
      termsOfServiceURL: 'https://boundless.network/terms-of-service',
      privacyPolicyURL: 'https://boundless.network/privacy-policy',
    });
    expect(boundless?.models[0]?.endpoint?.data_policy).toEqual({
      training: true,
      retainsPrompts: false,
    });
  });

  test('does not add providers already known under an OpenRouter slug', () => {
    const providerModelData = nvidiaProviderModelData();
    const vercelModels: Record<string, StoredModel> = {
      [MODEL_SLUG]: {
        id: MODEL_SLUG,
        name: 'NVIDIA Nemotron 3 Super',
        endpoints: [{ provider_name: 'nvidia' }, { provider_name: 'bedrock' }],
      },
    };

    injectSnapshotModels(vercelModels, providerModelData);

    expect(providerModelData.map(({ provider }) => provider.slug)).toEqual([
      'nvidia',
      'amazon-bedrock',
    ]);
  });

  test('ignores Vercel models that are not in the snapshot', () => {
    const providerModelData = nvidiaProviderModelData();
    const vercelModels: Record<string, StoredModel> = {
      'vendor/vercel-only-model': {
        id: 'vendor/vercel-only-model',
        name: 'Vercel Only Model',
        endpoints: [{ provider_name: 'boundless' }],
      },
    };

    injectSnapshotModels(vercelModels, providerModelData);

    expect(providerModelData).toHaveLength(2);
  });

  test('skips provider ids that routing would lowercase', () => {
    const providerModelData = nvidiaProviderModelData();
    const vercelModels: Record<string, StoredModel> = {
      [MODEL_SLUG]: {
        id: MODEL_SLUG,
        name: 'NVIDIA Nemotron 3 Super',
        endpoints: [{ provider_name: 'nvidia' }, { provider_name: 'futureProvider' }],
      },
    };

    injectSnapshotModels(vercelModels, providerModelData);

    expect(providerModelData).toHaveLength(2);
  });
});

describe('injectVercelModels with models only Vercel serves', () => {
  const catalog = {
    type: 'language',
    description: 'Qwen3.5 Flash description',
    created: 1_790_000_000,
    context_window: 1_000_000,
    modalities: { input: ['text', 'image'], output: ['text'] },
    pricing: { input: '0.0000001', output: '0.0000004' },
  };
  const freeCatalog = { ...catalog, pricing: { input: '0', output: '0' } };

  /** Vercel's model list with the given entries. */
  function catalogOf(entries: Record<string, typeof catalog>) {
    return parseVercelCatalog({
      data: Object.entries(entries).map(([id, entry]) => ({ id, ...entry })),
    });
  }

  function providerModelData() {
    return [
      {
        provider: provider('amazon-bedrock', 'Amazon Bedrock', {
          training: false,
          retainsPrompts: false,
          canPublish: false,
        }),
        models: [] as OpenRouterModel[],
      },
    ];
  }

  test('lists a Vercel-only model under existing and new providers', () => {
    const data = providerModelData();
    const vercelModels: Record<string, StoredModel> = {
      'alibaba/qwen3.5-flash': {
        id: 'alibaba/qwen3.5-flash',
        name: 'Qwen3.5 Flash',
        type: 'language',
        endpoints: [
          {
            provider_name: 'bedrock',
            context_length: 500_000,
            pricing: { prompt: '0.0000002', completion: '0.0000008' },
            has_zdr: true,
            has_no_training: true,
          },
          { provider_name: 'alibaba' },
        ],
      },
      'alibaba/qwen3-max': {
        id: 'alibaba/qwen3-max',
        name: 'Qwen3 Max',
        type: 'language',
        endpoints: [{ provider_name: 'alibaba' }],
      },
    };

    injectVercelModels({
      vercelModels,
      vercelCatalog: catalogOf({ 'alibaba/qwen3.5-flash': catalog, 'alibaba/qwen3-max': catalog }),
      openRouterCatalogModels: [{ id: 'qwen/qwen3-max', name: 'Qwen: Qwen3 Max' }],
      openRouterModelIds: ['qwen/qwen3-max'],
      providerModelData: data,
      vercelModelIdOverrides: new Map(),
      updatedAt: '2026-11-02T00:00:00.000Z',
    });

    expect(data.map(({ provider }) => provider.slug)).toEqual(['amazon-bedrock', 'alibaba']);
    expect(data[0]?.provider.dataPolicy).toEqual({
      training: false,
      retainsPrompts: false,
      canPublish: false,
    });
    expect(data[0]?.models).toEqual([
      {
        slug: 'qwen/qwen3.5-flash',
        name: 'Qwen: Qwen3.5 Flash',
        author: 'qwen',
        description: 'Qwen3.5 Flash description',
        context_length: 500_000,
        input_modalities: ['text', 'image'],
        output_modalities: ['text'],
        group: 'Other',
        updated_at: '2026-11-02T00:00:00.000Z',
        endpoint: {
          provider_display_name: 'Amazon Bedrock',
          is_free: false,
          pricing: { prompt: '0.0000002', completion: '0.0000008' },
        },
      },
    ]);
    expect(data[1]?.provider.dataPolicy).toMatchObject({ training: true, retainsPrompts: true });
    expect(data[1]?.models.map(model => [model.slug, model.endpoint?.pricing])).toEqual([
      ['qwen/qwen3.5-flash', { prompt: '0.0000001', completion: '0.0000004' }],
    ]);
  });

  test("skips a Vercel-only model that is missing from Vercel's model list", () => {
    const data = providerModelData();
    injectVercelModels({
      vercelModels: {
        'runinfra/fast-1': {
          id: 'runinfra/fast-1',
          name: 'Fast 1',
          type: 'language',
          endpoints: [{ provider_name: 'runinfra' }],
        },
      },
      vercelCatalog: new Map(),
      openRouterCatalogModels: [],
      openRouterModelIds: [],
      providerModelData: data,
      vercelModelIdOverrides: new Map(),
      updatedAt: '2026-11-02T00:00:00.000Z',
    });

    expect(data.map(({ provider }) => provider.slug)).toEqual(['amazon-bedrock']);
  });

  test('marks a free Vercel-only model free and assumes it trains on prompts', () => {
    const data = providerModelData();
    injectVercelModels({
      vercelModels: {
        'reflection/beam-free': {
          id: 'reflection/beam-free',
          name: 'Beam (Free)',
          type: 'language',
          endpoints: [
            {
              provider_name: 'reflection',
              pricing: { prompt: '0', completion: '0' },
              has_zdr: true,
              has_no_training: true,
            },
          ],
        },
      },
      vercelCatalog: catalogOf({ 'reflection/beam-free': freeCatalog }),
      openRouterCatalogModels: [],
      openRouterModelIds: [],
      providerModelData: data,
      vercelModelIdOverrides: new Map(),
      updatedAt: '2026-11-02T00:00:00.000Z',
    });

    const reflection = data.find(({ provider }) => provider.slug === 'reflection');
    expect(reflection?.provider.dataPolicy).toMatchObject({
      training: false,
      retainsPrompts: false,
    });
    expect(reflection?.models[0]?.endpoint).toEqual({
      provider_display_name: 'Reflection',
      is_free: true,
      pricing: { prompt: '0', completion: '0' },
      data_policy: { training: true, retainsPrompts: true },
    });
  });

  test('assumes a free Vercel-only model trains on prompts under an OpenRouter provider too', () => {
    const data = providerModelData();
    injectVercelModels({
      vercelModels: {
        'reflection/beam-free': {
          id: 'reflection/beam-free',
          name: 'Beam (Free)',
          type: 'language',
          endpoints: [{ provider_name: 'bedrock', has_zdr: true, has_no_training: true }],
        },
      },
      vercelCatalog: catalogOf({ 'reflection/beam-free': freeCatalog }),
      openRouterCatalogModels: [],
      openRouterModelIds: [],
      providerModelData: data,
      vercelModelIdOverrides: new Map(),
      updatedAt: '2026-11-02T00:00:00.000Z',
    });

    expect(data.map(({ provider }) => provider.slug)).toEqual(['amazon-bedrock']);
    expect(data[0]?.models[0]?.endpoint).toEqual({
      provider_display_name: 'Amazon Bedrock',
      is_free: true,
      pricing: { prompt: '0', completion: '0' },
      data_policy: { training: true, retainsPrompts: true },
    });
  });

  test('lists snapshot and Vercel-only models under one new provider', () => {
    const data = [
      ...providerModelData(),
      {
        provider: provider('nvidia', 'NVIDIA', {
          training: true,
          retainsPrompts: true,
          canPublish: false,
        }),
        models: [nvidiaModel()],
      },
    ];
    injectVercelModels({
      vercelModels: {
        [MODEL_SLUG]: {
          id: MODEL_SLUG,
          name: 'NVIDIA Nemotron 3 Super',
          endpoints: [{ provider_name: 'nvidia' }, { provider_name: 'runinfra' }],
        },
        'runinfra/fast-1': {
          id: 'runinfra/fast-1',
          name: 'Fast 1',
          type: 'language',
          endpoints: [{ provider_name: 'runinfra', has_zdr: true, has_no_training: true }],
        },
      },
      vercelCatalog: catalogOf({ 'runinfra/fast-1': catalog }),
      openRouterCatalogModels: [],
      openRouterModelIds: [MODEL_SLUG],
      providerModelData: data,
      vercelModelIdOverrides: new Map(),
      updatedAt: '2026-11-02T00:00:00.000Z',
    });

    const runinfra = data.filter(({ provider }) => provider.slug === 'runinfra');
    expect(runinfra).toHaveLength(1);
    expect(runinfra[0]?.models.map(model => model.slug)).toEqual([MODEL_SLUG, 'runinfra/fast-1']);
    expect(runinfra[0]?.provider.dataPolicy).toMatchObject({
      training: true,
      retainsPrompts: true,
    });
    expect(data.at(-1)?.provider.slug).toBe('runinfra');
  });
});
