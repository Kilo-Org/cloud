import { z } from 'zod';

/**
 * Sign-in through OAuth and OpenID Connect providers, WorkOS SSO, and the email link and code, on
 * the issuer origin (design 5.1). Each provider registration lists the callback URL of its
 * environment's issuer (`UTS_ENDPOINTS`), so these paths are part of every registration.
 */

/** The providers a user signs in with through an OAuth or OpenID Connect redirect. */
export const UTS_OAUTH_PROVIDERS = [
  'google',
  'openai',
  'anthropic',
  'anaconda',
  'apple',
  'github',
  'gitlab',
  'discord',
  'linkedin',
] as const;
export const UtsOAuthProviderSchema = z.enum(UTS_OAUTH_PROVIDERS);
export type UtsOAuthProvider = z.infer<typeof UtsOAuthProviderSchema>;

/** Starts a provider sign-in: a redirect to the provider. */
export function utsProviderStartPath(provider: UtsOAuthProvider): string {
  return `/signin/oauth/${provider}/start`;
}

/** The provider's redirect URI on the issuer origin. Apple posts to it (`form_post`). */
export function utsProviderCallbackPath(provider: UtsOAuthProvider): string {
  return `/signin/oauth/${provider}/callback`;
}

/** WorkOS SSO: the start takes the user's email address, whose domain picks the connection. */
export const UTS_SSO_START_PATH = '/signin/sso/start';
export const UTS_SSO_CALLBACK_PATH = '/signin/sso/callback';

/** Email sign-in: the request, the code entry, and the link's confirmation page and its post. */
export const UTS_EMAIL_START_PATH = '/signin/email/start';
export const UTS_EMAIL_CODE_PATH = '/signin/email/code';
export const UTS_EMAIL_LINK_PATH = '/signin/email/link';

/** Where a sign-in that names no other destination lands. */
export const UTS_SIGNED_IN_PATH = '/signin/done';

/** Design 5.3: a sign-in email's link and code live 10 minutes; a code takes 5 wrong entries. */
export const UTS_EMAIL_SIGN_IN_LIFETIME_SECONDS = 600;
export const UTS_EMAIL_CODE_ENTRIES = 5;
