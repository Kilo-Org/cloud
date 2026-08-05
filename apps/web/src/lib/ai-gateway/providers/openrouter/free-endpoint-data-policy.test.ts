import { describe, expect, test } from '@jest/globals';
import type { KiloExclusiveModel } from '@/lib/ai-gateway/providers/kilo-exclusive-model';
import {
  applyFreeEndpointDataPolicy,
  getOpenRouterFreeEndpoints,
} from '@/lib/ai-gateway/providers/openrouter/free-endpoint-data-policy';
import type { OpenRouterModel } from '@/lib/ai-gateway/providers/openrouter/openrouter-types';

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
    status: 'public',
    flags: [],
    gateway: 'openrouter',
    pricing: null,
    inference_provider_restriction,
  };
}

function dataCollectionExclusiveModel(
  public_id: string,
  inference_provider_restriction: KiloExclusiveModel['inference_provider_restriction']
): KiloExclusiveModel {
  const model = freeExclusiveModel(public_id, inference_provider_restriction);
  model.pricing = [
    {
      start_context_length: 0,
      pricing: {
        prompt_per_million: 1,
        completion_per_million: 1,
        input_cache_read_per_million: null,
        input_cache_write_per_million: null,
      },
    },
  ];
  model.flags = ['requires-data-collection'];
  return model;
}

describe('applyFreeEndpointDataPolicy', () => {
  test('applies free OpenRouter endpoint policy by normalized model and provider', () => {
    const freeVariant = offering('example/model:free', true);
    const matching = offering('example/model');
    const otherProvider = offering('example/model');
    const providerModelData = [
      { provider: { slug: 'novita' }, models: [freeVariant, matching] },
      { provider: { slug: 'deepinfra' }, models: [otherProvider] },
    ];
    const openRouterFreeEndpoints = getOpenRouterFreeEndpoints(providerModelData);

    applyFreeEndpointDataPolicy({
      providerModelData,
      openRouterFreeEndpoints,
      kiloExclusiveModels: [],
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
      openRouterFreeEndpoints: getOpenRouterFreeEndpoints([
        { provider: { slug: 'novita' }, models: [model] },
      ]),
      kiloExclusiveModels: [],
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
    });

    expect(first.endpoint?.data_policy).toEqual({ training: true, retainsPrompts: true });
    expect(second.endpoint?.data_policy).toEqual({ training: true, retainsPrompts: true });
  });

  test('ignores hidden free exclusive models', () => {
    const model = offering('example/model');
    const hidden = freeExclusiveModel('example/model:free', []);
    hidden.status = 'hidden';

    applyFreeEndpointDataPolicy({
      providerModelData: [{ provider: { slug: 'novita' }, models: [model] }],
      openRouterFreeEndpoints: [],
      kiloExclusiveModels: [hidden],
    });

    expect(model.endpoint?.data_policy).toEqual({ training: false, retainsPrompts: false });
  });

  test('applies public data-collection exclusive model policy', () => {
    const model = offering('example/model');

    applyFreeEndpointDataPolicy({
      providerModelData: [{ provider: { slug: 'deepseek' }, models: [model] }],
      openRouterFreeEndpoints: [],
      kiloExclusiveModels: [dataCollectionExclusiveModel('example/model:discounted', ['deepseek'])],
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
    });

    expect(first.endpoint?.data_policy).toEqual({ training: true, retainsPrompts: true });
    expect(second.endpoint?.data_policy).toEqual({ training: true, retainsPrompts: true });
  });

  test('ignores disabled and paid exclusive models without data collection', () => {
    const model = offering('example/model');
    const disabled = freeExclusiveModel('example/model:free', []);
    disabled.status = 'disabled';
    const paid = freeExclusiveModel('example/model:discounted', []);
    paid.pricing = [
      {
        start_context_length: 0,
        pricing: {
          prompt_per_million: 1,
          completion_per_million: 1,
          input_cache_read_per_million: null,
          input_cache_write_per_million: null,
        },
      },
    ];

    applyFreeEndpointDataPolicy({
      providerModelData: [{ provider: { slug: 'novita' }, models: [model] }],
      openRouterFreeEndpoints: [],
      kiloExclusiveModels: [disabled, paid],
    });

    expect(model.endpoint?.data_policy).toEqual({ training: false, retainsPrompts: false });
  });

  test('ignores unavailable OpenRouter and exclusive free models', () => {
    const freeVariant = offering('openai/gpt-oss-20b', true);
    const model = offering('openai/gpt-oss-20b');
    const providerModelData = [{ provider: { slug: 'darkbloom' }, models: [freeVariant, model] }];

    applyFreeEndpointDataPolicy({
      providerModelData,
      openRouterFreeEndpoints: getOpenRouterFreeEndpoints(providerModelData),
      kiloExclusiveModels: [freeExclusiveModel('openai/gpt-oss-20b:free', [])],
    });

    expect(freeVariant.endpoint?.data_policy).toEqual({ training: false, retainsPrompts: false });
    expect(model.endpoint?.data_policy).toEqual({ training: false, retainsPrompts: false });
  });

  test('does not collect free keys from offerings injected later', () => {
    const model = offering('example/model');
    const providerModelData = [{ provider: { slug: 'novita' }, models: [model] }];
    const openRouterFreeEndpoints = getOpenRouterFreeEndpoints(providerModelData);
    providerModelData[0].models.push(offering('example/model:free', true));

    applyFreeEndpointDataPolicy({
      providerModelData,
      openRouterFreeEndpoints,
      kiloExclusiveModels: [],
    });

    expect(model.endpoint?.data_policy).toEqual({ training: false, retainsPrompts: false });
  });
});
