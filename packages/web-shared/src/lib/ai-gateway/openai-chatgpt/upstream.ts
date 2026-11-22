import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';

/**
 * The delegated route must carry a key from the project that owns the OAuth
 * client. `OPENAI_API_KEY` is a different project's key: it is handed to the
 * Vercel AI Gateway as an OpenAI BYOK credential. Keep the two apart so neither
 * path inherits the other's project, quota, or billing.
 */
export const OPENAI_CHATGPT_API_KEY_ENV = 'OPENAI_CHATGPT_API_KEY';

/**
 * The partner key that lets this deployment share a ChatGPT plan, or null when
 * it is absent. The deployment is configured for token sharing only when the
 * key is present, so every caller treats null the same way: routing takes the
 * ordinary gateway route without reading the stored connection, the models list
 * stays untagged, and the served-model and eligibility lookups assume the model
 * is served.
 */
export function readOpenAiChatGptPartnerKey(): string | null {
  const key = getEnvVariable(OPENAI_CHATGPT_API_KEY_ENV).trim();
  return key.length === 0 ? null : key;
}

/**
 * The base URL for delegated "Sign in with ChatGPT" requests. The same
 * discovery-driven environment overrides as the OIDC endpoints
 * (`OPENAI_DISCOVERY_URL`, `OPENAI_TOKEN_ENDPOINT`) apply here.
 *
 * The inference request and the served-model lookup must agree: a stub or an
 * alternate host that serves the request must also answer `/models`, or a
 * non-production stack reaches a host the deployment did not intend to call.
 * This lives in its own module because `routing.ts` and `served-models.ts` both
 * read it and importing each other would create a cycle.
 */
export const OPENAI_CHATGPT_API_URL =
  getEnvVariable('OPENAI_CHATGPT_API_URL').trim().replace(/\/+$/, '') ||
  'https://api.openai.com/v1';
