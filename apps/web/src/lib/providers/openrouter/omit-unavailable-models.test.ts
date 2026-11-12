import { describe, expect, test } from '@jest/globals';
import {
  applyFreeEndpointDataPolicy,
  getOpenRouterFreeEndpoints,
} from '@/lib/providers/openrouter/free-endpoint-data-policy';
import { omitUnavailableModels } from '@/lib/providers/openrouter/omit-unavailable-models';
import type { OpenRouterModel } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/openrouter-types';

function offering(slug: string, variant?: string): OpenRouterModel {
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
      ...(variant && { variant }),
      is_free: variant === 'free',
      pricing: { prompt: '0.1', completion: '0.2' },
      data_policy: { training: false, retainsPrompts: false },
    },
  };
}

function slugsOf(providerModelData: Array<{ models: OpenRouterModel[] }>) {
  return providerModelData.map(({ models }) =>
    models.map(model => `${model.slug}:${model.endpoint?.variant ?? ''}`)
  );
}

describe('omitUnavailableModels', () => {
  test('removes unavailable models and keeps available ones', () => {
    const providerModelData = [
      {
        provider: { slug: 'novita' },
        models: [offering('example/gone'), offering('example/kept')],
      },
      { provider: { slug: 'deepinfra' }, models: [offering('example/gone')] },
    ];

    omitUnavailableModels(providerModelData, new Set(['example/gone']));

    expect(providerModelData.map(({ models }) => models.map(model => model.slug))).toEqual([
      ['example/kept'],
      [],
    ]);
  });

  test('leaves providers without models in place for the empty-provider filter', () => {
    const providerModelData = [
      { provider: { slug: 'only-gone' }, models: [offering('example/gone')] },
      { provider: { slug: 'other' }, models: [offering('example/kept')] },
    ];

    omitUnavailableModels(providerModelData, new Set(['example/gone']));

    expect(
      providerModelData.filter(data => data.models.length > 0).map(data => data.provider.slug)
    ).toEqual(['other']);
  });

  test('matches the exact gateway id of the served variant, as /api/v1/models does', () => {
    const providerModelData = [
      {
        provider: { slug: 'novita' },
        models: [
          offering('example/model', 'free'),
          offering('example/model', 'standard'),
          offering('example/model'),
        ],
      },
    ];

    omitUnavailableModels(providerModelData, new Set(['example/model:free']));

    expect(slugsOf(providerModelData)).toEqual([['example/model:standard', 'example/model:']]);
  });

  test('an unavailable standard id does not hide the free variant', () => {
    const providerModelData = [
      {
        provider: { slug: 'novita' },
        models: [offering('example/model', 'free'), offering('example/model', 'standard')],
      },
    ];

    omitUnavailableModels(providerModelData, new Set(['example/model']));

    expect(slugsOf(providerModelData)).toEqual([['example/model:free']]);
  });

  test('ids are compared exactly, not case-insensitively or by prefix', () => {
    const providerModelData = [
      {
        provider: { slug: 'novita' },
        models: [offering('Example/Model'), offering('example/model-2')],
      },
    ];

    omitUnavailableModels(providerModelData, new Set(['example/model']));

    expect(providerModelData[0].models.map(model => model.slug)).toEqual([
      'Example/Model',
      'example/model-2',
    ]);
  });

  test('does nothing when no model is unavailable', () => {
    const models = [offering('example/kept')];
    const providerModelData = [{ provider: { slug: 'novita' }, models }];

    omitUnavailableModels(providerModelData, new Set());

    expect(providerModelData[0].models).toEqual(models);
  });

  test('a non-free unavailable model does not suppress its family free endpoints', () => {
    const freeVariant = offering('example/model', 'free');
    const standard = offering('example/model', 'standard');
    const providerModelData = [{ provider: { slug: 'novita' }, models: [freeVariant, standard] }];
    const unavailableModelIds = new Set(['example/model']);

    applyFreeEndpointDataPolicy({
      providerModelData,
      openRouterFreeEndpoints: getOpenRouterFreeEndpoints(providerModelData, unavailableModelIds),
    });
    omitUnavailableModels(providerModelData, unavailableModelIds);

    expect(providerModelData[0].models).toEqual([freeVariant]);
    expect(freeVariant.endpoint?.data_policy).toEqual({ training: true, retainsPrompts: true });
  });

  test('an unavailable free model still gates free endpoints before it is removed', () => {
    const freeVariant = offering('example/model', 'free');
    const standard = offering('example/model', 'standard');
    const providerModelData = [{ provider: { slug: 'novita' }, models: [freeVariant, standard] }];
    const unavailableModelIds = new Set(['example/model:free']);

    applyFreeEndpointDataPolicy({
      providerModelData,
      openRouterFreeEndpoints: getOpenRouterFreeEndpoints(providerModelData, unavailableModelIds),
    });
    omitUnavailableModels(providerModelData, unavailableModelIds);

    expect(providerModelData[0].models).toEqual([standard]);
    expect(standard.endpoint?.data_policy).toEqual({ training: false, retainsPrompts: false });
  });
});
