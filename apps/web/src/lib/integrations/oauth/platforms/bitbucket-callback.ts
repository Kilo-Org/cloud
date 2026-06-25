import type { NextRequest } from 'next/server';
import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { captureException, captureMessage } from '@sentry/nextjs';
import { APP_URL } from '@/lib/constants';
import type { Owner } from '@/lib/integrations/core/types';
import {
  appendIntegrationOAuthRedirectQuery,
  parseOAuthStateOwner,
} from '@/lib/integrations/oauth/common';
import { verifyOAuthState } from '@/lib/integrations/oauth-state';
import {
  exchangeBitbucketOAuthCode,
  fetchBitbucketUser,
  fetchBitbucketWorkspaces,
} from '@/lib/integrations/platforms/bitbucket/adapter';
import {
  BitbucketIntegrationAuthorizationError,
  BitbucketIntegrationConnectionConflictError,
  storeBitbucketIntegration,
} from '@/lib/integrations/platforms/bitbucket/credentials';
import { scheduleBitbucketRepositoryCachePrime } from '@/lib/integrations/platforms/bitbucket/repository-cache';
import { getUserFromAuth } from '@/lib/user/server';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';

type CallbackState = { owner: string; returnTo?: string };
type CallbackPhase =
  | 'authenticate'
  | 'authorize_owner'
  | 'token_exchange'
  | 'provider_profile'
  | 'store_integration';
type AuthenticatedOAuthUser = Parameters<typeof ensureOrganizationAccess>[0]['user'];

function redirectWithStatus(
  state: CallbackState | null,
  key: 'success' | 'error',
  value: string
): NextResponse {
  const owner = state ? parseOAuthStateOwner(state.owner) : null;
  const defaultPath =
    owner?.type === 'org'
      ? `/organizations/${owner.id}/integrations/bitbucket`
      : '/integrations/bitbucket';
  const path = state?.returnTo
    ? appendIntegrationOAuthRedirectQuery(state.returnTo, `${key}=${encodeURIComponent(value)}`)
    : `${defaultPath}?${key}=${encodeURIComponent(value)}`;
  return NextResponse.redirect(new URL(path, APP_URL));
}

function safeCallbackContext(searchParams: URLSearchParams) {
  const state = searchParams.get('state');
  return {
    hasCode: Boolean(searchParams.get('code')),
    hasState: Boolean(state),
    stateHash: state ? createHash('sha256').update(state).digest('hex').slice(0, 8) : null,
    hasProviderError: Boolean(searchParams.get('error')),
  };
}

function validOAuthCode(code: string | null): string | null {
  if (!code || code.length > 2048 || !/^[A-Za-z0-9._~+/-]+$/.test(code)) return null;
  return code;
}

async function authorizeOwner(owner: Owner, user: AuthenticatedOAuthUser): Promise<void> {
  if (owner.type === 'user') {
    if (owner.id !== user.id) throw new Error('OAuth owner mismatch');
    return;
  }
  await ensureOrganizationAccess({ user }, owner.id, ['owner', 'billing_manager']);
}

export async function handleBitbucketOAuthCallback(request: NextRequest): Promise<Response> {
  const searchParams = request.nextUrl.searchParams;
  const verifiedState = verifyOAuthState(searchParams.get('state'));
  let callbackPhase: CallbackPhase = 'authenticate';

  try {
    const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
    if (authFailedResponse) {
      return NextResponse.redirect(new URL('/users/sign_in', APP_URL));
    }

    if (!verifiedState) {
      captureMessage('Bitbucket OAuth callback invalid state', {
        level: 'warning',
        tags: { endpoint: 'bitbucket/callback', source: 'bitbucket_oauth' },
        extra: safeCallbackContext(searchParams),
      });
      return redirectWithStatus(null, 'error', 'invalid_state');
    }

    const owner = parseOAuthStateOwner(verifiedState.owner);
    if (verifiedState.userId !== user.id || !owner) {
      return redirectWithStatus(verifiedState, 'error', 'unauthorized');
    }
    callbackPhase = 'authorize_owner';
    try {
      await authorizeOwner(owner, user);
    } catch {
      return redirectWithStatus(verifiedState, 'error', 'unauthorized');
    }

    if (searchParams.get('error')) {
      return redirectWithStatus(verifiedState, 'error', 'authorization_cancelled');
    }

    const code = validOAuthCode(searchParams.get('code'));
    if (!code) {
      return redirectWithStatus(verifiedState, 'error', 'missing_code');
    }

    callbackPhase = 'token_exchange';
    const tokens = await exchangeBitbucketOAuthCode(code);
    callbackPhase = 'provider_profile';
    const [bitbucketUser, availableWorkspaces] = await Promise.all([
      fetchBitbucketUser(tokens.accessToken),
      fetchBitbucketWorkspaces(tokens.accessToken),
    ]);
    if (availableWorkspaces.length === 0) {
      return redirectWithStatus(verifiedState, 'error', 'no_workspaces');
    }

    callbackPhase = 'store_integration';
    const storedIntegration = await storeBitbucketIntegration({
      owner,
      authorizedByUserId: user.id,
      bitbucketUser,
      tokens,
      availableWorkspaces,
    });
    if (storedIntegration.status === 'connected') {
      scheduleBitbucketRepositoryCachePrime({
        owner,
        kiloUserId: user.id,
        integrationId: storedIntegration.integrationId,
      });
    }

    return redirectWithStatus(verifiedState, 'success', storedIntegration.status);
  } catch (error) {
    if (error instanceof BitbucketIntegrationAuthorizationError) {
      return redirectWithStatus(verifiedState, 'error', 'unauthorized');
    }
    if (error instanceof BitbucketIntegrationConnectionConflictError) {
      return redirectWithStatus(verifiedState, 'error', 'connection_exists');
    }

    const callbackContext = safeCallbackContext(searchParams);
    if (process.env.NODE_ENV === 'development') {
      console.error('Bitbucket OAuth callback failed', {
        phase: callbackPhase,
        errorName: error instanceof Error ? error.name : 'UnknownError',
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
        ...callbackContext,
      });
    }
    captureException(error, {
      tags: { endpoint: 'bitbucket/callback', source: 'bitbucket_oauth' },
      extra: { phase: callbackPhase, ...callbackContext },
    });
    return redirectWithStatus(verifiedState, 'error', 'connection_failed');
  }
}
