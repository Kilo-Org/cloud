import 'server-only';
import { APP_URL } from '@/lib/constants';
import { getEnvVariable } from '@/lib/dotenvx';

/**
 * OpenAI (Sign in with ChatGPT) OAuth/OIDC configuration.
 *
 * The authorization, token, and JWKS endpoints are discovery-driven: the
 * NextAuth provider resolves them from `OPENAI_DISCOVERY_URL`. Nothing here
 * inlines an authorization URL or a JWKS, so a rotation on OpenAI's side is
 * picked up without a code change.
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
