import { getEnvVariable } from '@/lib/dotenvx';

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
