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
 *   emits `oauthSignIn failed` with the OAuth error code as `reason` and a
 *   fixed-vocabulary `detail` naming the cause behind that code.
 *
 * The reuse guard's own rejection never reaches `onError` (it answers from the
 * Durable Object before the provider runs), so it emits the same failed event
 * with detail `refresh_token_reuse` from `./refresh-reuse`.
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

/** Failure detail for a rejected reuse of a rotated refresh token. */
export const OAUTH_DETAIL_REFRESH_TOKEN_REUSE = 'refresh_token_reuse';

/**
 * The library's `error_description` values, mapped to a fixed slug vocabulary.
 *
 * `onError` sees the library's own description strings (`oauth-provider.js`
 * `createErrorResponse`), which are what separate a revoked grant from an
 * expired one, a client/refresh-token mismatch from a malformed token, and a
 * resource-audience problem from a genuinely invalid bearer. The raw text is
 * never captured: it is free text the library may interpolate into, so only a
 * slug from this table leaves the worker. An unlisted description reports
 * `other`, which keeps the vocabulary bounded without losing the reason code.
 */
const OAUTH_ERROR_DETAILS: Record<string, string> = {
  'Client ID mismatch': 'client_id_mismatch',
  'Client not found': 'client_not_found',
  'Grant not found': 'grant_not_found',
  'Invalid refresh token': 'invalid_refresh_token',
  'Refresh token has expired': 'refresh_token_expired',
  'Invalid token format': 'invalid_token_format',
  'Grant not found or authorization code expired': 'authorization_code_grant_missing',
  'Invalid authorization code': 'invalid_authorization_code',
  'Invalid authorization code format': 'invalid_authorization_code_format',
  'Authorization code already used': 'authorization_code_reused',
  'Invalid PKCE code_verifier': 'invalid_pkce_verifier',
  'Invalid access token': 'invalid_access_token',
  'Access token expired': 'access_token_expired',
  'Token audience does not match resource server': 'resource_audience_mismatch',
  'Access token is not bound to the configured resource': 'access_token_resource_mismatch',
};

/** The slug for one library error, or `other` for a description outside the table. */
function oauthErrorDetail(description: string): string {
  return OAUTH_ERROR_DETAILS[description] ?? 'other';
}

/**
 * Emit `oauthSignIn failed` for a provider error response. The `reason` is the
 * OAuth error code and `detail` narrows it to a cause; no identity is known at
 * the error boundary, so it is always anonymous.
 */
export function onError(error: OAuthProviderError, deps: ProviderHookDeps = {}): void {
  deps.analytics?.oauthSignIn({
    phase: 'failed',
    identity: null,
    reason: error.code,
    detail: oauthErrorDetail(error.description),
  });
}
