import { afterEach, describe, expect, jest, test } from '@jest/globals';
import type { Provider } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { createUserOpenRouterProvider, OPENROUTER } from './openrouter';

const originalApiKey = process.env.OPENROUTER_API_KEY;

afterEach(() => {
  if (originalApiKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalApiKey;
  jest.resetModules();
});

describe('createUserOpenRouterProvider', () => {
  test('serves OpenRouter with the supplied key and the singleton routing', () => {
    const provider: Provider = createUserOpenRouterProvider('factory-test-key');

    expect(provider).toMatchObject({
      type: 'openrouter',
      apiUrl: 'https://openrouter.ai/api/v1',
      apiUrlOverrides: {},
      disableUrlSuffix: false,
      apiKey: 'factory-test-key',
      apiKeyHeader: null,
    });
    expect(provider.supportedChatApis).toEqual(
      expect.arrayContaining(['chat_completions', 'messages', 'responses'])
    );
  });

  test('leaves the shared singleton on its own key', () => {
    const singletonKey = OPENROUTER.apiKey;

    createUserOpenRouterProvider('factory-user-key');

    expect(OPENROUTER.apiKey).toBe(singletonKey);
  });
});

describe('OPENROUTER', () => {
  test('binds the key that is present before the module is imported', async () => {
    process.env.OPENROUTER_API_KEY = 'stubbed-openrouter-key';
    jest.resetModules();

    // The import-time environment read is the subject, so the module must load here.
    const imported = await import('./openrouter');

    expect(imported.OPENROUTER.apiKey).toBe('stubbed-openrouter-key');
  });
});
