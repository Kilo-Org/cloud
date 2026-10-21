import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { ensureOrganizationAccess } from '@kilocode/web-shared/routers/organizations/utils';
import { captureException, captureMessage } from '@sentry/nextjs';
import {
  getInstallationByTeamId,
  revokeSlackToken,
  SlackWorkspaceAlreadyConnectedError,
  upsertSlackInstallation,
} from '@/lib/integrations/slack-service';
import type { SlackAdapter, SlackInstallation } from '@chat-adapter/slack';
import type { PlatformIntegration } from '@kilocode/db/schema';
import { isLegacyProviderOAuthState, verifyOAuthState } from '@/lib/integrations/oauth-state';
import { APP_URL } from '@kilocode/web-shared/lib/constants';
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
import { consumeProviderOAuthAttempt } from '@/lib/integrations/provider-oauth-attempts';

const SLACK_REDIRECT_URI = getPlatformOAuthCallbackUrl(PLATFORM.SLACK);

/**
 * Build the Chat SDK installation for a workspace from its recorded
 * integration.
 */
function buildStoredSlackInstallation(integration: PlatformIntegration): SlackInstallation | null {
  const metadata = integration.metadata as
    | { access_token?: unknown; bot_user_id?: unknown }
    | null
    | undefined;
  const botToken = typeof metadata?.access_token === 'string' ? metadata.access_token : null;

  if (!botToken) return null;

  return {
    botToken,
    ...(typeof metadata?.bot_user_id === 'string' ? { botUserId: metadata.bot_user_id } : {}),
    ...(integration.platform_account_login ? { teamName: integration.platform_account_login } : {}),
  };
}

/**
 * Write the workspace installation recorded for the workspace, or remove the
 * workspace installation when nothing is recorded.
 */
async function writeRecordedSlackInstallation({
  slackAdapter,
  teamId,
  recordedInstallation,
}: {
  slackAdapter: SlackAdapter;
  teamId: string;
  recordedInstallation: SlackInstallation | null;
}): Promise<void> {
  if (!recordedInstallation) {
    await slackAdapter.deleteInstallation(teamId);
    return;
  }

  try {
    await slackAdapter.setInstallation(teamId, recordedInstallation);
  } catch (error) {
    captureException(error, {
      tags: { endpoint: 'slack/callback', source: 'slack_oauth', op: 'restore-installation' },
      extra: { teamId },
    });
    await slackAdapter.deleteInstallation(teamId);
  }
}

/**
 * Keep a workspace's Chat SDK installation attached to the owner recorded for
 * it, and revoke a token that ends up attached to no installation. Revocation
 * runs whether or not the installation write succeeds. Workspace identity links
 * are left as they are.
 */
async function restoreRecordedSlackInstallation({
  slackAdapter,
  teamId,
  incomingInstallation,
}: {
  slackAdapter: SlackAdapter;
  teamId: string;
  incomingInstallation: SlackInstallation;
}): Promise<void> {
  const recordedIntegration = await getInstallationByTeamId(teamId);
  const recordedInstallation = recordedIntegration
    ? buildStoredSlackInstallation(recordedIntegration)
    : null;
  const reusesRecordedToken = incomingInstallation.botToken === recordedInstallation?.botToken;

  try {
    await writeRecordedSlackInstallation({ slackAdapter, teamId, recordedInstallation });
  } finally {
    if (!reusesRecordedToken) {
      const revoked = await revokeSlackToken(incomingInstallation.botToken);
      if (!revoked) {
        captureMessage(
          'Slack token revocation did not complete while settling a workspace install',
          {
            level: 'warning',
            tags: { endpoint: 'slack/callback', source: 'slack_oauth', op: 'revoke-token' },
            extra: { teamId },
          }
        );
      }
    }
  }
}

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

    if (
      verified.purpose === 'provider_install' &&
      !(await consumeProviderOAuthAttempt({
        actorUserId: user.id,
        owner,
        provider: 'slack',
        state,
        purpose: 'provider_install',
      }))
    ) {
      throw new Error('Slack OAuth attempt is invalid, expired, or already used');
    }

    // 7. Let the Chat SDK exchange the code and seed its installation state
    await bot.initialize();
    const slackAdapter = bot.getAdapter('slack');
    const url = new URL(request.url);
    url.searchParams.set('redirect_uri', SLACK_REDIRECT_URI);
    const patchedRequest = new Request(url, request);
    const { teamId, installation } = await slackAdapter.handleOAuthCallback(patchedRequest);

    // 8. Store installation in database
    try {
      await upsertSlackInstallation({ owner, teamId, installation });
    } catch (error) {
      if (error instanceof SlackWorkspaceAlreadyConnectedError) {
        try {
          await restoreRecordedSlackInstallation({
            slackAdapter,
            teamId,
            incomingInstallation: installation,
          });
        } catch (rollbackError) {
          captureException(rollbackError, {
            tags: {
              endpoint: 'slack/callback',
              source: 'slack_oauth',
              op: 'install-conflict-rollback',
            },
            extra: { teamId },
          });
        }

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
