import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';
import 'server-only';
import type { AccountBlockedRefusalReason } from '@kilocode/app-shared/auth';
import {
  validateAuthorizationHeader,
  isRejectedCredentialReason,
} from '@kilocode/web-shared/lib/tokens';
import {
  CloudAgentNextRuntimeAuthorizationClaimSchema,
  RuntimeProxyAttestationAudienceSchema,
  verifyRuntimeProxyAttestation,
} from '@kilocode/worker-utils/runtime-proxy-attestation';
import { NextResponse } from 'next/server';
import { TRPCError } from '@trpc/server';
import { headers } from 'next/headers';

import { findUserById } from '@kilocode/web-shared/lib/user/find-user-by-id';
import { isUserBlacklistedByDomain } from '@kilocode/web-shared/lib/user/domain-gates';
import { isBlockedAccount } from '@kilocode/web-shared/lib/user/account-status';
import { db, readDb } from '@kilocode/web-shared/lib/drizzle';
import type { NextAuthOptions, JWT, LoggerInstance, Session } from 'next-auth';
import { getServerSession } from 'next-auth';
import { IS_DEVELOPMENT, ORGANIZATION_ID_HEADER } from '@kilocode/web-shared/lib/constants';
import { redirect } from 'next/navigation';
import type { Organization, User } from '@kilocode/db/schema';
import { isDeviceSessionActive } from '@kilocode/web-shared/lib/auth/device-session-cache';
import { liveDeviceSessionCondition } from '@kilocode/db/device-session-condition';
import { requestOrganizationId } from '@kilocode/worker-utils/account-access';
import { isKiloUserCredentialPepperCurrent } from '@kilocode/worker-utils/kilo-token-pepper';
import { hasEffectiveOrganizationAccess } from '@kilocode/worker-utils/organization-membership';
import type { FailureResult } from '@kilocode/web-shared/lib/maybe-result';
import { failureResult } from '@kilocode/web-shared/lib/maybe-result';
import { isAdminStepUpEnabled, NEXTAUTH_SECRET } from '@kilocode/web-shared/lib/config.server';
import jwt from 'jsonwebtoken';
import {
  logExceptInTest,
  sentryLogger,
  warnExceptInTest,
} from '@kilocode/web-shared/lib/utils.server';
import {
  authViaTokenFromHeaders,
  clientIpFromHeaders,
  emitAdminAccessEvent,
  emitPrivilegedAccessEvent,
  methodFromHeaders,
  routeFromHeaders,
  userAgentProductFromHeaders,
} from '@kilocode/web-shared/lib/admin/admin-access-log';
import {
  deriveCredentialKind,
  StepUpRequiredError,
  type PrivilegedActionClass,
  type PrivilegedCredentialKind,
  type PrivilegedTargetKind,
  type StepUpRequirementPayload,
} from '@kilocode/web-shared/lib/admin/privileged-access';
import { actionClassForRoute } from '@kilocode/web-shared/lib/admin/privileged-inventory';
import { runStepUpGuard, stepUpRefusalPayload } from '@kilocode/web-shared/lib/admin/step-up-guard';
import { isCredentialExemptibleClass } from '@kilocode/web-shared/lib/admin/step-up-policy';
import { reportStepUpFailure } from '@kilocode/web-shared/lib/admin/step-up-observation';
import { z } from 'zod';
import { v5 as uuidv5 } from 'uuid';
import {
  isWebSessionCurrent,
  readWebSessionPepper,
} from '@kilocode/web-shared/lib/web-session-revocation';
import { extractBearerToken } from '@kilocode/worker-utils/extract-bearer-token';
import {
  isCloudAgentAuthorityHttpPathAllowed,
  type CloudAgentAuthority,
} from '@kilocode/worker-utils/cloud-agent-authority';
import { KILO_API_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import {
  KILO_EXCHANGE_SAFE_CLAIM_NAMES,
  isKiloCredentialExchangeEligible,
  verifyKiloTokenForPolicy,
  type KiloCredentialExchangeEligibilityPolicy,
  type KiloTokenPolicyClaims,
} from '@kilocode/worker-utils/kilo-token-policy';

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
      session.isAdmin = castToken.isAdmin || false;
      session.kiloUserId = castToken.kiloUserId;
      session.webSessionPepper = castToken.webSessionPepper ?? castToken.pepper ?? null;
      session.webSessionId = castToken.webSessionId;
      session.isNewUser = castToken.isNewUser || false;
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
 * False on apps/ai-gateway, whose next.config `env` inlines
 * `KILO_BROWSER_SESSIONS` at build time. The gateway authenticates by bearer
 * token only, so every session read there answers "no session".
 */
function acceptsBrowserSessions(): boolean {
  return process.env.KILO_BROWSER_SESSIONS !== 'disabled';
}

/**
 * Reads the NextAuth session, treating a session read that throws as no
 * session. With the JWT strategy the read only parses and re-serializes request
 * cookies, so a throw means the cookies are unusable, for example a malformed
 * cookie name that `cookie.serialize` rejects while NextAuth clears an invalid
 * session token. Any other failure is rethrown so it stays visible.
 */
async function readSession(): Promise<Session | null> {
  if (!acceptsBrowserSessions()) return null;
  try {
    return await getServerSession(sessionAuthOptions);
  } catch (error) {
    if (!isCookieValidationError(error)) throw error;
    warnExceptInTest(
      'NextAuth session read failed on malformed cookies; treating request as unauthenticated'
    );
    return null;
  }
}

const COOKIE_VALIDATION_ERROR_MESSAGE = /^(argument|option) \w+ (is invalid|must be a string)$/;

function isCookieValidationError(error: unknown): boolean {
  return error instanceof TypeError && COOKIE_VALIDATION_ERROR_MESSAGE.test(error.message);
}

/**
 * Returns the signed-in user id when the request carries a valid NextAuth
 * session, or null when it does not. This performs no authorization checks and
 * never redirects; it is used to decide where an OAuth callback error lands.
 */
export async function getUserFromSession(): Promise<{ id: string } | null> {
  const session = await readSession();
  return session?.kiloUserId ? { id: session.kiloUserId } : null;
}

export type RequiredPermissions = {
  adminOnly: boolean;
  DANGEROUS_allowBlockedUsers?: boolean;
  /**
   * Admits an account the authorization refuses — the R0 domain blacklist or
   * the R1 block — so it can end its own session. Only a request that does
   * nothing but that cleanup may set it: the app's sign-out has to end the
   * session server-side even while a refusal stands, or the app clears its
   * credentials and leaves a usable session and refresh token behind.
   */
  allowRefusedAccountSelfCleanup?: boolean;
  expectedAudience?: string;
  // Derive from an actual Request URL or fixed route path, never a request header.
  requestPathname?: string;
  /** The actual Request method when the caller has one; preferred over headers. */
  requestMethod?: string;
  requestHeaders?: Headers;
  /** How this admin read arrived; server components are not REST routes. */
  stepUpSurface?: 'rest' | 'server-component';
  /**
   * Layout-only escape hatch: authenticate the admin but let the caller render
   * the verification interstitial instead of returning a 403. Never use on a
   * data route.
   */
  skipStepUpGuard?: boolean;
  /**
   * Non-session credential kinds that skip the passkey step-up guard for this
   * call, for a read-only, low-risk data route that has been explicitly
   * approved to accept them (`GET /api/private/users`, for Pylon webhooks).
   *
   * Three limits hold regardless of what a caller passes:
   * - Matched against the kind `getUserFromAuth` derives for the request, not
   *   against headers.
   * - `'session'` is not accepted: the type excludes it and the runtime check
   *   ignores it, so a browser session always faces step-up.
   * - The exemption applies only when the request's action class is
   *   `credentialExemptible` in `step-up-policy.ts` (read-grade classes).
   *   Writes and operation-bound classes keep the guard.
   *
   * Admin authentication still applies in full. Do not add routes without a
   * security review. Pass `requestMethod` so the action class is not inferred
   * from a missing header.
   */
  stepUpExemptCredentials?: readonly StepUpExemptibleCredential[];
};

export type StepUpExemptibleCredential = Exclude<PrivilegedCredentialKind, 'session'>;

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
      /**
       * True when authorization refused a request that presented a credential.
       * The authentication response is the answer for such a request.
       */
      authorizationRefused?: boolean;
      /**
       * Set only when authorization refused the account itself — R0 (domain
       * blacklisted) or R1 (blocked account) — rather than the request. The
       * tRPC context turns it into the blocked-account refusal so the client
       * explains the block instead of signing the user out; every other
       * refusal (nonadmin, org membership, 401/400) leaves it unset.
       *
       * The two branches set different values because they promise different
       * things: R0 sets `email_domain_blocked`, which no client action can
       * change (the domain is on an admin-managed blacklist), while R1 sets
       * `account_blocked`, which support can lift, so only R1 may offer a
       * retry. Both stay refused, and the admission below is keyed on its
       * option, not this value.
       */
      refusalReason?: AccountBlockedRefusalReason;
      rejectionReason?: 'empty_organization_context';
      isNewUser?: undefined;
      organizationId?: Organization['id'];
      internalApiUse?: boolean;
      botId?: string;
      tokenSource?: string;
      deviceSessionId?: string;
      cloudAgentAuthority?: CloudAgentAuthority;
      cloudAgentRuntimeProxied?: undefined;
      credential?: undefined;
      webSessionId?: undefined;
      webSessionPepper?: undefined;
      authenticatedAt?: undefined;
      ssoSourceOrganizationId?: undefined;
    }
  | {
      user: User;
      authFailedResponse: null;
      credentialsRejected?: undefined;
      authorizationRefused?: undefined;
      refusalReason?: undefined;
      rejectionReason?: undefined;
      isNewUser?: boolean;
      organizationId?: Organization['id'];
      internalApiUse?: boolean;
      botId?: string;
      tokenSource?: string;
      deviceSessionId?: string;
      cloudAgentAuthority?: CloudAgentAuthority;
      /** True only for a token whose runtime claim the Cloud Agent runtime proxy attested. */
      cloudAgentRuntimeProxied?: boolean;
      credential?: PrivilegedCredentialKind;
      /** Server-only per-session id for MFA step-up; never sent to the browser. */
      webSessionId?: string;
      /** Server-only pepper the session was minted with, for primary re-reads. */
      webSessionPepper?: string | null;
      /** Unix seconds when the browser session signed in. */
      authenticatedAt?: number;
      /**
       * The WorkOS organization this browser session authenticated through,
       * recorded only when the session signed in through SSO. Server-only: it
       * is the provenance a management approval checks against the
       * organization the account's domain currently requires.
       */
      ssoSourceOrganizationId?: string;
    };

export async function getUserFromAuth(opts: RequiredPermissions): Promise<GetAuthResponse> {
  const headersList = opts.requestHeaders ?? (await headers());
  const result = await resolveUserFromAuth(opts, headersList);
  // Every admin audit event of one request carries the surface it arrived on,
  // so the same request lands in one inventory entry whichever way it resolves.
  const surface = opts.stepUpSurface ?? 'rest';

  const authViaToken = authViaTokenFromHeaders(headersList);
  const credential = deriveCredentialKind({
    authViaToken,
    tokenSource: result.tokenSource ?? null,
    internalApiUse: result.internalApiUse,
    delegatedWorkload: result.cloudAgentAuthority !== undefined,
  });

  // Admin audit trail: emit exactly one identity-attributed event per authorized
  // admin request. Guarded strictly on adminOnly so the millions of
  // adminOnly:false calls never log.
  if (opts.adminOnly === true && (result.user || authViaToken)) {
    // One header read and one privileged-inventory lookup per admin request, so
    // the step-up guard and the token outcome event that reports it cannot name
    // different actions.
    const route = routeFromHeaders(headersList);
    const method = methodFromHeaders(headersList, opts.requestMethod);
    let attribution:
      | {
          actionClass: PrivilegedActionClass;
          inventoryId: string | null;
          targetKind: PrivilegedTargetKind;
        }
      | undefined;
    const routeAttribution = () =>
      (attribution ??= actionClassForRoute({ surface, route: route ?? '', method }));

    // `wouldBlock` sizes bearer traffic that step-up enforcement would refuse. A
    // request the caller exempted is never refused, so it must not count as one.
    // Server-component layouts skip the guard but still refuse bearer
    // credentials themselves, so they keep reporting `wouldBlock` for
    // non-session traffic. The exemption needs both a listed credential kind and
    // an exemptible action class; the class is only resolved when the kind is
    // listed.
    const stepUpExempt =
      credential !== 'session' &&
      (opts.stepUpExemptCredentials?.some(kind => kind === credential) ?? false) &&
      isCredentialExemptibleClass(routeAttribution().actionClass);
    const wouldBlockUnderStepUp = credential !== 'session' && !stepUpExempt;

    if (result.user) {
      emitAdminAccessEvent({
        surface,
        kind: 'admin_guard',
        user: result.user,
        authViaToken,
        tokenSource: result.tokenSource ?? null,
        credential,
        wouldBlock: wouldBlockUnderStepUp,
        route,
        method,
        userAgentProduct: userAgentProductFromHeaders(headersList),
        ip: clientIpFromHeaders(headersList),
      });

      if (isAdminStepUpEnabled() && !opts.skipStepUpGuard && !stepUpExempt) {
        const { actionClass, inventoryId, targetKind } = routeAttribution();
        try {
          await runStepUpGuard({
            userId: result.user.id,
            credential,
            webSessionId: result.webSessionId,
            actionClass,
            target: { kind: targetKind, id: null },
            enabled: true,
            route,
            method,
            surface,
          });
        } catch (error) {
          // One privileged-access outcome per guarded non-session request:
          // `denied` for a policy verdict, `failed` for an unexpected throw.
          // Session traffic stays on `admin_guard`.
          const emitOutcome = (outcome: 'denied' | 'failed') => {
            if (credential === 'session') return;
            emitPrivilegedAccessEvent({
              surface,
              user: result.user,
              credential,
              outcome,
              actionClass,
              actionId: inventoryId,
              target: null,
              wouldBlock: true,
              userAgentProduct: userAgentProductFromHeaders(headersList),
              tokenSource: result.tokenSource ?? null,
              route,
              method,
              ip: clientIpFromHeaders(headersList),
            });
          };
          if (error instanceof TRPCError && error.cause instanceof StepUpRequiredError) {
            emitOutcome('denied');
            return authError(403, error.cause.code, result.user.id, {
              stepUp: stepUpRefusalPayload(error.cause),
            });
          }
          // Fail closed. The guard normally converts evaluation failures itself;
          // this covers anything unexpected around it.
          emitOutcome('failed');
          reportStepUpFailure('admin_step_up_rest', error);
          return authError(403, 'STEP_UP_UNAVAILABLE', result.user.id);
        }
      }
    }

    if (authViaToken) {
      const { actionClass, inventoryId } = routeAttribution();
      emitPrivilegedAccessEvent({
        surface,
        user: result.user ?? undefined,
        credential,
        outcome: result.user ? 'succeeded' : 'denied',
        actionClass,
        actionId: inventoryId,
        target: null,
        wouldBlock: wouldBlockUnderStepUp,
        userAgentProduct: userAgentProductFromHeaders(headersList),
        tokenSource: result.tokenSource ?? null,
        route,
        method,
        ip: clientIpFromHeaders(headersList),
      });
    }
  }

  if (result.user) {
    return { ...result, credential };
  }
  return result;
}

/**
 * Reads the browser session only. A request that presents a credential is
 * refused, never downgraded to its session, because these callers mint or
 * exchange credentials and must not do so for a bearer caller.
 *
 * Both session-only entry points (`resolveSessionOnly` and
 * `getUserFromSessionForCredentialIssuanceOrRedirect`) take the
 * credential-presence answer from `authViaTokenFromHeaders` and differ only in
 * their outcome, a 401 versus a redirect, so the presence rule has one home.
 */
async function resolveSessionOnly(opts: RequiredPermissions): Promise<GetAuthResponse> {
  if (authViaTokenFromHeaders(await headers())) {
    return authError(401, 'Unauthorized', '?');
  }

  return resolveUserFromSession(opts, db);
}

export async function getUserFromSessionForCredentialIssuance(): Promise<GetAuthResponse> {
  return resolveSessionOnly({ adminOnly: false });
}

/**
 * Session-only read for MFA step-up. It refuses any bearer credential and
 * reads the primary so a proof minted a moment ago is usable immediately. The
 * caller still enforces the route's Origin check before trusting the session.
 */
export async function getUserFromSessionForStepUp(): Promise<GetAuthResponse> {
  return resolveSessionOnly({ adminOnly: true });
}

export async function getUserFromSessionForCredentialIssuanceOrRedirect(
  loggedOutRedirectUrl = '/users/sign_in'
): Promise<User> {
  if (authViaTokenFromHeaders(await headers())) {
    redirect(await appendCallbackPath(loggedOutRedirectUrl));
  }

  return userOrRedirect(
    await resolveUserFromSession({ adminOnly: false, DANGEROUS_allowBlockedUsers: true }, db),
    loggedOutRedirectUrl
  );
}

async function verifyKiloApiBearer(requestHeaders: Headers) {
  const token = extractBearerToken(requestHeaders.get('authorization'));
  if (!token) return null;

  try {
    return await verifyKiloTokenForPolicy(
      token,
      { keys: { legacyHs256Secret: NEXTAUTH_SECRET }, acceptedIssuers: ['kilo-web'] },
      { audience: KILO_API_AUDIENCE, mode: 'allow-legacy' }
    );
  } catch {
    return null;
  }
}

export async function getUserFromBearerForCredentialExchange(
  requestHeaders: Headers,
  policy: KiloCredentialExchangeEligibilityPolicy
): Promise<GetAuthResponse> {
  const auth = await verifyKiloApiBearer(requestHeaders);
  if (!auth) return authError(401, 'Unauthorized', '?');

  if (auth.claims.env !== process.env.NODE_ENV) {
    return authError(401, 'Unauthorized', auth.userId);
  }

  const user = await findUserById(auth.userId, db);
  if (!user || !isKiloUserCredentialPepperCurrent(auth.claims, user.api_token_pepper)) {
    return authError(401, 'Unauthorized', auth.userId);
  }

  const result = await validateUserAuthorization({
    kiloUserId: auth.userId,
    user,
    opts: { adminOnly: false },
    isNewUser: false,
    deviceSessionId: auth.claims.deviceSessionId,
  });
  if (!result.user) return result;
  if (!isKiloCredentialExchangeEligible(auth, policy)) {
    return authError(401, 'Unauthorized', auth.userId);
  }
  return result;
}

// Spreading the shared `ReadonlySet<string>` widens the literal array to `string[]`, so the
// `satisfies` that used to type-check the whole allow-list sits on the account-only claims.
const accountOnlyClaimNames = [
  'deviceSessionId',
  'organizationId',
  'organizationRole',
] satisfies (keyof KiloTokenPolicyClaims)[];

const accountBearerClaimNames: ReadonlySet<string> = new Set([
  ...KILO_EXCHANGE_SAFE_CLAIM_NAMES,
  ...accountOnlyClaimNames,
]);

export async function getUserFromAccountBearer(requestHeaders: Headers): Promise<GetAuthResponse> {
  const auth = await verifyKiloApiBearer(requestHeaders);
  if (!auth) return authError(401, 'Unauthorized', '?');

  const { userId, claims, claimNames } = auth;
  const { tokenPurpose, deviceSessionId, organizationId, credentialExchange } = claims;
  if (
    claims.env !== process.env.NODE_ENV ||
    claims.apiTokenPepper === undefined ||
    credentialExchange === true ||
    !claimNames.every(name => accountBearerClaimNames.has(name)) ||
    (tokenPurpose !== undefined &&
      tokenPurpose !== 'human-api' &&
      tokenPurpose !== 'device-access') ||
    (tokenPurpose === 'device-access' && deviceSessionId === undefined)
  ) {
    return authError(401, 'Unauthorized', userId);
  }

  const user = await findUserById(userId, db);
  if (!user || user.is_bot || !isKiloUserCredentialPepperCurrent(claims, user.api_token_pepper)) {
    return authError(401, 'Unauthorized', userId);
  }
  const result = await validateUserAuthorization({
    kiloUserId: userId,
    user,
    opts: { adminOnly: false },
  });
  if (!result.user) return result;

  if (deviceSessionId !== undefined) {
    // This path answers immediately, so it reads the primary instead of the
    // cached answer: a session created moments ago must authenticate its first
    // request, and a revocation must not wait out the cache window. Its refusal
    // is plain — the rejected-credential flag is deliberately not set here —
    // because this path reports only that the account binding no longer works.
    const session = await checkDeviceSession(deviceSessionId, userId, {
      read: 'primary',
      refusal: 'plain',
    });
    if (!session.accepted) {
      return authError(401, DEVICE_SESSION_INACTIVE_MESSAGE, userId);
    }
  }

  // The caller authorizes the requested organization against this signed binding, not a header.
  return { ...result, organizationId };
}

async function resolveUserFromAuth(
  opts: RequiredPermissions,
  headersList: Awaited<ReturnType<typeof headers>>
): Promise<GetAuthResponse> {
  // This path is executed for non-next-auth requests
  // all calls from the extension including the openrouter proxy call use this auth method
  // also val.town and other blessed API users who are given their own custom JWTs use this path
  if (authViaTokenFromHeaders(headersList)) {
    const rawAuthorization = headersList.get('Authorization');
    const bearer = extractBearerToken(rawAuthorization);
    let decoded: ReturnType<typeof jwt.decode>;
    try {
      decoded = bearer ? jwt.decode(bearer) : null;
    } catch {
      return authError(401, 'Invalid API token', '?', { credentialsRejected: true });
    }
    const decodedPayload = decoded !== null && typeof decoded !== 'string' ? decoded : null;
    const decodedRuntimeAuthorization: unknown = decodedPayload?.runtimeAuthorization;
    const runtimeAuthorization = CloudAgentNextRuntimeAuthorizationClaimSchema.safeParse(
      decodedRuntimeAuthorization
    );
    const attestationAudience = RuntimeProxyAttestationAudienceSchema.safeParse(
      opts.expectedAudience ?? KILO_API_AUDIENCE
    );
    const runtimeProxyAttestationVerified =
      bearer !== null &&
      runtimeAuthorization.success &&
      attestationAudience.success &&
      typeof decodedPayload?.kiloUserId === 'string'
        ? await verifyRuntimeProxyAttestation({
            value: headersList.get('X-Kilo-Runtime-Proxy-Attestation'),
            keys: { legacyHs256Secret: NEXTAUTH_SECRET },
            acceptedIssuers: ['cloud-agent-next'],
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
      requestPathname: opts.requestPathname,
    });
    if (authorizationValidationResult.error != undefined) {
      return authError(401, authorizationValidationResult.error, '?', {
        credentialsRejected: isRejectedCredentialReason(authorizationValidationResult.reason),
      });
    }

    const internalApiUse = authorizationValidationResult.internalApiUse;
    const tokenSource = authorizationValidationResult.tokenSource;
    const scope = authorizationValidationResult.cloudAgentAuthority;
    if (scope && opts.adminOnly) {
      return authError(403, 'Scoped credentials cannot access admin APIs', scope.ownerId, {
        credentialsRejected: true,
        internalApiUse,
        tokenSource,
        cloudAgentAuthority: scope,
      });
    }
    const fromDb = scope ? db : readDb;
    const user = await findUserById(authorizationValidationResult.kiloUserId, fromDb);

    if (
      user &&
      !isKiloUserCredentialPepperCurrent(authorizationValidationResult, user.api_token_pepper)
    ) {
      return authError(401, 'Invalid API token', user.id, {
        credentialsRejected: true,
        internalApiUse,
        tokenSource,
        cloudAgentAuthority: scope,
      });
    }
    // A token-bound organization is signed; the request header is mutable.
    // Legacy and personal tokens intentionally continue to use the header.
    const headerOrganizationId = headersList.get(ORGANIZATION_ID_HEADER);
    if (scope && headerOrganizationId !== null && headerOrganizationId !== scope.organizationId) {
      return authError(403, 'Scoped organization mismatch', scope.ownerId, {
        credentialsRejected: true,
        internalApiUse,
        tokenSource,
        cloudAgentAuthority: scope,
      });
    }
    const organizationId = scope
      ? (scope.organizationId ?? undefined)
      : requestOrganizationId(authorizationValidationResult.organizationId, headerOrganizationId);
    const botId = authorizationValidationResult.botId;
    const deviceSessionId = authorizationValidationResult.deviceSessionId;

    const result = await validateUserAuthorization({
      kiloUserId: authorizationValidationResult.kiloUserId,
      user,
      opts,
      isNewUser: false,
      organizationId,
      internalApiUse,
      fromDb,
      botId,
      tokenSource,
      deviceSessionId,
      cloudAgentAuthority: scope,
      cloudAgentRuntimeProxied: authorizationValidationResult.cloudAgentRuntimeProxied,
    });
    if (scope && !isCloudAgentAuthorityHttpPathAllowed(scope, opts.requestPathname)) {
      return authError(401, 'Cloud Agent authority has expired', scope.ownerId, {
        credentialsRejected: true,
        internalApiUse,
        tokenSource,
        cloudAgentAuthority: scope,
      });
    }
    return result;
  }

  // On apps/ai-gateway `readSession` finds no session, so this is the anonymous result.
  return resolveUserFromSession(opts, readDb);
}

async function resolveUserFromSession(
  opts: RequiredPermissions,
  fromDb: typeof db
): Promise<GetAuthResponse> {
  const session = await readSession();
  const maybeKiloUserId = session?.kiloUserId;

  if (!maybeKiloUserId) return authError(401, 'Unauthorized', '?');

  const user = await findUserById(maybeKiloUserId, fromDb);
  if (!user) return authError(401, 'Unauthorized (D)', maybeKiloUserId);

  // `revokeWebSessions` commits the pepper on the primary and that write is the
  // authoritative revocation. A replica cannot answer either way: after a
  // revocation it still holds the previous pepper, and a pepper minted after a
  // revocation reaches the session before the replica does. So the replica row
  // supplies the payload only, and the verdict comes from the primary.
  const pepperSource =
    fromDb === db ? user : { web_session_pepper: await readWebSessionPepper(maybeKiloUserId) };
  if (!isWebSessionCurrent(session.webSessionPepper, pepperSource))
    return authError(401, 'Reauthentication required', maybeKiloUserId);

  // NOTE: we currently do not thread organization id through here as its only used for extension-originated requests
  return await validateUserAuthorization({
    kiloUserId: maybeKiloUserId,
    user,
    opts,
    isNewUser: session.isNewUser,
    fromDb,
    webSession: {
      id: session.webSessionId,
      pepper: session.webSessionPepper,
      authenticatedAt: session.authenticatedAt,
      ssoSourceOrganizationId: session.ssoSourceOrganizationId,
    },
  });
}

/**
 * Returns the resolved user, or redirects a request that has none to the
 * callback-aware sign-in URL, or a blocked account to the blocked-account
 * page. This is the one place that answers both redirect cases.
 */
async function userOrRedirect(auth: GetAuthResponse, loggedOutRedirectUrl: string): Promise<User> {
  if (!auth.user) {
    redirect(await appendCallbackPath(loggedOutRedirectUrl));
  }
  if (isBlockedAccount(auth.user)) {
    redirect('/account-blocked');
  }
  return auth.user;
}

export async function getUserFromAuthOrRedirect(
  loggedOutRedirectUrl = '/users/sign_in'
): Promise<User> {
  return userOrRedirect(
    await getUserFromAuth({ adminOnly: false, DANGEROUS_allowBlockedUsers: true }),
    loggedOutRedirectUrl
  );
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
  options?: {
    credentialsRejected?: boolean;
    authorizationRefused?: boolean;
    refusalReason?: AccountBlockedRefusalReason;
    rejectionReason?: 'empty_organization_context';
    internalApiUse?: boolean;
    tokenSource?: string;
    cloudAgentAuthority?: CloudAgentAuthority;
    stepUp?: StepUpRequirementPayload;
  }
) {
  console.warn(`AUTH-FAIL ${status} (${kiloUserId}): ${error}`);
  return {
    user: null,
    authFailedResponse: NextResponse.json(
      options?.stepUp ? { ...failureResult(error), stepUp: options.stepUp } : failureResult(error),
      { status }
    ),
    credentialsRejected: options?.credentialsRejected ?? false,
    authorizationRefused: options?.authorizationRefused ?? false,
    refusalReason: options?.refusalReason,
    internalApiUse: options?.internalApiUse,
    tokenSource: options?.tokenSource,
    cloudAgentAuthority: options?.cloudAgentAuthority,
    ...(options?.rejectionReason && { rejectionReason: options.rejectionReason }),
  };
}

type UserAuthorizationRequest = {
  kiloUserId: string;
  user: User | undefined;
  opts: RequiredPermissions;
  isNewUser?: boolean;
  organizationId?: Organization['id'];
  internalApiUse?: boolean;
  fromDb?: typeof db;
  botId?: string;
  tokenSource?: string;
  deviceSessionId?: string;
  cloudAgentAuthority?: CloudAgentAuthority;
  /** True only for a token whose runtime claim the Cloud Agent runtime proxy attested. */
  cloudAgentRuntimeProxied?: boolean;
  webSession?: {
    id?: string;
    pepper?: string | null;
    authenticatedAt?: number;
    ssoSourceOrganizationId?: string;
  };
};

async function validateUserAuthorization({
  kiloUserId,
  user,
  opts,
  isNewUser,
  organizationId,
  internalApiUse,
  fromDb = db,
  botId,
  tokenSource,
  deviceSessionId,
  cloudAgentAuthority,
  cloudAgentRuntimeProxied,
  webSession,
}: UserAuthorizationRequest): Promise<GetAuthResponse> {
  if (!user) {
    return authError(401, 'User not found', kiloUserId, {
      internalApiUse,
      tokenSource,
      cloudAgentAuthority,
    });
  }

  // The self-cleanup admission covers only the account refusals below, so every
  // other gate — including `adminOnly` — still runs for a cleanup request.
  if (!opts.allowRefusedAccountSelfCleanup) {
    if (await isUserBlacklistedByDomain(user, readDb)) {
      return authError(403, 'Access denied (R0)', kiloUserId, {
        authorizationRefused: true,
        refusalReason: 'email_domain_blocked',
        internalApiUse,
        tokenSource,
        cloudAgentAuthority,
      });
    }

    if (!opts.DANGEROUS_allowBlockedUsers && isBlockedAccount(user)) {
      return authError(403, 'Access denied (R1)', kiloUserId, {
        authorizationRefused: true,
        refusalReason: 'account_blocked',
        internalApiUse,
        tokenSource,
        cloudAgentAuthority,
      });
    }
  }

  if (opts.adminOnly && !user.is_admin) {
    return authError(403, 'Access denied (nonadmin)', kiloUserId, {
      authorizationRefused: true,
      internalApiUse,
      tokenSource,
      cloudAgentAuthority,
    });
  }

  // A credential bound to a device session is only valid while that session is
  // active. The answer is cached per instance for
  // `DEVICE_SESSION_CACHE_TTL_MS`, which is the window in which a revocation
  // written by another instance takes effect here; a revocation on this
  // instance invalidates its entry. See `lib/auth/device-session-cache`.
  // This path refuses with the rejected-credential flag: the caller presented a
  // credential that no longer works, so the refusal must not degrade into an
  // anonymous request.
  if (deviceSessionId !== undefined) {
    const session = await checkDeviceSession(deviceSessionId, kiloUserId, {
      read: 'cached',
      refusal: 'rejected-credential',
    });
    if (!session.accepted) {
      return authError(401, DEVICE_SESSION_INACTIVE_MESSAGE, kiloUserId, {
        credentialsRejected: session.credentialsRejected,
        internalApiUse,
        tokenSource,
        cloudAgentAuthority,
      });
    }
  }

  if (organizationId !== undefined) {
    const uuidResult = uuid.safeParse(organizationId);
    if (!uuidResult.success) {
      return authError(400, 'Invalid organization ID format', kiloUserId, {
        internalApiUse,
        tokenSource,
        cloudAgentAuthority,
        ...(organizationId === '' && { rejectionReason: 'empty_organization_context' }),
      });
    }
    // An organization context resolves through the effective-membership rule:
    // the caller holds a direct membership in the live organization, or a
    // permitted role (owner, admin, billing_manager) on its live parent
    // organization. The balance and member-allowance rules are separate and do
    // not follow inheritance.
    const hasAccess = await hasEffectiveOrganizationAccess(fromDb, {
      kiloUserId,
      organizationId,
    });
    if (!hasAccess) {
      return authError(403, 'Access denied (not a member of the organization)', kiloUserId, {
        authorizationRefused: true,
        internalApiUse,
        tokenSource,
        cloudAgentAuthority,
      });
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
    cloudAgentAuthority,
    cloudAgentRuntimeProxied,
    webSessionId: webSession?.id,
    webSessionPepper: webSession?.pepper,
    authenticatedAt: webSession?.authenticatedAt,
    ssoSourceOrganizationId: webSession?.ssoSourceOrganizationId,
  };
}

/**
 * Read a session from the primary: a session created moments ago must
 * authenticate its first request, which a lagging replica would refuse.
 */
async function readActiveDeviceSession(
  deviceSessionId: string,
  kiloUserId: string
): Promise<boolean> {
  const session = await db.query.device_sessions.findFirst({
    where: liveDeviceSessionCondition({ deviceSessionId, userId: kiloUserId }),
    columns: { id: true },
  });
  return session !== undefined;
}

const DEVICE_SESSION_INACTIVE_MESSAGE = 'Device session is no longer active';

/**
 * The one rule for whether a device session named by a credential may still
 * authenticate. A malformed id is never an active session. The two deliberate
 * differences between the call sites are parameters: `read` selects an
 * immediate primary read or the per-instance cached answer, and `refusal`
 * selects whether the caller must treat its credential as rejected.
 */
async function checkDeviceSession(
  deviceSessionId: string,
  kiloUserId: string,
  options: { read: 'primary' | 'cached'; refusal: 'rejected-credential' | 'plain' }
): Promise<{ accepted: true } | { accepted: false; credentialsRejected: boolean }> {
  const active = uuid.safeParse(deviceSessionId).success
    ? options.read === 'primary'
      ? await readActiveDeviceSession(deviceSessionId, kiloUserId)
      : await isDeviceSessionActive(deviceSessionId, kiloUserId, () =>
          readActiveDeviceSession(deviceSessionId, kiloUserId)
        )
    : false;
  if (active) return { accepted: true };
  return { accepted: false, credentialsRejected: options.refusal === 'rejected-credential' };
}

export const uuidSchema = z.uuid();
const uuid = uuidSchema;
// Namespace UUID for generating UUIDs from legacy user IDs
const USER_UUID_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'; // DNS namespace UUID

export function getUserUUID(user: User): string {
  if (uuid.safeParse(user.id).success) {
    return user.id;
  } else {
    return uuidv5(user.id, USER_UUID_NAMESPACE);
  }
}
