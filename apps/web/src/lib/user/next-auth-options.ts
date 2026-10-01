import 'server-only';
import { JWT_TOKEN_VERSION } from '@kilocode/web-shared/lib/tokens';
import { cookies, headers } from 'next/headers';

import { findUserById } from '@kilocode/web-shared/lib/user/find-user-by-id';
import type { CreateOrUpdateUserArgs, CreateOrUpdateUserTrackingContext } from '@/lib/user';
import { createOrUpdateUser, findAndSyncExistingUser } from '@/lib/user';
import type { NextAuthOptions, Account, User as NextUser, Profile } from 'next-auth';
import NextAuth from 'next-auth';
import type { GoogleProfile } from 'next-auth/providers/google';
import type { OAuthConfig } from 'next-auth/providers/oauth';
import GoogleProvider from 'next-auth/providers/google';
import GithubProvider from 'next-auth/providers/github';
import GitlabProvider from 'next-auth/providers/gitlab';
import LinkedInProvider from 'next-auth/providers/linkedin';
import DiscordProvider from 'next-auth/providers/discord';
import WorkOSProvider from 'next-auth/providers/workos';
import AppleProvider from 'next-auth/providers/apple';
import CredentialsProvider from 'next-auth/providers/credentials';
import { allow_fake_login } from '@kilocode/web-shared/lib/constants';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { verifyAndConsumeMagicLinkToken } from '@kilocode/web-shared/lib/auth/magic-link-tokens';
import { consumeSignInTicket } from '@/lib/auth/passkey';
import { IMPACT_CLICK_ID_COOKIE } from '@/lib/impact/affiliate-utils';
import { logImpactReferralDebug } from '@/lib/impact/debug';
import { countryCodeFromHeaders, localeFromHeaders } from '@/lib/impact/referral';
import {
  parseImpactAffiliateTouchFromUrl,
  parseImpactReferralTouchFromUrl,
} from '@/lib/impact/referral-utils';
import { secondsInDay } from 'date-fns/constants';
import type { AdapterUser } from 'next-auth/adapters';
import assert from 'node:assert';
import type { User } from '@kilocode/db/schema';
import type { AuthProviderId } from '@kilocode/db/schema-types';
import PostHogClient from '@kilocode/web-shared/lib/posthog';
import { captureException } from '@sentry/nextjs';
import {
  getOrganizationById,
  getUserOrgMemberships,
} from '@kilocode/web-shared/lib/organizations/organizations';
import { resolveSsoAuthorityForDomain } from '@kilocode/web-shared/lib/organizations/organization-sso-policy';
import { canManageOrganization } from '@kilocode/app-shared/organizations';
import { ensureVerifiedDomainOrganizationMembership } from '@/lib/organizations/verified-domain-membership';
import type { AccountLinkingSession } from '@/lib/account-linking-session';
import { getAccountLinkingSession } from '@/lib/account-linking-session';
import { linkAccountToExistingUser } from '@/lib/user';
import { whenOk } from '@kilocode/web-shared/lib/maybe-result';
import type { AuthErrorType } from '@/lib/auth/constants';
import { hosted_domain_specials } from '@/lib/auth/constants';
import { authFailureRedirectUrl, ssoSignInRedirectUrl } from '@/lib/auth/redirect-urls';
import { isValidCallbackPath } from '@/lib/getSignInCallbackUrl';
import {
  OPENAI_DISCOVERY_URL,
  OPENAI_IDENTITY_SCOPE,
  OPENAI_ISSUER,
  OPENAI_REDIRECT_URI,
  OPENAI_RESOURCE,
  isOpenAiTokenSharingGrant,
} from '@kilocode/web-shared/lib/auth/openai/config';
import {
  openAiChatGptSharedServicesOwner,
  saveOpenAiChatGptConnection,
} from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/store';
import type { OpenAiChatGptOwner } from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/store';
import {
  GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  ANACONDA_CLIENT_ID,
  ANACONDA_CLIENT_SECRET,
  OPENAI_CLIENT_ID,
  OPENAI_CLIENT_SECRET,
  LINKEDIN_CLIENT_ID,
  LINKEDIN_CLIENT_SECRET,
  WORKOS_API_KEY,
  WORKOS_CLIENT_ID,
  NEXTAUTH_SECRET,
  NEXTAUTH_URL,
  GITLAB_CLIENT_ID,
  GITLAB_CLIENT_SECRET,
  DISCORD_OAUTH_CLIENT_ID,
  DISCORD_OAUTH_CLIENT_SECRET,
  APPLE_CLIENT_ID,
  APPLE_TEAM_ID,
  APPLE_KEY_ID,
  APPLE_PRIVATE_KEY,
} from '@kilocode/web-shared/lib/config.server';
import jwt from 'jsonwebtoken';
import type { UUID } from 'node:crypto';
import { logExceptInTest, sentryLogger } from '@kilocode/web-shared/lib/utils.server';
import { processSSOUserLogin } from '@/lib/user/sso';
import { getLowerDomainFromEmail } from '@kilocode/web-shared/lib/email-address';
import { z } from 'zod';
import {
  isBlockedTLD,
  isEmailBlacklistedByDomainAsync,
  sessionAuthOptions,
} from '@kilocode/web-shared/lib/user/server';

export type TurnstileJwtPayload = {
  /**
   * SECURITY: this guid MUST be generated server side!
   * It's used to ensure idempotency, but also to determine the user id.
   */
  guid: UUID;
  ip: string;
  iat: number;
  exp: number;
};

const warnInSentry = sentryLogger('user.server', 'warning');

function generateAppleClientSecret(): string {
  if (!APPLE_PRIVATE_KEY || !APPLE_KEY_ID || !APPLE_TEAM_ID || !APPLE_CLIENT_ID) {
    return '';
  }

  const now = Math.floor(Date.now() / 1000);
  const sixMonths = 180 * 24 * 60 * 60;

  return jwt.sign(
    {
      iss: APPLE_TEAM_ID,
      iat: now,
      exp: now + sixMonths,
      aud: 'https://appleid.apple.com',
      sub: APPLE_CLIENT_ID,
    },
    APPLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    {
      algorithm: 'ES256',
      keyid: APPLE_KEY_ID,
    }
  );
}

const anacondaProfileSchema = z.object({
  sub: z.string().trim().min(1),
  email: z.string().email(),
  email_verified: z.literal(true),
  name: z.string().nullish(),
  given_name: z.string().nullish(),
  family_name: z.string().nullish(),
  picture: z.string().url().nullish(),
});

export function parseAnacondaProfile(profile: unknown) {
  const parsedProfile = anacondaProfileSchema.parse(profile);
  const fullName = [parsedProfile.given_name?.trim(), parsedProfile.family_name?.trim()]
    .filter(Boolean)
    .join(' ');

  return {
    id: parsedProfile.sub,
    email: parsedProfile.email,
    name: parsedProfile.name?.trim() || fullName || parsedProfile.email.split('@')[0],
    image: parsedProfile.picture ?? null,
  };
}

const openAiProfileSchema = z.object({
  sub: z.string().trim().min(1),
  email: z.string().email(),
  name: z.string().nullish(),
  picture: z.string().nullish(),
});

/**
 * Maps the verified OpenAI ID-token claims to a NextAuth user. `sub` is the
 * stable external identity: it is the only claim used to bind the account, so
 * a missing or empty subject is rejected rather than coerced.
 */
export function parseOpenAiProfile(profile: unknown) {
  const parsedProfile = openAiProfileSchema.parse(profile);
  return {
    id: parsedProfile.sub,
    email: parsedProfile.email,
    name: parsedProfile.name?.trim() || parsedProfile.email.split('@')[0],
    image: parsedProfile.picture ?? null,
  };
}

function createGoogleAccountInfo(
  account: Account,
  user: NextUser | AdapterUser,
  profile: Profile | undefined
): CreateOrUpdateUserArgs | null {
  if (account.provider !== 'google') return null;
  assert(user.email, 'User email is required for Google auth');
  const googleProfile = profile as GoogleProfile | undefined;
  assert(googleProfile, 'Google profile is required for Google auth');
  assert(googleProfile.email_verified, 'Google email must be verified');

  return {
    google_user_email: user.email,
    google_user_name: user.name || '',
    google_user_image_url: user.image || '',
    hosted_domain: googleProfile.hd ?? hosted_domain_specials.non_workspace_google_account,
    provider: account.provider,
    provider_account_id: account.providerAccountId,
    display_name: null, // Google OAuth does not provide a public profile URL
  };
}

function createAnacondaAccountInfo(
  account: Account,
  user: NextUser | AdapterUser
): CreateOrUpdateUserArgs | null {
  if (account.provider !== 'anaconda') return null;
  assert(user.email, 'User email is required for Anaconda auth');

  return {
    google_user_email: user.email,
    google_user_name: user.name || user.email.split('@')[0],
    google_user_image_url: user.image || '',
    hosted_domain: hosted_domain_specials.anaconda,
    provider: account.provider,
    provider_account_id: account.providerAccountId,
    display_name: null,
  };
}

function createOpenAiAccountInfo(
  account: Account,
  user: NextUser | AdapterUser,
  profile: Profile | undefined
): CreateOrUpdateUserArgs | null {
  if (account.provider !== 'openai') return null;
  assert(user.email, 'User email is required for OpenAI auth');

  const sub = (profile as { sub?: unknown } | undefined)?.sub;
  if (typeof sub !== 'string' || sub.trim() === '') {
    throw new Error('OpenAI auth profile is missing the subject');
  }

  return {
    google_user_email: user.email,
    google_user_name: user.name || user.email.split('@')[0],
    google_user_image_url: user.image || '',
    hosted_domain: hosted_domain_specials.openai,
    provider: account.provider,
    // Issuer-qualified subject: a `sub` from any other issuer or client can
    // never collide with an OpenAI account.
    provider_account_id: `${OPENAI_ISSUER}#${sub}`,
    display_name: null,
  };
}

/**
 * Persists the delegated tokens a completed ChatGPT authorization issued, so
 * the same consent that signs a person in also connects OpenAI BYOK. Only a
 * grant that carries the delegated scopes is stored: a plain identity-only
 * sign-in cannot invoke the API resource and cannot be refreshed, so storing it
 * would route eligible requests through a credential OpenAI rejects and would
 * overwrite a working token-sharing connection. A storage failure is reported to
 * Sentry without any token value and never fails the sign-in: the person is
 * still signed in and can connect again from BYOK.
 */
async function persistOpenAiChatGptConnection(
  userId: string,
  account: Account,
  profile: Profile | undefined
): Promise<void> {
  try {
    const accessToken = account.access_token;
    const subject = (profile as { sub?: unknown } | undefined)?.sub;
    if (!accessToken || typeof subject !== 'string' || subject.trim() === '') return;
    if (!isOpenAiTokenSharingGrant(account)) return;

    const email = (profile as { email?: unknown } | undefined)?.email;
    const extendedProfile = profile as ExtendedProfile | undefined;
    const organizationId = extendedProfile?.openAiChatGptOrganizationId;
    // A shared-services link stores the organization's single row instead of the
    // linking person's own connection.
    const owner: OpenAiChatGptOwner =
      organizationId && extendedProfile?.openAiChatGptSharedServices === true
        ? openAiChatGptSharedServicesOwner(organizationId)
        : { kiloUserId: userId, organizationId: organizationId ?? null };
    await saveOpenAiChatGptConnection(
      owner,
      {
        access_token: accessToken,
        ...(account.refresh_token ? { refresh_token: account.refresh_token } : {}),
        expires_at: account.expires_at ?? Math.floor(Date.now() / 1000) + 3600,
        ...(account.scope ? { scope: account.scope } : {}),
        ...(account.token_type ? { token_type: account.token_type } : {}),
        issuer: OPENAI_ISSUER,
        client_id: OPENAI_CLIENT_ID,
        subject,
        ...(typeof email === 'string' && email ? { email } : {}),
        connected_at: new Date().toISOString(),
        status: 'connected',
      },
      userId
    );
  } catch (error) {
    captureException(error, {
      tags: { operation: 'openai_chatgpt_connection_persist' },
    });
  }
}

/**
 * Whether the person completing a shared-services authorization may still
 * connect the organization's connection. The link start authorized the role,
 * but the consent round-trip can outlive it, so the callback re-reads the
 * current membership: an owner or admin of the organization, an owner or admin
 * of the parent organization whose access it inherits, or a Kilo platform admin
 * (elevated and audited by the link start's own access check) may persist the
 * connection. `canManageOrganization` is the rule every other organization
 * management surface uses.
 */
async function mayConnectOpenAiChatGptSharedServices(
  user: Pick<User, 'id' | 'is_admin'>,
  organizationId: string
): Promise<boolean> {
  if (user.is_admin) return true;

  const memberships = await getUserOrgMemberships(user.id);
  const organization = await getOrganizationById(organizationId);
  const roleIn = (id: string | null | undefined) =>
    memberships.find(membership => membership.orgId === id)?.role;

  return (
    canManageOrganization(roleIn(organizationId)) ||
    canManageOrganization(roleIn(organization?.parent_organization_id))
  );
}

/**
 * Where a refused shared-services authorization returns: the organization's
 * BYOK page, whose card renders the `openai_error` code. The generic
 * account-linking failure page cannot carry the organization, so the refusal
 * would land on a page with no card to show it.
 */
function openAiChatGptConnectFailureUrl(organizationId: string, error: AuthErrorType): string {
  const query = new URLSearchParams({ openai_error: error });
  return `/organizations/${organizationId}/byok?${query.toString()}`;
}

function createAppleAccountInfo(
  account: Account,
  user: NextUser | AdapterUser
): CreateOrUpdateUserArgs | null {
  if (account.provider !== 'apple') return null;
  assert(user.email, 'User email is required for Apple auth');

  return {
    google_user_email: user.email,
    google_user_name: user.name || user.email.split('@')[0],
    google_user_image_url: '',
    hosted_domain: hosted_domain_specials.apple,
    provider: account.provider,
    provider_account_id: account.providerAccountId,
    display_name: null,
  };
}

function createGitHubAccountInfo(
  account: Account,
  user: NextUser | AdapterUser,
  profile: Profile | undefined
): CreateOrUpdateUserArgs | null {
  if (account.provider !== 'github') return null;
  assert(user.email, 'User email is required for GitHub auth');
  assert(user.name, 'User name is required for GitHub auth');

  const githubProfile = profile as { login?: string } | undefined;
  const login = githubProfile?.login;
  const validLogin =
    login && /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(login) ? login : null;

  return {
    google_user_email: user.email,
    google_user_name: user.name || '',
    hosted_domain: hosted_domain_specials.github,
    google_user_image_url: user.image || '',
    provider: account.provider,
    provider_account_id: account.providerAccountId,
    display_name: validLogin,
  };
}

function createGitlabAccountInfo(
  account: Account,
  user: NextUser | AdapterUser
): CreateOrUpdateUserArgs | null {
  if (account.provider !== PLATFORM.GITLAB) return null;
  assert(user.email, 'User email is required for GitLab auth');
  assert(user.name, 'User name is required for GitLab auth');

  return {
    google_user_email: user.email,
    google_user_name: user.name || '',
    hosted_domain: hosted_domain_specials.gitlab,
    google_user_image_url: user.image || '',
    provider: account.provider,
    provider_account_id: account.providerAccountId,
    display_name: null, // TODO: populate with profile.username when GitLab auto-link is implemented
  };
}

function createLinkedInAccountInfo(
  account: Account,
  user: NextUser | AdapterUser
): CreateOrUpdateUserArgs | null {
  if (account.provider !== 'linkedin') return null;
  assert(user.email, 'User email is required for LinkedIn auth');
  assert(user.name, 'User name is required for LinkedIn auth');

  return {
    google_user_email: user.email,
    google_user_name: user.name || '',
    hosted_domain: hosted_domain_specials.linkedin,
    google_user_image_url: user.image || '',
    provider: account.provider,
    provider_account_id: account.providerAccountId,
    display_name: null, // LinkedIn OAuth response does not include the vanity URL slug needed to construct a profile link
  };
}

function createDiscordAccountInfo(
  account: Account,
  user: NextUser | AdapterUser
): CreateOrUpdateUserArgs | null {
  if (account.provider !== 'discord') return null;
  if (!user.email) return null;

  return {
    google_user_email: user.email,
    google_user_name: user.name || '',
    hosted_domain: hosted_domain_specials.discord,
    google_user_image_url: user.image || '',
    provider: account.provider as AuthProviderId,
    provider_account_id: account.providerAccountId,
    display_name: user.name || null,
  };
}

function createFakeAccountInfo(
  account: Account,
  user: NextUser | AdapterUser
): CreateOrUpdateUserArgs | null {
  if (account.provider !== 'fake-login') return null;
  assert(user.email, 'User email is required for fake login');
  assert(user.image, 'User image is required for fake login');
  assert(user.name, 'Fake login should make a fake name');

  return {
    google_user_email: user.email,
    google_user_name: user.name,
    google_user_image_url: user.image,
    hosted_domain: hosted_domain_specials.fake_devonly,
    provider: account.provider,
    provider_account_id: account.providerAccountId,
    display_name: null,
  };
}

function createSSOAccountInfo(
  account: Account,
  user: NextUser | AdapterUser,
  _profile: Profile | undefined
): CreateOrUpdateUserArgs | null {
  if (account.provider !== 'workos') return null;
  assert(user.email, 'User email is required for SSO auth');
  assert(user.name, 'User name is required for SSO auth');

  return {
    google_user_email: user.email,
    google_user_name: user.name || '',
    hosted_domain: getLowerDomainFromEmail(user.email) || '@@sso_unknown@@',
    google_user_image_url: user.image || '',
    provider: account.provider,
    provider_account_id: account.providerAccountId,
    display_name: null, // WorkOS SSO does not provide an upstream IdP profile URL
  };
}

/**
 * Parses a name from LinkedIn profile fields, ensuring it always returns a string.
 * This function guards against operator precedence bugs that could cause boolean values
 * to be returned instead of strings.
 *
 * @param profile - LinkedIn profile with name fields
 * @returns A string name, never a boolean
 */
export function parseLinkedInProfileName(profile: {
  name?: string;
  given_name?: string;
  family_name?: string;
}): string {
  return (
    profile.name ||
    (profile.given_name && profile.family_name
      ? `${profile.given_name} ${profile.family_name}`.trim()
      : profile.given_name || profile.family_name || 'LinkedIn User')
  );
}

/**
 * An OAuth/OIDC sign-in proves ownership of its email only when the provider
 * asserts the `email_verified` claim in the raw profile. Apple delivers the
 * claim as the string "true"; treat that as verified. Providers without the
 * claim (GitHub, GitLab, Discord) never prove the email here.
 */
export function profileProvesEmailOwnership(profile: unknown): boolean {
  const emailVerified = (profile as { email_verified?: unknown } | undefined)?.email_verified;
  return emailVerified === true || emailVerified === 'true';
}

function createEmailAccountInfo(
  account: Account,
  user: NextUser | AdapterUser
): CreateOrUpdateUserArgs | null {
  if (account.provider !== 'email') return null;
  assert(user.email, 'User email is required for email auth');

  // Extract the actual domain from the email address
  // This ensures admin detection works correctly for @kilocode.ai emails
  const emailDomain = user.email.split('@')[1];
  const hosted_domain = emailDomain || hosted_domain_specials.email;

  return {
    google_user_email: user.email,
    google_user_name: user.name || user.email.split('@')[0],
    google_user_image_url: user.image || '',
    hosted_domain,
    provider: account.provider,
    provider_account_id: user.email,
    display_name: null,
  };
}

/**
 * A passkey sign-in is resolved by its ticket, so the credentials `authorize`
 * returns the Kilo user id as the account id and this is the identity the
 * provider carries. A passkey never owns a `user_auth_provider` row: the
 * credential lives in `passkey_credentials`, keyed by user id.
 */
function createPasskeyAccountInfo(
  account: Account,
  user: NextUser | AdapterUser
): CreateOrUpdateUserArgs | null {
  if (account.provider !== 'passkey') return null;
  assert(user.email, 'User email is required for passkey auth');

  return {
    google_user_email: user.email,
    google_user_name: user.name || user.email.split('@')[0],
    google_user_image_url: user.image || '',
    // Never used for a passkey: the sign-in callback returns before user
    // settlement and the jwt callback resolves the account by user id without
    // rewriting its hosted domain.
    hosted_domain: getLowerDomainFromEmail(user.email) ?? null,
    provider: 'passkey',
    provider_account_id: account.providerAccountId,
    display_name: null,
  };
}

function createAccountInfo(
  account: Account,
  user: NextUser | AdapterUser,
  profile: Profile | undefined
): CreateOrUpdateUserArgs {
  const accountInfo =
    createGoogleAccountInfo(account, user, profile) ??
    createAnacondaAccountInfo(account, user) ??
    createOpenAiAccountInfo(account, user, profile) ??
    createAppleAccountInfo(account, user) ??
    createGitHubAccountInfo(account, user, profile) ??
    createGitlabAccountInfo(account, user) ??
    createLinkedInAccountInfo(account, user) ??
    createDiscordAccountInfo(account, user) ??
    createEmailAccountInfo(account, user) ??
    createPasskeyAccountInfo(account, user) ??
    createFakeAccountInfo(account, user) ??
    createSSOAccountInfo(account, user, profile);

  if (!accountInfo) {
    throw new Error(`Unsupported provider: ${account.provider}`);
  }

  return accountInfo;
}

export type SignInRedirectContext = {
  callbackPath?: string;
  signup?: boolean;
};

/**
 * Extracts the sign-in redirect context from the NextAuth callback-url cookie
 * value. Exported so the parsing logic can be tested without mocking the
 * next/headers cookie store.
 *
 * The NextAuth callback-url cookie holds the post-auth destination, e.g.
 * `/users/after-sign-in?callbackPath=/device-auth?code=<CODE>`. We lift
 * `callbackPath` and `signup` out so that bouncing back to `/users/sign_in`
 * on an auth error preserves the mobile device-auth context and the signup
 * UI mode the user originally requested.
 */
export function parseSignInRedirectContext(
  callbackUrlCookieValue: string | undefined
): SignInRedirectContext {
  if (!callbackUrlCookieValue) return {};

  let callbackUrl: URL;
  try {
    callbackUrl = new URL(callbackUrlCookieValue, 'http://localhost');
  } catch {
    return {};
  }

  const nestedCallbackPath = callbackUrl.searchParams.get('callbackPath')?.trim();
  const nestedSignup = callbackUrl.searchParams.get('signup') === 'true';

  return {
    callbackPath:
      nestedCallbackPath && isValidCallbackPath(nestedCallbackPath)
        ? nestedCallbackPath
        : undefined,
    signup: nestedSignup || undefined,
  };
}

async function getSignInRedirectContext(): Promise<SignInRedirectContext> {
  const cookieStore = await cookies();
  const raw =
    cookieStore.get('__Secure-next-auth.callback-url')?.value ??
    cookieStore.get('next-auth.callback-url')?.value;
  return parseSignInRedirectContext(raw);
}

async function getImpactTrackingContextFromAuthFlow(requestHeaders?: Headers): Promise<{
  affiliateTrackingId: string | null;
  trackingContext: CreateOrUpdateUserTrackingContext;
}> {
  const cookieStore = await cookies();

  const callbackUrlCookie =
    cookieStore.get('__Secure-next-auth.callback-url')?.value ??
    cookieStore.get('next-auth.callback-url')?.value;
  const cookieTrackingId = cookieStore.get(IMPACT_CLICK_ID_COOKIE)?.value?.trim() || null;

  if (callbackUrlCookie) {
    try {
      const callbackUrl = new URL(callbackUrlCookie, 'http://localhost');
      const referralTouch = parseImpactReferralTouchFromUrl(callbackUrl);
      const urlImRefParam = callbackUrl.searchParams.get('im_ref')?.trim() || null;
      const ignoreUrlImRefForReferralTouch = Boolean(
        referralTouch?.opaqueTrackingValue && urlImRefParam
      );
      const affiliateCookieFallbackUrl = new URL('http://localhost/users/after-sign-in');
      const callbackPath = callbackUrl.searchParams.get('callbackPath')?.trim();
      if (callbackPath) {
        affiliateCookieFallbackUrl.searchParams.set('callbackPath', callbackPath);
      }
      const affiliateTouch = ignoreUrlImRefForReferralTouch
        ? cookieTrackingId && cookieTrackingId !== urlImRefParam
          ? parseImpactAffiliateTouchFromUrl(affiliateCookieFallbackUrl, cookieTrackingId)
          : null
        : (parseImpactAffiliateTouchFromUrl(callbackUrl) ??
          (cookieTrackingId
            ? parseImpactAffiliateTouchFromUrl(affiliateCookieFallbackUrl, cookieTrackingId)
            : null));

      logImpactReferralDebug('Auth flow parsed Impact tracking context from callback URL cookie', {
        affiliateTouchPresent: Boolean(affiliateTouch),
        referralTouchPresent: Boolean(referralTouch),
        referralCookieValuePresent: Boolean(referralTouch?.opaqueTrackingValue),
        affiliateTrackingIdPresent: Boolean(affiliateTouch?.trackingId?.trim()),
        urlImRefParamPresent: Boolean(urlImRefParam),
        ignoredUrlImRefForReferralTouch: ignoreUrlImRefForReferralTouch,
        affiliateCookieFallbackPresent: Boolean(cookieTrackingId?.trim()),
        callbackPath: callbackUrl.pathname,
      });

      return {
        affiliateTrackingId: affiliateTouch?.trackingId ?? null,
        trackingContext: {
          affiliateTouch,
          referralTouch,
          locale: localeFromHeaders(requestHeaders),
          countryCode: countryCodeFromHeaders(requestHeaders),
        },
      };
    } catch {
      // fall through to cookie fallback
    }
  }

  const fallbackUrl = new URL('http://localhost/users/after-sign-in');
  const affiliateTouch = cookieTrackingId
    ? parseImpactAffiliateTouchFromUrl(fallbackUrl, cookieTrackingId)
    : null;

  logImpactReferralDebug('Auth flow parsed Impact tracking context from cookie fallback', {
    affiliateTouchPresent: Boolean(affiliateTouch),
    referralTouchPresent: false,
    affiliateTrackingIdPresent: Boolean(cookieTrackingId?.trim()),
    cookieTrackingIdLength: cookieTrackingId?.length ?? 0,
  });

  return {
    affiliateTrackingId: cookieTrackingId,
    trackingContext: {
      affiliateTouch,
      referralTouch: null,
      locale: localeFromHeaders(requestHeaders),
      countryCode: countryCodeFromHeaders(requestHeaders),
    },
  };
}

type ExtendedProfile = Profile & {
  isNewUser?: boolean; // Add isNewUser to the user type
  openAiChatGptOrganizationId?: string;
  /** Set when the authorization connected the organization's shared services. */
  openAiChatGptSharedServices?: boolean;
};

const posthogClient = PostHogClient();
const useSecureCookies = NEXTAUTH_URL?.startsWith('https://') ?? false;
const cookiePrefix = useSecureCookies ? '__Secure-' : '';

/**
 * OpenAI ("Sign in with ChatGPT") provider.
 *
 * The OAuth client's registered callback path is `/auth/openai/callback`
 * (`OPENAI_REDIRECT_PATH`). NextAuth rewrites a provider's `callbackUrl` to its
 * own `/api/auth/callback/<id>` at request time, so the registered path is
 * declared on the openid-client metadata (`client.redirect_uris`) for the
 * authorization request and repeated explicitly when the code is exchanged.
 * `callbackUrl` is kept because it names the registered path the route serves.
 */
const openAiProvider: OAuthConfig<Profile> & { callbackUrl: string } = {
  id: 'openai',
  name: 'ChatGPT',
  type: 'oauth',
  wellKnown: OPENAI_DISCOVERY_URL,
  issuer: OPENAI_ISSUER,
  idToken: true,
  checks: ['pkce', 'state', 'nonce'],
  client: {
    token_endpoint_auth_method: 'client_secret_basic',
    redirect_uris: [OPENAI_REDIRECT_URI],
  },
  clientId: OPENAI_CLIENT_ID,
  clientSecret: OPENAI_CLIENT_SECRET,
  callbackUrl: OPENAI_REDIRECT_URI,
  authorization: { params: { scope: OPENAI_IDENTITY_SCOPE, resource: OPENAI_RESOURCE } },
  token: {
    params: { resource: OPENAI_RESOURCE },
    // openid-client builds the code exchange from a fixed field set and drops
    // the resource, so an authorization that requested a resource is redeemed
    // without one and OpenAI rejects it with `invalid_grant`. `exchangeBody`
    // merges the resource back into the same token request.
    request: async ({ params, checks, client }) => ({
      tokens: await client.callback(OPENAI_REDIRECT_URI, params, checks, {
        exchangeBody: { resource: OPENAI_RESOURCE },
      }),
    }),
  },
  profile: parseOpenAiProfile,
};

export const authOptions: NextAuthOptions = {
  ...sessionAuthOptions,
  cookies: {
    // Apple Sign In uses response_mode=form_post, which is a cross-site POST
    // from appleid.apple.com. SameSite=Lax (the default) cookies are not sent
    // on cross-site POSTs, so the PKCE code_verifier cookie gets dropped.
    pkceCodeVerifier: {
      name: `${cookiePrefix}next-auth.pkce.code_verifier`,
      options: {
        httpOnly: true,
        sameSite: 'none',
        path: '/',
        secure: true,
      },
    },
  },
  providers: [
    GoogleProvider({
      clientId: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
    }),
    openAiProvider,
    {
      id: 'anaconda',
      name: 'Anaconda',
      type: 'oauth',
      issuer: 'https://auth.anaconda.com/api/auth',
      wellKnown: 'https://anaconda.com/.well-known/openid-configuration',
      authorization: {
        params: { scope: 'openid profile email' },
      },
      idToken: true,
      checks: ['pkce', 'state', 'nonce'],
      client: {
        token_endpoint_auth_method: 'client_secret_post',
      },
      clientId: ANACONDA_CLIENT_ID,
      clientSecret: ANACONDA_CLIENT_SECRET,
      profile: parseAnacondaProfile,
    },
    AppleProvider({
      clientId: APPLE_CLIENT_ID ?? '',
      clientSecret: generateAppleClientSecret(),
    }),
    GithubProvider({
      clientId: GITHUB_CLIENT_ID,
      clientSecret: GITHUB_CLIENT_SECRET,
    }),
    GitlabProvider({
      clientId: GITLAB_CLIENT_ID,
      clientSecret: GITLAB_CLIENT_SECRET,
    }),
    DiscordProvider({
      clientId: DISCORD_OAUTH_CLIENT_ID ?? '',
      clientSecret: DISCORD_OAUTH_CLIENT_SECRET ?? '',
    }),
    LinkedInProvider({
      clientId: LINKEDIN_CLIENT_ID,
      clientSecret: LINKEDIN_CLIENT_SECRET,
      issuer: 'https://www.linkedin.com/oauth',
      wellKnown: 'https://www.linkedin.com/oauth/.well-known/openid-configuration',
      client: {
        token_endpoint_auth_method: 'client_secret_post',
      },
      authorization: {
        params: {
          scope: 'openid profile email',
        },
      },
      userinfo: {
        // Use OpenID Connect userinfo endpoint instead of legacy REST API
        url: 'https://api.linkedin.com/v2/userinfo',
      },
      profile(profile) {
        // LinkedIn OpenID Connect returns profile in this format
        const email = profile.email || profile.email_address;
        const name = parseLinkedInProfileName(profile);
        const picture = profile.picture || profile.profile_picture;

        return {
          id: profile.sub,
          email: email,
          name: name,
          image: picture,
        };
      },
    }),
    WorkOSProvider({
      clientId: WORKOS_CLIENT_ID,
      clientSecret: WORKOS_API_KEY,
      client: {
        token_endpoint_auth_method: 'client_secret_post',
      },
    }),
    // Email provider for magic link authentication using CredentialsProvider
    // We use CredentialsProvider because EmailProvider requires a database adapter,
    // but we're using JWT sessions without an adapter
    CredentialsProvider({
      id: 'email',
      name: 'Email',
      credentials: {
        token: { label: 'Token', type: 'text' },
      },
      async authorize(credentials) {
        if (!credentials?.token) {
          return null;
        }

        const tokenData = await verifyAndConsumeMagicLinkToken(credentials.token);

        if (!tokenData) {
          return null;
        }

        return {
          id: `email-${tokenData.email}`,
          email: tokenData.email,
          name: tokenData.email.split('@')[0],
          image: '',
        };
      },
    }),
    // Passkey sign-in. The authenticate route verifies the WebAuthn assertion
    // against a server-stored challenge and mints a one-time ticket; redeeming
    // that ticket here is the identity proof, so `authorize` only exchanges it.
    CredentialsProvider({
      id: 'passkey',
      name: 'Passkey',
      credentials: {
        ticket: { label: 'Ticket', type: 'text' },
      },
      async authorize(credentials) {
        if (!credentials?.ticket) {
          return null;
        }

        const ticket = await consumeSignInTicket(credentials.ticket);
        if (!ticket) {
          // Unknown, expired, or already redeemed: a replayed ticket yields no
          // user, so NextAuth mints no session for it.
          return null;
        }

        const user = await findUserById(ticket.kilo_user_id);
        if (!user) {
          return null;
        }

        return {
          id: user.id,
          email: user.google_user_email,
          name: user.google_user_name || user.google_user_email.split('@')[0],
          image: user.google_user_image_url,
        };
      },
    }),
    // Fake login provider for development and testing
    ...(allow_fake_login
      ? [
          CredentialsProvider({
            id: 'fake-login',
            name: 'Fake Login',
            credentials: {
              email: { label: 'Email', type: 'email' },
            },
            async authorize(credentials) {
              console.log('Fake login attempt', credentials?.email);
              return !credentials?.email
                ? null
                : {
                    id: `fake-${credentials.email}`,
                    email: credentials.email,
                    name: credentials.email.split('@')[0],
                    image:
                      'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="beige"/><circle cx="16" cy="12" r="5" fill="red"/><path d="M6 26c0-5.5 4.5-10 10-10s10 4.5 10 10" fill="blue"/></svg>',
                  };
            },
          }),
        ]
      : []),
  ],
  callbacks: {
    ...sessionAuthOptions.callbacks,
    // NOTE(bmc): Errors thrown from this function have their messages sent to the client.
    // Realistically the entire thing should be wrapped in a try/catch and handle errors appropriately.
    // any string returned from here is a redirect URL and returning "true" is considered a successful login.
    // next-auth is...special.
    async signIn({ user, account, profile }) {
      let accountInfo: CreateOrUpdateUserArgs | undefined;
      let isAccountLinking: boolean | null = null;
      let linkingSession: AccountLinkingSession | null = null;
      const redirectContext = await getSignInRedirectContext();
      const redirectUrlForCode = (error: AuthErrorType): string => {
        const redirectUrl = new URL(
          authFailureRedirectUrl(error, Boolean(isAccountLinking)),
          'http://localhost'
        );
        if (!isAccountLinking) {
          if (redirectContext.callbackPath) {
            redirectUrl.searchParams.set('callbackPath', redirectContext.callbackPath);
          }
          if (redirectContext.signup) {
            redirectUrl.searchParams.set('signup', 'true');
          }
        }
        return `${redirectUrl.pathname}?${redirectUrl.searchParams.toString()}`;
      };
      try {
        if (!account) return `TRAP: No account found`;

        // early return for fake auth
        const isFakeLogin = account.provider === 'fake-login';
        if (isFakeLogin && !allow_fake_login)
          return 'Fake login is not available in production mode';

        // early return for email auth (magic link)
        const isEmailAuth = account.provider === 'email';

        // normalize the account, user, and profile objects into a single object
        // why does next-auth have 3 separate objects for this? who knows.
        accountInfo = createAccountInfo(account, user, profile);

        linkingSession = await getAccountLinkingSession();

        isAccountLinking = linkingSession && linkingSession.targetProvider === accountInfo.provider;

        // The linking session is consumed here, so it carries the organization
        // through to the jwt callback on the profile, the same way `isNewUser`
        // travels. Only an OpenAI link stores an organization-scoped
        // connection, so the session must have targeted OpenAI.
        if (
          account.provider === 'openai' &&
          linkingSession?.targetProvider === 'openai' &&
          linkingSession.organizationId &&
          profile
        ) {
          (profile as ExtendedProfile).openAiChatGptOrganizationId = linkingSession.organizationId;
          if (linkingSession.chatGptScope === 'shared_services') {
            (profile as ExtendedProfile).openAiChatGptSharedServices = true;
          }
        }

        // if a user's email domain matches any organization's SSO domain and they are not logging in with SSO, force them to use SSO immediately
        const domain = getLowerDomainFromEmail(accountInfo.google_user_email);

        if (!domain) {
          return redirectUrlForCode('USER-NOT-FOUND');
        }

        if (await isEmailBlacklistedByDomainAsync(accountInfo.google_user_email)) {
          sentryLogger('auth', 'warning')(
            `SECURITY: Blacklisted: ${accountInfo.google_user_email}`,
            accountInfo
          );

          return redirectUrlForCode(`BLOCKED`);
        }

        let domainToCheck = domain;

        // Check if this is an existing user with a different primary email
        const existingUser = await findAndSyncExistingUser(accountInfo);

        if (existingUser?.blocked_reason) {
          return redirectUrlForCode('BLOCKED');
        }

        // Block new signups from blocked TLDs (existing users can still sign in)
        if (!existingUser && isBlockedTLD(accountInfo.google_user_email)) {
          return redirectUrlForCode(`BLOCKED`);
        }

        if (existingUser) {
          const primaryEmailDomain = getLowerDomainFromEmail(existingUser.google_user_email);
          if (primaryEmailDomain) {
            domainToCheck = primaryEmailDomain;
          }
        }

        // we don't need to check gmail domains for SSO for now.
        // This is mostly an optimization so we don't hit the DB on every gmail login since they defacto aren't using SSO
        //
        // Account linking is not a sign-in: the person is already
        // authenticated and is only attaching another provider. Enforcing the
        // domain SSO policy here would redirect them to the sign-in page and
        // abort the link, so a BYOK connection (for example "Sign in with
        // ChatGPT") would never be stored for an SSO-protected domain.
        if (domainToCheck !== 'gmail.com' && !isAccountLinking) {
          // Fake login is intentionally exempt in supported non-production environments.
          if (accountInfo.provider !== 'workos' && accountInfo.provider !== 'fake-login') {
            const ssoAuthority = await resolveSsoAuthorityForDomain(domainToCheck);
            if (ssoAuthority.status === 'misconfigured') {
              warnInSentry('SSO authority is misconfigured', {
                extra: { domain: domainToCheck, reason: ssoAuthority.reason },
              });
              return redirectUrlForCode('UNKNOWN-ERROR');
            }
            if (ssoAuthority.status === 'required') {
              return ssoSignInRedirectUrl(domainToCheck);
            }
          }
        }

        // A redeemed passkey ticket already proved identity, so a passkey skips
        // both Turnstile and user settlement. This return sits after the domain
        // blacklist and SSO-authority checks above, so a passkey can never
        // bypass a domain that enforces SSO. No `user_auth_provider` row is
        // written for a passkey: the jwt callback resolves it by user id.
        if (accountInfo.provider === 'passkey') {
          return true;
        }

        const requestHeaders = await headers();

        if (accountInfo.provider === 'workos') {
          const { affiliateTrackingId, trackingContext } = !isAccountLinking
            ? await getImpactTrackingContextFromAuthFlow(requestHeaders)
            : { affiliateTrackingId: null, trackingContext: {} };

          logImpactReferralDebug(
            'Auth flow forwarding Impact tracking context to SSO user upsert',
            {
              provider: accountInfo.provider,
              affiliateTrackingIdPresent: Boolean(affiliateTrackingId?.trim()),
              affiliateTouchPresent: Boolean(trackingContext.affiliateTouch),
              referralTouchPresent: Boolean(trackingContext.referralTouch),
            }
          );

          return processSSOUserLogin(
            accountInfo,
            requestHeaders,
            affiliateTrackingId,
            trackingContext
          );
        }

        // Validate Turnstile JWT for real OAuth logins (not fake logins or email auth)
        let verifiedToken: TurnstileJwtPayload | null = null;
        if (!isFakeLogin && !isEmailAuth && !isAccountLinking) {
          const userCookies = await cookies();
          const turnstileJwtCookie = userCookies.get('turnstile_jwt');
          userCookies.delete('turnstile_jwt');

          if (!turnstileJwtCookie?.value) {
            warnInSentry('SECURITY: Missing Turnstile verification token');
            return redirectUrlForCode('TURNSTILE_REQUIRED');
          }

          try {
            verifiedToken = jwt.verify(turnstileJwtCookie.value, NEXTAUTH_SECRET, {
              algorithms: ['HS256'],
            }) as unknown as TurnstileJwtPayload;
          } catch (error) {
            sentryLogger('turnstile-auth')(
              'SECURITY: Invalid Turnstile JWT : ' +
                (error instanceof Error ? error.message : String(error)),
              accountInfo
            );
            return redirectUrlForCode('INVALID_VERIFICATION');
          }

          const currentIP = requestHeaders.get('x-forwarded-for');
          if (verifiedToken.ip !== currentIP) {
            sentryLogger('turnstile-auth')(
              `SECURITY: IP mismatch - JWT: ${verifiedToken.ip}, Current: ${currentIP}`,
              accountInfo
            );
            return redirectUrlForCode('IP_MISMATCH');
          }

          console.log(`Turnstile verification validated`, accountInfo);
        }

        // Check if this is an account linking operation
        // Auto-link only when the credential proves ownership of the email:
        // a magic link consumes an inbox token; fake-login is dev-only; an
        // OAuth profile proves it via the provider's email_verified claim.
        // Methods without proof keep the DIFFERENT-OAUTH refusal.
        const autoLinkToExistingUser =
          isEmailAuth || isFakeLogin || profileProvesEmailOwnership(profile);
        if (isAccountLinking) {
          logImpactReferralDebug('Auth flow skipped Impact tracking context extraction', {
            provider: accountInfo.provider,
            isAccountLinking: Boolean(isAccountLinking),
            isFakeLogin,
          });
        }

        const { affiliateTrackingId, trackingContext } = !isAccountLinking
          ? await getImpactTrackingContextFromAuthFlow(requestHeaders)
          : { affiliateTrackingId: null, trackingContext: {} };

        logImpactReferralDebug('Auth flow forwarding Impact tracking context to user upsert', {
          provider: accountInfo.provider,
          affiliateTrackingIdPresent: Boolean(affiliateTrackingId?.trim()),
          affiliateTouchPresent: Boolean(trackingContext.affiliateTouch),
          referralTouchPresent: Boolean(trackingContext.referralTouch),
        });
        const result =
          isAccountLinking && linkingSession
            ? whenOk(
                await linkAccountToExistingUser(linkingSession.existingUserId, accountInfo),
                v => ({ ...v, isNew: false })
              )
            : await createOrUpdateUser(
                accountInfo,
                verifiedToken?.guid,
                autoLinkToExistingUser,
                requestHeaders,
                affiliateTrackingId,
                trackingContext
              );

        if (result.success === false) {
          // Expected user errors that shouldn't be logged to Sentry
          const expectedErrors: AuthErrorType[] = [
            'ACCOUNT-ALREADY-LINKED',
            'PROVIDER-ALREADY-LINKED',
            'DIFFERENT-OAUTH',
            'SIGNUP-RATE-LIMITED',
            'EMAIL-ALREADY-USED',
          ];

          // Only log unexpected errors to Sentry
          if (!expectedErrors.includes(result.error)) {
            sentryLogger('auth-linking', 'error')(
              `[AUTH][signIn] Operation failed: ${result.error}`,
              {
                isAccountLinking,
                provider: accountInfo.provider,
                email: accountInfo.google_user_email,
              }
            );
          }
          return redirectUrlForCode(result.error);
        }

        if (result.user.blocked_reason) {
          return redirectUrlForCode(`BLOCKED`);
        }

        // The link start authorized the connect, but the authorization can be
        // consented to after that role is revoked: the callback re-reads the
        // current membership before the jwt callback stores the organization's
        // shared-services connection, and a refusal returns to the card that
        // started the connect instead of failing silently.
        if (
          account.provider === 'openai' &&
          linkingSession?.targetProvider === 'openai' &&
          linkingSession.chatGptScope === 'shared_services' &&
          linkingSession.organizationId &&
          !(await mayConnectOpenAiChatGptSharedServices(result.user, linkingSession.organizationId))
        ) {
          return openAiChatGptConnectFailureUrl(linkingSession.organizationId, 'LINKING-FAILED');
        }

        if (!isAccountLinking && autoLinkToExistingUser) {
          await ensureVerifiedDomainOrganizationMembership(result.user.id);
        }

        // NOTE(bmc): this is sad but its here for a reason, don't change it
        if (profile) {
          const extendedProfile = profile as ExtendedProfile;
          // mutate the profile to track if its new (only for new user registrations)
          extendedProfile.isNewUser = 'isNew' in result ? result.isNew : false; // Add isNewUser to the profile
        }
        return true;
      } catch (error) {
        const operation = isAccountLinking ? 'account_linking' : 'user_creation';
        console.error(`[AUTH][${operation}] Unexpected error:`, error);
        captureException(error, {
          tags: {
            operation,
            provider: accountInfo?.provider,
          },
          extra: {
            ...accountInfo,
            isAccountLinking,
            linkingSession,
          },
        });
        if (accountInfo)
          posthogClient.capture({
            distinctId: accountInfo.google_user_email,
            event: operation + '_failed',
            properties: {
              error: error instanceof Error ? error.message : String(error),
              email: accountInfo.google_user_email,
              name: accountInfo.google_user_name,
              hosted_domain: accountInfo.hosted_domain,
              isAccountLinking,
            },
          });

        // Clear linking session if it was an account linking attempt
        return redirectUrlForCode('UNKNOWN-ERROR');
      }
    },
    async jwt({ token, account, user, trigger, profile }) {
      let accountInfo: CreateOrUpdateUserArgs | undefined = undefined;
      try {
        if (!trigger) return token;
        if (!account) throw new Error(`TRAP: No account found: ${trigger}`);

        accountInfo = createAccountInfo(account, user, profile);
        const existingUser = await findAndSyncExistingUser(accountInfo);

        assert(existingUser, `TRAP: No existing user found for ${accountInfo.google_user_email}`);

        token.kiloUserId = existingUser.id;

        // The ChatGPT authorization carries the delegated tokens that are the
        // OpenAI BYOK credential; store them on the same flow that signs in.
        if (account.provider === 'openai' && account.access_token) {
          await persistOpenAiChatGptConnection(existingUser.id, account, profile);
        }

        token.version = JWT_TOKEN_VERSION;
        token.exp = Math.floor(Date.now() / 1000) + secondsInDay * 30;
        token.iat = Math.floor(Date.now() / 1000);
        token.isNewUser = (profile as ExtendedProfile)?.isNewUser || false;
        token.webSessionPepper = existingUser.web_session_pepper;
        token.isAdmin = existingUser.is_admin;
        token.authProvider = accountInfo.provider;
        token.authenticatedAt = token.iat;
        delete token.ssoSourceOrganizationId;

        if (accountInfo.provider === 'workos') {
          const domain = getLowerDomainFromEmail(existingUser.google_user_email);
          assert(domain, 'WorkOS user must have a valid primary email domain');
          const ssoAuthority = await resolveSsoAuthorityForDomain(domain);
          assert(
            ssoAuthority.status === 'required',
            `WorkOS user does not have one active SSO authority for ${domain}`
          );
          token.ssoSourceOrganizationId = ssoAuthority.sourceOrganizationId;
        }

        if (existingUser.is_admin) {
          // Admin audit trail: identify which Kilocode admin authenticated.
          // Emitted only after JWT creation is guaranteed to succeed.
          logExceptInTest(
            JSON.stringify({
              event: 'admin_login_succeeded',
              kiloUserId: existingUser.id,
              email: existingUser.google_user_email,
              provider: accountInfo.provider,
              adminTier: existingUser.is_super_admin ? 'super_admin' : 'platform_admin',
            })
          );
        }
      } catch (error) {
        captureException(error, {
          tags: {
            operation: 'user_sync_jwt',
            provider: accountInfo?.provider,
          },
          extra: accountInfo,
        });

        console.error('Failed to create or update user JWT:', error);
        throw error;
      }
      return token;
    },
  },
};

export const nextAuthHttpHandler = NextAuth(authOptions);
