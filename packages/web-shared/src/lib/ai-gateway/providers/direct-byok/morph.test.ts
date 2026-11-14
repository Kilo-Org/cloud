import { describe, expect, test } from '@jest/globals';
import morph from './morph';
import type { DirectByokProvider } from './types';

describe('Morph direct BYOK AI SDK provider', () => {
  const provider: DirectByokProvider = morph;

  test('uses Chat Completions for a Morph model name that classifies as OpenAI', () => {
    expect(provider.getAiSdkProvider?.('morph/morph-gpt-compatible')).toEqual({
      aiSdkProvider: undefined,
    });
  });
});
