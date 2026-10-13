import { ttlCached } from '@kilocode/worker-utils';
import type { SystemOneClient } from '@kilocode/auto-routing-contracts/classifier';

type OpenRouterEnv = Pick<Env, 'OPENROUTER_API_KEY'>;

export const OPENROUTER_HTTP_REFERER = 'https://kilocode.ai';
export const OPENROUTER_APP_TITLE = 'Kilo Code';

// Only the API key string is cached at module scope, so each classification
// skips the secrets-store read. The TTL keeps key rotations effective within
// five minutes.
const API_KEY_CACHE_TTL_MS = 300_000;

const apiKeyCache = ttlCached(API_KEY_CACHE_TTL_MS, (env: OpenRouterEnv) =>
  env.OPENROUTER_API_KEY.get()
);

export async function createSystemOneClient(env: OpenRouterEnv): Promise<SystemOneClient> {
  return {
    apiKey: await apiKeyCache.get(env),
    attributionHeaders: {
      'HTTP-Referer': OPENROUTER_HTTP_REFERER,
      'X-Title': OPENROUTER_APP_TITLE,
    },
  };
}
