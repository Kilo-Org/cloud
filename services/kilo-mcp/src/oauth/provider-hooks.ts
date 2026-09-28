/**
 * Library hooks for the kilo-MCP OAuth provider (s3).
 *
 * `@cloudflare/workers-oauth-provider` calls these on its token endpoint:
 *
 * - `tokenExchangeCallback` fires per token exchange. The authorization-code
 *   exchange is the moment a user finishes sign-in, so it emits
 *   `oauthSignIn succeeded` with the identity bound into the grant props by
 *   GET|POST /authorize/org. Refresh exchanges stay silent.
 * - `onError` fires for every OAuth error response the provider produces; it
 *   emits `oauthSignIn failed` with the OAuth error code as `reason`.
 *
 * Analytics is best-effort (src/analytics.ts never throws), so a hook can
 * never affect the token response.
 */
import type {
  OAuthProviderOptions,
  TokenExchangeCallbackOptions,
} from '@cloudflare/workers-oauth-provider';
import type { AnalyticsIdentity, McpAnalytics } from '../analytics';

/** The argument the provider passes to its `onError` hook. */
export type OAuthProviderError = Parameters<NonNullable<OAuthProviderOptions['onError']>>[0];

export type ProviderHookDeps = {
  /** Best-effort sign-in analytics; never awaited and never allowed to throw. */
  analytics?: McpAnalytics;
};

/**
 * The identity carried in the grant props at `completeAuthorization` time
 * (`{ kiloUserId, organizationId, kiloToken }`). Returns null when the props do
 * not carry a usable Kilo user id, so a malformed grant is reported anonymously
 * rather than mis-attributed.
 */
function identityFromProps(props: unknown): AnalyticsIdentity | null {
  if (typeof props !== 'object' || props === null) return null;
  const record = props as Record<string, unknown>;
  const kiloUserId = record['kiloUserId'];
  if (typeof kiloUserId !== 'string' || kiloUserId.length === 0) return null;
  const organizationId = record['organizationId'];
  return {
    kiloUserId,
    organizationId:
      typeof organizationId === 'string' && organizationId.length > 0 ? organizationId : null,
  };
}

/**
 * Emit `oauthSignIn succeeded` when the library exchanges an authorization
 * code for tokens. The identity comes from the grant props the org picker
 * stored; a refresh exchange is not a new sign-in and emits nothing.
 */
export function tokenExchangeCallback(
  options: TokenExchangeCallbackOptions,
  deps: ProviderHookDeps = {}
): void {
  // The library's GrantType.AUTHORIZATION_CODE value. Compared by string so
  // this module needs no runtime import of the provider (which eagerly imports
  // `cloudflare:workers`).
  if (String(options.grantType) !== 'authorization_code') return;
  deps.analytics?.oauthSignIn({
    phase: 'succeeded',
    identity: identityFromProps(options.props),
  });
}

/**
 * Emit `oauthSignIn failed` for a provider error response. The `reason` is the
 * OAuth error code; no identity is known at the error boundary.
 */
export function onError(error: OAuthProviderError, deps: ProviderHookDeps = {}): void {
  deps.analytics?.oauthSignIn({
    phase: 'failed',
    identity: null,
    reason: error.code,
  });
}
