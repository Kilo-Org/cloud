import { getAiSdkProvider } from '../model-settings';
import type { TransformRequestContext } from '../types';
import edenai from './edenai';

describe('Eden AI direct BYOK provider', () => {
  test('uses the Eden AI v3 Chat Completions API', () => {
    expect(edenai.base_url).toBe('https://api.edenai.run/v3');
    expect(edenai.supported_chat_apis).toEqual(['chat_completions']);
  });

  test.each(['edenai/openai/gpt-5.6-luna', 'edenai/anthropic/claude-sonnet-5'])(
    'uses OpenAI-compatible Chat Completions for %s',
    model => {
      expect(getAiSdkProvider(model, 'edenai')).toBe('openai-compatible');
    }
  );

  test.each([
    [{ reasoning: { effort: 'high' } }, 'high'],
    [{ reasoning: { effort: 'low' }, reasoning_effort: 'medium' }, 'medium'],
  ] as const)('translates reasoning settings for Chat Completions', (body, expectedEffort) => {
    const context = {
      request: { kind: 'chat_completions', body: { model: 'test', messages: [], ...body } },
    } as TransformRequestContext;

    edenai.transformRequest(context);

    expect(context.request.body).toMatchObject({ reasoning_effort: expectedEffort });
    expect(context.request.body).not.toHaveProperty('reasoning');
  });
});
