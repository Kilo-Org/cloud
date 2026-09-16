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
export const OPENAI_REDIRECT_PATH = '/testing/oai-redirect';

/**
 * The exact `redirect_uri` sent to the authorization endpoint. Derived from
 * the application origin so the same registration works per environment.
 */
export const OPENAI_REDIRECT_URI = `${APP_URL}${OPENAI_REDIRECT_PATH}`;

/** Identity-only scopes: stable subject, profile, and email claims. */
export const OPENAI_IDENTITY_SCOPE = 'openid profile email';

/** Token-sharing scopes, used once a client is approved for delegated access. */
export const OPENAI_TOKEN_SHARING_SCOPE =
  'openid profile email offline_access resource.invoke chatpass.enable.request';

/** The API resource that token sharing targets. */
export const OPENAI_RESOURCE = 'https://api.openai.com/v1';
