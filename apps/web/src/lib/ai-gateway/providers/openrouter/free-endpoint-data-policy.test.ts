import { describe, expect, test } from '@jest/globals';
import type { KiloExclusiveModel } from '@/lib/ai-gateway/providers/kilo-exclusive-model';
import { applyFreeEndpointDataPolicy } from '@/lib/ai-gateway/providers/openrouter/free-endpoint-data-policy';
import type { OpenRouterModel } from '@/lib/ai-gateway/providers/openrouter/openrouter-types';
import type { StoredModel } from '@kilocode/db/schema-types';

function offering(slug: string): OpenRouterModel {
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
      is_free: false,
      pricing: { prompt: '0.1', completion: '0.2' },
      data_policy: { training: false, retainsPrompts: false },
    },
  };
}

function storedModel(id: string, tag: string, prompt: string, completion: string): StoredModel {
  return {
    id,
    name: id,
    endpoints: [{ tag, pricing: { prompt, completion } }],
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

describe('applyFreeEndpointDataPolicy', () => {
  test('applies free OpenRouter endpoint policy by normalized model and provider', () => {
    const matching = offering('example/model');
    const otherProvider = offering('example/model');
    const providerModelData = [
      { provider: { slug: 'novita' }, models: [matching] },
      { provider: { slug: 'deepinfra' }, models: [otherProvider] },
    ];

    applyFreeEndpointDataPolicy({
      providerModelData,
      openRouterModels: {
        'example/model:free': storedModel('example/model:free', 'novita/fp8', '0', '0.000'),
      },
      kiloExclusiveModels: [],
    });

    expect(matching.endpoint?.data_policy).toEqual({ training: true, retainsPrompts: true });
    expect(otherProvider.endpoint?.data_policy).toEqual({
      training: false,
      retainsPrompts: false,
    });
  });

  test('requires both OpenRouter token prices to be zero', () => {
    const model = offering('example/model');

    applyFreeEndpointDataPolicy({
      providerModelData: [{ provider: { slug: 'novita' }, models: [model] }],
      openRouterModels: {
        'example/model': storedModel('example/model', 'novita', '0', '0.1'),
      },
      kiloExclusiveModels: [],
    });

    expect(model.endpoint?.data_policy).toEqual({ training: false, retainsPrompts: false });
  });

  test('does not treat malformed OpenRouter prices as zero', () => {
    const model = offering('example/model');

    applyFreeEndpointDataPolicy({
      providerModelData: [{ provider: { slug: 'novita' }, models: [model] }],
      openRouterModels: {
        'example/model': storedModel('example/model', 'novita', '0foo', '0'),
      },
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
      openRouterModels: {},
      kiloExclusiveModels: [freeExclusiveModel('example/model:free', [])],
    });

    expect(first.endpoint?.data_policy).toEqual({ training: true, retainsPrompts: true });
    expect(second.endpoint?.data_policy).toEqual({ training: true, retainsPrompts: true });
  });

  test('respects free exclusive model provider restrictions', () => {
    const allowed = offering('example/model');
    const blocked = offering('example/model');

    applyFreeEndpointDataPolicy({
      providerModelData: [
        { provider: { slug: 'stepfun' }, models: [allowed] },
        { provider: { slug: 'novita' }, models: [blocked] },
      ],
      openRouterModels: {},
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
      openRouterModels: {},
      kiloExclusiveModels: [
        freeExclusiveModel('example/model:free', ['stepfun']),
        freeExclusiveModel('example/model:promo', ['novita']),
      ],
    });

    expect(first.endpoint?.data_policy).toEqual({ training: true, retainsPrompts: true });
    expect(second.endpoint?.data_policy).toEqual({ training: true, retainsPrompts: true });
  });

  test('ignores disabled and paid exclusive models', () => {
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
      openRouterModels: {},
      kiloExclusiveModels: [disabled, paid],
    });

    expect(model.endpoint?.data_policy).toEqual({ training: false, retainsPrompts: false });
  });
});
