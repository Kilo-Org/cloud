import { test, expect, describe } from '@jest/globals';
import { buildPreferredModels, PRIMARY_DEFAULT_MODEL } from '@/lib/ai-gateway/models';
import {
  isKiloAutoModel,
  KILO_AUTO_BALANCED_MODEL,
  KILO_AUTO_EFFICIENT_MODEL,
  KILO_AUTO_FRONTIER_MODEL,
} from '@/lib/ai-gateway/auto-model';
import { getMonitoredModels } from '@/lib/ai-gateway/monitored-models';
import type * as AutoFreeConfigModule from '@/lib/ai-gateway/auto-model/auto-free-config';

jest.mock('@/lib/ai-gateway/auto-model/auto-free-config', () => ({
  ...jest.requireActual<typeof AutoFreeConfigModule>(
    '@/lib/ai-gateway/auto-model/auto-free-config'
  ),
  getConfiguredAutoFreeModels: jest.fn(async () => [
    { model: 'poolside/laguna-s-2.1:free', weight: 1, reasoning: { enabled: true } },
    { model: 'openrouter/free', weight: 1, reasoning: { enabled: true } },
  ]),
}));

const preferredModels = buildPreferredModels([]);
import {
  CLAUDE_OPUS_CURRENT_MODEL_ID,
  CLAUDE_SONNET_CURRENT_MODEL_ID,
} from '@/lib/ai-gateway/providers/anthropic.constants';
import { DEEPSEEK_V4_1_FLASH_MODEL_ID } from '@/lib/ai-gateway/providers/deepseek';
import { GPT_SOL_CURRENT_MODEL_ID } from '@/lib/ai-gateway/providers/openai';
import { GEMMA_4_26B_A4B_IT_ID } from '@/lib/ai-gateway/providers/google';
import { gemma_4_26b_a4b_it_free_model } from '@/lib/ai-gateway/kilo-exclusive-models';
import { QWEN37_PLUS_MODEL_ID } from '@/lib/ai-gateway/providers/qwen';
import { GLM_CURRENT_MODEL_ID, GLM_FLASH_CURRENT_MODEL_ID } from '@/lib/ai-gateway/providers/zai';

describe('OpenRouter Models Config', () => {
  test('preferred models should contain expected models', () => {
    expect(PRIMARY_DEFAULT_MODEL).toBe(GLM_FLASH_CURRENT_MODEL_ID);
    expect(GPT_SOL_CURRENT_MODEL_ID).toBe('openai/gpt-6.1-sol');

    const expectedModels = [
      CLAUDE_OPUS_CURRENT_MODEL_ID,
      GPT_SOL_CURRENT_MODEL_ID,
      DEEPSEEK_V4_1_FLASH_MODEL_ID,
      GLM_FLASH_CURRENT_MODEL_ID,
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
      CLAUDE_SONNET_CURRENT_MODEL_ID,
      GLM_CURRENT_MODEL_ID,
      'tencent/hy3:free',
      'meituan/longcat-2.0-free',
    ];

    supersededModels.forEach(model => {
      expect(preferredModels).not.toContain(model);
    });

    expect(preferredModels.indexOf(DEEPSEEK_V4_1_FLASH_MODEL_ID)).toBeLessThan(
      preferredModels.indexOf(GLM_FLASH_CURRENT_MODEL_ID)
    );
  });

  test('monitors only concrete preferred models', async () => {
    const monitoredModels = await getMonitoredModels();
    const configuredPreferredModels = buildPreferredModels(['poolside/laguna-s-2.1:free']);
    expect(configuredPreferredModels).toContain(KILO_AUTO_EFFICIENT_MODEL.id);
    expect(monitoredModels).toEqual(
      configuredPreferredModels.filter(model => !isKiloAutoModel(model))
    );
    expect(monitoredModels).not.toContain('openrouter/free');
    expect(monitoredModels).not.toContain(GEMMA_4_26B_A4B_IT_ID);
    expect(monitoredModels).not.toContain(gemma_4_26b_a4b_it_free_model.public_id);
  });
});
