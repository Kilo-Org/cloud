import { describe, expect, it } from '@jest/globals';
import type { StoredModel } from '@kilocode/db/schema-types';
import type {
  NormalizedOpenRouterResponse,
  OpenRouterModel,
} from '@/lib/ai-gateway/providers/openrouter/openrouter-types';
import {
  buildDataCollectionRequiredModelIds,
  buildModelIdToProviderSlugsIndex,
  createModelsByProviderIndexLoader,
  getEndpointProviderSlugs,
  getSnapshotModelVariantId,
  narrowProviderSlugsToVariant,
} from '@/lib/ai-gateway/providers/openrouter/models-by-provider-index.server';

const MODEL = 'nvidia/nemotron-3.5-lightning';
const FREE_MODEL = `${MODEL}:free`;

function snapshotModel(slug: string, variant: string | null): OpenRouterModel {
  return {
    slug,
    name: slug,
    author: 'nvidia',
    description: '',
    context_length: 1,
    input_modalities: ['text'],
    output_modalities: ['text'],
    group: 'other',
    updated_at: '2026-09-01T00:00:00.000Z',
    endpoint: {
      provider_display_name: 'x',
      variant,
      is_free: variant === 'free',
      pricing: { prompt: '0', completion: '0' },
    },
  };
}

function makeSnapshot(): NormalizedOpenRouterResponse {
  const providers = [
    { slug: 'deepinfra', models: [snapshotModel(MODEL, 'standard')] },
    { slug: 'coreweave', models: [snapshotModel(MODEL, 'standard')] },
    { slug: 'nvidia', models: [snapshotModel(MODEL, 'free')] },
  ].map(({ slug, models }) => ({
    name: slug,
    displayName: slug,
    slug,
    dataPolicy: { training: false, retainsPrompts: false, canPublish: false },
    models,
  }));
  return {
    providers,
    total_providers: providers.length,
    total_models: providers.reduce((total, provider) => total + provider.models.length, 0),
    generated_at: '2026-09-01T00:00:00.000Z',
  };
}

function storedModel(id: string, tags: (string | undefined)[]): StoredModel {
  return {
    id,
    name: id,
    endpoints: tags.map(tag => ({ tag })),
  };
}

const storedModels: Record<string, StoredModel> = {
  [MODEL]: storedModel(MODEL, ['deepinfra/bf16', 'coreweave/bf16']),
  [FREE_MODEL]: storedModel(FREE_MODEL, ['nvidia/nvfp4']),
};

describe('getSnapshotModelVariantId', () => {
  it('suffixes non-standard variants and leaves standard entries alone', () => {
    expect(getSnapshotModelVariantId(snapshotModel(MODEL, 'free'))).toBe(FREE_MODEL);
    expect(getSnapshotModelVariantId(snapshotModel(MODEL, 'standard'))).toBe(MODEL);
    expect(getSnapshotModelVariantId(snapshotModel(MODEL, null))).toBe(MODEL);
    expect(getSnapshotModelVariantId({ ...snapshotModel(MODEL, 'free'), endpoint: null })).toBe(
      MODEL
    );
  });
});

describe('buildDataCollectionRequiredModelIds', () => {
  function provider(slug: string, training: boolean, models: OpenRouterModel[]) {
    return {
      name: slug,
      displayName: slug,
      slug,
      dataPolicy: { training, retainsPrompts: true, canPublish: false },
      models,
    };
  }

  function withTraining(model: OpenRouterModel, training: boolean): OpenRouterModel {
    return model.endpoint
      ? { ...model, endpoint: { ...model.endpoint, data_policy: { training } } }
      : model;
  }

  it('includes only model variants that train on every provider', () => {
    const snapshot = makeSnapshot();
    snapshot.providers = [
      provider('meta', false, [
        withTraining(snapshotModel('meta/muse-spark-1.3-contributor', 'standard'), true),
        withTraining(snapshotModel('meta/muse-spark-1.3', 'standard'), false),
        withTraining(snapshotModel('mixed/model', 'standard'), true),
      ]),
      provider('other', true, [
        snapshotModel('mixed/model', 'standard'),
        snapshotModel(MODEL, 'free'),
      ]),
      provider('private', false, [withTraining(snapshotModel('mixed/model', 'standard'), false)]),
    ];

    expect(buildDataCollectionRequiredModelIds(snapshot)).toEqual(
      new Set(['meta/muse-spark-1.3-contributor', FREE_MODEL])
    );
  });

  it('keys standard and free variants separately', () => {
    const snapshot = makeSnapshot();
    snapshot.providers = [
      provider('paid', false, [snapshotModel(MODEL, 'standard')]),
      provider('free', false, [withTraining(snapshotModel(MODEL, 'free'), true)]),
    ];

    expect(buildDataCollectionRequiredModelIds(snapshot)).toEqual(new Set([FREE_MODEL]));
  });
});

describe('getEndpointProviderSlugs', () => {
  it('maps endpoint tags to provider slugs and ignores untagged endpoints', () => {
    expect(
      getEndpointProviderSlugs(storedModel(MODEL, ['DeepInfra/fp8', 'deepinfra/bf16', undefined]))
    ).toEqual(new Set(['deepinfra']));
  });
});

describe('narrowProviderSlugsToVariant', () => {
  const collapsed = new Set(['deepinfra', 'coreweave', 'nvidia']);

  it('keeps only the snapshot providers that serve the variant', () => {
    expect(narrowProviderSlugsToVariant(collapsed, storedModels[FREE_MODEL])).toEqual(
      new Set(['nvidia'])
    );
    expect(narrowProviderSlugsToVariant(collapsed, storedModels[MODEL])).toEqual(
      new Set(['deepinfra', 'coreweave'])
    );
  });

  it('falls back to the collapsed providers without usable endpoint metadata', () => {
    expect(narrowProviderSlugsToVariant(collapsed, undefined)).toBe(collapsed);
    expect(narrowProviderSlugsToVariant(collapsed, storedModel(MODEL, [undefined]))).toBe(
      collapsed
    );
    expect(narrowProviderSlugsToVariant(collapsed, storedModel(MODEL, ['unknown-provider']))).toBe(
      collapsed
    );
  });
});

describe('createModelsByProviderIndexLoader', () => {
  function loader(
    models: Record<string, StoredModel> = storedModels,
    vercelModels: Record<string, StoredModel> = {},
    snapshot = makeSnapshot()
  ) {
    return createModelsByProviderIndexLoader({
      fetchSnapshot: async () => snapshot,
      fetchOpenRouterModels: async () => models,
      fetchVercelModels: async () => vercelModels,
      ttlMs: 60_000,
      nowMs: () => 0,
    });
  }

  it('indexes the snapshot by collapsed model id', () => {
    expect(buildModelIdToProviderSlugsIndex(makeSnapshot()).get(MODEL)).toEqual(
      new Set(['deepinfra', 'coreweave', 'nvidia'])
    );
  });

  it('retries a failed snapshot read instead of caching an empty data-collection set', async () => {
    const snapshot = makeSnapshot();
    snapshot.providers = snapshot.providers.map(provider =>
      provider.slug === 'nvidia'
        ? { ...provider, dataPolicy: { ...provider.dataPolicy, training: true } }
        : provider
    );
    let calls = 0;
    const { getDataCollectionRequiredModelIds } = createModelsByProviderIndexLoader({
      fetchSnapshot: async () => {
        calls += 1;
        if (calls === 1) throw new Error('database unavailable');
        return snapshot;
      },
      fetchOpenRouterModels: async () => storedModels,
      fetchVercelModels: async () => ({}),
      ttlMs: 60_000,
      nowMs: () => 0,
    });

    await expect(getDataCollectionRequiredModelIds()).resolves.toEqual(new Set());
    await expect(getDataCollectionRequiredModelIds()).resolves.toEqual(new Set([FREE_MODEL]));
    await getDataCollectionRequiredModelIds();
    expect(calls).toBe(2);
  });

  it('resolves variant-specific providers for suffixed ids', async () => {
    const { getProviderSlugsForModel } = loader();

    await expect(getProviderSlugsForModel(FREE_MODEL)).resolves.toEqual(new Set(['nvidia']));
    await expect(getProviderSlugsForModel(MODEL)).resolves.toEqual(
      new Set(['deepinfra', 'coreweave'])
    );
  });

  it('keeps the collapsed providers when no endpoint metadata is stored', async () => {
    const { getProviderSlugsForModel } = loader({});

    await expect(getProviderSlugsForModel(FREE_MODEL)).resolves.toEqual(
      new Set(['deepinfra', 'coreweave', 'nvidia'])
    );
  });

  it('returns no providers for models missing from the snapshot', async () => {
    const { getProviderSlugsForModel } = loader();

    await expect(getProviderSlugsForModel('unknown/model')).resolves.toEqual(new Set());
    await expect(getProviderSlugsForModel('unknown/model:free')).resolves.toEqual(new Set());
  });

  it.each(['provider_name', 'tag'] as const)(
    'retains Vercel-only Bedrock and Alibaba endpoints identified by %s',
    async providerField => {
      const modelId = 'moonshotai/kimi-k3';
      const snapshot = makeSnapshot();
      snapshot.providers = ['novita', 'amazon-bedrock', 'alibaba', 'deepinfra'].map(slug => ({
        name: slug,
        displayName: slug,
        slug,
        dataPolicy: { training: false, retainsPrompts: false, canPublish: false },
        models: [snapshotModel(modelId, 'standard')],
      }));
      const { getProviderSlugsForModel } = loader(
        { [modelId]: storedModel(modelId, ['novita/bf16']) },
        {
          [modelId]: {
            id: modelId,
            name: modelId,
            endpoints: ['bedrock', 'alibaba', 'fireworks'].map(provider => ({
              [providerField]: provider,
            })),
          },
        },
        snapshot
      );

      await expect(getProviderSlugsForModel(modelId)).resolves.toEqual(
        new Set(['novita', 'amazon-bedrock', 'alibaba'])
      );
    }
  );

  it('does not retain paid Vercel providers for a free variant', async () => {
    const { getProviderSlugsForModel } = loader(storedModels, {
      [MODEL]: { ...storedModel(MODEL, []), endpoints: [{ provider_name: 'deepinfra' }] },
    });

    await expect(getProviderSlugsForModel(FREE_MODEL)).resolves.toEqual(new Set(['nvidia']));
  });

  it('maps model and provider IDs when retaining Vercel endpoints', async () => {
    const modelId = 'anthropic/claude-sonnet-4-6';
    const vercelModelId = 'anthropic/claude-sonnet-4.6';
    const snapshot = makeSnapshot();
    snapshot.providers = ['anthropic', 'google-vertex'].map(slug => ({
      name: slug,
      displayName: slug,
      slug,
      dataPolicy: { training: false, retainsPrompts: false, canPublish: false },
      models: [snapshotModel(modelId, 'standard')],
    }));
    const { getProviderSlugsForModel } = loader(
      { [modelId]: storedModel(modelId, ['anthropic']) },
      {
        [vercelModelId]: {
          ...storedModel(vercelModelId, []),
          endpoints: [{ provider_name: 'vertexAnthropic' }],
        },
      },
      snapshot
    );

    await expect(getProviderSlugsForModel(modelId)).resolves.toEqual(
      new Set(['anthropic', 'google-vertex'])
    );
  });
});
