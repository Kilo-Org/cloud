import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { ensureOrganizationAccess } from '@kilocode/web-shared/routers/organizations/utils';
import { ORGANIZATION_BILLING_ROLES } from '@kilocode/app-shared/organizations';
import { captureException, captureMessage } from '@sentry/nextjs';
import { safeCallbackContext } from '@/lib/integrations/oauth/callback-safety';
import {
  DiscordGuildAlreadyConnectedError,
  exchangeDiscordCode,
  upsertDiscordInstallation,
} from '@/lib/integrations/discord-service';
import { parseDiscordSnowflake } from '@/lib/discord-bot/discord-id';
import { getDefaultAllowedModel } from '@/lib/slack-bot/model-allow-list';
import { DEFAULT_BOT_MODEL } from '@/lib/bot/constants';
import type { DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { withWorkspaceInstallationLock } from '@/lib/integrations/oauth/workspace-installation-lock';
import { verifyOAuthState } from '@/lib/integrations/oauth-state';
import { oauthCallbackRedirectPath, resolveOAuthCallbackActor } from '@/lib/integrations/oauth/common';
import { APP_URL } from '@kilocode/web-shared/lib/constants';
import { PLATFORM } from '@/lib/integrations/core/constants';
import {
  appendIntegrationOAuthRedirectQuery,
  buildIntegrationOAuthRedirectPath,
  buildIntegrationOAuthRedirectPathFromState,
  parseOAuthStateOwner,
  cancelMissingCodeProviderOAuthAttempt,
  organizationAccessDenialErrorCode,
} from '@/lib/integrations/oauth/common';
import { consumeProviderOAuthAttempt } from '@/lib/integrations/provider-oauth-attempts';

/**
 * Discord OAuth Callback
 *
 * Called when user completes the Discord OAuth flow
 */
export async function handleDiscordOAuthCallback(request: NextRequest) {
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

    // Handle OAuth errors from Discord
    if (error) {
      await cancelMissingCodeProviderOAuthAttempt({ state, user, provider: 'discord' });
      captureMessage('Discord OAuth error', {
        level: 'warning',
        tags: { endpoint: 'discord/callback', source: 'discord_oauth' },
        extra: { error, ...safeCallbackContext(searchParams) },
      });

      return NextResponse.redirect(
        new URL(
          buildIntegrationOAuthRedirectPathFromState(
            PLATFORM.DISCORD,
            state,
            `error=${encodeURIComponent(error)}`
          ),
          APP_URL
        )
      );
    }

    // Validate code is present
    if (!code) {
      await cancelMissingCodeProviderOAuthAttempt({ state, user, provider: 'discord' });
      captureMessage('Discord callback missing code', {
        level: 'warning',
        tags: { endpoint: 'discord/callback', source: 'discord_oauth' },
        extra: safeCallbackContext(searchParams),
      });

      return NextResponse.redirect(
        new URL(
          buildIntegrationOAuthRedirectPathFromState(PLATFORM.DISCORD, state, 'error=missing_code'),
          APP_URL
        )
      );
    }

    // 3. Verify signed state (CSRF protection)
    if (!state || !verified) {
      captureMessage('Discord callback invalid or tampered state signature', {
        level: 'warning',
        tags: { endpoint: 'discord/callback', source: 'discord_oauth' },
        extra: safeCallbackContext(searchParams),
      });
      return NextResponse.redirect(
        new URL(oauthCallbackRedirectPath(request, '/integrations?error=invalid_state'), APP_URL)
      );
    }

    // 4. Verify the user completing the flow is the same user who initiated it
    if (verified.userId !== user.id) {
      captureMessage('Discord callback user mismatch (possible CSRF)', {
        level: 'warning',
        tags: { endpoint: 'discord/callback', source: 'discord_oauth' },
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
      captureMessage('Discord callback missing or invalid owner in state', {
        level: 'warning',
        tags: { endpoint: 'discord/callback', source: 'discord_oauth' },
        extra: { code: '***', owner: ownerStr },
      });
      return NextResponse.redirect(
        new URL(oauthCallbackRedirectPath(request, '/integrations?error=invalid_state'), APP_URL)
      );
    }

    // 6. Verify the user may change the owner's Discord connection. An organization
    // connection carries a shared bot token and model policy, so it needs the
    // organization role that governs the integration, not just membership.
    if (owner.type === 'org') {
      await ensureOrganizationAccess({ user }, owner.id, ORGANIZATION_BILLING_ROLES);
    } else {
      // For user-owned integrations, verify it's the same user
      if (user.id !== owner.id) {
        return NextResponse.redirect(
        new URL(oauthCallbackRedirectPath(request, '/integrations?error=unauthorized'), APP_URL)
      );
      }
    }

    if (verified.provider !== PLATFORM.DISCORD || verified.purpose !== 'provider_install') {
      return NextResponse.redirect(
        new URL(oauthCallbackRedirectPath(request, '/integrations?error=invalid_state'), APP_URL)
      );
    }

    if (
      verified.purpose === 'provider_install' &&
      !(await consumeProviderOAuthAttempt({
        actorUserId: user.id,
        owner,
        provider: 'discord',
        state,
        purpose: 'provider_install',
      }))
    ) {
      throw new Error('Discord OAuth attempt is invalid, expired, or already used');
    }

    // 7. Exchange code for access token
    const oauthData = await exchangeDiscordCode(code);

    // 8. Store installation in database. The organization path is the only caller
    // allowed to move an existing organization connection to another server, and
    // only after the organization role check above. The per-server lock keeps two
    // concurrent connections of one server from each passing the ownership check.
    const guildId = oauthData.guild?.id
      ? parseDiscordSnowflake(oauthData.guild.id, 'guild ID')
      : null;
    // Resolve the owner's model policy before the lock, so the transaction only
    // performs the ownership check and the installation write.
    const defaultModel =
      owner.type === 'org' ? await getDefaultAllowedModel(owner.id, DEFAULT_BOT_MODEL) : undefined;
    try {
      const store = (database?: DrizzleTransaction) =>
        upsertDiscordInstallation(
          owner,
          oauthData,
          { allowGuildRebind: owner.type === 'org', defaultModel },
          database
        );

      if (guildId) {
        await withWorkspaceInstallationLock(PLATFORM.DISCORD, owner, guildId, store);
      } else {
        await store();
      }
    } catch (error) {
      if (error instanceof DiscordGuildAlreadyConnectedError) {
        return NextResponse.redirect(
          new URL(
            buildIntegrationOAuthRedirectPathFromState(
              PLATFORM.DISCORD,
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
      ? appendIntegrationOAuthRedirectQuery(verified.returnTo, 'success=discord_installed')
      : buildIntegrationOAuthRedirectPath(PLATFORM.DISCORD, owner, 'success=installed');

    return NextResponse.redirect(new URL(successPath, APP_URL));
  } catch (error) {
    console.error('Error handling Discord OAuth callback:', error);

    // Capture error to Sentry with context for debugging
    const searchParams = request.nextUrl.searchParams;
    const state = searchParams.get('state');

    const denialCode = organizationAccessDenialErrorCode(error);
    if (denialCode) {
      return NextResponse.redirect(
        new URL(
          buildIntegrationOAuthRedirectPathFromState(
            PLATFORM.DISCORD,
            state,
            `error=${denialCode}`
          ),
          APP_URL
        )
      );
    }

    captureException(error, {
      tags: {
        endpoint: 'discord/callback',
        source: 'discord_oauth',
      },
      extra: safeCallbackContext(searchParams),
    });

    return NextResponse.redirect(
      new URL(
        buildIntegrationOAuthRedirectPathFromState(
          PLATFORM.DISCORD,
          state,
          'error=installation_failed'
        ),
        APP_URL
      )
    );
  }
}
