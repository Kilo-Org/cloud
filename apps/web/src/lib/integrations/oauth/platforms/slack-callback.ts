import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user/server';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import { captureException, captureMessage } from '@sentry/nextjs';
import {
  activateReservedSlackInstallation,
  completePendingSlackDeletion,
  SlackWorkspaceAlreadyConnectedError,
} from '@/lib/integrations/slack-service';
import { isLegacyProviderOAuthState, verifyOAuthState } from '@/lib/integrations/oauth-state';
import { APP_URL } from '@/lib/constants';
import { bot } from '@/lib/bot';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { getPlatformOAuthCallbackUrl } from '@/lib/integrations/oauth/urls';
import {
  appendIntegrationOAuthRedirectQuery,
  buildIntegrationOAuthRedirectPath,
  buildIntegrationOAuthRedirectPathFromState,
  parseOAuthStateOwner,
  cancelMissingCodeProviderOAuthAttempt,
} from '@/lib/integrations/oauth/common';
import {
  claimLegacySlackProviderInstallation,
  claimSlackProviderInstallation,
} from '@/lib/integrations/provider-installation-reservations';
import { exchangeSlackOAuthCode } from '@/lib/integrations/platforms/slack/oauth-exchange';

const SLACK_REDIRECT_URI = getPlatformOAuthCallbackUrl(PLATFORM.SLACK);

/**
 * Slack OAuth Callback
 *
 * Called when user completes the Slack OAuth flow
 */
export async function handleSlackOAuthCallback(request: NextRequest) {
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
      await cancelMissingCodeProviderOAuthAttempt({ state, user, provider: 'slack' });
      captureMessage('Slack OAuth error', {
        level: 'warning',
        tags: { endpoint: 'slack/callback', source: 'slack_oauth' },
        extra: { error, state },
      });

      return NextResponse.redirect(
        new URL(
          buildIntegrationOAuthRedirectPathFromState(
            PLATFORM.SLACK,
            state,
            `error=${encodeURIComponent(error)}`
          ),
          APP_URL
        )
      );
    }

    // Validate code is present
    if (!code) {
      await cancelMissingCodeProviderOAuthAttempt({ state, user, provider: 'slack' });
      captureMessage('Slack callback missing code', {
        level: 'warning',
        tags: { endpoint: 'slack/callback', source: 'slack_oauth' },
        extra: { state, allParams: Object.fromEntries(searchParams.entries()) },
      });

      return NextResponse.redirect(
        new URL(
          buildIntegrationOAuthRedirectPathFromState(PLATFORM.SLACK, state, 'error=missing_code'),
          APP_URL
        )
      );
    }

    // 3. Verify signed state (CSRF protection)
    const verified = verifyOAuthState(state);
    if (!state || !verified) {
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
    const ownerStr = verified.owner;
    const owner = parseOAuthStateOwner(ownerStr);
    if (!owner) {
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

    if (verified.purpose !== 'provider_install' && !isLegacyProviderOAuthState(verified)) {
      return NextResponse.redirect(new URL('/integrations?error=invalid_state', APP_URL));
    }

    // 7. Exchange with Slack before writing provider installation state.
    await bot.initialize();
    const slackAdapter = bot.getAdapter('slack');
    const { teamId, installation, grantedScopes } = await exchangeSlackOAuthCode(
      code,
      SLACK_REDIRECT_URI
    );
    await completePendingSlackDeletion(teamId, id => slackAdapter.deleteInstallation(id));

    // 8. Store installation in database and activate Chat SDK state for the winning generation.
    try {
      if (verified.purpose === 'provider_install') {
        const claim = await claimSlackProviderInstallation({
          actorUserId: user.id,
          owner,
          state,
          teamId,
        });
        if (!claim) throw new Error('Slack OAuth attempt is invalid, expired, or already used');
        await activateReservedSlackInstallation({
          owner,
          teamId,
          installation,
          grantedScopes,
          claim,
          setChatSdkInstallation: (id, value) => slackAdapter.setInstallation(id, value),
        });
      } else {
        const claim = await claimLegacySlackProviderInstallation(owner, teamId);
        if (!claim) throw new SlackWorkspaceAlreadyConnectedError(installation.teamName ?? teamId);
        await activateReservedSlackInstallation({
          owner,
          teamId,
          installation,
          grantedScopes,
          claim,
          setChatSdkInstallation: (id, value) => slackAdapter.setInstallation(id, value),
        });
      }
    } catch (error) {
      if (error instanceof SlackWorkspaceAlreadyConnectedError) {
        return NextResponse.redirect(
          new URL(
            buildIntegrationOAuthRedirectPathFromState(
              PLATFORM.SLACK,
              state,
              'error=workspace_already_connected'
            ),
            APP_URL
          )
        );
      }

      throw error;
    }

    // 9. Redirect to success page
    const successPath = verified.returnTo
      ? appendIntegrationOAuthRedirectQuery(verified.returnTo, 'success=slack_installed')
      : buildIntegrationOAuthRedirectPath(PLATFORM.SLACK, owner, 'success=installed');

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
      new URL(
        buildIntegrationOAuthRedirectPathFromState(
          PLATFORM.SLACK,
          state,
          'error=installation_failed'
        ),
        APP_URL
      )
    );
  }
}
