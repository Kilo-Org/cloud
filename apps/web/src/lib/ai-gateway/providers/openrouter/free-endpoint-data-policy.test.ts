import { describe, expect, test } from '@jest/globals';
import type { KiloExclusiveModel } from '@/lib/ai-gateway/providers/kilo-exclusive-model';
import {
  normalizeProviderModelsWithDataPolicy,
} from '@/lib/ai-gateway/providers/openrouter/free-endpoint-data-policy';
import {
  OpenRouterModel,
  OpenRouterProvider,
} from '@/lib/ai-gateway/providers/openrouter/openrouter-types';

const provider = OpenRouterProvider.parse({
  name: 'Example Provider',
  displayName: 'Example Provider',
  slug: 'deepinfra',
  dataPolicy: { training: false, retainsPrompts: false, canPublish: false },
});

function model(slug: string, isFree: boolean) {
  return OpenRouterModel.parse({
    slug,
    name: slug,
    author: 'example',
    description: '',
    context_length: 32_000,
    input_modalities: ['text'],
    output_modalities: ['text'],
    group: 'example',
    updated_at: '2026-07-25T00:00:00Z',
    endpoint: {
      provider_display_name: provider.displayName,
      is_free: isFree,
      pricing: {
        prompt: isFree ? '0' : '0.000001',
        completion: isFree ? '0' : '0.000002',
      },
      data_policy: { training: false, retainsPrompts: false },
    },
  });
}

function kiloExclusiveModel(
  publicId: string,
  restriction: KiloExclusiveModel['inference_provider_restriction']
): KiloExclusiveModel {
  return {
    public_id: publicId,
    display_name: publicId,
    description: '',
    context_length: 32_000,
    max_completion_tokens: 4_096,
    status: 'public',
    flags: [],
    gateway: 'openrouter',
    internal_id: publicId,
    pricing: null,
    inference_provider_restriction: restriction,
  };
}

describe('free endpoint data policy sync', () => {
  test('marks the normalized model and provider when an OpenRouter variant is free', () => {
    const result = normalizeProviderModelsWithDataPolicy(
      provider,
      [model('example/model:free', true), model('example/model', false)],
      []
    );

    expect(result.dataPolicy).toEqual({
      training: true,
      retainsPrompts: true,
      canPublish: false,
    });
    expect(result.models).toHaveLength(1);
    expect(result.models[0]?.endpoint?.data_policy).toEqual({
      training: true,
      retainsPrompts: true,
    });
  });

  test('uses Kilo-exclusive provider restrictions and treats an empty restriction as all', () => {
    const paidModels = [model('example/restricted', false), model('example/unrestricted', false)];
    const result = normalizeProviderModelsWithDataPolicy(provider, paidModels, [
      kiloExclusiveModel('example/restricted:free', ['deepinfra']),
      kiloExclusiveModel('example/unrestricted:free', []),
    ]);

    expect(result.models.map(entry => entry.endpoint?.data_policy)).toEqual([
      { training: true, retainsPrompts: true },
      { training: true, retainsPrompts: true },
    ]);
  });

  test('does not apply a Kilo-exclusive endpoint to a different provider', () => {
    const result = normalizeProviderModelsWithDataPolicy(
      provider,
      [model('example/model', false)],
      [kiloExclusiveModel('example/model:free', ['stepfun'])]
    );

    expect(result.dataPolicy).toEqual(provider.dataPolicy);
    expect(result.models[0]?.endpoint?.data_policy).toEqual({
      training: false,
      retainsPrompts: false,
    });
  });

  test('marks a Kilo-exclusive-only provider and model from its free endpoint', () => {
    const freeModel = model('example/model:free', true);
    const result = normalizeProviderModelsWithDataPolicy(provider, [freeModel], [
      kiloExclusiveModel(freeModel.slug, []),
    ]);

    expect(result.dataPolicy.training).toBe(true);
    expect(result.dataPolicy.retainsPrompts).toBe(true);
    expect(result.models[0]?.endpoint?.data_policy).toEqual({
      training: true,
      retainsPrompts: true,
    });
  });

  test('ignores disabled free Kilo-exclusive models', () => {
    const disabledModel = kiloExclusiveModel('example/model:free', []);
    disabledModel.status = 'disabled';
    const result = normalizeProviderModelsWithDataPolicy(
      provider,
      [model('example/model', false)],
      [disabledModel]
    );

    expect(result.dataPolicy).toEqual(provider.dataPolicy);
    expect(result.models[0]?.endpoint?.data_policy).toEqual({
      training: false,
      retainsPrompts: false,
    });
  });
});
