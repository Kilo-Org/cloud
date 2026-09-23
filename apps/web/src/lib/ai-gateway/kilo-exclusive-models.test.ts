import { afterEach, describe, expect, test } from '@jest/globals';
import { MARTIAN } from '@/lib/ai-gateway/providers/definitions/martian';
import { OPENROUTER } from '@/lib/ai-gateway/providers/definitions/openrouter';
import {
  kiloExclusiveModels,
  findKiloExclusiveModel,
  claude_opus_4_8_stealth_model,
  claude_opus_4_7_stealth_model,
  claude_sonnet_4_6_stealth_model,
  claude_opus_4_6_stealth_model,
  qwen36_plus_stealth_model,
  gemma_4_26b_a4b_it_free_model,
  stepfun_37_flash_free_model,
} from '@/lib/ai-gateway/kilo-exclusive-models';

describe('Kilo-exclusive model providers', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('has unique public IDs', () => {
    expect(new Set(kiloExclusiveModels.map(model => model.public_id)).size).toBe(
      kiloExclusiveModels.length
    );
  });

  test.each(kiloExclusiveModels)(
    '$public_id lookup preserves model identity and visibility',
    model => {
      const found = findKiloExclusiveModel(model.public_id);
      if (model.status === 'disabled') {
        expect(found).toBeNull();
      } else {
        expect(found).toBe(model);
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
    expect(findKiloExclusiveModel(model.public_id)?.provider).toBe(MARTIAN);
  });

  test.each([gemma_4_26b_a4b_it_free_model, stepfun_37_flash_free_model])(
    'serves $public_id through OpenRouter',
    model => {
      expect(findKiloExclusiveModel(model.public_id)?.provider).toBe(OPENROUTER);
    }
  );

  test('does not match unknown or ordinary OpenRouter models', () => {
    expect(findKiloExclusiveModel('unknown/model')).toBeNull();
    expect(findKiloExclusiveModel('openai/gpt-5-mini')).toBeNull();
  });

  test('stops serving a model when it is disabled', () => {
    jest.replaceProperty(gemma_4_26b_a4b_it_free_model, 'status', 'disabled');
    expect(findKiloExclusiveModel(gemma_4_26b_a4b_it_free_model.public_id)).toBeNull();
  });
});
