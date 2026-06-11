import { OpenRouter } from '@openrouter/sdk';
import { ttlCached } from './ttl-cache';

type OpenRouterEnv = Pick<Env, 'OPENROUTER_API_KEY'>;

export const OPENROUTER_HTTP_REFERER = 'https://kilocode.ai';
export const OPENROUTER_APP_TITLE = 'Kilo Code';

// Isolate-local client cache so each classification does not re-read the
// API key from the secrets store. The TTL keeps key rotations effective.
const CLIENT_CACHE_TTL_MS = 300_000;

const clientCache = ttlCached(
  CLIENT_CACHE_TTL_MS,
  async (env: OpenRouterEnv) =>
    new OpenRouter({
      apiKey: await env.OPENROUTER_API_KEY.get(),
      httpReferer: OPENROUTER_HTTP_REFERER,
      appTitle: OPENROUTER_APP_TITLE,
    })
);

export function createOpenRouterClient(env: OpenRouterEnv): Promise<OpenRouter> {
  return clientCache.get(env);
}
