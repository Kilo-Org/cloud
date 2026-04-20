import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { captureException, captureMessage } from '@sentry/nextjs';
import { APP_URL } from '@/lib/constants';
import { getUserFromAuth } from '@/lib/user.server';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import { getInstanceById } from '@/lib/kiloclaw/instance-registry';
import { exchangeGoogleOAuthCode } from '@/lib/integrations/google-service';
import {
  type VerifiedGoogleOAuthState,
  verifyGoogleOAuthState,
} from '@/lib/integrations/google/oauth-state';
import { upsertKiloClawGoogleOAuthConnection } from '@/lib/kiloclaw/google-oauth-connections';
import { KiloClawInternalClient } from '@/lib/kiloclaw/kiloclaw-internal-client';

function buildGoogleRedirectPath(
  owner: VerifiedGoogleOAuthState['owner'] | null | undefined,
  queryParam: string
): string {
  if (owner?.type === 'org') {
    return `/organizations/${owner.id}/claw/settings?${queryParam}`;
  }

  if (owner?.type === 'user') {
    return `/claw/settings?${queryParam}`;
  }

  return `/claw/settings?${queryParam}`;
}

function sanitizeOAuthProviderError(
  error: string | null,
  errorDescription: string | null
): string | null {
  const source = errorDescription ?? error;
  if (!source) return null;
  const normalized = source.trim();
  if (!normalized) return null;

  if (!/^[A-Za-z0-9 _.:/-]{1,200}$/.test(normalized)) {
    return 'oauth_error';
  }

  return encodeURIComponent(normalized);
}

function sanitizeOAuthCode(code: string | null): string | null {
  if (!code) return null;
  const normalized = code.trim();
  if (!normalized || normalized.length > 2048) return null;
  if (!/^[A-Za-z0-9._~+\-/]+$/.test(normalized)) return null;
  return normalized;
}

function oauthSentryContext(searchParams: URLSearchParams): {
  hasCode: boolean;
  hasState: boolean;
  stateHash: string | null;
  error: string | null;
  errorDescription: string | null;
} {
  const state = searchParams.get('state');
  return {
    hasCode: !!searchParams.get('code'),
    hasState: !!state,
    stateHash: state ? createHash('sha256').update(state).digest('hex').slice(0, 8) : null,
    error: searchParams.get('error'),
    errorDescription: searchParams.get('error_description'),
  };
}

/**
 * Google OAuth callback.
 *
 * Validates signed state, exchanges authorization code for tokens, and stores
 * encrypted token linkage in KiloClaw-owned OAuth storage.
 */
export async function GET(request: NextRequest) {
  try {
    const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
    if (authFailedResponse) {
      return NextResponse.redirect(new URL('/users/sign_in', APP_URL));
    }

    const searchParams = request.nextUrl.searchParams;
    const state = searchParams.get('state');
    const code = searchParams.get('code');
    const error = searchParams.get('error');
    const errorDescription = searchParams.get('error_description');

    const verifiedState = verifyGoogleOAuthState(state);
    if (!verifiedState) {
      captureMessage('Google callback invalid or tampered state', {
        level: 'warning',
        tags: { endpoint: 'google/callback', source: 'google_oauth' },
        extra: oauthSentryContext(searchParams),
      });
      return NextResponse.redirect(new URL('/claw/settings?error=invalid_state', APP_URL));
    }

    if (verifiedState.userId !== user.id) {
      captureMessage('Google callback user mismatch (possible CSRF)', {
        level: 'warning',
        tags: { endpoint: 'google/callback', source: 'google_oauth' },
        extra: {
          stateUserId: verifiedState.userId,
          sessionUserId: user.id,
        },
      });

      return NextResponse.redirect(new URL('/claw/settings?error=unauthorized', APP_URL));
    }

    if (verifiedState.owner.type === 'org') {
      await ensureOrganizationAccess({ user }, verifiedState.owner.id);
    } else if (verifiedState.owner.id !== user.id) {
      return NextResponse.redirect(new URL('/claw/settings?error=unauthorized', APP_URL));
    }

    const oauthErrorCode = sanitizeOAuthProviderError(error, errorDescription);
    if (oauthErrorCode) {
      captureMessage('Google OAuth error', {
        level: 'warning',
        tags: { endpoint: 'google/callback', source: 'google_oauth' },
        extra: oauthSentryContext(searchParams),
      });

      return NextResponse.redirect(
        new URL(buildGoogleRedirectPath(verifiedState.owner, `error=${oauthErrorCode}`), APP_URL)
      );
    }

    const oauthCode = sanitizeOAuthCode(code);
    if (!oauthCode) {
      captureMessage('Google callback missing code', {
        level: 'warning',
        tags: { endpoint: 'google/callback', source: 'google_oauth' },
        extra: oauthSentryContext(searchParams),
      });

      return NextResponse.redirect(
        new URL(buildGoogleRedirectPath(verifiedState.owner, 'error=missing_code'), APP_URL)
      );
    }

    const instance = await getInstanceById(verifiedState.instanceId);
    if (!instance) {
      captureMessage('Google callback missing target instance', {
        level: 'warning',
        tags: { endpoint: 'google/callback', source: 'google_oauth' },
        extra: {
          instanceId: verifiedState.instanceId,
          owner: verifiedState.owner,
          userId: user.id,
        },
      });

      return NextResponse.redirect(
        new URL(buildGoogleRedirectPath(verifiedState.owner, 'error=missing_instance'), APP_URL)
      );
    }

    const isUserOwnerMatch =
      verifiedState.owner.type === 'user' &&
      instance.userId === user.id &&
      instance.organizationId === null;

    const isOrgOwnerMatch =
      verifiedState.owner.type === 'org' && instance.organizationId === verifiedState.owner.id;

    if (!isUserOwnerMatch && !isOrgOwnerMatch) {
      captureMessage('Google callback owner/instance mismatch', {
        level: 'warning',
        tags: { endpoint: 'google/callback', source: 'google_oauth' },
        extra: {
          owner: verifiedState.owner,
          instanceId: instance.id,
          instanceUserId: instance.userId,
          instanceOrgId: instance.organizationId,
          userId: user.id,
        },
      });

      return NextResponse.redirect(new URL('/claw/settings?error=unauthorized', APP_URL));
    }

    const oauthData = await exchangeGoogleOAuthCode(oauthCode, verifiedState.capabilities);

    const persisted = await upsertKiloClawGoogleOAuthConnection({
      instanceId: verifiedState.instanceId,
      accountSubject: oauthData.googleSubject,
      accountEmail: oauthData.googleEmail,
      scopes: oauthData.grantedScopes,
      capabilities: verifiedState.capabilities,
      refreshToken: oauthData.refreshToken,
    });

    const kiloclawClient = new KiloClawInternalClient();
    await kiloclawClient.updateGoogleOAuthConnection(
      user.id,
      {
        googleOAuthConnection: {
          status: persisted.status,
          accountEmail: persisted.accountEmail,
          accountSubject: oauthData.googleSubject,
          scopes: persisted.scopes,
          capabilities: persisted.capabilities,
        },
      },
      verifiedState.instanceId
    );

    const successPath =
      verifiedState.owner.type === 'org'
        ? `/organizations/${verifiedState.owner.id}/claw/settings?success=google_connected`
        : '/claw/settings?success=google_connected';

    return NextResponse.redirect(new URL(successPath, APP_URL));
  } catch (error) {
    console.error('Error handling Google OAuth callback:', error);

    const state = request.nextUrl.searchParams.get('state');

    captureException(error, {
      tags: {
        endpoint: 'google/callback',
        source: 'google_oauth',
      },
      extra: oauthSentryContext(request.nextUrl.searchParams),
    });

    return NextResponse.redirect(
      new URL(
        buildGoogleRedirectPath(verifyGoogleOAuthState(state)?.owner, 'error=connection_failed'),
        APP_URL
      )
    );
  }
}
