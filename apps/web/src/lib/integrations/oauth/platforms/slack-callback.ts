import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { ORGANIZATION_MANAGE_ROLES } from '@kilocode/app-shared/organizations';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { ensureOrganizationAccess } from '@kilocode/web-shared/routers/organizations/utils';
import { captureException, captureMessage } from '@sentry/nextjs';
import { getCallbackReportParams } from '@/lib/integrations/oauth/callback-params';
import {
  exchangeSlackOAuthCode,
  getConflictingSlackInstallation,
  SlackWorkspaceAlreadyConnectedError,
  upsertSlackInstallation,
} from '@/lib/integrations/slack-service';
import { verifyOAuthState } from '@/lib/integrations/oauth-state';
import { APP_URL } from '@kilocode/web-shared/lib/constants';
import { bot } from '@/lib/bot';
import { PLATFORM } from '@/lib/integrations/core/constants';
import type { User } from '@kilocode/db';
import { after } from 'next/server';
import type { PlatformIdentity } from '@/lib/bot-identity';
import { completeLinkAccount, reprocessLinkedContext } from '@/lib/bot/link-account-completion';
import { errorPage, linkConflictPage, linkUsedPage, page } from '@/lib/bot/link-account-page';
import {
  verifySlackBotLinkState,
  type VerifiedSlackBotLinkState,
} from '@/lib/bot/slack-link-state';
import {
  canKiloUserAccessPlatformIntegration,
  getPlatformIntegration,
} from '@/lib/bot/platform-helpers';
import {
  exchangeSlackOidcCode,
  fetchSlackIdentity,
  revokeSlackOidcToken,
  type SlackIdentity,
} from '@/lib/integrations/slack-oidc';
import {
  appendIntegrationOAuthRedirectQuery,
  buildIntegrationOAuthRedirectPath,
  buildIntegrationOAuthRedirectPathFromState,
  parseOAuthStateOwner,
  cancelMissingCodeProviderOAuthAttempt,
  organizationAccessDenialErrorCode,
} from '@/lib/integrations/oauth/common';
import { consumeProviderOAuthAttempt } from '@/lib/integrations/provider-oauth-attempts';
import { withWorkspaceInstallationLock } from '@/lib/integrations/oauth/workspace-installation-lock';
import { getDefaultAllowedModel } from '@/lib/slack-bot/model-allow-list';
import { DEFAULT_BOT_MODEL } from '@/lib/bot/constants';

/**
 * Complete a link started from the generic `/api/chat/link-account` page.
 *
 * The page wrote nothing; it only sent the browser here after the Kilo user was
 * authenticated and authorized for the integration. This handler is where the
 * Slack identity is actually proven:
 *
 *  1. the Kilo user finishing the flow must be the one who started it;
 *  2. Slack must accept the authorization code and answer `userinfo` for it;
 *  3. the identity Slack asserts must equal the identity the pending link
 *     named — that is the proof the URL alone never provided;
 *  4. the integration must still resolve and the user must still have access;
 *  5. only then is the single-use context consumed and the mapping written,
 *     compare-and-set, so an existing mapping is never reassigned.
 */
async function handleSlackBotLinkCallback({
  user,
  state,
  code,
  error,
}: {
  user: User;
  state: VerifiedSlackBotLinkState;
  code: string | null;
  error: string | null;
}): Promise<Response> {
  if (state.userId !== user.id) {
    return errorPage(
      'Link Failed',
      'This Slack link request was started by another Kilo user.',
      403
    );
  }

  if (error) {
    return errorPage(
      'Link Failed',
      `Slack sign-in was not completed (${error}). Please go back to your chat and try again.`,
      400
    );
  }

  if (!code) {
    return errorPage(
      'Link Failed',
      'Slack did not return an authorization code. Please try again.',
      400
    );
  }

  const identity: PlatformIdentity = {
    platform: PLATFORM.SLACK,
    teamId: state.slackTeamId,
    userId: state.slackUserId,
  };

  const integration = await getPlatformIntegration(identity);
  if (!integration) {
    return errorPage('Link Failed', 'No matching Slack integration was found.', 404);
  }

  if (!(await canKiloUserAccessPlatformIntegration(integration, user.id))) {
    return errorPage('Link Failed', 'You do not have access to this Slack integration.', 403);
  }

  let slackIdentity: SlackIdentity;
  let accessToken: string;
  try {
    accessToken = await exchangeSlackOidcCode(code);
    try {
      slackIdentity = await fetchSlackIdentity(accessToken);
    } finally {
      await revokeSlackOidcToken(accessToken);
    }
  } catch (error) {
    captureException(error, {
      tags: { component: 'kilo-bot', op: 'slack-bot-link-identity-proof' },
      extra: { stateUserId: state.userId },
    });
    return errorPage(
      'Link Failed',
      'We could not confirm your Slack account. Please go back to your chat and try again.',
      400
    );
  }

  const provenIdentity: PlatformIdentity = {
    platform: PLATFORM.SLACK,
    teamId: slackIdentity.teamId,
    userId: slackIdentity.userId,
  };

  if (provenIdentity.teamId !== identity.teamId || provenIdentity.userId !== identity.userId) {
    return errorPage(
      'Link Failed',
      'You signed in to a different Slack account than the one this link was issued for. No changes were made.',
      403
    );
  }

  await bot.initialize();
  const outcome = await completeLinkAccount({
    identity: provenIdentity,
    contextKey: state.contextKey,
    user,
  });

  if (outcome.status === 'used') {
    return linkUsedPage();
  }

  if (outcome.status === 'context_missing') {
    return errorPage(
      'Link Expired',
      'Invalid or expired link. Please go back to your chat and try again.',
      400
    );
  }

  if (outcome.status === 'conflict') {
    return linkConflictPage(PLATFORM.SLACK);
  }

  after(() => reprocessLinkedContext(provenIdentity, outcome.context, user));

  return page(
    'Account linked',
    `  <p>Your Slack account has been linked to your Kilo account.<br>
     You can close this tab and return to Slack. Kilo is processing your message.</p>`
  );
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

    // Bot-link branch: dispatch on the discriminator-bearing state shape BEFORE
    // running install-flow logic. The two HMACs cover different payload shapes,
    // so verifyOAuthState returns null for bot-link states and
    // verifySlackBotLinkState returns null for install states.
    const botLinkState = verifySlackBotLinkState(state);
    if (botLinkState) {
      return await handleSlackBotLinkCallback({ user, state: botLinkState, code, error });
    }

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
        extra: { state, allParams: getCallbackReportParams(searchParams) },
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
        extra: { code: '***', state, allParams: getCallbackReportParams(searchParams) },
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

    // 6. Verify the user may change the owner's Slack connection. An organization
    // connection carries a shared bot token and model policy, so it needs
    // organization management authority, not just membership.
    if (owner.type === 'org') {
      await ensureOrganizationAccess({ user }, owner.id, ORGANIZATION_MANAGE_ROLES);
    } else {
      // For user-owned integrations, verify it's the same user
      if (user.id !== owner.id) {
        return NextResponse.redirect(new URL('/integrations?error=unauthorized', APP_URL));
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

    return await withWorkspaceInstallationLock(PLATFORM.SLACK, owner, installationId, async tx => {
      const conflicting = await getConflictingSlackInstallation(owner, installationId, tx);
      if (conflicting) {
        return conflictRedirect;
      }

      const previousInstallation = await slackAdapter.getInstallation(installationId);
      await slackAdapter.setInstallation(installationId, installation);

      try {
        await upsertSlackInstallation(
          {
            owner,
            teamId: installationId,
            installation,
            allowWorkspaceRebind: owner.type === 'org',
            defaultModel,
          },
          tx
        );
      } catch (error) {
        if (error instanceof SlackWorkspaceAlreadyConnectedError) {
          if (previousInstallation) {
            await slackAdapter.setInstallation(installationId, previousInstallation);
          } else {
            await slackAdapter.deleteInstallation(installationId);
          }
          return conflictRedirect;
        }

        throw error;
      }

      const successPath = verified.returnTo
        ? appendIntegrationOAuthRedirectQuery(verified.returnTo, 'success=slack_installed')
        : buildIntegrationOAuthRedirectPath(PLATFORM.SLACK, owner, 'success=installed');

      return NextResponse.redirect(new URL(successPath, APP_URL));
    });
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
