import { test, expect, describe } from '@jest/globals';
import { preferredModels } from '@/lib/ai-gateway/models';
import { CLAUDE_SONNET_CURRENT_MODEL_ID } from '@/lib/ai-gateway/providers/anthropic.constants';
import { GPT_CURRENT_MODEL_ID } from '@/lib/ai-gateway/providers/openai';

describe('OpenRouter Models Config', () => {
  test('preferred models should contain expected models', () => {
    const expectedModels = [CLAUDE_SONNET_CURRENT_MODEL_ID, GPT_CURRENT_MODEL_ID, 'z-ai/glm-5.2'];

    expectedModels.forEach(model => {
      expect(preferredModels).toContain(model);
    });
  });
});
