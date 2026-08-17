import { describe, expect, it } from '@jest/globals';
import type {
  NormalizedOpenRouterResponse,
  OpenRouterModel,
  OpenRouterProvider,
} from '@/lib/ai-gateway/providers/openrouter/openrouter-types';
import {
  CODESTRAL_FIM_MODEL_ID,
  findSupportedFimModel,
  injectSupportedFimModels,
  MERCURY_EDIT_FIM_MODEL_ID,
} from '@/lib/ai-gateway/supported-fim-models';
import { buildModelIdToProviderSlugsIndex } from '@/lib/ai-gateway/providers/openrouter/models-by-provider-index.server';
import { createAllowPredicateFromProviderAllowList } from '@/lib/model-allow.server';

function provider(slug: string): OpenRouterProvider {
  return {
    name: slug,
    displayName: slug,
    slug,
    dataPolicy: {
      training: false,
      retainsPrompts: false,
      canPublish: false,
    },
  };
}

function makeProviderModelData() {
  return ['mistral', 'inception', 'other'].map(
    (slug): { provider: OpenRouterProvider; models: OpenRouterModel[] } => ({
      provider: provider(slug),
      models: [],
    })
  );
}

function makeSnapshot(): NormalizedOpenRouterResponse {
  const providerModelData = makeProviderModelData();
  injectSupportedFimModels(providerModelData);
  return {
    providers: providerModelData.map(({ provider: item, models }) => ({
      ...item,
      models,
    })),
    total_providers: providerModelData.length,
    total_models: providerModelData.reduce((total, item) => total + item.models.length, 0),
    generated_at: '2026-08-07T00:00:00.000Z',
  };
}

describe('supported FIM models', () => {
  it('injects known models into their direct providers for selector visibility', () => {
    const snapshot = makeSnapshot();

    expect(snapshot.providers.find(item => item.slug === 'mistral')?.models).toEqual([
      expect.objectContaining({ slug: CODESTRAL_FIM_MODEL_ID }),
    ]);
    expect(snapshot.providers.find(item => item.slug === 'inception')?.models).toEqual([
      expect.objectContaining({ slug: MERCURY_EDIT_FIM_MODEL_ID }),
    ]);
    expect(snapshot.providers.find(item => item.slug === 'other')?.models).toEqual([]);
  });

  it('does not duplicate a model already present under its direct provider', () => {
    const providerModelData = makeProviderModelData();

    injectSupportedFimModels(providerModelData);
    injectSupportedFimModels(providerModelData);

    expect(providerModelData.flatMap(item => item.models)).toHaveLength(2);
  });

  it('warns when a direct provider is missing from the upstream snapshot', () => {
    const providerModelData = makeProviderModelData().filter(
      item => item.provider.slug !== 'inception'
    );
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      injectSupportedFimModels(providerModelData);

      expect(warn).toHaveBeenCalledWith(
        '[injectSupportedFimModels] Missing provider %s for supported FIM model %s',
        'inception',
        MERCURY_EDIT_FIM_MODEL_ID
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('does not share mutable snapshot metadata with the supported-model catalog', () => {
    const providerModelData = makeProviderModelData();
    injectSupportedFimModels(providerModelData);

    const injectedModel = providerModelData
      .find(item => item.provider.slug === 'mistral')
      ?.models.find(model => model.slug === CODESTRAL_FIM_MODEL_ID);
    const catalogModel = findSupportedFimModel(CODESTRAL_FIM_MODEL_ID)?.snapshotModel;
    if (!injectedModel?.endpoint || !catalogModel?.endpoint) {
      throw new Error('Expected Codestral snapshot metadata');
    }

    expect(injectedModel.endpoint).not.toBe(catalogModel.endpoint);
    expect(injectedModel.endpoint.pricing).not.toBe(catalogModel.endpoint.pricing);
    expect(injectedModel.input_modalities).not.toBe(catalogModel.input_modalities);
    expect(injectedModel.output_modalities).not.toBe(catalogModel.output_modalities);

    injectedModel.endpoint.data_policy = { training: true, retainsPrompts: true };
    injectedModel.endpoint.pricing.prompt = 'mutated';

    expect(catalogModel.endpoint.data_policy).toBeUndefined();
    expect(catalogModel.endpoint.pricing.prompt).toBe('0.000000300000');
  });

  it('indexes the exact provider associations used by Enterprise restrictions', () => {
    const index = buildModelIdToProviderSlugsIndex(makeSnapshot());

    expect(index.get(CODESTRAL_FIM_MODEL_ID)).toEqual(new Set(['mistral']));
    expect(index.get(MERCURY_EDIT_FIM_MODEL_ID)).toEqual(new Set(['inception']));
    expect(index.has('codestral-2508')).toBe(false);
    expect(index.has('mistralai/codestral-2508:free')).toBe(false);
    expect(index.has('inception/mercury-edit-latest')).toBe(false);
  });

  it('applies provider allow lists to each FIM model using its direct provider', async () => {
    const index = buildModelIdToProviderSlugsIndex(makeSnapshot());
    const providerLookup = async (modelId: string) => index.get(modelId) ?? new Set<string>();
    const mistralOnly = createAllowPredicateFromProviderAllowList([], ['mistral'], providerLookup);
    const inceptionOnly = createAllowPredicateFromProviderAllowList(
      [],
      ['inception'],
      providerLookup
    );

    await expect(mistralOnly(CODESTRAL_FIM_MODEL_ID)).resolves.toBe(true);
    await expect(mistralOnly(MERCURY_EDIT_FIM_MODEL_ID)).resolves.toBe(false);
    await expect(inceptionOnly(CODESTRAL_FIM_MODEL_ID)).resolves.toBe(false);
    await expect(inceptionOnly(MERCURY_EDIT_FIM_MODEL_ID)).resolves.toBe(true);
  });

  it('only resolves exact supported ids and never invents aliases', () => {
    expect(findSupportedFimModel(CODESTRAL_FIM_MODEL_ID)?.provider).toBe('mistral');
    expect(findSupportedFimModel(MERCURY_EDIT_FIM_MODEL_ID)?.provider).toBe('inception');
    expect(findSupportedFimModel('codestral-2508')).toBeUndefined();
    expect(findSupportedFimModel('mistralai/codestral-2508:free')).toBeUndefined();
    expect(findSupportedFimModel('inception/mercury-edit-latest')).toBeUndefined();
  });
});
