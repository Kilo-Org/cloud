import { getAiSdkProvider } from '../model-settings';

describe('getAiSdkProvider', () => {
  test.each(['opencode-go/minimax-m3', 'opencode-go/qwen3.7-plus'])(
    'uses the Anthropic Messages API for OpenCode Go model %s',
    model => {
      expect(getAiSdkProvider(model, 'opencode-go')).toBe('anthropic');
    }
  );

  test('uses Chat Completions for MiniMax models from other direct providers', () => {
    expect(getAiSdkProvider('minimax/minimax-m2.5', 'crofai')).toBeUndefined();
  });

  test('uses OpenAI-compatible Chat Completions for Morph direct BYOK models', () => {
    expect(getAiSdkProvider('morph/morph-gpt-compatible', 'morph-byok')).toBe('openai-compatible');
  });

  test('uses the Anthropic Messages API for MiniMax models through the gateway', () => {
    expect(getAiSdkProvider('minimax/minimax-m2.5', null)).toBe('anthropic');
  });
});
