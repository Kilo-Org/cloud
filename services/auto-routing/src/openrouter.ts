import { OpenRouter } from '@openrouter/sdk';
import { ttlCached } from './ttl-cache';

type OpenRouterEnv = Pick<Env, 'OPENROUTER_API_KEY'>;

export const OPENROUTER_HTTP_REFERER = 'https://kilocode.ai';
export const OPENROUTER_APP_TITLE = 'Kilo Code';

// Only the API key string is cached at module scope (plain value, not a
// transport-owning SDK object), so each classification skips the
// secrets-store read. The client itself is constructed per request; that is
// just object setup around global fetch. The TTL keeps key rotations
// effective within five minutes.
const API_KEY_CACHE_TTL_MS = 300_000;

const apiKeyCache = ttlCached(API_KEY_CACHE_TTL_MS, (env: OpenRouterEnv) =>
  env.OPENROUTER_API_KEY.get()
);

export async function createOpenRouterClient(env: OpenRouterEnv): Promise<OpenRouter> {
  return new OpenRouter({
    apiKey: await apiKeyCache.get(env),
    httpReferer: OPENROUTER_HTTP_REFERER,
    appTitle: OPENROUTER_APP_TITLE,
  });
}
