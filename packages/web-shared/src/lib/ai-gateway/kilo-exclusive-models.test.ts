import { describe, expect, test } from '@jest/globals';
import {
  findKiloExclusiveModel,
  gemma_4_26b_a4b_it_free_model,
} from '@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models';

describe('kiloExclusiveModels', () => {
  test.each([
    'stealth/claude-opus-4.8',
    'stealth/claude-opus-4.7',
    'stealth/claude-sonnet-4.6',
    'stealth/claude-opus-4.6',
    'stealth/qwen3.6-plus',
  ])('no longer serves discounted Martian model %s', modelId => {
    expect(findKiloExclusiveModel(modelId)).toBeNull();
  });

  test('serves the free Gemma 4 26B A4B model', () => {
    expect(findKiloExclusiveModel(gemma_4_26b_a4b_it_free_model.public_id)).toBe(
      gemma_4_26b_a4b_it_free_model
    );
  });
});
