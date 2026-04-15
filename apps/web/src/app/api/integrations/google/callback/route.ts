import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { captureException, captureMessage } from '@sentry/nextjs';
import { APP_URL } from '@/lib/constants';
import { getUserFromAuth } from '@/lib/user.server';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import { getInstanceById } from '@/lib/kiloclaw/instance-registry';
import {
  exchangeGoogleOAuthCode,
  upsertGoogleOAuthIntegration,
} from '@/lib/integrations/google-service';
import { verifyGoogleOAuthState } from '@/lib/integrations/google/oauth-state';

function buildGoogleRedirectPath(state: string | null, queryParam: string): string {
  const verified = verifyGoogleOAuthState(state);
  const owner = verified?.owner;

  if (owner?.type === 'org') {
    return `/organizations/${owner.id}/integrations?${queryParam}`;
  }

  if (owner?.type === 'user') {
    return `/integrations?${queryParam}`;
  }

  return `/integrations?${queryParam}`;
}

/**
 * Google OAuth callback.
 *
 * Validates signed state, exchanges authorization code for tokens, and stores
 * encrypted token linkage in `platform_integrations`.
 */
export async function GET(request: NextRequest) {
  try {
    const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
    if (authFailedResponse) {
      return NextResponse.redirect(new URL('/users/sign_in', APP_URL));
    }

    const searchParams = request.nextUrl.searchParams;
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const error = searchParams.get('error');
    const errorDescription = searchParams.get('error_description');

    if (error) {
      captureMessage('Google OAuth error', {
        level: 'warning',
        tags: { endpoint: 'google/callback', source: 'google_oauth' },
        extra: { error, errorDescription, state },
      });

      const errorCode = encodeURIComponent(errorDescription || error);
      return NextResponse.redirect(
        new URL(buildGoogleRedirectPath(state, `error=${errorCode}`), APP_URL)
      );
    }

    if (!code) {
      captureMessage('Google callback missing code', {
        level: 'warning',
        tags: { endpoint: 'google/callback', source: 'google_oauth' },
        extra: { state, allParams: Object.fromEntries(searchParams.entries()) },
      });

      return NextResponse.redirect(
        new URL(buildGoogleRedirectPath(state, 'error=missing_code'), APP_URL)
      );
    }

    const verifiedState = verifyGoogleOAuthState(state);
    if (!verifiedState) {
      captureMessage('Google callback invalid or tampered state', {
        level: 'warning',
        tags: { endpoint: 'google/callback', source: 'google_oauth' },
        extra: { state, allParams: Object.fromEntries(searchParams.entries()) },
      });
      return NextResponse.redirect(new URL('/integrations?error=invalid_state', APP_URL));
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

      return NextResponse.redirect(new URL('/integrations?error=unauthorized', APP_URL));
    }

    if (verifiedState.owner.type === 'org') {
      await ensureOrganizationAccess({ user }, verifiedState.owner.id);
    } else if (verifiedState.owner.id !== user.id) {
      return NextResponse.redirect(new URL('/integrations?error=unauthorized', APP_URL));
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
        new URL(buildGoogleRedirectPath(state, 'error=missing_instance'), APP_URL)
      );
    }

    const isUserOwnerMatch =
      verifiedState.owner.type === 'user' &&
      instance.userId === user.id &&
      instance.organizationId === null;

    const isOrgOwnerMatch =
      verifiedState.owner.type === 'org' &&
      instance.userId === user.id &&
      instance.organizationId === verifiedState.owner.id;

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

      return NextResponse.redirect(new URL('/integrations?error=unauthorized', APP_URL));
    }

    const oauthData = await exchangeGoogleOAuthCode(code, verifiedState.capabilities);

    await upsertGoogleOAuthIntegration({
      owner: verifiedState.owner,
      createdByUserId: user.id,
      instanceId: verifiedState.instanceId,
      googleSubject: oauthData.googleSubject,
      googleEmail: oauthData.googleEmail,
      grantedScopes: oauthData.grantedScopes,
      capabilities: verifiedState.capabilities,
      refreshToken: oauthData.refreshToken,
    });

    const successPath =
      verifiedState.owner.type === 'org'
        ? `/organizations/${verifiedState.owner.id}/integrations?success=google_connected`
        : '/integrations?success=google_connected';

    return NextResponse.redirect(new URL(successPath, APP_URL));
  } catch (error) {
    console.error('Error handling Google OAuth callback:', error);

    const state = request.nextUrl.searchParams.get('state');

    captureException(error, {
      tags: {
        endpoint: 'google/callback',
        source: 'google_oauth',
      },
      extra: {
        state,
        hasCode: !!request.nextUrl.searchParams.get('code'),
      },
    });

    return NextResponse.redirect(
      new URL(buildGoogleRedirectPath(state, 'error=connection_failed'), APP_URL)
    );
  }
}
