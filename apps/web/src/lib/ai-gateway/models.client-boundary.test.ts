import { describe, expect, test } from '@jest/globals';
import type * as ModelsModule from '@/lib/ai-gateway/models';
import type * as AutoModelModule from '@/lib/ai-gateway/auto-model';
import type * as AnthropicModule from '@/lib/ai-gateway/providers/anthropic.constants';
import type * as GoogleModule from '@/lib/ai-gateway/providers/google';
import type * as QwenModule from '@/lib/ai-gateway/providers/qwen';
import type * as StepFunModule from '@/lib/ai-gateway/providers/stepfun';

jest.mock('server-only', () => {
  throw new Error('Client-safe model modules must not import server-only modules');
});

jest.mock('@/lib/dotenvx', () => {
  throw new Error('Client-safe model modules must not read server credentials');
});

describe('client-safe model imports', () => {
  test('loads model preferences, auto-model IDs and vendor helpers without server dependencies', () => {
    jest.isolateModules(() => {
      const models = jest.requireActual<typeof ModelsModule>('@/lib/ai-gateway/models');
      const autoModel = jest.requireActual<typeof AutoModelModule>('@/lib/ai-gateway/auto-model');
      const anthropic = jest.requireActual<typeof AnthropicModule>(
        '@/lib/ai-gateway/providers/anthropic.constants'
      );
      const google = jest.requireActual<typeof GoogleModule>('@/lib/ai-gateway/providers/google');
      const qwen = jest.requireActual<typeof QwenModule>('@/lib/ai-gateway/providers/qwen');
      const stepfun = jest.requireActual<typeof StepFunModule>(
        '@/lib/ai-gateway/providers/stepfun'
      );

      expect(models.preferredModels).toContain(models.PRIMARY_DEFAULT_MODEL);
      expect(autoModel.AUTO_SMALL_TARGET_MODELS.free).toBe(google.GEMMA_4_26B_A4B_IT_FREE_ID);
      expect(anthropic.isClaudeModel(anthropic.CLAUDE_OPUS_CURRENT_MODEL_ID)).toBe(true);
      expect(google.isGeminiModel(google.GEMINI_PRO_CURRENT_MODEL_ID)).toBe(true);
      expect(qwen.isQwenModel(qwen.QWEN37_PLUS_MODEL_ID)).toBe(true);
      expect(stepfun.isStepModel('stepfun/step-3.7-flash')).toBe(true);
    });
  });
});
