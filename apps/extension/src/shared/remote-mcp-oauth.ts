import type { OAuthClientMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';

/**
 * Pure OAuth helpers for the remote MCP feature. No browser APIs live here so
 * everything is unit-testable in plain Node.
 */

/**
 * Parses the redirect URL the auth flow returns and extracts the `code`.
 * Throws if the URL is malformed, carries an OAuth `error`, or lacks a `code`.
 */
export const parseAuthorizationRedirect = (redirectUrl: string): string => {
  const params = new URL(redirectUrl).searchParams;

  const error = params.get('error');
  if (error !== null) {
    const description = params.get('error_description');
    throw new Error(description === null ? error : `${error}: ${description}`);
  }

  const code = params.get('code');
  if (code === null) {
    throw new Error('Authorization redirect did not include a code.');
  }

  return code;
};

/** Builds public-client (no secret) PKCE registration metadata. */
export const buildPublicClientMetadata = (redirectUrl: string): OAuthClientMetadata => ({
  client_name: 'Kilo Extension',
  grant_types: ['authorization_code', 'refresh_token'],
  redirect_uris: [redirectUrl],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
});
