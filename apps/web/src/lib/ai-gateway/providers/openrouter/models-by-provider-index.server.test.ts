import { describe, expect, it } from '@jest/globals';
import type { StoredModel } from '@kilocode/db/schema-types';
import type {
  NormalizedOpenRouterResponse,
  OpenRouterModel,
} from '@/lib/ai-gateway/providers/openrouter/openrouter-types';
import {
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
  function loader(models: Record<string, StoredModel> = storedModels) {
    return createModelsByProviderIndexLoader({
      fetchSnapshot: async () => makeSnapshot(),
      fetchStoredModels: async () => models,
      ttlMs: 60_000,
      nowMs: () => 0,
    });
  }

  it('indexes the snapshot by collapsed model id', () => {
    expect(buildModelIdToProviderSlugsIndex(makeSnapshot()).get(MODEL)).toEqual(
      new Set(['deepinfra', 'coreweave', 'nvidia'])
    );
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
});
