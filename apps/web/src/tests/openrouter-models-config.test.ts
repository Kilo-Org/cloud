import { test, expect, describe } from '@jest/globals';
import { preferredModels } from '@/lib/ai-gateway/models';
import { CLAUDE_SONNET_CURRENT_MODEL_ID } from '@/lib/ai-gateway/providers/anthropic.constants';

describe('OpenRouter Models Config', () => {
  test('preferred models should contain expected models', () => {
    const expectedModels = [
      'google/gemini-3.1-pro-preview',
      CLAUDE_SONNET_CURRENT_MODEL_ID,
      'openai/gpt-5.5',
      'z-ai/glm-5.2',
    ];

    expectedModels.forEach(model => {
      expect(preferredModels).toContain(model);
    });
  });
});
