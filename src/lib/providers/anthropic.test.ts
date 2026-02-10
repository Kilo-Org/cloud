import type { OpenRouterChatCompletionRequest } from '@/lib/providers/openrouter/types';
import { applyAnthropicModelSettings, isAnthropicModel } from '@/lib/providers/anthropic';

function makeRequest(
  overrides: Partial<OpenRouterChatCompletionRequest> = {}
): OpenRouterChatCompletionRequest {
  return {
    model: 'anthropic/claude-sonnet-4.5',
    messages: [{ role: 'user', content: 'hello' }],
    ...overrides,
  };
}

describe('isAnthropicModel', () => {
  test('returns true for anthropic models', () => {
    expect(isAnthropicModel('anthropic/claude-sonnet-4.5')).toBe(true);
    expect(isAnthropicModel('anthropic/claude-opus-4.6')).toBe(true);
  });

  test('returns false for non-anthropic models', () => {
    expect(isAnthropicModel('openai/gpt-4')).toBe(false);
    expect(isAnthropicModel('google/gemini-pro')).toBe(false);
  });
});

describe('applyAnthropicModelSettings', () => {
  test('defaults reasoning.effort to medium when reasoning is undefined', () => {
    const request = makeRequest();
    const headers: Record<string, string> = {};

    applyAnthropicModelSettings(request, headers);

    expect(request.reasoning).toEqual({ effort: 'medium' });
  });

  test('defaults reasoning.effort to medium when reasoning exists but effort is not set', () => {
    const request = makeRequest({ reasoning: { max_tokens: 1024 } });
    const headers: Record<string, string> = {};

    applyAnthropicModelSettings(request, headers);

    expect(request.reasoning).toEqual({ max_tokens: 1024, effort: 'medium' });
  });

  test('preserves existing reasoning.effort when already set', () => {
    const request = makeRequest({ reasoning: { effort: 'high', max_tokens: 2048 } });
    const headers: Record<string, string> = {};

    applyAnthropicModelSettings(request, headers);

    expect(request.reasoning).toEqual({ effort: 'high', max_tokens: 2048 });
  });

  test('preserves reasoning.effort of low when explicitly set', () => {
    const request = makeRequest({ reasoning: { effort: 'low' } });
    const headers: Record<string, string> = {};

    applyAnthropicModelSettings(request, headers);

    expect(request.reasoning).toEqual({ effort: 'low' });
  });
});
