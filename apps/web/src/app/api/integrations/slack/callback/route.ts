import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import type { Owner } from '@/lib/integrations/core/types';
import { captureException, captureMessage } from '@sentry/nextjs';
import { upsertSlackInstallation } from '@/lib/integrations/slack-service';
import { verifyOAuthState } from '@/lib/integrations/oauth-state';
import { APP_URL } from '@/lib/constants';
import { bot } from '@/lib/bot';

const SLACK_REDIRECT_URI = `${APP_URL}/api/integrations/slack/callback`;

const buildSlackRedirectPath = (state: string | null, queryParam: string): string => {
  const verified = state ? verifyOAuthState(state) : null;
  const owner = verified?.owner;

  if (owner?.startsWith('org_')) {
    return `/organizations/${owner.replace('org_', '')}/integrations/slack?${queryParam}`;
  }
  if (owner?.startsWith('user_')) {
    return `/integrations/slack?${queryParam}`;
  }
  return `/integrations?${queryParam}`;
};

/**
 * Slack OAuth Callback
 *
 * Called when user completes the Slack OAuth flow
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

    // Handle OAuth errors from Slack
    if (error) {
      captureMessage('Slack OAuth error', {
        level: 'warning',
        tags: { endpoint: 'slack/callback', source: 'slack_oauth' },
        extra: { error, state },
      });

      return NextResponse.redirect(
        new URL(buildSlackRedirectPath(state, `error=${error}`), APP_URL)
      );
    }

    // Validate code is present
    if (!code) {
      captureMessage('Slack callback missing code', {
        level: 'warning',
        tags: { endpoint: 'slack/callback', source: 'slack_oauth' },
        extra: { state, allParams: Object.fromEntries(searchParams.entries()) },
      });

      return NextResponse.redirect(
        new URL(buildSlackRedirectPath(state, 'error=missing_code'), APP_URL)
      );
    }

    // 3. Verify signed state (CSRF protection)
    const verified = verifyOAuthState(state);
    if (!verified) {
      captureMessage('Slack callback invalid or tampered state signature', {
        level: 'warning',
        tags: { endpoint: 'slack/callback', source: 'slack_oauth' },
        extra: { code: '***', state, allParams: Object.fromEntries(searchParams.entries()) },
      });
      return NextResponse.redirect(new URL('/integrations?error=invalid_state', APP_URL));
    }

    // 4. Verify the user completing the flow is the same user who initiated it
    if (verified.userId !== user.id) {
      captureMessage('Slack callback user mismatch (possible CSRF)', {
        level: 'warning',
        tags: { endpoint: 'slack/callback', source: 'slack_oauth' },
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
      captureMessage('Slack callback missing or invalid owner in state', {
        level: 'warning',
        tags: { endpoint: 'slack/callback', source: 'slack_oauth' },
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

    // 7. Let the Chat SDK exchange the code and seed its installation state
    await bot.initialize();
    const slackAdapter = bot.getAdapter('slack');
    const url = new URL(request.url);
    url.searchParams.set('redirect_uri', SLACK_REDIRECT_URI);
    const patchedRequest = new Request(url, request);
    const { teamId, installation } = await slackAdapter.handleOAuthCallback(patchedRequest);

    // 8. Store installation in database
    await upsertSlackInstallation({ owner, teamId, installation });

    // 9. Redirect to success page
    const successPath =
      owner.type === 'org'
        ? `/organizations/${owner.id}/integrations/slack?success=installed`
        : `/integrations/slack?success=installed`;

    return NextResponse.redirect(new URL(successPath, APP_URL));
  } catch (error) {
    console.error('Error handling Slack OAuth callback:', error);

    // Capture error to Sentry with context for debugging
    const searchParams = request.nextUrl.searchParams;
    const state = searchParams.get('state');

    captureException(error, {
      tags: {
        endpoint: 'slack/callback',
        source: 'slack_oauth',
      },
      extra: {
        state,
        hasCode: !!searchParams.get('code'),
      },
    });

    return NextResponse.redirect(
      new URL(buildSlackRedirectPath(state, 'error=installation_failed'), APP_URL)
    );
  }
}
