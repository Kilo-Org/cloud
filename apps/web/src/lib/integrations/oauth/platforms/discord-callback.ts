import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { ensureOrganizationAccess } from '@kilocode/web-shared/routers/organizations/utils';
import { ORGANIZATION_BILLING_ROLES } from '@kilocode/app-shared/organizations';
import { captureException, captureMessage } from '@sentry/nextjs';
import { safeCallbackContext } from '@/lib/integrations/oauth/callback-safety';
import {
  DiscordGuildAlreadyConnectedError,
  discardDiscordGuildRows,
  exchangeDiscordCode,
  probeBotInGuild,
  releasePreviousDiscordGuild,
  type UpsertDiscordInstallationResult,
  upsertDiscordInstallation,
} from '@/lib/integrations/discord-service';
import { parseDiscordSnowflake } from '@/lib/discord-bot/discord-id';
import { getDefaultAllowedModel } from '@/lib/slack-bot/model-allow-list';
import { DEFAULT_BOT_MODEL } from '@/lib/bot/constants';
import type { DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { withWorkspaceInstallationLock } from '@/lib/integrations/oauth/workspace-installation-lock';
import { verifyOAuthState } from '@/lib/integrations/oauth-state';
import {
  oauthCallbackRedirectPath,
  resolveOAuthCallbackActor,
} from '@/lib/integrations/oauth/common';
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
import {
  addAdminAuditMetadata,
  adminActionContextFromHeaders,
  runElevatedOrganizationWrite,
  setAdminAuditOutcome,
} from '@kilocode/web-shared/lib/admin/admin-action-audit';

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

    // 6. Verify the user may change the owner's Discord connection.
    if (owner.type === 'user' && user.id !== owner.id) {
      return NextResponse.redirect(
        new URL(oauthCallbackRedirectPath(request, '/integrations?error=unauthorized'), APP_URL)
      );
    }

    const connect = async () => {
      // Names the outcome an elevated organization write records: a `returnTo`
      // with its own query or fragment keeps the redirect target from saying it
      // reliably.
      const failWith = (errorCode: string, path: string) => {
        setAdminAuditOutcome({ outcome: 'failure', errorCode });
        return NextResponse.redirect(new URL(path, APP_URL));
      };

      if (verified.provider !== PLATFORM.DISCORD || verified.purpose !== 'provider_install') {
        return failWith(
          'invalid_state',
          oauthCallbackRedirectPath(request, '/integrations?error=invalid_state')
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

      // 8. The OAuth consent selects a server and adds the bot to it. Read that
      // server before anything is written, because a write must not move an
      // existing connection to a server where the bot cannot act: the row it
      // replaces would then be the only record of a membership left behind. A
      // server the bot is not in therefore ends the connect with nothing written
      // and nothing released, so an existing connection keeps its row and its bot
      // in its previous server. An unread answer is not evidence against the
      // connection, so it is reported and the connect continues.
      const guildId = oauthData.guild?.id
        ? parseDiscordSnowflake(oauthData.guild.id, 'guild ID')
        : null;
      if (guildId) {
        const selectedPresence = await probeBotInGuild(guildId);

        if (selectedPresence.status === 'absent') {
          captureException(new Error('Discord connect selected a server without the bot'), {
            tags: { source: 'discord_oauth', op: 'connect_membership_check' },
            extra: { guildId, outcome: selectedPresence.status },
          });

          return failWith(
            'bot_not_in_server',
            buildIntegrationOAuthRedirectPathFromState(
              PLATFORM.DISCORD,
              state,
              'error=bot_not_in_server'
            )
          );
        }

        if (selectedPresence.status === 'unreachable') {
          captureMessage('Discord connect could not verify the bot is in the selected server', {
            level: 'warning',
            tags: { source: 'discord_oauth', op: 'connect_membership_check' },
            extra: { guildId, outcome: selectedPresence.status, reason: selectedPresence.reason },
          });
        }
      }

      // 9. Store installation in database. The organization path is the only caller
      // allowed to move an existing organization connection to another server, and
      // only after the organization role check above. The per-server lock keeps two
      // concurrent connections of one server from each passing the ownership check.
      // Resolve the owner's model policy before the lock, so the transaction only
      // performs the ownership check and the installation write.
      const defaultModel =
        owner.type === 'org'
          ? await getDefaultAllowedModel(owner.id, DEFAULT_BOT_MODEL)
          : undefined;
      let installation: UpsertDiscordInstallationResult;
      try {
        const store = (database?: DrizzleTransaction) =>
          upsertDiscordInstallation(
            owner,
            oauthData,
            { allowGuildRebind: owner.type === 'org', defaultModel },
            database
          );

        installation = guildId
          ? await withWorkspaceInstallationLock(PLATFORM.DISCORD, owner, guildId, store)
          : await store();
      } catch (error) {
        if (error instanceof DiscordGuildAlreadyConnectedError) {
          return failWith(
            'workspace_already_connected',
            buildIntegrationOAuthRedirectPathFromState(
              PLATFORM.DISCORD,
              state,
              'error=workspace_already_connected'
            )
          );
        }

        throw error;
      }

      addAdminAuditMetadata({ integrationId: installation.integration.id });

      // 10. A connection the write did not move was read a moment before it
      // committed, and the bot's membership can be gone by now: another owner's
      // connect can release a server it read as unclaimed before that consent's
      // membership landed, and a manual kick ends it too. Such a row describes a
      // connection that cannot act, so it is discarded.
      //
      // Only a write that did not move an existing connection is re-read. A rebind
      // moved the owner's one row to the new server, so discarding it would keep
      // the bot in the server the owner just left while deleting the record of the
      // server the consent selected, and the release below keeps both memberships
      // matching a connection that stays.
      const recordedGuildId =
        installation.integration.platform_installation_id ??
        installation.integration.platform_account_id;
      if (recordedGuildId && installation.previousGuildId === null) {
        const presence = await probeBotInGuild(recordedGuildId);

        if (presence.status === 'absent') {
          // The row the write returned is the one this connect may discard, so the
          // discard names that write and not every row of the same owner and server.
          let discarded: number | undefined;
          try {
            discarded = await discardDiscordGuildRows(owner, recordedGuildId, {
              id: installation.integration.id,
              updatedAt: installation.integration.updated_at,
            });
          } catch (error) {
            // The connection write has committed and the one-shot OAuth attempt is
            // consumed, so a discard that cannot settle is reported rather than
            // turned into a failed connect. The redirect below is the same either
            // way; only the operator report differs.
            captureException(error, {
              tags: { source: 'discord_oauth', op: 'connect_membership_discard' },
              extra: { guildId: recordedGuildId, rowId: installation.integration.id },
            });
          }
          captureException(new Error('Discord connect recorded a server without the bot'), {
            tags: { source: 'discord_oauth', op: 'connect_membership_check' },
            extra: { guildId: recordedGuildId, outcome: presence.status, discarded },
          });

          return failWith(
            'bot_not_in_server',
            buildIntegrationOAuthRedirectPathFromState(
              PLATFORM.DISCORD,
              state,
              'error=bot_not_in_server'
            )
          );
        }

        if (presence.status === 'unreachable') {
          // The question is open, and a row the probe could not read is not
          // evidence against the connection, so the connect succeeds and the
          // outcome goes to operators.
          captureMessage('Discord connect could not verify the bot is in the server', {
            level: 'warning',
            tags: { source: 'discord_oauth', op: 'connect_membership_check' },
            extra: { guildId: recordedGuildId, outcome: presence.status, reason: presence.reason },
          });
        }
      }

      // 11. The connection is kept, so the bot is removed from the server it
      // replaced. This runs after the write has committed and after the check
      // above, so the release follows a connection that stays rather than deciding
      // it.
      if (installation.previousGuildId) {
        await releasePreviousDiscordGuild(owner, installation.previousGuildId);
      }

      // 12. Redirect to success page
      const successPath = verified.returnTo
        ? appendIntegrationOAuthRedirectQuery(verified.returnTo, 'success=discord_installed')
        : buildIntegrationOAuthRedirectPath(PLATFORM.DISCORD, owner, 'success=installed');

      setAdminAuditOutcome({ outcome: 'success' });
      return NextResponse.redirect(new URL(successPath, APP_URL));
    };

    if (owner.type !== 'org') return await connect();
    // An organization connection carries a shared bot token and model policy, so
    // it needs the organization role that governs the integration, not just
    // membership.
    await ensureOrganizationAccess({ user }, owner.id, ORGANIZATION_BILLING_ROLES);
    return await runElevatedOrganizationWrite(
      adminActionContextFromHeaders(user, request.headers),
      {
        organizationId: owner.id,
        requiredRoles: ORGANIZATION_BILLING_ROLES,
        action: 'organization.discord.connect',
        message: 'Discord: OAuth connection stored',
      },
      connect
    );
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
