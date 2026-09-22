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

/**
 * The scopes that make a grant a delegated BYOK credential rather than an
 * identity-only sign-in. `resource.invoke` is what permits calling the API
 * resource on the person's behalf, `chatpass.enable.request` is the consent to
 * spend the person's ChatGPT allowance, and `offline_access` is what makes the
 * token renewable without another sign-in. An identity-only sign-in grants
 * none of them, and a person can decline token sharing while still granting
 * identity, so the allowance consent must be checked on its own.
 */
const OPENAI_DELEGATED_GRANT_SCOPES = [
  'resource.invoke',
  'chatpass.enable.request',
  'offline_access',
] as const;

/**
 * True when a completed authorization granted the delegated-access scopes.
 *
 * RFC 6749 §5.1 lets a token response omit `scope` when it is identical to the
 * scope that was requested, so an omitted scope falls back to the refresh token:
 * `offline_access` is the only scope for which OpenAI issues one, and the
 * identity-only sign-in flow never requests it.
 */
export function isOpenAiTokenSharingGrant(grant: {
  scope?: string | null;
  refresh_token?: string | null;
}): boolean {
  const scope = typeof grant.scope === 'string' ? grant.scope.trim() : '';
  if (scope !== '') {
    const granted = new Set(scope.split(/\s+/));
    return OPENAI_DELEGATED_GRANT_SCOPES.every(required => granted.has(required));
  }

  return typeof grant.refresh_token === 'string' && grant.refresh_token !== '';
}
