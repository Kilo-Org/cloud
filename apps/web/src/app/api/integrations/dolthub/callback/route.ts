import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import type { Owner } from '@/lib/integrations/core/types';
import { captureException, captureMessage } from '@sentry/nextjs';
import { IS_DEVELOPMENT } from '@/lib/constants';
import {
  exchangeDoltHubOAuthCode,
  upsertDoltHubInstallation,
} from '@/lib/integrations/dolthub-service';
import { verifyOAuthState } from '@/lib/integrations/oauth-state';
import { APP_URL } from '@/lib/constants';

function buildDoltHubRedirectPath(state: string | null, queryParam: string): string {
  const verified = state ? verifyOAuthState(state) : null;
  const owner = verified?.owner;

  if (owner?.startsWith('org_')) {
    return `/organizations/${owner.replace('org_', '')}/integrations/dolthub?${queryParam}`;
  }
  if (owner?.startsWith('user_')) {
    return `/integrations/dolthub?${queryParam}`;
  }
  return `/integrations?${queryParam}`;
}

/**
 * DoltHub OAuth Callback
 *
 * Called when user completes the DoltHub OAuth flow.
 * Exchanges the authorization code for tokens and stores the integration.
 */
export async function GET(request: NextRequest) {
  if (!IS_DEVELOPMENT) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  try {
    const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
    if (authFailedResponse) {
      return NextResponse.redirect(new URL('/users/sign_in', APP_URL));
    }

    const searchParams = request.nextUrl.searchParams;
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const error = searchParams.get('error');

    if (error) {
      captureMessage('DoltHub OAuth error', {
        level: 'warning',
        tags: { endpoint: 'dolthub/callback', source: 'dolthub_oauth' },
        extra: { error, state },
      });

      return NextResponse.redirect(
        new URL(buildDoltHubRedirectPath(state, `error=${encodeURIComponent(error)}`), APP_URL)
      );
    }

    // Build a redacted copy of the callback query params so we never write
    // the raw `code` (a short-lived credential) into Sentry/logs even if a
    // future change adds another logging path here.
    const redactedParams = Object.fromEntries(
      Array.from(searchParams.entries()).map(([k, v]) => [k, k === 'code' ? '***' : v])
    );

    if (!code) {
      captureMessage('DoltHub callback missing code', {
        level: 'warning',
        tags: { endpoint: 'dolthub/callback', source: 'dolthub_oauth' },
        extra: { state, allParams: redactedParams },
      });

      return NextResponse.redirect(
        new URL(buildDoltHubRedirectPath(state, 'error=missing_code'), APP_URL)
      );
    }

    const verified = verifyOAuthState(state);
    if (!verified) {
      captureMessage('DoltHub callback invalid or tampered state signature', {
        level: 'warning',
        tags: { endpoint: 'dolthub/callback', source: 'dolthub_oauth' },
        extra: { code: '***', state, allParams: redactedParams },
      });
      return NextResponse.redirect(new URL('/integrations?error=invalid_state', APP_URL));
    }

    if (verified.userId !== user.id) {
      captureMessage('DoltHub callback user mismatch (possible CSRF)', {
        level: 'warning',
        tags: { endpoint: 'dolthub/callback', source: 'dolthub_oauth' },
        extra: { stateUserId: verified.userId, sessionUserId: user.id },
      });
      return NextResponse.redirect(new URL('/integrations?error=unauthorized', APP_URL));
    }

    let owner: Owner;
    const ownerStr = verified.owner;

    if (ownerStr.startsWith('org_')) {
      const ownerId = ownerStr.replace('org_', '');
      owner = { type: 'org', id: ownerId };
    } else if (ownerStr.startsWith('user_')) {
      const ownerId = ownerStr.replace('user_', '');
      owner = { type: 'user', id: ownerId };
    } else {
      captureMessage('DoltHub callback missing or invalid owner in state', {
        level: 'warning',
        tags: { endpoint: 'dolthub/callback', source: 'dolthub_oauth' },
        extra: { code: '***', owner: ownerStr },
      });
      return NextResponse.redirect(new URL('/integrations?error=invalid_state', APP_URL));
    }

    if (owner.type === 'org') {
      await ensureOrganizationAccess({ user }, owner.id);
    } else if (user.id !== owner.id) {
      return NextResponse.redirect(new URL('/integrations?error=unauthorized', APP_URL));
    }

    const tokens = await exchangeDoltHubOAuthCode(code);

    await upsertDoltHubInstallation({
      owner,
      tokens,
    });

    const successPath =
      owner.type === 'org'
        ? `/organizations/${owner.id}/integrations/dolthub?success=installed`
        : `/integrations/dolthub?success=installed`;

    return NextResponse.redirect(new URL(successPath, APP_URL));
  } catch (error) {
    console.error('Error handling DoltHub OAuth callback:', error);

    const searchParams = request.nextUrl.searchParams;
    const state = searchParams.get('state');

    captureException(error, {
      tags: {
        endpoint: 'dolthub/callback',
        source: 'dolthub_oauth',
      },
      extra: {
        state,
        hasCode: !!searchParams.get('code'),
      },
    });

    return NextResponse.redirect(
      new URL(buildDoltHubRedirectPath(state, 'error=installation_failed'), APP_URL)
    );
  }
}
