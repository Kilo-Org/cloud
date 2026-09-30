import { test, expect, describe } from '@jest/globals';
import { getPreferredModels, getPrimaryDefaultModel } from '@/lib/ai-gateway/models';
import {
  isKiloAutoModel,
  KILO_AUTO_BALANCED_MODEL,
  KILO_AUTO_EFFICIENT_MODEL,
  KILO_AUTO_FRONTIER_MODEL,
} from '@/lib/ai-gateway/auto-model';
import { getMonitoredModels } from '@/lib/ai-gateway/monitored-models';
import { FALLBACK_CURRENT_MODEL_IDS as current } from '@/lib/ai-gateway/current-models';
import { getCurrentModelIds } from '@/lib/ai-gateway/providers/gateway-models-cache';
import { DEEPSEEK_V4_1_FLASH_MODEL_ID } from '@/lib/ai-gateway/providers/deepseek';
import { GEMMA_4_26B_A4B_IT_ID } from '@/lib/ai-gateway/providers/google';
import { gemma_4_26b_a4b_it_free_model } from '@/lib/ai-gateway/kilo-exclusive-models';
import { QWEN37_PLUS_MODEL_ID } from '@/lib/ai-gateway/providers/qwen';

describe('OpenRouter Models Config', () => {
  const preferredModels = getPreferredModels(current);

  test('preferred models should contain expected models', () => {
    expect(getPrimaryDefaultModel(current)).toBe(current.glmFlash);

    const expectedModels = [
      current.claudeOpus,
      current.gptSol,
      DEEPSEEK_V4_1_FLASH_MODEL_ID,
      current.glmFlash,
    ];

    expectedModels.forEach(model => {
      expect(preferredModels).toContain(model);
    });

    const deemphasizedAutoModels = [KILO_AUTO_BALANCED_MODEL.id, KILO_AUTO_FRONTIER_MODEL.id];
    deemphasizedAutoModels.forEach(model => {
      expect(preferredModels).not.toContain(model);
    });

    const supersededModels = [
      'openai/gpt-6-sol',
      'openai/gpt-5.6-sol',
      'openai/gpt-5.6-terra',
      'stealth/claude-opus-4.8',
      'stealth/qwen3.6-plus',
      QWEN37_PLUS_MODEL_ID,
      'deepseek/deepseek-v4-pro',
      current.claudeSonnet,
      current.glm,
      'tencent/hy3:free',
      'meituan/longcat-2.0-free',
    ];

    supersededModels.forEach(model => {
      expect(preferredModels).not.toContain(model);
    });

    expect(preferredModels.indexOf(DEEPSEEK_V4_1_FLASH_MODEL_ID)).toBeLessThan(
      preferredModels.indexOf(current.glmFlash)
    );
  });

  test('monitors only concrete preferred models', async () => {
    const monitoredModels = await getMonitoredModels();
    const resolvedPreferredModels = getPreferredModels(await getCurrentModelIds());

    expect(resolvedPreferredModels).toContain(KILO_AUTO_EFFICIENT_MODEL.id);
    expect(monitoredModels).toEqual(
      resolvedPreferredModels.filter(model => !isKiloAutoModel(model))
    );
    expect(monitoredModels).not.toContain(GEMMA_4_26B_A4B_IT_ID);
    expect(monitoredModels).not.toContain(gemma_4_26b_a4b_it_free_model.public_id);
  });
});
