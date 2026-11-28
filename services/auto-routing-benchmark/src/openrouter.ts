import type { SystemOneClient } from '@kilocode/auto-routing-contracts/classifier';
import { ttlCached } from '@kilocode/worker-utils';
import { readAutoRoutingBenchmarkSecret } from './secrets';

type OpenRouterEnv = Pick<Env, 'OPENROUTER_API_KEY'>;

export const OPENROUTER_HTTP_REFERER = 'https://kilocode.ai';
export const OPENROUTER_APP_TITLE = 'Kilo Code';

// Only the API key string is cached at module scope, so each classification
// skips the secrets-store read. The TTL keeps key rotations effective within
// five minutes.
//
// `ttlCached` loaders receive only the env, so this read has no invocation
// context to hand a STS bundle revalidation to. Every classification job runs
// in a queue message or a request that already performed a ctx-bearing read.
const API_KEY_CACHE_TTL_MS = 300_000;

const apiKeyCache = ttlCached(API_KEY_CACHE_TTL_MS, async (env: OpenRouterEnv) => {
  const apiKey = await readAutoRoutingBenchmarkSecret(env, 'OPENROUTER_API_KEY');
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not configured');
  return apiKey;
});

export async function createSystemOneClient(env: OpenRouterEnv): Promise<SystemOneClient> {
  return {
    apiKey: await apiKeyCache.get(env),
    attributionHeaders: {
      'HTTP-Referer': OPENROUTER_HTTP_REFERER,
      'X-Title': OPENROUTER_APP_TITLE,
    },
  };
}
