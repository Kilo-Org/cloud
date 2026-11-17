import 'server-only';
import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';

/**
 * Claude Platform OAuth configuration shared by "Sign in with Claude" and
 * Linked billing with Claude Platform.
 *
 * Every Anthropic URL has an environment override so a local stub can stand in
 * for the whole surface. Production leaves them unset.
 */

const DEFAULT_OIDC_ISSUER = 'https://identity.anthropic.com/users';
const DEFAULT_AUTH_BASE_URL = 'https://auth.claude.com';
const DEFAULT_API_BASE_URL = 'https://api.anthropic.com';

function withoutTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/** The `iss` of Anthropic's ID tokens; also the base of the discovery document. */
export const CLAUDE_OIDC_ISSUER = withoutTrailingSlash(
  getEnvVariable('CLAUDE_OIDC_ISSUER') || DEFAULT_OIDC_ISSUER
);

export const CLAUDE_DISCOVERY_URL = `${CLAUDE_OIDC_ISSUER}/.well-known/openid-configuration`;

/**
 * Hosts the authorization, pushed authorization request, and token endpoints.
 * The discovery document does not list the PAR endpoint, so it is derived here.
 */
export const CLAUDE_AUTH_BASE_URL = withoutTrailingSlash(
  getEnvVariable('CLAUDE_AUTH_BASE_URL') || DEFAULT_AUTH_BASE_URL
);

export const CLAUDE_AUTHORIZE_URL = `${CLAUDE_AUTH_BASE_URL}/oauth/authorize`;
export const CLAUDE_PAR_URL = `${CLAUDE_AUTH_BASE_URL}/v1/oauth/par`;
export const CLAUDE_TOKEN_URL = `${CLAUDE_AUTH_BASE_URL}/v1/oauth/token`;

/** The Claude API: user profiles, the federation token exchange, and inference. */
export const CLAUDE_API_BASE_URL = withoutTrailingSlash(
  getEnvVariable('CLAUDE_API_BASE_URL') || DEFAULT_API_BASE_URL
);

export const CLAUDE_CLIENT_ASSERTION_TYPE =
  'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

/** The "Sign in with Claude" OAuth app. Its client ID is public. */
export const CLAUDE_SIGN_IN_CLIENT_ID = getEnvVariable('CLAUDE_SIGN_IN_CLIENT_ID');

/**
 * The `aud` the sign-in app's client authentication settings expect on a
 * client assertion. Each OAuth app shows its own value.
 */
export const CLAUDE_SIGN_IN_ASSERTION_AUDIENCE = getEnvVariable(
  'CLAUDE_SIGN_IN_ASSERTION_AUDIENCE'
);

export const CLAUDE_SIGN_IN_SCOPE = 'openid email profile';

/** The Linked billing with Claude Platform OAuth app ("Attribute and bill users"). */
export const CLAUDE_BILLING_CLIENT_ID = getEnvVariable('CLAUDE_BILLING_CLIENT_ID');

/** The `aud` the billing app's client authentication settings expect. */
export const CLAUDE_BILLING_ASSERTION_AUDIENCE = getEnvVariable(
  'CLAUDE_BILLING_ASSERTION_AUDIENCE'
);

export const CLAUDE_BILLING_SCOPE = 'org:billing_attribution';

/** Requests an organization connection, which only a billing connection uses. */
export const CLAUDE_BILLING_CONNECTION_TYPE = 'organization_shared';

/** Beta header Anthropic enables for billing connections; required with `billing_policy`. */
export const CLAUDE_BILLING_BETA = 'user-profiles-billing-2026-10-01';

/**
 * Kilo's operator service account: the only identity allowed to send requests
 * that bill a connected customer. Its federation rule maps Kilo-signed JWTs
 * with `CLAUDE_OPERATOR_TOKEN_AUDIENCE` to the service account.
 */
export const CLAUDE_OPERATOR_FEDERATION_RULE_ID = getEnvVariable(
  'CLAUDE_OPERATOR_FEDERATION_RULE_ID'
);
export const CLAUDE_OPERATOR_ORGANIZATION_ID = getEnvVariable('CLAUDE_OPERATOR_ORGANIZATION_ID');
export const CLAUDE_OPERATOR_SERVICE_ACCOUNT_ID = getEnvVariable(
  'CLAUDE_OPERATOR_SERVICE_ACCOUNT_ID'
);
/** Optional: needed only when the federation rule covers several workspaces. */
export const CLAUDE_OPERATOR_WORKSPACE_ID = getEnvVariable('CLAUDE_OPERATOR_WORKSPACE_ID');
export const CLAUDE_OPERATOR_TOKEN_AUDIENCE = getEnvVariable('CLAUDE_OPERATOR_TOKEN_AUDIENCE');
