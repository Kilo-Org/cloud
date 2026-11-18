import { describe, expect, it } from 'vitest';
import { OPENROUTER_APP_TITLE, OPENROUTER_HTTP_REFERER, createSystemOneClient } from './openrouter';

describe('createSystemOneClient', () => {
  it('carries the platform key and the Next.js OpenRouter attribution headers', async () => {
    const client = await createSystemOneClient({
      OPENROUTER_API_KEY: {
        get: async () => 'sk-or-test',
      },
    } satisfies Pick<Env, 'OPENROUTER_API_KEY'>);

    expect(client).toEqual({
      apiKey: 'sk-or-test',
      attributionHeaders: {
        'HTTP-Referer': OPENROUTER_HTTP_REFERER,
        'X-Title': OPENROUTER_APP_TITLE,
      },
    });
  });
});
