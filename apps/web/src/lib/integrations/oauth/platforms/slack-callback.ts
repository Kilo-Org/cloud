import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { ORGANIZATION_MANAGE_ROLES } from '@kilocode/app-shared/organizations';
import { ensureOrganizationAccess } from '@kilocode/web-shared/routers/organizations/utils';
import { captureException, captureMessage } from '@sentry/nextjs';
import { safeCallbackContext } from '@/lib/integrations/oauth/callback-safety';
import {
  exchangeSlackOAuthCode,
  getConflictingSlackInstallation,
  SlackWorkspaceAlreadyConnectedError,
  SlackWorkspaceRebindUnsettledError,
  retirePreviousSlackWorkspace,
  upsertSlackInstallation,
} from '@/lib/integrations/slack-service';
import { verifyOAuthState } from '@/lib/integrations/oauth-state';
import { APP_URL } from '@kilocode/web-shared/lib/constants';
import { bot } from '@/lib/bot';
import { unlinkTeamKiloUsers } from '@/lib/bot-identity';
import { PLATFORM } from '@/lib/integrations/core/constants';
import {
  appendIntegrationOAuthRedirectQuery,
  buildIntegrationOAuthRedirectPath,
  buildIntegrationOAuthRedirectPathFromState,
  oauthCallbackRedirectPath,
  parseOAuthStateOwner,
  resolveOAuthCallbackActor,
  cancelMissingCodeProviderOAuthAttempt,
  organizationAccessDenialErrorCode,
} from '@/lib/integrations/oauth/common';
import { consumeProviderOAuthAttempt } from '@/lib/integrations/provider-oauth-attempts';
import { withWorkspaceInstallationLock } from '@/lib/integrations/oauth/workspace-installation-lock';
import { restoreProviderInstallation } from '@/lib/integrations/oauth/provider-installation-restore';
import { getDefaultAllowedModel } from '@/lib/slack-bot/model-allow-list';
import { DEFAULT_BOT_MODEL } from '@/lib/bot/constants';

async function deleteChatSdkSlackInstallation(teamId: string): Promise<void> {
  await bot.getAdapter('slack').deleteInstallation(teamId);
}

async function deleteChatSdkSlackIdentityCache(teamId: string): Promise<void> {
  await unlinkTeamKiloUsers(bot.getState(), PLATFORM.SLACK, teamId);
}

/**
 * Redirect an install that could not settle the workspace it would replace. The
 * retryable reason asks for another attempt; an unreadable credential needs the
 * support path, because no retry of the same install can revoke it.
 */
function settlementRedirectPath(error: unknown): string | null {
  if (!(error instanceof SlackWorkspaceRebindUnsettledError)) return null;
  return error.reason === 'read_failed'
    ? 'error=previous_workspace_unconfirmed'
    : 'error=previous_workspace_unreadable';
}

/**
 * Slack OAuth Callback
 *
 * Called when user completes the Slack OAuth flow
 */
export async function handleSlackOAuthCallback(request: NextRequest) {
  try {
    // 1. Extract parameters
    const searchParams = request.nextUrl.searchParams;
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const error = searchParams.get('error');

    // 2. Identify the caller: a web session, or the app shell's signed state
    // plus the flow cookie its connect route set for this exact attempt.
    const verified = verifyOAuthState(state);
    const actor = await resolveOAuthCallbackActor({ request, rawState: state, verified });
    if (actor.status === 'unauthenticated') {
      return NextResponse.redirect(
        new URL(oauthCallbackRedirectPath(request, '/users/sign_in'), APP_URL)
      );
    }
    const user = actor.user;

    // Handle OAuth errors from Slack
    if (error) {
      await cancelMissingCodeProviderOAuthAttempt({ state, user, provider: 'slack' });
      captureMessage('Slack OAuth error', {
        level: 'warning',
        tags: { endpoint: 'slack/callback', source: 'slack_oauth' },
        extra: { error, ...safeCallbackContext(searchParams) },
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
        extra: safeCallbackContext(searchParams),
      });

      return NextResponse.redirect(
        new URL(
          buildIntegrationOAuthRedirectPathFromState(PLATFORM.SLACK, state, 'error=missing_code'),
          APP_URL
        )
      );
    }

    // 3. Verify signed state (CSRF protection)
    if (!state || !verified) {
      captureMessage('Slack callback invalid or tampered state signature', {
        level: 'warning',
        tags: { endpoint: 'slack/callback', source: 'slack_oauth' },
        extra: safeCallbackContext(searchParams),
      });
      return NextResponse.redirect(
        new URL(oauthCallbackRedirectPath(request, '/integrations?error=invalid_state'), APP_URL)
      );
    }

    // 4. Verify the user completing the flow is the same user who initiated it
    if (verified.userId !== user.id) {
      captureMessage('Slack callback user mismatch (possible CSRF)', {
        level: 'warning',
        tags: { endpoint: 'slack/callback', source: 'slack_oauth' },
        extra: { stateUserId: verified.userId, sessionUserId: user.id },
      });
      return NextResponse.redirect(
        new URL(oauthCallbackRedirectPath(request, '/integrations?error=unauthorized'), APP_URL)
      );
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

    // 6. Verify the user may change the owner's Slack connection. An organization
    // connection carries a shared bot token and model policy, so it needs
    // organization management authority, not just membership.
    if (owner.type === 'org') {
      await ensureOrganizationAccess({ user }, owner.id, ORGANIZATION_MANAGE_ROLES);
    } else {
      // For user-owned integrations, verify it's the same user
      if (user.id !== owner.id) {
        return NextResponse.redirect(
          new URL(oauthCallbackRedirectPath(request, '/integrations?error=unauthorized'), APP_URL)
        );
      }
    }

    if (verified.provider !== PLATFORM.SLACK || verified.purpose !== 'provider_install') {
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

    await bot.initialize();
    const slackAdapter = bot.getAdapter('slack');

    const { installationId, installation } = await exchangeSlackOAuthCode(code);
    // Resolve the owner's model policy before taking the workspace locks, so the
    // transaction only performs the ownership check and the integration write.
    const defaultModel =
      owner.type === 'org'
        ? await getDefaultAllowedModel(owner.id, DEFAULT_BOT_MODEL)
        : DEFAULT_BOT_MODEL;

    const conflictRedirect = NextResponse.redirect(
      new URL(
        buildIntegrationOAuthRedirectPathFromState(
          PLATFORM.SLACK,
          state,
          'error=workspace_already_connected'
        ),
        APP_URL
      )
    );

    // A rebind settles the workspace it replaces only after this transaction has
    // committed: the row then names the new workspace, and the previous one's
    // token is revoked against the team id that no row records any more.
    const install = await withWorkspaceInstallationLock(
      PLATFORM.SLACK,
      owner,
      installationId,
      async tx => {
        const conflicting = await getConflictingSlackInstallation(owner, installationId, tx);
        if (conflicting) {
          return { response: conflictRedirect, previousWorkspace: null };
        }

        const previousInstallation = await slackAdapter.getInstallation(installationId);
        await slackAdapter.setInstallation(installationId, installation);

        try {
          const { previousWorkspace } = await upsertSlackInstallation(
            {
              owner,
              teamId: installationId,
              installation,
              allowWorkspaceRebind: owner.type === 'org',
              defaultModel,
            },
            tx
          );

          const successPath = verified.returnTo
            ? appendIntegrationOAuthRedirectQuery(verified.returnTo, 'success=slack_installed')
            : buildIntegrationOAuthRedirectPath(PLATFORM.SLACK, owner, 'success=installed');

          return {
            response: NextResponse.redirect(new URL(successPath, APP_URL)),
            previousWorkspace,
          };
        } catch (error) {
          // The installation store is not part of the database transaction, so a
          // rolled-back write must put back what this install replaced.
          await restoreProviderInstallation({
            provider: 'slack',
            previousInstallation,
            setInstallation: restored => slackAdapter.setInstallation(installationId, restored),
            deleteInstallation: () => slackAdapter.deleteInstallation(installationId),
          });

          if (error instanceof SlackWorkspaceAlreadyConnectedError) {
            return { response: conflictRedirect, previousWorkspace: null };
          }

          const unsettledPath = settlementRedirectPath(error);
          if (unsettledPath) {
            return {
              response: NextResponse.redirect(
                new URL(
                  buildIntegrationOAuthRedirectPathFromState(PLATFORM.SLACK, state, unsettledPath),
                  APP_URL
                )
              ),
              previousWorkspace: null,
            };
          }

          throw error;
        }
      }
    );

    if (install.previousWorkspace) {
      await retirePreviousSlackWorkspace(install.previousWorkspace, {
        deleteChatSdkInstallation: deleteChatSdkSlackInstallation,
        deleteChatSdkIdentityCache: deleteChatSdkSlackIdentityCache,
      });
    }

    return install.response;
  } catch (error) {
    console.error('Error handling Slack OAuth callback:', error);

    // Capture error to Sentry with context for debugging
    const searchParams = request.nextUrl.searchParams;
    const state = searchParams.get('state');

    const denialCode = organizationAccessDenialErrorCode(error);
    if (denialCode) {
      return NextResponse.redirect(
        new URL(
          buildIntegrationOAuthRedirectPathFromState(PLATFORM.SLACK, state, `error=${denialCode}`),
          APP_URL
        )
      );
    }

    captureException(error, {
      tags: {
        endpoint: 'slack/callback',
        source: 'slack_oauth',
      },
      extra: safeCallbackContext(searchParams),
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
