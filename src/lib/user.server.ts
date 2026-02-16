import { getEnvVariable } from '@/lib/dotenvx';
import 'server-only';
import { validateAuthorizationHeader, JWT_TOKEN_VERSION } from './tokens';
import { NextResponse } from 'next/server';
import { cookies, headers } from 'next/headers';
import type { CreateOrUpdateUserArgs } from './user';
import { findUserById, createOrUpdateUser, findAndSyncExistingUser } from './user';
import { db, readDb } from '@/lib/drizzle';
import type {
  NextAuthOptions,
  JWT,
  Account,
  User as NextUser,
  Profile,
  LoggerInstance,
} from 'next-auth';
import NextAuth, { getServerSession } from 'next-auth';
import type { GoogleProfile } from 'next-auth/providers/google';
import GoogleProvider from 'next-auth/providers/google';
import GithubProvider from 'next-auth/providers/github';
import GitlabProvider from 'next-auth/providers/gitlab';
import LinkedInProvider from 'next-auth/providers/linkedin';
import WorkOSProvider from 'next-auth/providers/workos';
import CredentialsProvider from 'next-auth/providers/credentials';
import { allow_fake_login, ORGANIZATION_ID_HEADER } from './constants';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { verifyAndConsumeMagicLinkToken } from '@/lib/auth/magic-link-tokens';
import { redirect } from 'next/navigation';
import { isOrganizationHardLocked } from '@/lib/organizations/trial-utils';
import { secondsInDay } from 'date-fns/constants';
import type { AdapterUser } from 'next-auth/adapters';
import assert from 'node:assert';
import type { Organization, User } from '@/db/schema';
import PostHogClient from '@/lib/posthog';
import { captureException } from '@sentry/nextjs';
import {
  doesOrgWithSSODomainExist,
  getSingleUserOrganization,
  isOrganizationMember,
} from '@/lib/organizations/organizations';
import type { AccountLinkingSession } from '@/lib/account-linking-session';
import { getAccountLinkingSession } from '@/lib/account-linking-session';
import { linkAccountToExistingUser } from '@/lib/user';
import type { FailureResult } from '@/lib/maybe-result';
import { failureResult, whenOk } from '@/lib/maybe-result';
import type { AuthErrorType } from '@/lib/auth/constants';
import { hosted_domain_specials, SSO_SIGNIN_PATH } from '@/lib/auth/constants';
import {
  GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  LINKEDIN_CLIENT_ID,
  LINKEDIN_CLIENT_SECRET,
  WORKOS_API_KEY,
  WORKOS_CLIENT_ID,
  NEXTAUTH_SECRET,
  GITLAB_CLIENT_ID,
  GITLAB_CLIENT_SECRET,
} from '@/lib/config.server';
import jwt from 'jsonwebtoken';
import type { UUID } from 'node:crypto';
import { logExceptInTest, sentryLogger } from '@/lib/utils.server';
import { processSSOUserLogin } from '@/lib/sso-user';
import { getLowerDomainFromEmail } from '@/lib/utils';
import { z } from 'zod';
import { v5 as uuidv5 } from 'uuid';

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

const blacklistDomainsEnv = getEnvVariable('BLACKLIST_DOMAINS');
const BLACKLIST_DOMAINS = blacklistDomainsEnv
  ? blacklistDomainsEnv.split('|').map((domain: string) => domain.trim())
  : [];

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
  };
}

function createGitHubAccountInfo(
  account: Account,
  user: NextUser | AdapterUser
): CreateOrUpdateUserArgs | null {
  if (account.provider !== 'github') return null;
  assert(user.email, 'User email is required for GitHub auth');
  assert(user.name, 'User name is required for GitHub auth');

  return {
    google_user_email: user.email,
    google_user_name: user.name || '',
    hosted_domain: hosted_domain_specials.github,
    google_user_image_url: user.image || '',
    provider: account.provider,
    provider_account_id: account.providerAccountId,
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
  };
}

function createAccountInfo(
  account: Account,
  user: NextUser | AdapterUser,
  profile: Profile | undefined
): CreateOrUpdateUserArgs {
  const accountInfo =
    createGoogleAccountInfo(account, user, profile) ??
    createGitHubAccountInfo(account, user) ??
    createGitlabAccountInfo(account, user) ??
    createLinkedInAccountInfo(account, user) ??
    createEmailAccountInfo(account, user) ??
    createFakeAccountInfo(account, user) ??
    createSSOAccountInfo(account, user, profile);

  if (!accountInfo) {
    throw new Error(`Unsupported provider: ${account.provider}`);
  }

  return accountInfo;
}

type ExtendedProfile = Profile & {
  isNewUser?: boolean; // Add isNewUser to the user type
};

const posthogClient = PostHogClient();
const logger: LoggerInstance = {
  debug: logExceptInTest,
  warn: sentryLogger('NEXTAUTH', 'warning'),
  error: sentryLogger('NEXTAUTH', 'error'),
};

const authOptions: NextAuthOptions = {
  secret: NEXTAUTH_SECRET,
  providers: [
    GoogleProvider({
      clientId: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
    }),
    GithubProvider({
      clientId: GITHUB_CLIENT_ID,
      clientSecret: GITHUB_CLIENT_SECRET,
    }),
    GitlabProvider({
      clientId: GITLAB_CLIENT_ID,
      clientSecret: GITLAB_CLIENT_SECRET,
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
        email: { label: 'Email', type: 'email' },
        token: { label: 'Token', type: 'text' },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.token) {
          return null;
        }

        const tokenData = await verifyAndConsumeMagicLinkToken(credentials.token);

        if (!tokenData || tokenData.email !== credentials.email) {
          return null;
        }

        return {
          id: `email-${credentials.email}`,
          email: credentials.email,
          name: credentials.email.split('@')[0],
          image: '',
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
              console.log('Fake login attempt', credentials);
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
  logger, // Surfacing NextAuth internal logs/errors for diagnostics
  callbacks: {
    // NOTE(bmc): Errors thrown from this function have their messages sent to the client.
    // Realistically the entire thing should be wrapped in a try/catch and handle errors appropriately.
    // any string returned from here is a redirect URL and returning "true" is considered a successful login.
    // next-auth is...special.
    async signIn({ user, account, profile }) {
      let accountInfo: CreateOrUpdateUserArgs | undefined;
      let isAccountLinking: boolean | null = null;
      let linkingSession: AccountLinkingSession | null = null;
      const redirectUrlForCode = (error: AuthErrorType, email?: string): string => {
        const baseUrl = isAccountLinking ? '/connected-accounts' : '/users/sign_in';
        const params = new URLSearchParams({ error });
        if (email) {
          params.set('email', email);
        }
        return `${baseUrl}?${params.toString()}`;
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

        // if a user's email domain matches any organization's SSO domain and they are not logging in with SSO, force them to use SSO immediately
        const domain = getLowerDomainFromEmail(accountInfo.google_user_email);

        if (!domain) {
          return redirectUrlForCode('USER-NOT-FOUND', accountInfo.google_user_email);
        }

        if (isEmailBlacklistedByDomain(accountInfo.google_user_email)) {
          sentryLogger('auth', 'warning')(
            `SECURITY: Blacklisted: ${accountInfo.google_user_email}`,
            accountInfo
          );

          return redirectUrlForCode(`BLOCKED`, accountInfo.google_user_email);
        }

        let domainToCheck = domain;

        // Check if this is an existing user with a different primary email
        const existingUser = await findAndSyncExistingUser(accountInfo);
        if (existingUser) {
          const primaryEmailDomain = getLowerDomainFromEmail(existingUser.google_user_email);
          if (primaryEmailDomain) {
            domainToCheck = primaryEmailDomain;
          }
        }

        // we don't need to check gmail domains for SSO for now.
        // This is mostly an optimization so we don't hit the DB on every gmail login since they defacto aren't using SSO
        if (domainToCheck !== 'gmail.com') {
          // if you're logging in with NOT workos but you belong to a domain with SSO you need to go back through the SSO login flow
          // Exclude fake-login from SSO checks - it should always work regardless of domain configuration
          const redir =
            accountInfo.provider != 'workos' &&
            accountInfo.provider != 'fake-login' &&
            (await doesOrgWithSSODomainExist(domainToCheck));

          if (redir) {
            // Include email in redirect so it can be auto-filled on SSO sign-in page
            const emailParam = accountInfo.google_user_email
              ? `&email=${encodeURIComponent(accountInfo.google_user_email)}`
              : '';
            return SSO_SIGNIN_PATH + `?domain=${encodeURIComponent(domainToCheck)}${emailParam}`; // redirect to SSO sign-in page
          }
        }

        if (accountInfo.provider === 'workos') {
          return processSSOUserLogin(accountInfo);
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

          const currentIP = (await headers()).get('x-forwarded-for');
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
        // For email (magic link) auth, we auto-link to existing users since magic link
        // is verified by email ownership
        const autoLinkToExistingUser = isEmailAuth || isFakeLogin;
        const result =
          isAccountLinking && linkingSession
            ? whenOk(
                await linkAccountToExistingUser(linkingSession.existingUserId, accountInfo),
                v => ({ ...v, isNew: false })
              )
            : await createOrUpdateUser(accountInfo, verifiedToken?.guid, autoLinkToExistingUser);

        if (result.success === false) {
          // Expected user errors that shouldn't be logged to Sentry
          const expectedErrors: AuthErrorType[] = [
            'ACCOUNT-ALREADY-LINKED',
            'PROVIDER-ALREADY-LINKED',
            'DIFFERENT-OAUTH',
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
          return redirectUrlForCode(result.error, accountInfo.google_user_email);
        }

        if (result.user.blocked_reason) {
          return redirectUrlForCode(`BLOCKED`);
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

        token.version = JWT_TOKEN_VERSION;
        token.exp = Math.floor(Date.now() / 1000) + secondsInDay * 30;
        token.iat = Math.floor(Date.now() / 1000);
        token.isNewUser = (profile as ExtendedProfile)?.isNewUser || false;
        token.pepper = existingUser.api_token_pepper;
        token.isAdmin = existingUser.is_admin;
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
    async session({ session, token }) {
      const castToken = token as unknown as JWT;
      session.user.id = castToken.sub;
      session.isAdmin = castToken.isAdmin || false; // Ensure isAdmin is always defined
      session.kiloUserId = castToken.kiloUserId;
      session.pepper = castToken.pepper;
      session.isNewUser = castToken.isNewUser || false; // Pass isNewUser to the session
      return session;
    },
  },
  pages: {
    signIn: '/users/sign_in',
    error: '/users/sign_in',
  },
  debug: !!getEnvVariable('DEBUG_AUTH'),
};

export const nextAuthHttpHandler = NextAuth(authOptions);

export type RequiredPermissions = {
  adminOnly: boolean;
  DANGEROUS_allowBlockedUsers?: boolean;
};

type GetAuthResponse =
  | {
      user: null;
      authFailedResponse: NextResponse<FailureResult<string>>;
      isNewUser?: undefined;
      organizationId?: undefined;
      internalApiUse?: undefined;
    }
  | {
      user: User;
      authFailedResponse: null;
      isNewUser?: boolean;
      organizationId?: Organization['id'];
      internalApiUse?: boolean;
    };

export async function getUserFromAuth(opts: RequiredPermissions): Promise<GetAuthResponse> {
  const headersList = await headers();

  // This path is executed for non-next-auth requests
  // all calls from the extension including the openrouter proxy call use this auth method
  // also val.town and other blessed API users who are given their own custom JWTs use this path
  if (headersList.get('Authorization')) {
    const authorizationValidationResult = validateAuthorizationHeader(headersList);
    if (authorizationValidationResult.error != undefined) {
      return authError(401, authorizationValidationResult.error, '?');
    }

    const user = await findUserById(authorizationValidationResult.kiloUserId, readDb);

    if (
      user?.api_token_pepper &&
      user.api_token_pepper !== authorizationValidationResult.apiTokenPepper
    ) {
      return authError(401, 'Invalid API token', user.id);
    }

    const organizationId = headersList.get(ORGANIZATION_ID_HEADER) || undefined;
    const internalApiUse = authorizationValidationResult.internalApiUse;

    return await validateUserAuthorization(
      authorizationValidationResult.kiloUserId,
      user,
      opts,
      false,
      organizationId,
      internalApiUse,
      readDb
    );
  }

  const session = await getServerSession(authOptions);
  const maybeKiloUserId = session?.kiloUserId;

  if (!maybeKiloUserId) return authError(401, 'Unauthorized', '?');

  const user = await findUserById(maybeKiloUserId, readDb);
  if (!user) return authError(401, 'Unauthorized (D)', maybeKiloUserId);

  if (user.api_token_pepper != session.pepper)
    return authError(401, 'Reauthentication required', maybeKiloUserId);

  // NOTE: we currently do not thread organization id through here as its only used for extension-originated requests
  return await validateUserAuthorization(
    maybeKiloUserId,
    user,
    opts,
    session.isNewUser,
    undefined,
    undefined,
    readDb
  );
}

export async function getUserFromAuthOrRedirect(loggedOutRedirectUrl: string): Promise<User> {
  const { user } = await getUserFromAuth({ adminOnly: false, DANGEROUS_allowBlockedUsers: true });
  if (!user) {
    redirect(loggedOutRedirectUrl);
  }
  if (user.blocked_reason) {
    redirect('/account-blocked');
  }
  return user;
}

function authError(status: number, error: string, kiloUserId: string) {
  console.warn(`AUTH-FAIL ${status} (${kiloUserId}): ${error}`);
  return { user: null, authFailedResponse: NextResponse.json(failureResult(error), { status }) };
}

async function validateUserAuthorization(
  kiloUserId: string,
  user: User | undefined,
  opts: RequiredPermissions,
  isNewUser?: boolean,
  organizationId?: Organization['id'],
  internalApiUse?: boolean,
  fromDb: typeof db = db
): Promise<GetAuthResponse> {
  if (!user) {
    return authError(401, 'User not found', kiloUserId);
  } else if (isUserBlacklistedByDomain(user)) {
    return authError(403, 'Access denied (R0)', kiloUserId);
  } else if (!opts.DANGEROUS_allowBlockedUsers && user.blocked_reason) {
    return report_blocked_user(kiloUserId);
  } else if (opts.adminOnly && !user.is_admin) {
    return authError(403, 'Access denied (nonadmin)', kiloUserId);
  }

  if (organizationId) {
    const uuidResult = uuid.safeParse(organizationId);
    if (!uuidResult.success) {
      return authError(400, 'Invalid organization ID format', kiloUserId);
    }
    const isMember = await isOrganizationMember(organizationId, kiloUserId, fromDb);
    if (!isMember) {
      return authError(403, 'Access denied (not a member of the organization)', kiloUserId);
    }
  }

  return { user, authFailedResponse: null, isNewUser, organizationId, internalApiUse };
}

export const isUserBlacklistedByDomain = (existingUser: Pick<User, 'google_user_email'>) =>
  isEmailBlacklistedByDomain(existingUser.google_user_email);

export const isEmailBlacklistedByDomain = (
  email: string,
  blacklisted_domains = BLACKLIST_DOMAINS
) =>
  blacklisted_domains?.some(
    domain =>
      email.toLowerCase().endsWith('@' + domain.toLowerCase()) ||
      email.toLowerCase().endsWith('.' + domain.toLowerCase())
  );

export function report_blocked_user(kiloUserId: string) {
  return authError(403, 'Access denied (R1)', kiloUserId);
}

export const uuidSchema = z.uuid();
const uuid = uuidSchema;
// Namespace UUID for generating UUIDs from legacy user IDs
// This is a fixed UUID that serves as the namespace for all user ID conversions
const USER_UUID_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'; // DNS namespace UUID

export function getUserUUID(user: User): string {
  if (uuid.safeParse(user.id).success) {
    return user.id;
  } else {
    return uuidv5(user.id, USER_UUID_NAMESPACE);
  }
}

// decides if we want to redirect to /profile or the org page
// the org page will be redirected to if the user is a member of exactly one organization
// or if the org is SSO org
export async function getProfileRedirectPath(user: User) {
  // Check if user is a member of exactly one organization (skip redirect if multiple)
  const singleOrg = await getSingleUserOrganization(user.id);
  if (singleOrg) {
    if (isOrganizationHardLocked(singleOrg)) {
      return '/profile';
    }
    return `/organizations/${singleOrg.id}`;
  }

  // Fall back to SSO domain check for users not yet members
  const domain = getLowerDomainFromEmail(user.google_user_email);
  if (!domain || domain === 'gmail.com') {
    return '/profile';
  }
  const res = await doesOrgWithSSODomainExist(domain);
  if (res !== false) {
    return `/organizations/${res}`;
  }
  return '/profile';
}
