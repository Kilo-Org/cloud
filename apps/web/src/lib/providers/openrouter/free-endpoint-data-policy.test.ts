import { describe, expect, test } from '@jest/globals';
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
      kiloExclusiveModelIds: [],
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
      kiloExclusiveModelIds: [],
      unavailableModelIds: noUnavailableModels,
    });

    expect(model.endpoint?.data_policy).toEqual({ training: false, retainsPrompts: false });
  });

  test('applies a Kilo-exclusive model to every provider', () => {
    const first = offering('example/model');
    const second = offering('example/model');

    applyFreeEndpointDataPolicy({
      providerModelData: [
        { provider: { slug: 'novita' }, models: [first] },
        { provider: { slug: 'deepinfra' }, models: [second] },
      ],
      openRouterFreeEndpoints: [],
      kiloExclusiveModelIds: ['example/model:free'],
      unavailableModelIds: noUnavailableModels,
    });

    expect(first.endpoint?.data_policy).toEqual({ training: true, retainsPrompts: true });
    expect(second.endpoint?.data_policy).toEqual({ training: true, retainsPrompts: true });
  });

  test('ignores unavailable OpenRouter and exclusive free models', () => {
    const freeVariant = offering('google/gemma-4-31b-it:free', true);
    const model = offering('google/gemma-4-31b-it');
    const providerModelData = [{ provider: { slug: 'darkbloom' }, models: [freeVariant, model] }];
    const unavailableModelIds = new Set(['google/gemma-4-31b-it:free']);

    applyFreeEndpointDataPolicy({
      providerModelData,
      openRouterFreeEndpoints: getOpenRouterFreeEndpoints(providerModelData, unavailableModelIds),
      kiloExclusiveModelIds: ['google/gemma-4-31b-it:free'],
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
      kiloExclusiveModelIds: [],
      unavailableModelIds: noUnavailableModels,
    });

    expect(model.endpoint?.data_policy).toEqual({ training: false, retainsPrompts: false });
  });
});
