import { describe, expect, it, vi } from 'vitest';
import {
  OPENROUTER_APP_TITLE,
  OPENROUTER_HTTP_REFERER,
  createOpenRouterClient,
} from './openrouter';

const openRouterConstructorCalls = vi.hoisted(() => [] as unknown[]);

vi.mock('@openrouter/sdk', () => ({
  OpenRouter: class {
    chat = { send: vi.fn() };

    constructor(options: unknown) {
      openRouterConstructorCalls.push(options);
    }
  },
}));

describe('createOpenRouterClient', () => {
  it('creates an OpenRouter SDK client that matches the Next.js OpenRouter attribution', async () => {
    openRouterConstructorCalls.length = 0;

    const client = await createOpenRouterClient({
      OPENROUTER_API_KEY: {
        get: async () => 'sk-or-test',
      },
    } satisfies Pick<Env, 'OPENROUTER_API_KEY'>);

    expect(client).toHaveProperty('chat');
    expect(openRouterConstructorCalls).toEqual([
      {
        apiKey: 'sk-or-test',
        httpReferer: OPENROUTER_HTTP_REFERER,
        appTitle: OPENROUTER_APP_TITLE,
      },
    ]);
  });
});
