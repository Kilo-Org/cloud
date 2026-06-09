import { OpenRouter } from '@openrouter/sdk';

type OpenRouterEnv = Pick<Env, 'OPENROUTER_API_KEY'>;

export const OPENROUTER_HTTP_REFERER = 'https://kilocode.ai';
export const OPENROUTER_APP_TITLE = 'Kilo Code';

export async function createOpenRouterClient(env: OpenRouterEnv): Promise<OpenRouter> {
  return new OpenRouter({
    apiKey: await env.OPENROUTER_API_KEY.get(),
    httpReferer: OPENROUTER_HTTP_REFERER,
    appTitle: OPENROUTER_APP_TITLE,
  });
}
