import 'server-only';
import { captureException } from '@sentry/nextjs';
import { db, type DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import type { PlatformIntegration } from '@kilocode/db/schema';
import { platform_integrations } from '@kilocode/db/schema';
import { eq, and, isNull, or, sql } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import type { Owner } from '@/lib/integrations/core/types';
import { INTEGRATION_STATUS, PLATFORM } from '@/lib/integrations/core/constants';
import { getPlatformOAuthCallbackUrl } from '@/lib/integrations/oauth/urls';
import {
  INSTALLATION_SERVER_LOCK_STATEMENT_TIMEOUT_MS,
  withInstallationServerLock,
  withWorkspaceInstallationLock,
} from '@/lib/integrations/oauth/workspace-installation-lock';
import {
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  DISCORD_BOT_TOKEN,
} from '@kilocode/web-shared/lib/config.server';
import { getDefaultAllowedModel } from '@/lib/slack-bot/model-allow-list';
import { DEFAULT_BOT_MODEL } from '@/lib/bot/constants';
import { resolveOrganizationBotModel } from '@/lib/bot/organization-model';
import { isOrganizationModelUpdateAllowed } from '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server';
import { buildDiscordApiUrl, parseDiscordSnowflake } from '@/lib/discord-bot/discord-id';

// Discord OAuth2 scopes for the bot integration
// 'bot' scope is needed for the bot to join servers
// 'guilds' scope allows reading basic guild info
const DISCORD_SCOPES = ['bot', 'guilds', 'applications.commands'];

// Discord bot permissions (bitfield)
// Includes: Send Messages, Read Message History, Add Reactions, Use Slash Commands, Embed Links, Attach Files
const DISCORD_BOT_PERMISSIONS = '277025770560';

const DISCORD_REDIRECT_URI = getPlatformOAuthCallbackUrl(PLATFORM.DISCORD);

/**
 * Raised when the Discord server selected in the OAuth consent belongs to a
 * different Kilo owner. Event routing resolves an installation by server id, so
 * one server cannot act for two owners.
 */
export class DiscordGuildAlreadyConnectedError extends Error {
  constructor(guildName: string) {
    super(
      `The Discord server ${guildName} is already connected to a different Kilo account. Disconnect it there before connecting it here.`
    );
    this.name = 'DiscordGuildAlreadyConnectedError';
  }
}

/**
 * Raised when a connection would move an organization's Discord integration to
 * a different server without the authorization that replacement requires.
 */
export class DiscordGuildRebindNotAllowedError extends Error {
  constructor() {
    super(
      'This organization is already connected to a different Discord server. Disconnect it before connecting another server.'
    );
    this.name = 'DiscordGuildRebindNotAllowedError';
  }
}

/** How long a single bot-removal request may take before it counts as failed. */
const DISCORD_BOT_REMOVAL_TIMEOUT_MS = 10_000;

/**
 * Budget for the release's removal request, the external call in its locked
 * section. The section runs at most two lookups at
 * `INSTALLATION_SERVER_LOCK_STATEMENT_TIMEOUT_MS` each, so its worst case is
 * `2 statements x 1s + 2s removal = 4s < 5s wait`.
 */
export const DISCORD_RELEASE_REMOVAL_TIMEOUT_MS = 2_000;

/**
 * Budget for the disconnect's removal request, the external call in its locked
 * section. That section runs at most three statements (row read, ownership
 * check, delete) at `INSTALLATION_SERVER_LOCK_STATEMENT_TIMEOUT_MS` each, so its
 * worst case is `3 statements x 1s + 1.5s removal = 4.5s < 5s wait`. Another
 * statement in the section needs this budget re-checked against the lock wait.
 */
export const DISCORD_DISCONNECT_REMOVAL_TIMEOUT_MS = 1_500;

/**
 * The message the server puts on a Discord disconnect Discord did not confirm.
 *
 * The row and its server id are kept, so repeating the same Disconnect action
 * once Discord answers settles the connection.
 */
export const DISCORD_DISCONNECT_UNCONFIRMED_MESSAGE =
  'Discord could not confirm the disconnect, so the bot is still in the server. Try again.';

/**
 * The message the server puts on a Discord disconnect it cannot attempt at all:
 * no bot token is configured, Discord rejects the token, the connection records
 * no usable server id, or the server is not exclusively this connection's. No
 * retry of the same request can revoke the bot's membership, so the client names
 * the support step instead.
 */
export const DISCORD_DISCONNECT_NEEDS_SUPPORT_MESSAGE =
  'Kilo could not complete the Discord disconnect for this connection. Contact support to finish disconnecting it.';

/**
 * Outcome of asking Discord to remove the bot from a server.
 *
 * `left` is Discord's 204. `already_absent` is its 403/404 answer for a server
 * the bot no longer belongs to, where the membership this disconnect revokes is
 * already gone. Every other outcome must be reported instead of a disconnect.
 */
export type DiscordBotRemoval =
  | { status: 'left' }
  | { status: 'already_absent' }
  | { status: 'temporary_failure'; reason: 'rate_limited' | 'response_error' | 'network' }
  | { status: 'unavailable'; reason: 'not_configured' | 'invalid_guild_id' | 'rejected_token' };

/**
 * Discord OAuth2 token response shape
 */
export type DiscordOAuth2Response = {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
  guild?: {
    id: string;
    name: string;
    icon: string | null;
  };
};

function getOwnershipConditions(owner: Owner) {
  return owner.type === 'user'
    ? [
        eq(platform_integrations.owned_by_user_id, owner.id),
        isNull(platform_integrations.owned_by_organization_id),
      ]
    : [
        eq(platform_integrations.owned_by_organization_id, owner.id),
        isNull(platform_integrations.owned_by_user_id),
      ];
}

/**
 * Get Discord OAuth URL for initiating the OAuth flow
 */
export function getDiscordOAuthUrl(state: string): string {
  if (!DISCORD_CLIENT_ID) {
    throw new Error('DISCORD_CLIENT_ID is not configured');
  }

  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    permissions: DISCORD_BOT_PERMISSIONS,
    scope: DISCORD_SCOPES.join(' '),
    redirect_uri: DISCORD_REDIRECT_URI,
    response_type: 'code',
    state,
  });

  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

/**
 * Exchange OAuth code for access token
 */
export async function exchangeDiscordCode(code: string): Promise<DiscordOAuth2Response> {
  if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) {
    throw new Error('Discord OAuth credentials are not configured');
  }

  const response = await fetch('https://discord.com/api/v10/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      client_secret: DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: DISCORD_REDIRECT_URI,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Discord OAuth error: ${errorText}`);
  }

  const data = (await response.json()) as DiscordOAuth2Response;

  if (!data.access_token) {
    throw new Error('Discord OAuth error: No access token received');
  }

  return data;
}

/**
 * Get Discord installation for an owner
 */
export async function getInstallation(
  owner: Owner,
  database: typeof db | DrizzleTransaction = db
): Promise<PlatformIntegration | null> {
  const [integration] = await database
    .select()
    .from(platform_integrations)
    .where(
      and(...getOwnershipConditions(owner), eq(platform_integrations.platform, PLATFORM.DISCORD))
    )
    // A row that records the server in `platform_installation_id` is the one
    // inbound events resolve to. Prefer it over a row that carries the server id
    // only in `platform_account_id`, so an update targets the same row and the
    // owner keeps one connection.
    .orderBy(
      sql`${platform_integrations.platform_installation_id} IS NULL`,
      platform_integrations.id
    )
    .limit(1);

  return integration || null;
}

/**
 * A row can record its server in `platform_account_id` while
 * `platform_installation_id` is empty. The lifecycle still supports that row
 * shape, so the lookups below cover it wherever a server is resolved.
 */
function legacyDiscordGuildCondition(guildId: string) {
  return and(
    eq(platform_integrations.platform_account_id, guildId),
    isNull(platform_integrations.platform_installation_id)
  );
}

/**
 * Rows that record a server: its canonical row, plus a legacy row that carries
 * the server id only in `platform_account_id`.
 */
function recordsDiscordGuildCondition(guildId: string) {
  return or(
    eq(platform_integrations.platform_installation_id, guildId),
    legacyDiscordGuildCondition(guildId)
  );
}

/**
 * Get Discord installation by guild ID
 * Used to identify which Kilo Code user/org owns the installation when receiving Discord events
 */
export async function getInstallationByGuildId(
  guildId: string
): Promise<PlatformIntegration | null> {
  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.platform, PLATFORM.DISCORD),
        recordsDiscordGuildCondition(guildId)
      )
    )
    // A row that records the server in `platform_installation_id` is the one
    // inbound events resolve to. Prefer it over a legacy row that carries the
    // server id only in `platform_account_id`.
    .orderBy(
      sql`${platform_integrations.platform_installation_id} IS NULL`,
      platform_integrations.id
    )
    .limit(1);

  return integration || null;
}

/**
 * Find a Discord installation that already records `guildId` for a different
 * Kilo owner. Callers use this before persisting a connection so each server
 * stays bound to one owner and the write is refused without touching either row.
 *
 * A server resolves to the row that holds it as its canonical installation id.
 * Only when no such row exists do rows that record the server in
 * `platform_account_id` take part, matching how `upsertDiscordInstallation`
 * reads the bound server of an existing row.
 */
export async function getConflictingDiscordInstallation(
  owner: Owner,
  guildId: string,
  database: typeof db | DrizzleTransaction = db
): Promise<PlatformIntegration | null> {
  const canonical = await database
    .select()
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.platform, PLATFORM.DISCORD),
        eq(platform_integrations.platform_installation_id, guildId)
      )
    )
    .limit(2);

  const foreignCanonical = canonical.find(integration => !isOwnedBy(integration, owner));
  if (foreignCanonical) {
    return foreignCanonical;
  }
  if (canonical.length > 0) {
    return null;
  }

  const [conflicting] = await database
    .select()
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.platform, PLATFORM.DISCORD),
        legacyDiscordGuildCondition(guildId),
        isOwnedByAnotherOwner(owner)
      )
    )
    .limit(1);

  return conflicting ?? null;
}

function isOwnedBy(integration: PlatformIntegration, owner: Owner): boolean {
  return owner.type === 'user'
    ? integration.owned_by_user_id === owner.id && integration.owned_by_organization_id === null
    : integration.owned_by_organization_id === owner.id && integration.owned_by_user_id === null;
}

/**
 * The complement of `isOwnedBy` as a filter. `NOT` over the nullable owner columns
 * would drop rows, so each owner is compared with `IS NOT DISTINCT FROM` and the
 * other owner column with `IS NULL`.
 */
function isOwnedByAnotherOwner(owner: Owner) {
  return owner.type === 'user'
    ? sql`NOT (${platform_integrations.owned_by_user_id} IS NOT DISTINCT FROM ${owner.id} AND ${platform_integrations.owned_by_organization_id} IS NULL)`
    : sql`NOT (${platform_integrations.owned_by_organization_id} IS NOT DISTINCT FROM ${owner.id} AND ${platform_integrations.owned_by_user_id} IS NULL)`;
}

/**
 * Get the owner information from a Discord installation
 */
export function getOwnerFromInstallation(integration: PlatformIntegration): Owner | null {
  if (integration.owned_by_organization_id) {
    return { type: 'org', id: integration.owned_by_organization_id };
  }
  if (integration.owned_by_user_id) {
    return { type: 'user', id: integration.owned_by_user_id };
  }
  return null;
}

export type UpsertDiscordInstallationResult = {
  integration: PlatformIntegration;
  /**
   * The server this write moved the connection away from, when the owner
   * reconnected onto a different one. The caller releases it after the write has
   * committed; see `releasePreviousDiscordGuild`.
   */
  previousGuildId: string | null;
};

/**
 * Persist the selected Discord installation while preserving owner configuration.
 *
 * A server bound to a different Kilo owner is refused outright. An organization
 * connection holds a shared bot token and model policy, so moving it to another
 * server requires `allowGuildRebind`, which callers set only after verifying the
 * organization role that controls the integration.
 *
 * Discord adds the bot to the selected server during the OAuth consent, so a
 * connection that moves to another server records the new one and reports the
 * server it replaced. The caller releases that server after this write has
 * committed.
 */
export async function upsertDiscordInstallation(
  owner: Owner,
  oauthResponse: DiscordOAuth2Response,
  {
    allowGuildRebind = false,
    defaultModel,
  }: { allowGuildRebind?: boolean; defaultModel?: string | null } = {},
  database: typeof db | DrizzleTransaction = db
): Promise<UpsertDiscordInstallationResult> {
  if (!oauthResponse.guild?.id) {
    throw new Error(
      'Discord OAuth response did not include guild information. The bot must be added to a server during authorization.'
    );
  }

  const guildId = parseDiscordSnowflake(oauthResponse.guild.id, 'guild ID');
  const guildName = oauthResponse.guild.name || 'Unknown Server';

  const conflicting = await getConflictingDiscordInstallation(owner, guildId, database);
  if (conflicting) {
    throw new DiscordGuildAlreadyConnectedError(guildName);
  }

  const existing = await getInstallation(owner, database);

  // Rows created before 80a295f26 recorded the server only in `platform_account_id`.
  const boundGuildId = existing?.platform_installation_id ?? existing?.platform_account_id ?? null;

  if (
    existing &&
    !allowGuildRebind &&
    owner.type === 'org' &&
    boundGuildId &&
    boundGuildId !== guildId
  ) {
    throw new DiscordGuildRebindNotAllowedError();
  }

  const scopes = oauthResponse.scope?.split(' ') || null;

  // Note: We intentionally do NOT store the OAuth2 access_token or refresh_token.
  // Discord's OAuth2 user tokens are short-lived and not used for bot operations.
  // All bot API calls use the DISCORD_BOT_TOKEN env var instead.

  if (existing) {
    // Preserve existing model_slug when re-authorizing
    const existingMetadata = existing.metadata || {};
    const updatedMetadata = {
      ...existingMetadata,
      guild_icon: oauthResponse.guild.icon,
    };

    const [updated] = await database
      .update(platform_integrations)
      .set({
        platform_installation_id: guildId,
        platform_account_id: guildId,
        platform_account_login: guildName,
        scopes,
        integration_status: INTEGRATION_STATUS.ACTIVE,
        // A re-authorization replaces the connection, so the status and both
        // suspension columns describe the new authorization.
        suspended_at: null,
        suspended_by: null,
        metadata: updatedMetadata,
        updated_at: new Date().toISOString(),
      })
      .where(eq(platform_integrations.id, existing.id))
      .returning();

    return {
      integration: updated,
      previousGuildId: boundGuildId && boundGuildId !== guildId ? boundGuildId : null,
    };
  }

  // For org integrations, use a model that respects org access policy. A null
  // result means the policy allows none of the candidates, so the installation
  // stores no model and the bot reports that no model is configured. Callers
  // inside a lock resolve it beforehand; without one it is resolved here.
  // For user integrations, use the shared bot default model.
  const resolvedModel =
    owner.type === 'user'
      ? DEFAULT_BOT_MODEL
      : defaultModel !== undefined
        ? defaultModel
        : await getDefaultAllowedModel(owner.id, DEFAULT_BOT_MODEL);

  const metadata = {
    guild_icon: oauthResponse.guild.icon,
    ...(resolvedModel ? { model_slug: resolvedModel } : {}),
  };

  const [created] = await database
    .insert(platform_integrations)
    .values({
      owned_by_user_id: owner.type === 'user' ? owner.id : null,
      owned_by_organization_id: owner.type === 'org' ? owner.id : null,
      platform: PLATFORM.DISCORD,
      integration_type: 'oauth',
      platform_installation_id: guildId,
      platform_account_id: guildId,
      platform_account_login: guildName,
      scopes,
      integration_status: INTEGRATION_STATUS.ACTIVE,
      metadata,
      installed_at: new Date().toISOString(),
    })
    .returning();

  return { integration: created, previousGuildId: null };
}

/**
 * Remove the bot from a server through the Discord API.
 *
 * `DELETE /users/@me/guilds/{guild.id}` is the endpoint a bot uses to leave a
 * server. The OAuth exchange stores no user token, deliberately, so this call is
 * the one that ends the membership the integration holds. Discord answers 204
 * when the bot left, and 403 or 404 when the bot is not a member of that server.
 *
 * `timeoutMs` bounds the request. A caller inside the installation lock passes a
 * value below that lock's wait; without one the full default applies.
 */
export async function removeBotFromGuild(
  guildId: string | null,
  timeoutMs = DISCORD_BOT_REMOVAL_TIMEOUT_MS
): Promise<DiscordBotRemoval> {
  if (!DISCORD_BOT_TOKEN) {
    return { status: 'unavailable', reason: 'not_configured' };
  }

  if (!guildId) {
    return { status: 'unavailable', reason: 'invalid_guild_id' };
  }

  let validatedGuildId: string;
  try {
    validatedGuildId = parseDiscordSnowflake(guildId, 'guild ID');
  } catch {
    return { status: 'unavailable', reason: 'invalid_guild_id' };
  }

  try {
    const response = await fetch(buildDiscordApiUrl(['users', '@me', 'guilds', validatedGuildId]), {
      method: 'DELETE',
      headers: {
        Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (response.ok) {
      return { status: 'left' };
    }

    // 401 means Discord does not accept the configured bot token at all, so
    // repeating the same request cannot succeed.
    if (response.status === 401) {
      return { status: 'unavailable', reason: 'rejected_token' };
    }

    // 404 is an unknown server and 403 a server the bot is not in; in both
    // cases the membership is already gone, so there is nothing left to revoke.
    if (response.status === 403 || response.status === 404) {
      return { status: 'already_absent' };
    }

    return {
      status: 'temporary_failure',
      reason: response.status === 429 ? 'rate_limited' : 'response_error',
    };
  } catch {
    return { status: 'temporary_failure', reason: 'network' };
  }
}

/**
 * Release the server a connection moved away from.
 *
 * The connection records the selected server, so this removal keeps the bot's
 * memberships matching it. Call it once the write that records the new server has
 * committed: it never throws, because a release that does not settle is reported
 * to operators rather than reported as a failed connection.
 *
 * The previous server is released only while it is still unclaimed. A server
 * that another owner has since recorded belongs to that connection, so it is
 * left alone. The lookup and the removal hold the per-server lock the connect
 * write takes, so the two steps are one decision. That lock takes no owner key,
 * so a release in flight never delays another connection of the same owner.
 */
export async function releasePreviousDiscordGuild(
  owner: Owner,
  previousGuildId: string
): Promise<void> {
  try {
    const removal = await withInstallationServerLock(
      PLATFORM.DISCORD,
      previousGuildId,
      async tx => {
        const recordedByAnotherOwner = await getConflictingDiscordInstallation(
          owner,
          previousGuildId,
          tx
        );
        if (recordedByAnotherOwner) {
          return null;
        }

        return removeBotFromGuild(previousGuildId, DISCORD_RELEASE_REMOVAL_TIMEOUT_MS);
      }
    );

    if (removal === null || removal.status === 'left' || removal.status === 'already_absent') {
      return;
    }

    captureException(new Error(`Previous Discord server release ended as ${removal.status}`), {
      tags: { source: 'discord_oauth', op: 'release_previous_guild' },
      extra: { guildId: previousGuildId, status: removal.status, reason: removal.reason },
    });
  } catch (error) {
    // The connection write has already committed, so a failure here cannot fail
    // the connect; it is reported and the callback continues.
    captureException(error, {
      tags: { source: 'discord_oauth', op: 'release_previous_guild' },
      extra: { guildId: previousGuildId, outcome: 'lookup_failed' },
    });
  }
}

/**
 * The one outcome a locked Discord disconnect settles on. Each tag names what
 * the section found, so no follow-up decision can read a stale flag. `moved` is
 * a control signal for the retry loop, never a return value.
 */
type DiscordDisconnectOutcome =
  | { kind: 'missing' }
  | { kind: 'moved'; guildId: string | null }
  | { kind: 'shared' }
  | { kind: 'removal'; removal: DiscordBotRemoval };

/** How many times a disconnect may follow the row to the server it now records. */
const DISCORD_DISCONNECT_ATTEMPTS = 2;

/**
 * The disconnect's serialized section. It holds the locks the connect path takes
 * for this owner and server, reads the row, requires the server to be
 * exclusively this connection's, removes the bot, and deletes the row only for a
 * server it just removed. It runs at most three statements (row read, ownership
 * check, delete), which is what `DISCORD_DISCONNECT_REMOVAL_TIMEOUT_MS` budgets
 * for.
 */
async function runLockedDiscordDisconnect(
  owner: Owner,
  guildId: string
): Promise<DiscordDisconnectOutcome> {
  return withWorkspaceInstallationLock(
    PLATFORM.DISCORD,
    owner,
    guildId,
    async (tx): Promise<DiscordDisconnectOutcome> => {
      const current = await getInstallation(owner, tx);
      if (!current) {
        return { kind: 'missing' };
      }

      const currentGuildId = current.platform_installation_id ?? current.platform_account_id;
      if (currentGuildId !== guildId) {
        return { kind: 'moved', guildId: currentGuildId };
      }

      // The server must belong to this connection alone before its bot
      // membership is revoked.
      const [shared] = await tx
        .select({ id: platform_integrations.id })
        .from(platform_integrations)
        .where(
          and(
            eq(platform_integrations.platform, PLATFORM.DISCORD),
            recordsDiscordGuildCondition(guildId),
            isOwnedByAnotherOwner(owner)
          )
        )
        .limit(1);
      if (shared) {
        return { kind: 'shared' };
      }

      const removal = await removeBotFromGuild(guildId, DISCORD_DISCONNECT_REMOVAL_TIMEOUT_MS);
      if (removal.status === 'unavailable' || removal.status === 'temporary_failure') {
        return { kind: 'removal', removal };
      }

      // The row was re-read and the row and server were both checked above, so
      // the delete names them both: a row that moved matches nothing here.
      await tx
        .delete(platform_integrations)
        .where(
          and(eq(platform_integrations.id, current.id), recordsDiscordGuildCondition(guildId))
        );

      return { kind: 'removal', removal };
    },
    { statementTimeoutMs: INSTALLATION_SERVER_LOCK_STATEMENT_TIMEOUT_MS }
  );
}

/**
 * Uninstall Discord integration for an owner.
 *
 * Disconnecting ends the access the installation holds: a bot installation's
 * durable grant is its membership in the recorded server, so the bot leaves that
 * server through the Discord API before the association is discarded. When the
 * removal does not settle, the association is kept and the caller reports the
 * failure, so the owner can repeat the same action.
 *
 * The disconnect reads and decides in one serialized section. It takes the owner
 * and server locks the connect path takes, so a connect that moves this owner's
 * connection to another server cannot interleave with it. Inside the locks it
 * reads the row, requires the server to be exclusively this connection's, and
 * removes the bot; its delete then names both the row it read and the server it
 * removed, so it only removes the row it decided on. Every delete this call
 * makes names a row it read in the same locked section.
 *
 * A row that records a different server when the lock is held is followed to
 * that server, at most `DISCORD_DISCONNECT_ATTEMPTS` times, so the call acts on
 * the server the row records while the lock is held and never deletes a row it
 * did not check. The server the row left is released by the connect that moved
 * it, not by this call. A row that is still moving after the last attempt was
 * not disconnected, and repeating the disconnect is the safe action, so the
 * caller gets the retryable message rather than a success it cannot back.
 */
export async function uninstallApp(owner: Owner) {
  const integration = await getInstallation(owner);

  if (!integration) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Discord installation not found',
    });
  }

  // A suspended association still holds a live membership in the server, so its
  // disconnect revokes that membership like any other.
  const initialGuildId = integration.platform_installation_id ?? integration.platform_account_id;
  if (!initialGuildId) {
    throw new TRPCError({
      code: 'SERVICE_UNAVAILABLE',
      message: DISCORD_DISCONNECT_NEEDS_SUPPORT_MESSAGE,
    });
  }

  let targetGuildId = initialGuildId;

  for (let attempt = 1; ; attempt++) {
    const guildId = targetGuildId;
    const outcome = await runLockedDiscordDisconnect(owner, guildId);

    if (outcome.kind === 'moved') {
      // A connect moved the row while this section waited for the lock. The
      // server it left is released by that connect, so this call follows the
      // row instead of removing anything the row no longer records.
      if (outcome.guildId === null) {
        // The row now records no server, so no retry of this request can name
        // one to remove.
        throw new TRPCError({
          code: 'SERVICE_UNAVAILABLE',
          message: DISCORD_DISCONNECT_NEEDS_SUPPORT_MESSAGE,
        });
      }
      if (attempt >= DISCORD_DISCONNECT_ATTEMPTS) {
        // Still rebinding after the last attempt: nothing was removed and
        // repeating the disconnect is safe, so the caller may retry.
        throw new TRPCError({
          code: 'SERVICE_UNAVAILABLE',
          message: DISCORD_DISCONNECT_UNCONFIRMED_MESSAGE,
        });
      }
      targetGuildId = outcome.guildId;
      continue;
    }

    if (outcome.kind === 'missing') {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Discord installation not found',
      });
    }

    if (outcome.kind === 'shared') {
      captureException(
        new Error('Discord disconnect skipped a server another connection records'),
        {
          tags: { source: 'discord_disconnect', op: 'shared_server' },
          extra: { guildId },
        }
      );
      throw new TRPCError({
        code: 'SERVICE_UNAVAILABLE',
        message: DISCORD_DISCONNECT_NEEDS_SUPPORT_MESSAGE,
      });
    }

    const { removal } = outcome;

    if (removal.status === 'unavailable') {
      throw new TRPCError({
        code: 'SERVICE_UNAVAILABLE',
        message: DISCORD_DISCONNECT_NEEDS_SUPPORT_MESSAGE,
      });
    }

    if (removal.status === 'temporary_failure') {
      throw new TRPCError({
        code: 'SERVICE_UNAVAILABLE',
        message: DISCORD_DISCONNECT_UNCONFIRMED_MESSAGE,
      });
    }

    return { success: true };
  }
}

/**
 * Remove only the database row for a Discord integration without revoking the token.
 * Useful for development when you want to re-test the OAuth flow.
 */
export async function removeDbRowOnly(owner: Owner) {
  const integration = await getInstallation(owner);

  if (!integration) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Discord installation not found',
    });
  }

  await db.delete(platform_integrations).where(eq(platform_integrations.id, integration.id));

  return { success: true };
}

/**
 * Test Discord connection by verifying the bot can access the guild.
 * Uses the Bot Token (not the OAuth2 user token) since bot operations
 * require `Bot` authorization, and the OAuth2 token from the install
 * flow is short-lived.
 */
export async function testConnection(owner: Owner): Promise<{ success: boolean; error?: string }> {
  const integration = await getInstallation(owner);

  if (!integration) {
    return { success: false, error: 'No Discord installation found' };
  }

  if (!DISCORD_BOT_TOKEN) {
    return { success: false, error: 'DISCORD_BOT_TOKEN is not configured' };
  }

  const guildId = integration.platform_account_id;
  if (!guildId) {
    return { success: false, error: 'No guild ID found for this installation' };
  }

  let validatedGuildId: string;
  try {
    validatedGuildId = parseDiscordSnowflake(guildId, 'guild ID');
  } catch {
    return { success: false, error: 'Invalid guild ID found for this installation' };
  }

  try {
    // Verify the bot can access this guild
    const response = await fetch(buildDiscordApiUrl(['guilds', validatedGuildId]), {
      headers: {
        Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      if (response.status === 403 || response.status === 404) {
        return {
          success: false,
          error: 'Bot does not have access to this server. It may have been removed.',
        };
      }
      return { success: false, error: `Discord API error: ${errorText}` };
    }

    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage };
  }
}

/**
 * Get the model for a Discord integration.
 * Reads model_slug from the given installation's metadata, falling back to
 * the platform default for installations created before model config existed.
 * For organization-owned integrations, a stored model is resolved through the
 * organization's current policy at read time, so a policy change applies to the
 * next message; a user-owned integration keeps its stored model.
 */
export async function getModel(owner: Owner): Promise<string | null> {
  const integration = await getInstallation(owner);
  if (!integration) {
    return null;
  }

  const metadata = integration.metadata as { model_slug?: string } | null;
  if (metadata?.model_slug) {
    return resolveOrganizationBotModel({
      organizationId: owner.type === 'org' ? owner.id : null,
      storedModelSlug: metadata.model_slug,
    });
  }

  // Pre-existing installation without a stored model — resolve a default
  return owner.type === 'org'
    ? getDefaultAllowedModel(owner.id, DEFAULT_BOT_MODEL)
    : DEFAULT_BOT_MODEL;
}

/**
 * Update the model for a Discord integration.
 * For organization-owned integrations, validates the model against org access policy.
 */
export async function updateModel(
  owner: Owner,
  modelSlug: string
): Promise<{ success: boolean; error?: string }> {
  const integration = await getInstallation(owner);

  if (!integration) {
    return { success: false, error: 'No Discord installation found' };
  }

  // For org integrations, validate the model against org access policy.
  if (owner.type === 'org') {
    if (!(await isOrganizationModelUpdateAllowed(owner.id, modelSlug))) {
      return { success: false, error: 'Model is not allowed by organization policy' };
    }
  }

  const existingMetadata = (integration.metadata || {}) as Record<string, unknown>;

  await db
    .update(platform_integrations)
    .set({
      metadata: {
        ...existingMetadata,
        model_slug: modelSlug,
      },
      updated_at: new Date().toISOString(),
    })
    .where(eq(platform_integrations.id, integration.id));

  return { success: true };
}

/**
 * Post a message to a Discord channel using the Bot Token.
 */
export async function postDiscordMessage(
  channelId: string,
  content: string,
  options?: { messageReference?: { message_id: string } }
): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  if (!DISCORD_BOT_TOKEN) {
    return { ok: false, error: 'DISCORD_BOT_TOKEN is not configured' };
  }

  let validatedChannelId: string;
  try {
    validatedChannelId = parseDiscordSnowflake(channelId, 'channel ID');
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Invalid channel ID' };
  }

  try {
    const body: Record<string, unknown> = { content };
    if (options?.messageReference) {
      try {
        body.message_reference = {
          message_id: parseDiscordSnowflake(
            options.messageReference.message_id,
            'message reference ID'
          ),
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : 'Invalid message reference ID',
        };
      }
    }

    const response = await fetch(buildDiscordApiUrl(['channels', validatedChannelId, 'messages']), {
      method: 'POST',
      headers: {
        Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { ok: false, error: `Discord API ${response.status}: ${errorText}` };
    }

    const data = (await response.json()) as { id: string };
    return { ok: true, messageId: data.id };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[DiscordService] Error posting message:', errorMessage);
    return { ok: false, error: errorMessage };
  }
}

/**
 * Add a reaction to a Discord message using the Bot Token.
 */
export async function addDiscordReaction(
  channelId: string,
  messageId: string,
  emoji: string
): Promise<{ ok: boolean; error?: string }> {
  if (!DISCORD_BOT_TOKEN) {
    return { ok: false, error: 'DISCORD_BOT_TOKEN is not configured' };
  }

  let validatedChannelId: string;
  let validatedMessageId: string;
  try {
    validatedChannelId = parseDiscordSnowflake(channelId, 'channel ID');
    validatedMessageId = parseDiscordSnowflake(messageId, 'message ID');
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Invalid Discord ID' };
  }

  try {
    const response = await fetch(
      buildDiscordApiUrl([
        'channels',
        validatedChannelId,
        'messages',
        validatedMessageId,
        'reactions',
        emoji,
        '@me',
      ]),
      {
        method: 'PUT',
        headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      return { ok: false, error: `Discord API ${response.status}: ${errorText}` };
    }

    return { ok: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[DiscordService] Error adding reaction:', errorMessage);
    return { ok: false, error: errorMessage };
  }
}

/**
 * Remove the bot's own reaction from a Discord message.
 */
export async function removeDiscordReaction(
  channelId: string,
  messageId: string,
  emoji: string
): Promise<{ ok: boolean; error?: string }> {
  if (!DISCORD_BOT_TOKEN) {
    return { ok: false, error: 'DISCORD_BOT_TOKEN is not configured' };
  }

  let validatedChannelId: string;
  let validatedMessageId: string;
  try {
    validatedChannelId = parseDiscordSnowflake(channelId, 'channel ID');
    validatedMessageId = parseDiscordSnowflake(messageId, 'message ID');
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Invalid Discord ID' };
  }

  try {
    const response = await fetch(
      buildDiscordApiUrl([
        'channels',
        validatedChannelId,
        'messages',
        validatedMessageId,
        'reactions',
        emoji,
        '@me',
      ]),
      {
        method: 'DELETE',
        headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      return { ok: false, error: `Discord API ${response.status}: ${errorText}` };
    }

    return { ok: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[DiscordService] Error removing reaction:', errorMessage);
    return { ok: false, error: errorMessage };
  }
}
