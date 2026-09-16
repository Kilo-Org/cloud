/**
 * The OAuth scopes for the OpenAI ("Sign in with ChatGPT") client.
 *
 * This module is deliberately free of `server-only` and of environment reads:
 * the BYOK card is a client component and needs `OPENAI_TOKEN_SHARING_SCOPE` to
 * add the delegated-access scope to the authorization request. Server code
 * keeps importing it from `./config`, which re-exports these values.
 */

/** Identity-only scopes: stable subject, profile, and email claims. */
export const OPENAI_IDENTITY_SCOPE = 'openid profile email';

/** Token-sharing scopes, used once a client is approved for delegated access. */
export const OPENAI_TOKEN_SHARING_SCOPE =
  'openid profile email offline_access resource.invoke chatpass.enable.request';

/** The API resource that token sharing targets. */
export const OPENAI_RESOURCE = 'https://api.openai.com/v1';
