import { test, expect, describe } from '@jest/globals';
import { preferredModels } from '@/lib/ai-gateway/models';
import {
  CLAUDE_OPUS_CURRENT_MODEL_ID,
  CLAUDE_SONNET_CURRENT_MODEL_ID,
} from '@/lib/ai-gateway/providers/anthropic.constants';
import { GPT_CURRENT_MODEL_ID } from '@/lib/ai-gateway/providers/openai';
import { gpt_5_6_sol_discounted_model } from '@/lib/ai-gateway/providers/openai-exclusive';
import { QWEN37_PLUS_MODEL_ID } from '@/lib/ai-gateway/providers/qwen';
import { tencent_hy3_free_model } from '@/lib/ai-gateway/providers/tencent';

describe('OpenRouter Models Config', () => {
  test('preferred models should contain expected models', () => {
    const expectedModels = [
      CLAUDE_SONNET_CURRENT_MODEL_ID,
      CLAUDE_OPUS_CURRENT_MODEL_ID,
      GPT_CURRENT_MODEL_ID,
      'z-ai/glm-5.3',
      tencent_hy3_free_model.public_id,
    ];

    expectedModels.forEach(model => {
      expect(preferredModels).toContain(model);
    });

    const supersededModels = [
      'openai/gpt-5.6-terra',
      'stealth/claude-opus-4.8',
      'stealth/qwen3.6-plus',
      QWEN37_PLUS_MODEL_ID,
      'deepseek/deepseek-v4-pro',
    ];

    supersededModels.forEach(model => {
      expect(preferredModels).not.toContain(model);
    });

    if (gpt_5_6_sol_discounted_model.status === 'public') {
      expect(preferredModels).toContain(gpt_5_6_sol_discounted_model.public_id);
      expect(preferredModels.indexOf(GPT_CURRENT_MODEL_ID)).toBeLessThan(
        preferredModels.indexOf(gpt_5_6_sol_discounted_model.public_id)
      );
    } else {
      expect(preferredModels).not.toContain(gpt_5_6_sol_discounted_model.public_id);
    }
  });
});
