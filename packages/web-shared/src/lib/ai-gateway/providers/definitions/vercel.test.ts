import { afterEach, describe, expect, jest, test } from '@jest/globals';
import type { Provider } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { createUserVercelAiGatewayProvider, VERCEL_AI_GATEWAY } from './vercel';

const originalApiKey = process.env.VERCEL_AI_GATEWAY_API_KEY;

afterEach(() => {
  if (originalApiKey === undefined) delete process.env.VERCEL_AI_GATEWAY_API_KEY;
  else process.env.VERCEL_AI_GATEWAY_API_KEY = originalApiKey;
  jest.resetModules();
});

describe('createUserVercelAiGatewayProvider', () => {
  test('serves the Vercel AI Gateway with the supplied key and the singleton routing', () => {
    const provider: Provider = createUserVercelAiGatewayProvider('factory-test-key');

    expect(provider).toMatchObject({
      type: 'vercel',
      apiUrl: 'https://ai-gateway.vercel.sh/v1',
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
    const singletonKey = VERCEL_AI_GATEWAY.apiKey;

    createUserVercelAiGatewayProvider('factory-user-key');

    expect(VERCEL_AI_GATEWAY.apiKey).toBe(singletonKey);
  });
});

describe('VERCEL_AI_GATEWAY', () => {
  test('binds the key that is present before the module is imported', async () => {
    process.env.VERCEL_AI_GATEWAY_API_KEY = 'stubbed-vercel-key';
    jest.resetModules();

    // The import-time environment read is the subject, so the module must load here.
    const imported = await import('./vercel');

    expect(imported.VERCEL_AI_GATEWAY.apiKey).toBe('stubbed-vercel-key');
  });
});
