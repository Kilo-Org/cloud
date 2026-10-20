import { describe, expect, it } from 'vitest';
import { getAiSdkProvider } from './ai-sdk-provider';

describe('getAiSdkProvider', () => {
  it.each([
    ['anthropic/claude-opus-4.6', 'anthropic'],
    ['openai/gpt-5.5', 'openai'],
    ['x-ai/grok-code-fast-1', 'openai'],
    ['meta/muse-spark-1.2', 'openai'],
  ] as const)('maps %s to the %s provider', (model, provider) => {
    expect(getAiSdkProvider(model, null)).toBe(provider);
  });

  it.each(['kilo-auto/balanced', 'openai/gpt-oss-120b', 'minimax/minimax-m2.5'])(
    'uses the default provider for %s',
    model => {
      expect(getAiSdkProvider(model, null)).toBeUndefined();
    }
  );

  it('applies direct BYOK provider overrides', () => {
    expect(getAiSdkProvider('opencode-go/minimax-m3', 'opencode-go')).toBe('anthropic');
    expect(getAiSdkProvider('morph-byok/morph-gpt-compatible', 'morph-byok')).toBeUndefined();
  });
});
