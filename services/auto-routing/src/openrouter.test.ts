import { describe, expect, it } from 'vitest';
import {
  OPENROUTER_APP_TITLE,
  OPENROUTER_HTTP_REFERER,
  createOpenRouterClient,
} from './openrouter';

type OpenRouterClientOptions = {
  _options: {
    apiKey: string;
    httpReferer: string;
    appTitle: string;
  };
};

describe('createOpenRouterClient', () => {
  it('creates an OpenRouter SDK client that matches the Next.js OpenRouter attribution', async () => {
    const client = await createOpenRouterClient({
      OPENROUTER_API_KEY: {
        get: async () => 'sk-or-test',
      },
    } satisfies Pick<Env, 'OPENROUTER_API_KEY'>);

    expect(client).toHaveProperty('chat');

    const options = (client as OpenRouterClientOptions)._options;
    expect(options.apiKey).toBe('sk-or-test');
    expect(options.httpReferer).toBe(OPENROUTER_HTTP_REFERER);
    expect(options.appTitle).toBe(OPENROUTER_APP_TITLE);
  });
});
