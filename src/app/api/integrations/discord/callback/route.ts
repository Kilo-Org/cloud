import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import type { Owner } from '@/lib/integrations/core/types';
import { captureException, captureMessage } from '@sentry/nextjs';
import { exchangeDiscordCode, upsertDiscordInstallation } from '@/lib/integrations/discord-service';
import { verifyOAuthState } from '@/lib/integrations/oauth-state';
import { APP_URL } from '@/lib/constants';

const buildDiscordRedirectPath = (state: string | null, queryParam: string): string => {
  // Try to extract the owner from a signed state for best-effort redirects on error paths.
  // We use verifyOAuthState so we don't trust unsigned/tampered values for routing.
  const verified = state ? verifyOAuthState(state) : null;
  const owner = verified?.owner;

  if (owner?.startsWith('org_')) {
    return `/organizations/${owner.replace('org_', '')}/integrations/discord?${queryParam}`;
  }
  if (owner?.startsWith('user_')) {
    return `/integrations/discord?${queryParam}`;
  }
  return `/integrations?${queryParam}`;
};

/**
 * Discord OAuth Callback
 *
 * Called when user completes the Discord OAuth flow
 */
export async function GET(request: NextRequest) {
  try {
    // 1. Verify user authentication
    const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
    if (authFailedResponse) {
      return NextResponse.redirect(new URL('/users/sign_in', APP_URL));
    }

    // 2. Extract parameters
    const searchParams = request.nextUrl.searchParams;
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const error = searchParams.get('error');

    // Handle OAuth errors from Discord
    if (error) {
      captureMessage('Discord OAuth error', {
        level: 'warning',
        tags: { endpoint: 'discord/callback', source: 'discord_oauth' },
        extra: { error, state },
      });

      return NextResponse.redirect(
        new URL(buildDiscordRedirectPath(state, `error=${encodeURIComponent(error)}`), APP_URL)
      );
    }

    // Validate code is present
    if (!code) {
      captureMessage('Discord callback missing code', {
        level: 'warning',
        tags: { endpoint: 'discord/callback', source: 'discord_oauth' },
        extra: { state, allParams: Object.fromEntries(searchParams.entries()) },
      });

      return NextResponse.redirect(
        new URL(buildDiscordRedirectPath(state, 'error=missing_code'), APP_URL)
      );
    }

    // 3. Verify signed state (CSRF protection)
    const verified = verifyOAuthState(state);
    if (!verified) {
      captureMessage('Discord callback invalid or tampered state signature', {
        level: 'warning',
        tags: { endpoint: 'discord/callback', source: 'discord_oauth' },
        extra: { code: '***', state, allParams: Object.fromEntries(searchParams.entries()) },
      });
      return NextResponse.redirect(new URL('/integrations?error=invalid_state', APP_URL));
    }

    // 4. Verify the user completing the flow is the same user who initiated it
    if (verified.userId !== user.id) {
      captureMessage('Discord callback user mismatch (possible CSRF)', {
        level: 'warning',
        tags: { endpoint: 'discord/callback', source: 'discord_oauth' },
        extra: { stateUserId: verified.userId, sessionUserId: user.id },
      });
      return NextResponse.redirect(new URL('/integrations?error=unauthorized', APP_URL));
    }

    // 5. Parse owner from verified state payload
    let owner: Owner;
    const ownerStr = verified.owner;

    if (ownerStr.startsWith('org_')) {
      const ownerId = ownerStr.replace('org_', '');
      owner = { type: 'org', id: ownerId };
    } else if (ownerStr.startsWith('user_')) {
      const ownerId = ownerStr.replace('user_', '');
      owner = { type: 'user', id: ownerId };
    } else {
      captureMessage('Discord callback missing or invalid owner in state', {
        level: 'warning',
        tags: { endpoint: 'discord/callback', source: 'discord_oauth' },
        extra: { code: '***', owner: ownerStr },
      });
      return NextResponse.redirect(new URL('/integrations?error=invalid_state', APP_URL));
    }

    // 6. Verify user has access to the owner
    if (owner.type === 'org') {
      await ensureOrganizationAccess({ user }, owner.id);
    } else {
      // For user-owned integrations, verify it's the same user
      if (user.id !== owner.id) {
        return NextResponse.redirect(new URL('/integrations?error=unauthorized', APP_URL));
      }
    }

    // 7. Exchange code for access token
    const oauthData = await exchangeDiscordCode(code);

    // 8. Store installation in database
    await upsertDiscordInstallation(owner, oauthData);

    // 9. Redirect to success page
    const successPath =
      owner.type === 'org'
        ? `/organizations/${owner.id}/integrations/discord?success=installed`
        : `/integrations/discord?success=installed`;

    return NextResponse.redirect(new URL(successPath, APP_URL));
  } catch (error) {
    console.error('Error handling Discord OAuth callback:', error);

    // Capture error to Sentry with context for debugging
    const searchParams = request.nextUrl.searchParams;
    const state = searchParams.get('state');

    captureException(error, {
      tags: {
        endpoint: 'discord/callback',
        source: 'discord_oauth',
      },
      extra: {
        state,
        hasCode: !!searchParams.get('code'),
      },
    });

    return NextResponse.redirect(
      new URL(buildDiscordRedirectPath(state, 'error=installation_failed'), APP_URL)
    );
  }
}
