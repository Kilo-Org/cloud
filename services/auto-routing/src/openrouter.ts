import { OpenRouter } from '@openrouter/sdk';

type OpenRouterEnv = Pick<Env, 'OPENROUTER_API_KEY'>;

export const OPENROUTER_HTTP_REFERER = 'https://kilocode.ai';
export const OPENROUTER_APP_TITLE = 'Kilo Code';

// Isolate-local client cache so each classification does not re-read the
// API key from the secrets store. The TTL keeps key rotations effective.
const CLIENT_CACHE_TTL_MS = 300_000;

let cachedClient: { clientPromise: Promise<OpenRouter>; expiresAt: number } | null = null;

export function clearOpenRouterClientCache(): void {
  cachedClient = null;
}

export function createOpenRouterClient(env: OpenRouterEnv): Promise<OpenRouter> {
  if (cachedClient && cachedClient.expiresAt > Date.now()) {
    return cachedClient.clientPromise;
  }

  const clientPromise = (async () =>
    new OpenRouter({
      apiKey: await env.OPENROUTER_API_KEY.get(),
      httpReferer: OPENROUTER_HTTP_REFERER,
      appTitle: OPENROUTER_APP_TITLE,
    }))();
  cachedClient = { clientPromise, expiresAt: Date.now() + CLIENT_CACHE_TTL_MS };
  clientPromise.catch(() => {
    cachedClient = null;
  });
  return clientPromise;
}
