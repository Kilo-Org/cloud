import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import type { Owner } from '@/lib/integrations/core/types';
import { captureException, captureMessage } from '@sentry/nextjs';
import {
  exchangeDoltHubOAuthCode,
  upsertDoltHubInstallation,
} from '@/lib/integrations/dolthub-service';
import { verifyOAuthState } from '@/lib/integrations/oauth-state';
import { APP_URL } from '@/lib/constants';

function buildRedirectPath(ownerStr: string | null, queryParam: string): string {
  if (ownerStr?.startsWith('org_')) {
    return `/organizations/${ownerStr.replace('org_', '')}/integrations/dolthub?${queryParam}`;
  }
  if (ownerStr?.startsWith('user_')) {
    return `/integrations/dolthub?${queryParam}`;
  }
  return `/integrations/dolthub?${queryParam}`;
}

/**
 * Fetch the DoltHub user identity from an authenticated endpoint.
 *
 * DoltHub does not yet expose a dedicated `whoami` endpoint, so we call the
 * v1alpha1 profile SQL endpoint as a proof-of-authentication and try to
 * extract any account marker that comes back.
 *
 * TODO: Replace with a proper whoami endpoint once DoltHub exposes one.
 */
async function fetchDoltHubIdentity(accessToken: string): Promise<{ username: string }> {
  try {
    const response = await fetch(
      'https://www.dolthub.com/api/v1alpha1/dolthub/profile?q=select+1',
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    if (!response.ok) {
      return { username: 'pending' };
    }

    const data = (await response.json()) as unknown;

    // Try common shapes: array of rows or { rows: [...] }
    let rows: Array<Record<string, unknown>> | undefined;
    if (Array.isArray(data)) {
      rows = data;
    } else if (data && typeof data === 'object' && 'rows' in data && Array.isArray(data.rows)) {
      rows = data.rows as Array<Record<string, unknown>>;
    }

    const firstRow = rows?.[0];
    const candidate =
      firstRow && typeof firstRow === 'object'
        ? (firstRow.username ?? firstRow.login ?? firstRow.name ?? firstRow.id)
        : undefined;

    const username = typeof candidate === 'string' && candidate.length > 0 ? candidate : 'pending';
    return { username };
  } catch {
    return { username: 'pending' };
  }
}

/**
 * DoltHub OAuth Callback
 *
 * Called when the user completes the DoltHub OAuth authorization flow.
 * Exchanges the authorization code for tokens and stores the integration.
 */
export async function GET(request: NextRequest) {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'Not Found' }, { status: 404 });
  }

  const searchParams = request.nextUrl.searchParams;
  const state = searchParams.get('state');
  const code = searchParams.get('code');
  const error = searchParams.get('error');

  // Verify the state signature once up-front so subsequent redirects can
  // reuse the resulting owner string without re-running HMAC verification
  // on every error branch.
  const verified = state ? verifyOAuthState(state) : null;
  const verifiedOwner = verified?.owner ?? null;

  try {
    const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
    if (authFailedResponse) {
      return NextResponse.redirect(new URL('/users/sign_in', APP_URL));
    }

    if (error) {
      captureMessage('DoltHub OAuth error', {
        level: 'warning',
        tags: { endpoint: 'dolthub/callback', source: 'dolthub_oauth' },
        extra: { error, state },
      });
      return NextResponse.redirect(
        new URL(buildRedirectPath(verifiedOwner, `error=${error}`), APP_URL)
      );
    }

    if (!code) {
      captureMessage('DoltHub callback missing code', {
        level: 'warning',
        tags: { endpoint: 'dolthub/callback', source: 'dolthub_oauth' },
        extra: { state, allParams: Object.fromEntries(searchParams.entries()) },
      });
      return NextResponse.redirect(
        new URL(buildRedirectPath(verifiedOwner, 'error=missing_code'), APP_URL)
      );
    }

    if (!verified) {
      captureMessage('DoltHub callback invalid or tampered state signature', {
        level: 'warning',
        tags: { endpoint: 'dolthub/callback', source: 'dolthub_oauth' },
        extra: { code: '***', state, allParams: Object.fromEntries(searchParams.entries()) },
      });
      return NextResponse.redirect(new URL('/integrations/dolthub?error=invalid_state', APP_URL));
    }

    if (verified.userId !== user.id) {
      captureMessage('DoltHub callback user mismatch (possible CSRF)', {
        level: 'warning',
        tags: { endpoint: 'dolthub/callback', source: 'dolthub_oauth' },
        extra: { stateUserId: verified.userId, sessionUserId: user.id },
      });
      return NextResponse.redirect(new URL('/integrations/dolthub?error=unauthorized', APP_URL));
    }

    let owner: Owner;
    const ownerStr = verified.owner;

    if (ownerStr.startsWith('org_')) {
      owner = { type: 'org', id: ownerStr.replace('org_', '') };
    } else if (ownerStr.startsWith('user_')) {
      owner = { type: 'user', id: ownerStr.replace('user_', '') };
    } else {
      captureMessage('DoltHub callback missing or invalid owner in state', {
        level: 'warning',
        tags: { endpoint: 'dolthub/callback', source: 'dolthub_oauth' },
        extra: { code: '***', owner: ownerStr },
      });
      return NextResponse.redirect(new URL('/integrations/dolthub?error=invalid_state', APP_URL));
    }

    if (owner.type === 'org') {
      await ensureOrganizationAccess({ user }, owner.id);
    } else if (user.id !== owner.id) {
      return NextResponse.redirect(new URL('/integrations/dolthub?error=unauthorized', APP_URL));
    }

    let tokens: Awaited<ReturnType<typeof exchangeDoltHubOAuthCode>>;
    try {
      tokens = await exchangeDoltHubOAuthCode(code);
    } catch (tokenError) {
      captureException(tokenError, {
        tags: {
          endpoint: 'dolthub/callback',
          source: 'dolthub_oauth',
        },
        extra: { owner: ownerStr },
      });
      return NextResponse.redirect(
        new URL(buildRedirectPath(verifiedOwner, 'error=token_exchange_failed'), APP_URL)
      );
    }

    const account = await fetchDoltHubIdentity(tokens.accessToken);

    await upsertDoltHubInstallation({ owner, account, tokens });

    const successPath =
      owner.type === 'org'
        ? `/organizations/${owner.id}/integrations/dolthub`
        : '/integrations/dolthub';

    return NextResponse.redirect(new URL(successPath, APP_URL));
  } catch (unexpectedError) {
    captureException(unexpectedError, {
      tags: {
        endpoint: 'dolthub/callback',
        source: 'dolthub_oauth',
      },
      extra: {
        state,
        hasCode: !!code,
      },
    });

    return NextResponse.redirect(
      new URL(buildRedirectPath(verifiedOwner, 'error=installation_failed'), APP_URL)
    );
  }
}
