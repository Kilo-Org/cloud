import { describe, expect, test } from '@jest/globals';
import { OPENROUTER } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/openrouter';
import {
  findKiloExclusiveModel,
  gemma_4_26b_a4b_it_free_model,
} from '@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models';

describe('Kilo-exclusive model providers', () => {
  test.each([
    'stealth/claude-opus-4.8',
    'stealth/claude-opus-4.7',
    'stealth/claude-sonnet-4.6',
    'stealth/claude-opus-4.6',
    'stealth/qwen3.6-plus',
  ])('no longer serves discounted Martian model %s', modelId => {
    expect(findKiloExclusiveModel(modelId)).toBeNull();
  });

  test.each([gemma_4_26b_a4b_it_free_model])('serves $public_id through OpenRouter', model => {
    expect(findKiloExclusiveModel(model.public_id)?.provider).toBe(OPENROUTER);
  });
});
