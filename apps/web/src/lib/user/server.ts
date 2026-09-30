import { getEnvVariable } from '@/lib/dotenvx';
import 'server-only';
import { validateAuthorizationHeader, isRejectedCredentialReason } from '@/lib/tokens';
import {
  CloudAgentNextRuntimeAuthorizationClaimSchema,
  RuntimeProxyAttestationAudienceSchema,
  verifyRuntimeProxyAttestation,
} from '@kilocode/worker-utils/runtime-proxy-attestation';
import { NextResponse } from 'next/server';
import { headers } from 'next/headers';

import { findUserById } from '@/lib/user/find-user-by-id';
import type { CreateOrUpdateUserArgs, CreateOrUpdateUserTrackingContext } from '@/lib/user';
import { createOrUpdateUser, findAndSyncExistingUser } from '@/lib/user';
import { db, readDb } from '@/lib/drizzle';
import type { NextAuthOptions, JWT, LoggerInstance } from 'next-auth';
import { getServerSession } from 'next-auth';
import { IS_DEVELOPMENT, ORGANIZATION_ID_HEADER } from '@/lib/constants';
import { redirect } from 'next/navigation';
import type { Organization, User } from '@kilocode/db/schema';
import { isOrganizationMember } from '@/lib/organizations/organizations';
import type { FailureResult } from '@/lib/maybe-result';
import { failureResult } from '@/lib/maybe-result';
import { NEXTAUTH_SECRET, BLACKLIST_TLDS } from '@/lib/config.server';
import jwt from 'jsonwebtoken';
import { logExceptInTest, sentryLogger } from '@/lib/utils.server';
import {
  authViaTokenFromHeaders,
  clientIpFromHeaders,
  emitAdminAccessEvent,
  routeFromHeaders,
} from '@/lib/admin/admin-access-log';
import { processSSOUserLogin } from '@/lib/user/sso';
import { getLowerDomainFromEmail } from '@/lib/email-address';
import { z } from 'zod';
import { v5 as uuidv5 } from 'uuid';
import { isWebSessionCurrent } from '@/lib/web-session-revocation';
import { extractBearerToken } from '@kilocode/worker-utils/extract-bearer-token';
import { KILO_API_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import {
  isKiloCredentialExchangeEligible,
  verifyKiloTokenForPolicy,
  type KiloCredentialExchangeEligibilityPolicy,
} from '@kilocode/worker-utils/kilo-token-policy';

import { getBlacklistedDomains } from '@/lib/blacklist-domains-config';

const blacklistDomainsEnv = getEnvVariable('BLACKLIST_DOMAINS');
const BLACKLIST_DOMAINS_FROM_ENV = blacklistDomainsEnv
  ? blacklistDomainsEnv.split('|').map((domain: string) => domain.trim())
  : [];

// NextAuth calls a user-provided `debug` logger regardless of the `debug` option,
// and its debug payloads contain sensitive data (tokens, secrets, provider config).
// Only wire up the debug logger in local development.
// https://next-auth.js.org/configuration/options
const logger: LoggerInstance = {
  debug: IS_DEVELOPMENT ? logExceptInTest : () => {},
  warn: sentryLogger('NEXTAUTH', 'warning'),
  error: sentryLogger('NEXTAUTH', 'error'),
};

/**
 * The NextAuth options a session read uses. `getServerSession` drops the
 * providers, and a session read calls the `jwt` callback without a `trigger`,
 * for which the `authOptions` callback also returns the token unchanged. Reading
 * a session with these options therefore matches `authOptions`
 * (lib/user/next-auth-options) without loading the sign-in flows.
 */
export const sessionAuthOptions = {
  secret: NEXTAUTH_SECRET,
  providers: [],
  logger, // Surfacing NextAuth internal logs/errors for diagnostics
  callbacks: {
    async jwt({ token }) {
      return token;
    },
    async session({ session, token }) {
      const castToken = token as unknown as JWT;
      session.user.id = castToken.sub;
      session.isAdmin = castToken.isAdmin || false; // Ensure isAdmin is always defined
      session.kiloUserId = castToken.kiloUserId;
      session.webSessionPepper = castToken.webSessionPepper ?? castToken.pepper ?? null;
      session.isNewUser = castToken.isNewUser || false; // Pass isNewUser to the session
      session.authProvider = castToken.authProvider;
      session.authenticatedAt = castToken.authenticatedAt;
      session.ssoSourceOrganizationId = castToken.ssoSourceOrganizationId;
      return session;
    },
  },
  pages: {
    signIn: '/users/sign_in',
    error: '/users/sign_in',
  },
  debug: !!getEnvVariable('DEBUG_AUTH'),
} satisfies NextAuthOptions;

/**
 * Returns the signed-in user id when the request carries a valid NextAuth
 * session, or null when it does not. This performs no authorization checks and
 * never redirects; it is used to decide where an OAuth callback error lands.
 */
export async function getUserFromSession(): Promise<{ id: string } | null> {
  const session = await getServerSession(sessionAuthOptions);
  return session?.kiloUserId ? { id: session.kiloUserId } : null;
}

export type RequiredPermissions = {
  adminOnly: boolean;
  DANGEROUS_allowBlockedUsers?: boolean;
  expectedAudience?: string;
};

type GetAuthResponse =
  | {
      user: null;
      authFailedResponse: NextResponse<FailureResult<string>>;
      /**
       * True when the request presented a credential that failed verification,
       * rather than presenting none. Such a request must not be downgraded to
       * an anonymous identity; see `isRejectedCredentialReason`.
       *
       * `authError` always sets this. It is optional only so existing callers
       * that construct a failure result directly keep compiling; absent means
       * false.
       */
      credentialsRejected?: boolean;
      isNewUser?: undefined;
      organizationId?: undefined;
      internalApiUse?: undefined;
      botId?: undefined;
      tokenSource?: undefined;
      deviceSessionId?: undefined;
    }
  | {
      user: User;
      authFailedResponse: null;
      credentialsRejected?: undefined;
      isNewUser?: boolean;
      organizationId?: Organization['id'];
      internalApiUse?: boolean;
      botId?: string;
      tokenSource?: string;
      deviceSessionId?: string;
    };

export async function getUserFromAuth(opts: RequiredPermissions): Promise<GetAuthResponse> {
  const headersList = await headers();
  const result = await resolveUserFromAuth(opts, headersList);

  // Admin audit trail: emit exactly one identity-attributed event per authorized
  // admin request. Guarded strictly on adminOnly so the millions of
  // adminOnly:false calls never log.
  if (opts.adminOnly === true && result.user) {
    emitAdminAccessEvent({
      surface: 'rest',
      kind: 'admin_guard',
      user: result.user,
      authViaToken: authViaTokenFromHeaders(headersList),
      tokenSource: result.tokenSource ?? null,
      route: routeFromHeaders(headersList),
      // No reliable HTTP method header is available here; do not fabricate one.
      method: null,
      ip: clientIpFromHeaders(headersList),
    });
  }

  return result;
}

export async function getUserFromSessionForCredentialIssuance(): Promise<GetAuthResponse> {
  const headersList = await headers();
  if (headersList.has('authorization')) {
    return authError(401, 'Unauthorized', '?');
  }

  return resolveUserFromSession({ adminOnly: false }, db);
}

export async function getUserFromSessionForCredentialIssuanceOrRedirect(
  loggedOutRedirectUrl = '/users/sign_in'
): Promise<User> {
  const headersList = await headers();
  if (headersList.has('authorization')) {
    redirect(await appendCallbackPath(loggedOutRedirectUrl));
  }

  const { user } = await resolveUserFromSession(
    { adminOnly: false, DANGEROUS_allowBlockedUsers: true },
    db
  );
  if (!user) {
    redirect(await appendCallbackPath(loggedOutRedirectUrl));
  }
  if (user.blocked_reason) {
    redirect('/account-blocked');
  }
  return user;
}

export async function getUserFromBearerForCredentialExchange(
  requestHeaders: Headers,
  policy: KiloCredentialExchangeEligibilityPolicy
): Promise<GetAuthResponse> {
  const token = extractBearerToken(requestHeaders.get('authorization'));
  if (!token) return authError(401, 'Unauthorized', '?');

  let auth: Awaited<ReturnType<typeof verifyKiloTokenForPolicy>>;
  try {
    auth = await verifyKiloTokenForPolicy(token, NEXTAUTH_SECRET, {
      audience: KILO_API_AUDIENCE,
      mode: 'allow-legacy',
    });
  } catch {
    return authError(401, 'Unauthorized', '?');
  }

  if (auth.claims.env !== process.env.NODE_ENV) {
    return authError(401, 'Unauthorized', auth.userId);
  }

  const user = await findUserById(auth.userId, db);
  if (
    auth.claims.apiTokenPepper === undefined ||
    auth.claims.apiTokenPepper !== user?.api_token_pepper
  ) {
    return authError(401, 'Unauthorized', auth.userId);
  }

  const result = await validateUserAuthorization(
    auth.userId,
    user,
    { adminOnly: false },
    false,
    undefined,
    undefined,
    db
  );
  if (!result.user) return result;
  if (!isKiloCredentialExchangeEligible(auth, policy)) {
    return authError(401, 'Unauthorized', auth.userId);
  }
  return result;
}

async function resolveUserFromAuth(
  opts: RequiredPermissions,
  headersList: Awaited<ReturnType<typeof headers>>
): Promise<GetAuthResponse> {
  // This path is executed for non-next-auth requests
  // all calls from the extension including the openrouter proxy call use this auth method
  // also val.town and other blessed API users who are given their own custom JWTs use this path
  if (headersList.get('Authorization')) {
    const rawAuthorization = headersList.get('Authorization');
    const bearer = rawAuthorization?.match(/^Bearer (.+)$/i)?.[1];
    let decoded: ReturnType<typeof jwt.decode>;
    try {
      decoded = bearer ? jwt.decode(bearer) : null;
    } catch {
      return authError(401, 'Invalid API token', '?', { credentialsRejected: true });
    }
    const decodedPayload = decoded !== null && typeof decoded !== 'string' ? decoded : null;
    const decodedRuntimeAuthorization = decodedPayload?.runtimeAuthorization;
    const runtimeAuthorization = CloudAgentNextRuntimeAuthorizationClaimSchema.safeParse(
      decodedRuntimeAuthorization
    );
    const attestationAudience = RuntimeProxyAttestationAudienceSchema.safeParse(
      opts.expectedAudience ?? KILO_API_AUDIENCE
    );
    const runtimeProxyAttestationVerified =
      bearer !== undefined &&
      runtimeAuthorization.success &&
      attestationAudience.success &&
      typeof decodedPayload?.kiloUserId === 'string'
        ? await verifyRuntimeProxyAttestation({
            value: headersList.get('X-Kilo-Runtime-Proxy-Attestation'),
            secret: NEXTAUTH_SECRET,
            audience: attestationAudience.data,
            userId: decodedPayload.kiloUserId,
            authorizationId: runtimeAuthorization.data.id,
            resourceId: runtimeAuthorization.data.resourceId,
            bearer,
          })
        : false;
    const authorizationValidationResult = validateAuthorizationHeader(headersList, {
      expectedAudience: opts.expectedAudience,
      runtimeProxyAttestationVerified,
    });
    if (authorizationValidationResult.error != undefined) {
      return authError(401, authorizationValidationResult.error, '?', {
        credentialsRejected: isRejectedCredentialReason(authorizationValidationResult.reason),
      });
    }

    const user = await findUserById(authorizationValidationResult.kiloUserId, readDb);

    if (
      user?.api_token_pepper &&
      user.api_token_pepper !== authorizationValidationResult.apiTokenPepper
    ) {
      return authError(401, 'Invalid API token', user.id, { credentialsRejected: true });
    }
    // A token-bound organization is signed; the request header is mutable.
    // Legacy and personal tokens intentionally continue to use the header.
    const organizationId =
      authorizationValidationResult.organizationId ??
      headersList.get(ORGANIZATION_ID_HEADER) ??
      undefined;
    const internalApiUse = authorizationValidationResult.internalApiUse;
    const botId = authorizationValidationResult.botId;
    const tokenSource = authorizationValidationResult.tokenSource;
    const deviceSessionId = authorizationValidationResult.deviceSessionId;

    return await validateUserAuthorization(
      authorizationValidationResult.kiloUserId,
      user,
      opts,
      false,
      organizationId,
      internalApiUse,
      readDb,
      botId,
      tokenSource,
      deviceSessionId
    );
  }

  return resolveUserFromSession(opts, readDb);
}

async function resolveUserFromSession(
  opts: RequiredPermissions,
  fromDb: typeof db
): Promise<GetAuthResponse> {
  const session = await getServerSession(sessionAuthOptions);
  const maybeKiloUserId = session?.kiloUserId;

  if (!maybeKiloUserId) return authError(401, 'Unauthorized', '?');

  const user = await findUserById(maybeKiloUserId, fromDb);
  if (!user) return authError(401, 'Unauthorized (D)', maybeKiloUserId);

  if (!isWebSessionCurrent(session.webSessionPepper, user))
    return authError(401, 'Reauthentication required', maybeKiloUserId);

  // NOTE: we currently do not thread organization id through here as its only used for extension-originated requests
  return await validateUserAuthorization(
    maybeKiloUserId,
    user,
    opts,
    session.isNewUser,
    undefined,
    undefined,
    fromDb
  );
}

export async function getUserFromAuthOrRedirect(
  loggedOutRedirectUrl = '/users/sign_in'
): Promise<User> {
  const { user } = await getUserFromAuth({ adminOnly: false, DANGEROUS_allowBlockedUsers: true });
  if (!user) {
    redirect(await appendCallbackPath(loggedOutRedirectUrl));
  }
  if (user.blocked_reason) {
    redirect('/account-blocked');
  }
  return user;
}

export async function signInUrlWithCallbackPath(): Promise<string> {
  return appendCallbackPath('/users/sign_in');
}

async function appendCallbackPath(url: string): Promise<string> {
  if (url.includes('callbackPath')) return url;
  const headersList = await headers();
  const pathname = headersList.get('x-pathname');
  if (pathname && pathname !== '/') {
    // Keep the request's query in the callback so a resume link does not lose
    // its `?at=` anchor across sign-in (see the `/cloud/sessions/<id>` route,
    // whose layout redirects before the page can build its own callbackPath).
    const search = headersList.get('x-search') ?? '';
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}callbackPath=${encodeURIComponent(`${pathname}${search}`)}`;
  }
  return url;
}

function authError(
  status: number,
  error: string,
  kiloUserId: string,
  options?: { credentialsRejected?: boolean }
) {
  console.warn(`AUTH-FAIL ${status} (${kiloUserId}): ${error}`);
  return {
    user: null,
    authFailedResponse: NextResponse.json(failureResult(error), { status }),
    credentialsRejected: options?.credentialsRejected ?? false,
  };
}

async function validateUserAuthorization(
  kiloUserId: string,
  user: User | undefined,
  opts: RequiredPermissions,
  isNewUser?: boolean,
  organizationId?: Organization['id'],
  internalApiUse?: boolean,
  fromDb: typeof db = db,
  botId?: string,
  tokenSource?: string,
  deviceSessionId?: string
): Promise<GetAuthResponse> {
  if (!user) {
    return authError(401, 'User not found', kiloUserId);
  } else if (await isUserBlacklistedByDomain(user)) {
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

  return {
    user,
    authFailedResponse: null,
    isNewUser,
    organizationId,
    internalApiUse,
    botId,
    tokenSource,
    deviceSessionId,
  };
}

export async function isUserBlacklistedByDomain(
  existingUser: Pick<User, 'google_user_email'>
): Promise<boolean> {
  const domains = await getBlacklistedDomains();
  return isEmailBlacklistedByDomain(existingUser.google_user_email, domains);
}

export const isEmailBlacklistedByDomain = (
  email: string,
  blacklisted_domains: string[] | undefined = BLACKLIST_DOMAINS_FROM_ENV
) =>
  blacklisted_domains?.some(
    domain =>
      email.toLowerCase().endsWith('@' + domain.toLowerCase()) ||
      email.toLowerCase().endsWith('.' + domain.toLowerCase())
  );

export async function isEmailBlacklistedByDomainAsync(email: string): Promise<boolean> {
  const domains = await getBlacklistedDomains();
  return !!isEmailBlacklistedByDomain(email, domains);
}

export const isBlockedTLD = (email: string, blacklisted_tlds = BLACKLIST_TLDS) =>
  blacklisted_tlds.some(tld => email.toLowerCase().endsWith(tld));

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
