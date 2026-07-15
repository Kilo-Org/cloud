import { test, expect, describe } from '@jest/globals';
import { preferredModels } from '@/lib/ai-gateway/models';
import {
  CLAUDE_OPUS_CURRENT_MODEL_ID,
  CLAUDE_SONNET_CURRENT_MODEL_ID,
} from '@/lib/ai-gateway/providers/anthropic.constants';
import { GPT_CURRENT_MODEL_ID } from '@/lib/ai-gateway/providers/openai';
import { gpt_5_6_sol_stealth_model } from '@/lib/ai-gateway/providers/openai-exclusive';
import { QWEN37_PLUS_MODEL_ID } from '@/lib/ai-gateway/providers/qwen';

describe('OpenRouter Models Config', () => {
  test('preferred models should contain expected models', () => {
    const expectedModels = [
      CLAUDE_SONNET_CURRENT_MODEL_ID,
      CLAUDE_OPUS_CURRENT_MODEL_ID,
      gpt_5_6_sol_stealth_model.public_id,
      'deepseek/deepseek-v4-pro',
      QWEN37_PLUS_MODEL_ID,
      'z-ai/glm-5.2',
    ];

    expectedModels.forEach(model => {
      expect(preferredModels).toContain(model);
    });

    const supersededModels = [
      GPT_CURRENT_MODEL_ID,
      'openai/gpt-5.6-terra',
      'stealth/claude-opus-4.8',
      'deepseek/deepseek-v4-pro:discounted',
      'stealth/qwen3.6-plus',
    ];

    supersededModels.forEach(model => {
      expect(preferredModels).not.toContain(model);
    });
  });
});
