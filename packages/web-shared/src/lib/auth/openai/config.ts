import 'server-only';
import { APP_URL } from '@kilocode/web-shared/lib/constants';
import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';

/**
 * OpenAI (Sign in with ChatGPT) OAuth/OIDC configuration.
 *
 * The authorization and JWKS endpoints are discovery-driven: the NextAuth
 * provider resolves them from `OPENAI_DISCOVERY_URL`, so a rotation on OpenAI's
 * side is picked up without a code change.
 *
 * The delegated ChatGPT token refresh is the exception. `OPENAI_TOKEN_ENDPOINT`
 * is an environment-overridable constant with a fixed default, and the refresh
 * code posts to it directly instead of reading the discovery document.
 */

export const OPENAI_ISSUER = 'https://auth.openai.com';

export const OPENAI_DISCOVERY_URL =
  getEnvVariable('OPENAI_DISCOVERY_URL') ||
  'https://auth.openai.com/.well-known/openid-configuration';

export const OPENAI_TOKEN_ENDPOINT =
  getEnvVariable('OPENAI_TOKEN_ENDPOINT') || 'https://auth.openai.com/api/accounts/oauth/token';

/**
 * The callback path registered with the OpenAI OAuth client. It is a fixed
 * part of the registration and must not be changed without re-registering.
 */
export const OPENAI_REDIRECT_PATH = '/auth/openai/callback';

/**
 * The exact `redirect_uri` sent to the authorization endpoint. Derived from
 * the application origin so the same registration works per environment.
 */
export const OPENAI_REDIRECT_URI = `${APP_URL}${OPENAI_REDIRECT_PATH}`;

// The scope sets and the API resource live in a client-safe module so the BYOK
// card can add the token-sharing scope without importing this server-only file.
export {
  OPENAI_IDENTITY_SCOPE,
  OPENAI_RESOURCE,
  OPENAI_TOKEN_SHARING_SCOPE,
  isOpenAiTokenSharingGrant,
} from './scopes';
