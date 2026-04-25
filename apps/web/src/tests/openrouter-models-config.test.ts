import { test, expect, describe } from '@jest/globals';
import { preferredModels } from '@/lib/ai-gateway/models';

describe('OpenRouter Models Config', () => {
  test('preferred models should contain expected models', () => {
    const expectedModels = [
      'google/gemini-3.1-pro-preview',
      'anthropic/claude-sonnet-4.6',
      'openai/gpt-5.5',
    ];

    expectedModels.forEach(model => {
      expect(preferredModels).toContain(model);
    });
  });
});
