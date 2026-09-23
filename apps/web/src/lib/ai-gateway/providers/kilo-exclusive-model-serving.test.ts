import { afterEach, describe, expect, test } from '@jest/globals';
import { MARTIAN } from '@/lib/ai-gateway/providers/definitions/martian';
import {
  claude_opus_4_8_stealth_model,
  claude_opus_4_7_stealth_model,
  claude_sonnet_4_6_stealth_model,
  claude_opus_4_6_stealth_model,
  kiloExclusiveModels,
  findKiloExclusiveModel,
  qwen36_plus_stealth_model,
  gemma_4_26b_a4b_it_free_model,
} from '@/lib/ai-gateway/kilo-exclusive-models';
import {
  findKiloExclusiveModelServing,
  kiloExclusiveModelServing,
} from '@/lib/ai-gateway/providers/kilo-exclusive-model-serving';

describe('Kilo-exclusive model serving', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('binds every shared model definition exactly once', () => {
    const boundModels = kiloExclusiveModelServing.map(({ model }) => model);
    expect(boundModels).toHaveLength(kiloExclusiveModels.length);
    expect(new Set(boundModels)).toEqual(new Set(kiloExclusiveModels));
    expect(new Set(boundModels.map(model => model.public_id)).size).toBe(boundModels.length);
    for (const model of kiloExclusiveModels) {
      expect(boundModels.some(bound => bound === model)).toBe(true);
    }
  });

  test.each(kiloExclusiveModelServing)(
    '$model.public_id keeps its gateway identity and visibility',
    ({ model, provider }) => {
      expect(provider.id).toBe(model.gateway);
      const serving = findKiloExclusiveModelServing(model.public_id);
      expect(serving?.model ?? null).toBe(findKiloExclusiveModel(model.public_id));
      if (model.status === 'disabled') {
        expect(serving).toBeNull();
      } else {
        expect(serving?.provider).toBe(provider);
      }
    }
  );

  test.each([
    claude_opus_4_8_stealth_model,
    claude_opus_4_7_stealth_model,
    claude_sonnet_4_6_stealth_model,
    claude_opus_4_6_stealth_model,
    qwen36_plus_stealth_model,
  ])('serves $public_id through Martian', model => {
    expect(findKiloExclusiveModelServing(model.public_id)?.provider).toBe(MARTIAN);
  });

  test('does not bind unknown or ordinary OpenRouter models', () => {
    expect(findKiloExclusiveModelServing('unknown/model')).toBeNull();
    expect(findKiloExclusiveModelServing('openai/gpt-5-mini')).toBeNull();
  });

  test('stops serving a bound model when it is disabled', () => {
    jest.replaceProperty(gemma_4_26b_a4b_it_free_model, 'status', 'disabled');
    expect(findKiloExclusiveModelServing(gemma_4_26b_a4b_it_free_model.public_id)).toBeNull();
  });
});
