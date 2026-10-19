import { describe, expect, test } from '@jest/globals';
import { OPENROUTER } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/openrouter';
import type { KiloExclusiveModel } from '@kilocode/web-shared/lib/ai-gateway/providers/kilo-exclusive-model';
import {
  applyFreeEndpointDataPolicy,
  getOpenRouterFreeEndpoints,
} from '@/lib/providers/openrouter/free-endpoint-data-policy';
import type { OpenRouterModel } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/openrouter-types';

function offering(slug: string, isFree = false): OpenRouterModel {
  return {
    slug,
    name: slug,
    author: 'test',
    description: '',
    context_length: 1,
    input_modalities: ['text'],
    output_modalities: ['text'],
    group: 'test',
    updated_at: '2026-07-27T00:00:00.000Z',
    endpoint: {
      provider_display_name: 'Test',
      is_free: isFree,
      pricing: { prompt: '0.1', completion: '0.2' },
      data_policy: { training: false, retainsPrompts: false },
    },
  };
}

function freeExclusiveModel(
  public_id: string,
  inference_provider_restriction: KiloExclusiveModel['inference_provider_restriction']
): KiloExclusiveModel {
  return {
    public_id,
    internal_id: public_id,
    display_name: public_id,
    description: '',
    context_length: 1,
    max_completion_tokens: 1,
    flags: [],
    provider: OPENROUTER,
    pricing: null,
    inference_provider_restriction,
  };
}

function dataCollectionExclusiveModel(
  public_id: string,
  inference_provider_restriction: KiloExclusiveModel['inference_provider_restriction']
): KiloExclusiveModel {
  const model = freeExclusiveModel(public_id, inference_provider_restriction);
  model.pricing = {
    tiers: [
      {
        start_context_length: 0,
        pricing: {
          prompt_per_million: 1,
          completion_per_million: 1,
          input_cache_read_per_million: null,
          input_cache_write_per_million: null,
        },
      },
    ],
  };
  model.flags = ['requires-data-collection'];
  return model;
}

const noUnavailableModels: ReadonlySet<string> = new Set();

describe('applyFreeEndpointDataPolicy', () => {
  test('applies free OpenRouter endpoint policy by normalized model and provider', () => {
    const freeVariant = offering('example/model:free', true);
    const matching = offering('example/model');
    const otherProvider = offering('example/model');
    const providerModelData = [
      { provider: { slug: 'novita' }, models: [freeVariant, matching] },
      { provider: { slug: 'deepinfra' }, models: [otherProvider] },
    ];
    const openRouterFreeEndpoints = getOpenRouterFreeEndpoints(
      providerModelData,
      noUnavailableModels
    );

    applyFreeEndpointDataPolicy({
      providerModelData,
      openRouterFreeEndpoints,
      kiloExclusiveModels: [],
      unavailableModelIds: noUnavailableModels,
    });

    expect(freeVariant.endpoint?.data_policy).toEqual({ training: true, retainsPrompts: true });
    expect(matching.endpoint?.data_policy).toEqual({ training: true, retainsPrompts: true });
    expect(otherProvider.endpoint?.data_policy).toEqual({
      training: false,
      retainsPrompts: false,
    });
  });

  test('does not infer free status from zero token prices', () => {
    const model = offering('example/model');
    if (!model.endpoint) throw new Error('expected endpoint');
    model.endpoint.pricing = { prompt: '0', completion: '0' };

    applyFreeEndpointDataPolicy({
      providerModelData: [{ provider: { slug: 'novita' }, models: [model] }],
      openRouterFreeEndpoints: getOpenRouterFreeEndpoints(
        [{ provider: { slug: 'novita' }, models: [model] }],
        noUnavailableModels
      ),
      kiloExclusiveModels: [],
      unavailableModelIds: noUnavailableModels,
    });

    expect(model.endpoint?.data_policy).toEqual({ training: false, retainsPrompts: false });
  });

  test('applies an unrestricted free exclusive model to every provider', () => {
    const first = offering('example/model');
    const second = offering('example/model');

    applyFreeEndpointDataPolicy({
      providerModelData: [
        { provider: { slug: 'novita' }, models: [first] },
        { provider: { slug: 'deepinfra' }, models: [second] },
      ],
      openRouterFreeEndpoints: [],
      kiloExclusiveModels: [freeExclusiveModel('example/model:free', [])],
      unavailableModelIds: noUnavailableModels,
    });

    expect(first.endpoint?.data_policy).toEqual({ training: true, retainsPrompts: true });
    expect(second.endpoint?.data_policy).toEqual({ training: true, retainsPrompts: true });
  });

  test('applies data-collection exclusive model policy', () => {
    const model = offering('example/model');

    applyFreeEndpointDataPolicy({
      providerModelData: [{ provider: { slug: 'deepseek' }, models: [model] }],
      openRouterFreeEndpoints: [],
      kiloExclusiveModels: [dataCollectionExclusiveModel('example/model:discounted', ['deepseek'])],
      unavailableModelIds: noUnavailableModels,
    });

    expect(model.endpoint?.data_policy).toEqual({ training: true, retainsPrompts: true });
  });

  test('respects free exclusive model provider restrictions', () => {
    const allowed = offering('example/model');
    const blocked = offering('example/model');

    applyFreeEndpointDataPolicy({
      providerModelData: [
        { provider: { slug: 'stepfun' }, models: [allowed] },
        { provider: { slug: 'novita' }, models: [blocked] },
      ],
      openRouterFreeEndpoints: [],
      kiloExclusiveModels: [freeExclusiveModel('example/model:free', ['stepfun'])],
      unavailableModelIds: noUnavailableModels,
    });

    expect(allowed.endpoint?.data_policy).toEqual({ training: true, retainsPrompts: true });
    expect(blocked.endpoint?.data_policy).toEqual({ training: false, retainsPrompts: false });
  });

  test('combines restrictions from normalized free exclusive variants', () => {
    const first = offering('example/model');
    const second = offering('example/model');

    applyFreeEndpointDataPolicy({
      providerModelData: [
        { provider: { slug: 'stepfun' }, models: [first] },
        { provider: { slug: 'novita' }, models: [second] },
      ],
      openRouterFreeEndpoints: [],
      kiloExclusiveModels: [
        freeExclusiveModel('example/model:free', ['stepfun']),
        freeExclusiveModel('example/model:promo', ['novita']),
      ],
      unavailableModelIds: noUnavailableModels,
    });

    expect(first.endpoint?.data_policy).toEqual({ training: true, retainsPrompts: true });
    expect(second.endpoint?.data_policy).toEqual({ training: true, retainsPrompts: true });
  });

  test('ignores paid exclusive models without data collection', () => {
    const model = offering('example/model');
    const paid = freeExclusiveModel('example/model:discounted', []);
    paid.pricing = {
      tiers: [
        {
          start_context_length: 0,
          pricing: {
            prompt_per_million: 1,
            completion_per_million: 1,
            input_cache_read_per_million: null,
            input_cache_write_per_million: null,
          },
        },
      ],
    };

    applyFreeEndpointDataPolicy({
      providerModelData: [{ provider: { slug: 'novita' }, models: [model] }],
      openRouterFreeEndpoints: [],
      kiloExclusiveModels: [paid],
      unavailableModelIds: noUnavailableModels,
    });

    expect(model.endpoint?.data_policy).toEqual({ training: false, retainsPrompts: false });
  });

  test('ignores unavailable OpenRouter and exclusive free models', () => {
    const freeVariant = offering('google/gemma-4-31b-it:free', true);
    const model = offering('google/gemma-4-31b-it');
    const providerModelData = [{ provider: { slug: 'darkbloom' }, models: [freeVariant, model] }];
    const unavailableModelIds = new Set(['google/gemma-4-31b-it:free']);

    applyFreeEndpointDataPolicy({
      providerModelData,
      openRouterFreeEndpoints: getOpenRouterFreeEndpoints(providerModelData, unavailableModelIds),
      kiloExclusiveModels: [freeExclusiveModel('google/gemma-4-31b-it:free', [])],
      unavailableModelIds,
    });

    expect(freeVariant.endpoint?.data_policy).toEqual({ training: false, retainsPrompts: false });
    expect(model.endpoint?.data_policy).toEqual({ training: false, retainsPrompts: false });
  });

  test('does not collect free keys from offerings injected later', () => {
    const model = offering('example/model');
    const providerModelData = [{ provider: { slug: 'novita' }, models: [model] }];
    const openRouterFreeEndpoints = getOpenRouterFreeEndpoints(
      providerModelData,
      noUnavailableModels
    );
    providerModelData[0].models.push(offering('example/model:free', true));

    applyFreeEndpointDataPolicy({
      providerModelData,
      openRouterFreeEndpoints,
      kiloExclusiveModels: [],
      unavailableModelIds: noUnavailableModels,
    });

    expect(model.endpoint?.data_policy).toEqual({ training: false, retainsPrompts: false });
  });
});
