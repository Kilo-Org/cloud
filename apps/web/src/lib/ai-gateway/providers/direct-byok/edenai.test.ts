import { getAiSdkProvider } from '../model-settings';
import type { GatewayRequest } from '../openrouter/types';
import type { TransformRequestContext } from '../types';
import edenai from './edenai';

describe('Eden AI direct BYOK provider', () => {
  test('supports all chat APIs with the nested Anthropic Messages base URL', () => {
    expect(edenai.base_url).toBe('https://api.edenai.run/v3');
    expect(edenai.base_url_overrides).toEqual({ messages: 'https://api.edenai.run/v3/v1' });
    expect(edenai.supported_chat_apis).toEqual(['chat_completions', 'messages', 'responses']);
  });

  test.each([
    ['edenai/openai/gpt-5.6-luna', 'openai'],
    ['edenai/anthropic/claude-sonnet-5', 'anthropic'],
    ['edenai/xai/grok-4.6', 'openai'],
    ['edenai/google/gemini-flash-latest', undefined],
  ] as const)('selects the model-family API for %s', (model, expectedProvider) => {
    expect(getAiSdkProvider(model, 'edenai')).toBe(expectedProvider);
  });

  test.each([
    [{ reasoning: { effort: 'high' } }, 'high'],
    [{ reasoning: { enabled: false } }, 'none'],
    [{ reasoning: { effort: 'low' }, reasoning_effort: 'medium' }, 'medium'],
  ] as const)('translates reasoning settings for Chat Completions', (body, expectedEffort) => {
    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: { model: 'test', messages: [], ...body },
    };

    edenai.transformRequest({ request } as TransformRequestContext);

    expect(request.body).toMatchObject({ reasoning_effort: expectedEffort });
    expect(request.body).not.toHaveProperty('reasoning');
  });
});
