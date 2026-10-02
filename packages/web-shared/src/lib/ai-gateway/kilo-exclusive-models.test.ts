import { describe, expect, test } from '@jest/globals';
import { MARTIAN } from '@/lib/ai-gateway/providers/definitions/martian';
import { OPENROUTER } from '@/lib/ai-gateway/providers/definitions/openrouter';
import {
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
});
