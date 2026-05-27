import 'server-only';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { captureException } from '@sentry/nextjs';
import { APP_URL } from '@/lib/constants';
import { getUserFromAuth } from '@/lib/user/server';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import { requireActiveSubscriptionOrTrial } from '@/lib/organizations/trial-middleware';
import { createOAuthState, verifyOAuthState } from '@/lib/integrations/oauth-state';
import { validateReturnPath } from '@/lib/integrations/validate-return-path';
import type { Owner } from '@/lib/integrations/core/types';
import type { StandardOAuthPlatform } from '@/lib/integrations/oauth/paths';

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
  platform: StandardOAuthPlatform,
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
  {
    platform,
    source,
    buildOAuthUrl,
    organizationRoles,
    requireActiveOrganizationSubscription,
  }: HandleStatefulOAuthConnectOptions
): Promise<Response> {
  const organizationId = request.nextUrl.searchParams.get('organizationId');

  try {
    const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
    if (authFailedResponse) {
      return redirectToSignInForOAuthConnect(request);
    }

    const { owner } = await resolveOAuthConnectOwner(request, user, {
      organizationRoles,
      requireActiveOrganizationSubscription,
    });
    const returnToParam = request.nextUrl.searchParams.get('returnTo');
    const returnTo = returnToParam ? validateReturnPath(returnToParam) : null;
    const state = createOAuthState(ownerToOAuthStateOwner(owner), user.id, returnTo ?? undefined);

    return NextResponse.redirect(buildOAuthUrl(state));
  } catch (error) {
    captureException(error, {
      tags: {
        endpoint: `${platform}/connect`,
        source,
      },
      extra: {
        organizationId,
      },
    });

    return NextResponse.redirect(
      new URL(
        buildIntegrationOAuthConnectErrorPath(platform, organizationId, 'oauth_init_failed'),
        APP_URL
      )
    );
  }
}
