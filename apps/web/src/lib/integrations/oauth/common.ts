import 'server-only';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { captureException } from '@sentry/nextjs';
import { TRPCError } from '@trpc/server';
import { APP_URL } from '@kilocode/web-shared/lib/constants';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { ensureOrganizationAccess } from '@kilocode/web-shared/routers/organizations/utils';
import { requireActiveSubscriptionOrTrial } from '@kilocode/web-shared/lib/organizations/trial-middleware';
import { createOAuthState, verifyOAuthState } from '@/lib/integrations/oauth-state';
import { APP_SHELL_PREFIX, buildAppShellIntegrationPath } from '@/lib/app-shell/shell-paths';
import { appShellRedirect } from '@/lib/app-shell/redirect';
import { loadAppShellUser } from '@/lib/app-shell/session';
import {
  APP_SHELL_FLOW_COOKIE,
  appShellFlowCookieOptions,
  createAppShellFlowToken,
  verifyAppShellFlowToken,
} from '@/lib/integrations/oauth/app-shell-flow';
import { beginProviderOAuthAttempt } from '@/lib/integrations/provider-oauth-attempts';
import {
  cancelProviderOAuthAttempt,
  type ReservedOAuthProvider,
} from '@/lib/integrations/provider-oauth-attempts';
import { validateReturnPath } from '@/lib/integrations/validate-return-path';
import type { Owner } from '@/lib/integrations/core/types';
import type { RetainedOAuthPlatform, StandardOAuthPlatform } from '@/lib/integrations/oauth/paths';

/**
 * Maps an organization-access denial to a user-facing OAuth error code.
 * `ensureOrganizationAccess` throws the same UNAUTHORIZED code for both
 * "no membership" and "insufficient role", so the message distinguishes them.
 * Returns null when the error is not an expected access denial.
 */
export function organizationAccessDenialErrorCode(error: unknown): string | null {
  if (!(error instanceof TRPCError) || error.code !== 'UNAUTHORIZED') return null;
  if (error.message === 'You do not have access to this organization') {
    return 'organization_access_required';
  }
  return 'permission_required';
}

type AuthenticatedOAuthUser = Parameters<typeof ensureOrganizationAccess>[0]['user'];

export type ResolveConnectOwnerOptions = {
  organizationRoles?: Parameters<typeof ensureOrganizationAccess>[2];
  requireActiveOrganizationSubscription?: boolean;
};

export type HandleStatefulOAuthConnectOptions = ResolveConnectOwnerOptions & {
  platform: StandardOAuthPlatform;
  source: string;
  buildOAuthUrl: (state: string) => string;
};

export type StartStatefulOAuthConnectOptions = HandleStatefulOAuthConnectOptions & {
  /** The caller the flow is minted for; the shell supplies its own session. */
  user: AuthenticatedOAuthUser;
  /**
   * Set when the app shell started the flow: the state says so, every redirect
   * stays on the shell page that owns the connection, and the callback may
   * identify the user from the state itself.
   */
  appShell?: boolean;
};

function ownerToOAuthStateOwner(owner: Owner): string {
  return owner.type === 'org' ? `org_${owner.id}` : `user_${owner.id}`;
}

export function appendIntegrationOAuthRedirectQuery(path: string, queryParam: string): string {
  const hashIndex = path.indexOf('#');
  const pathWithoutHash = hashIndex === -1 ? path : path.slice(0, hashIndex);
  const hash = hashIndex === -1 ? '' : path.slice(hashIndex);

  return `${pathWithoutHash}${pathWithoutHash.includes('?') ? '&' : '?'}${queryParam}${hash}`;
}

export function parseOAuthStateOwner(owner: string): Owner | null {
  if (owner.startsWith('org_') && owner.length > 'org_'.length) {
    return { type: 'org', id: owner.slice('org_'.length) };
  }

  if (owner.startsWith('user_') && owner.length > 'user_'.length) {
    return { type: 'user', id: owner.slice('user_'.length) };
  }

  return null;
}

export async function cancelMissingCodeProviderOAuthAttempt(input: {
  state: string | null;
  user: AuthenticatedOAuthUser;
  provider: ReservedOAuthProvider;
}): Promise<boolean> {
  const verified = verifyOAuthState(input.state);
  if (!input.state || !verified || verified.purpose !== 'provider_install') return false;
  if (verified.userId !== input.user.id) return false;
  const owner = parseOAuthStateOwner(verified.owner);
  if (!owner) return false;
  if (owner.type === 'org') await ensureOrganizationAccess({ user: input.user }, owner.id);
  else if (owner.id !== input.user.id) return false;
  return cancelProviderOAuthAttempt({
    actorUserId: input.user.id,
    owner,
    provider: input.provider,
    state: input.state,
    purpose: 'provider_install',
  });
}

export function buildIntegrationOAuthRedirectPath(
  platform: StandardOAuthPlatform,
  owner: Owner | null | undefined,
  queryParam: string,
  returnTo?: string
): string {
  if (returnTo) {
    return appendIntegrationOAuthRedirectQuery(returnTo, queryParam);
  }

  if (owner?.type === 'org') {
    return `/organizations/${owner.id}/integrations/${platform}?${queryParam}`;
  }

  if (owner?.type === 'user') {
    return `/integrations/${platform}?${queryParam}`;
  }

  return `/integrations?${queryParam}`;
}

export function buildIntegrationOAuthRedirectPathFromOwner(
  platform: StandardOAuthPlatform,
  owner: string | null | undefined,
  queryParam: string,
  returnTo?: string
): string {
  return buildIntegrationOAuthRedirectPath(
    platform,
    owner ? parseOAuthStateOwner(owner) : null,
    queryParam,
    returnTo
  );
}

export function buildIntegrationOAuthRedirectPathFromState(
  platform: StandardOAuthPlatform,
  state: string | null,
  queryParam: string
): string {
  const verified = state ? verifyOAuthState(state) : null;

  return buildIntegrationOAuthRedirectPathFromOwner(
    platform,
    verified?.owner,
    queryParam,
    verified?.returnTo
  );
}

export function buildIntegrationOAuthConnectErrorPath(
  platform: RetainedOAuthPlatform,
  organizationId: string | null | undefined,
  errorCode: string
): string {
  const queryParam = `error=${encodeURIComponent(errorCode)}`;

  if (organizationId) {
    return `/organizations/${organizationId}/integrations/${platform}?${queryParam}`;
  }

  return `/integrations/${platform}?${queryParam}`;
}

export function redirectToSignInForOAuthConnect(
  request: NextRequest,
  callbackPath = `${request.nextUrl.pathname}${request.nextUrl.search}`
): Response {
  const signInUrl = new URL('/users/sign_in', request.url);
  signInUrl.searchParams.set('callbackPath', callbackPath);
  return NextResponse.redirect(signInUrl);
}

export async function resolveOAuthConnectOwner(
  request: NextRequest,
  user: AuthenticatedOAuthUser,
  options: ResolveConnectOwnerOptions = {}
): Promise<{ owner: Owner; organizationId: string | null }> {
  const organizationId = request.nextUrl.searchParams.get('organizationId');

  if (!organizationId) {
    return {
      owner: { type: 'user', id: user.id },
      organizationId: null,
    };
  }

  await ensureOrganizationAccess({ user }, organizationId, options.organizationRoles);

  if (options.requireActiveOrganizationSubscription) {
    await requireActiveSubscriptionOrTrial(organizationId);
  }

  return {
    owner: { type: 'org', id: organizationId },
    organizationId,
  };
}

export async function handleStatefulPlatformOAuthConnect(
  request: NextRequest,
  options: HandleStatefulOAuthConnectOptions
): Promise<Response> {
  try {
    const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
    if (authFailedResponse) {
      return redirectToSignInForOAuthConnect(request);
    }
    return await startStatefulOAuthConnect(request, { ...options, user });
  } catch (error) {
    return oauthConnectFailure(request, options.platform, error, options.source);
  }
}

/**
 * Starts the provider dance for an already-identified caller. The web entry
 * point supplies the web session's user; the app shell supplies the shell
 * session's user and `appShell`, which keeps the flow inside the shell.
 */
export async function startStatefulOAuthConnect(
  request: NextRequest,
  options: StartStatefulOAuthConnectOptions
): Promise<Response> {
  const {
    user,
    appShell,
    platform,
    buildOAuthUrl,
    organizationRoles,
    requireActiveOrganizationSubscription,
  } = options;
  const organizationId = request.nextUrl.searchParams.get('organizationId');
  const { owner } = await resolveOAuthConnectOwner(request, user, {
    organizationRoles,
    requireActiveOrganizationSubscription,
  });
  const returnToParam = request.nextUrl.searchParams.get('returnTo');
  const returnTo = appShell
    ? buildAppShellIntegrationPath(platform, organizationId ?? undefined)
    : returnToParam
      ? validateReturnPath(returnToParam)
      : null;
  const state = createOAuthState(ownerToOAuthStateOwner(owner), user.id, returnTo ?? undefined, {
    provider: platform,
    appShell,
    ...(platform === 'slack' || platform === 'linear' || platform === 'discord'
      ? { purpose: 'provider_install' as const }
      : {}),
  });
  if (platform === 'slack' || platform === 'linear' || platform === 'discord') {
    await beginProviderOAuthAttempt({
      actorUserId: user.id,
      owner,
      provider: platform,
      state,
      purpose: 'provider_install',
    });
  }

  const response = NextResponse.redirect(buildOAuthUrl(state));
  if (appShell) {
    response.cookies.set(
      APP_SHELL_FLOW_COOKIE,
      createAppShellFlowToken({ userId: user.id, state }),
      appShellFlowCookieOptions()
    );
  }
  return response;
}

/** Reports a connect that could not start and returns its user-facing reason. */
function reportOAuthConnectFailure(
  platform: string,
  error: unknown,
  source: string,
  organizationId: string | null
): string | null {
  const denialCode = organizationAccessDenialErrorCode(error);
  if (!denialCode) {
    captureException(error, {
      tags: {
        endpoint: `${platform}/connect`,
        source,
      },
      extra: {
        organizationId,
      },
    });
  }

  return denialCode;
}

/**
 * The redirect an aborted connect lands on: the shell page when the shell
 * started it, the full web page otherwise.
 */
function oauthConnectFailure(
  request: NextRequest,
  platform: RetainedOAuthPlatform,
  error: unknown,
  source: string
): Response {
  const organizationId = request.nextUrl.searchParams.get('organizationId');
  const errorCode =
    reportOAuthConnectFailure(platform, error, source, organizationId) ?? 'oauth_init_failed';

  if (request.nextUrl.pathname.startsWith(APP_SHELL_PREFIX)) {
    return appShellConnectFailureRedirect(platform, organizationId, errorCode);
  }

  return NextResponse.redirect(
    new URL(buildIntegrationOAuthConnectErrorPath(platform, organizationId, errorCode), APP_URL)
  );
}

/**
 * The shell's own failure outcome. The shell connect route resolves its session
 * itself, so it cannot use `handleStatefulPlatformOAuthConnect`'s catch and
 * calls this instead: an error becomes the shell page that renders the reason,
 * never a framework error page.
 */
export function respondToAppShellOAuthConnectFailure(
  request: NextRequest,
  platform: string,
  error: unknown,
  source: string
): Response {
  const organizationId = request.nextUrl.searchParams.get('organizationId');
  const errorCode =
    reportOAuthConnectFailure(platform, error, source, organizationId) ?? 'oauth_init_failed';
  return appShellConnectFailureRedirect(platform, organizationId, errorCode);
}

function appShellConnectFailureRedirect(
  platform: string,
  organizationId: string | null | undefined,
  errorCode: string
): Response {
  return appShellRedirect(
    appendIntegrationOAuthRedirectQuery(
      buildAppShellIntegrationPath(platform, organizationId ?? undefined),
      `error=${encodeURIComponent(errorCode)}`
    )
  );
}

export type OAuthCallbackActor =
  | { status: 'web_session'; user: AuthenticatedOAuthUser }
  | { status: 'app_shell'; user: AuthenticatedOAuthUser }
  | { status: 'unauthenticated' };

/**
 * Who is completing this OAuth callback.
 *
 * A web session wins when there is one. Otherwise only a state the app shell
 * minted can identify the caller, and only together with the flow cookie the
 * shell's connect route set for that exact state — so a callback URL on its own
 * never acts as a login. The state names a user id, so it runs the same account
 * gates the web session path runs before it becomes an actor. Callbacks
 * re-check organization membership from the database for whichever user this
 * returns.
 */
export async function resolveOAuthCallbackActor(input: {
  request: NextRequest;
  rawState: string | null;
  verified: { userId: string; appShell?: boolean } | null;
}): Promise<OAuthCallbackActor> {
  const { user } = await getUserFromAuth({ adminOnly: false });
  if (user) return { status: 'web_session', user };

  if (!input.verified?.appShell || !input.rawState) return { status: 'unauthenticated' };

  const flow = verifyAppShellFlowToken(input.request, input.rawState);
  if (!flow || flow.userId !== input.verified.userId) return { status: 'unauthenticated' };

  const lookup = await loadAppShellUser(input.verified.userId);
  return lookup.status === 'active'
    ? { status: 'app_shell', user: lookup.user }
    : { status: 'unauthenticated' };
}

/**
 * Where a failed OAuth callback lands. A browser that carries the shell's flow
 * cookie gets the shell's terminal page instead of the full web app's hub.
 */
export function oauthCallbackRedirectPath(request: NextRequest, webPath: string): string {
  if (request.cookies.has(APP_SHELL_FLOW_COOKIE)) return `${APP_SHELL_PREFIX}/expired`;
  return webPath;
}
