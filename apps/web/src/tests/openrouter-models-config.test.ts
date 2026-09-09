import { test, expect, describe } from '@jest/globals';
import { preferredModels } from '@/lib/ai-gateway/models';
import {
  isKiloAutoModel,
  KILO_AUTO_BALANCED_MODEL,
  KILO_AUTO_EFFICIENT_MODEL,
  KILO_AUTO_FRONTIER_MODEL,
} from '@/lib/ai-gateway/auto-model';
import { monitoredModels } from '@/lib/ai-gateway/monitored-models';
import {
  CLAUDE_OPUS_CURRENT_MODEL_ID,
  CLAUDE_SONNET_CURRENT_MODEL_ID,
} from '@/lib/ai-gateway/providers/anthropic.constants';
import { GPT_CURRENT_MODEL_ID } from '@/lib/ai-gateway/providers/openai';
import { gpt_5_6_sol_discounted_model } from '@/lib/ai-gateway/providers/openai-exclusive';
import {
  GEMMA_4_26B_A4B_IT_ID,
  gemma_4_26b_a4b_it_free_model,
} from '@/lib/ai-gateway/providers/google';
import { QWEN37_PLUS_MODEL_ID } from '@/lib/ai-gateway/providers/qwen';

describe('OpenRouter Models Config', () => {
  test('preferred models should contain expected models', () => {
    const expectedModels = [
      CLAUDE_SONNET_CURRENT_MODEL_ID,
      CLAUDE_OPUS_CURRENT_MODEL_ID,
      GPT_CURRENT_MODEL_ID,
      'z-ai/glm-5.3',
    ];

    expectedModels.forEach(model => {
      expect(preferredModels).toContain(model);
    });

    const deemphasizedAutoModels = [KILO_AUTO_BALANCED_MODEL.id, KILO_AUTO_FRONTIER_MODEL.id];
    deemphasizedAutoModels.forEach(model => {
      expect(preferredModels).not.toContain(model);
    });

    const supersededModels = [
      'openai/gpt-5.6-terra',
      'stealth/claude-opus-4.8',
      'stealth/qwen3.6-plus',
      QWEN37_PLUS_MODEL_ID,
      'deepseek/deepseek-v4-pro',
      'tencent/hy3:free',
      'meituan/longcat-2.0-free',
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

  test('monitors only concrete preferred models', () => {
    expect(preferredModels).toContain(KILO_AUTO_EFFICIENT_MODEL.id);
    expect(monitoredModels).toEqual(preferredModels.filter(model => !isKiloAutoModel(model)));
    expect(monitoredModels).not.toContain(GEMMA_4_26B_A4B_IT_ID);
    expect(monitoredModels).not.toContain(gemma_4_26b_a4b_it_free_model.public_id);
  });
});
