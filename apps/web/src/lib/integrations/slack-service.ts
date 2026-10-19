import 'server-only';
import { db } from '@kilocode/web-shared/lib/drizzle';
import type { PlatformIntegration, SlackOAuthCredential } from '@kilocode/db/schema';
import { platform_integrations } from '@kilocode/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import type { Owner } from '@/lib/integrations/core/types';
import { INTEGRATION_STATUS, PLATFORM } from '@/lib/integrations/core/constants';
import { getPlatformOAuthCallbackUrl } from '@/lib/integrations/oauth/urls';
import { SLACK_CLIENT_ID } from '@kilocode/web-shared/lib/config.server';
import { WebClient } from '@slack/web-api';
import type { SlackInstallation } from '@chat-adapter/slack';
import { getDefaultAllowedModel } from '@/lib/slack-bot/model-allow-list';
import { DEFAULT_BOT_MODEL } from '@/lib/bot/constants';
import { isOrganizationModelUpdateAllowed } from '@kilocode/web-shared/lib/organizations/effective-model-access.server';
import {
  decryptSlackBotToken,
  getSlackCredentialByIntegrationId,
  writeSlackCredential,
} from '@/lib/integrations/platforms/slack/credential-store';
import { SlackCredentialDecryptionError } from '@/lib/integrations/platforms/slack/credential-encryption';
import { captureException } from '@sentry/nextjs';

export class SlackWorkspaceAlreadyConnectedError extends Error {
  constructor(teamName: string) {
    super(
      `${teamName} is already connected to another Kilo account or organization. Disconnect it there before connecting it here.`
    );
    this.name = 'SlackWorkspaceAlreadyConnectedError';
  }
}

// Slack OAuth scopes for the integration
// These should be kept in sync with the scopes requested in the Slack app configuration
export const SLACK_SCOPES = [
  'app_mentions:read',
  'assistant:write',
  'channels:history',
  'channels:read',
  'chat:write',
  'files:read',
  'groups:history',
  'groups:read',
  'im:history',
  'im:read',
  'mpim:history',
  'mpim:read',
  'reactions:read',
  'reactions:write',
  'team:read',
  'users:read',
];

export function getMissingSlackScopes(installedScopes: string[] | null): string[] {
  const installedScopeSet = new Set(installedScopes ?? []);
  return SLACK_SCOPES.filter(scope => !installedScopeSet.has(scope));
}

const SLACK_REDIRECT_URI = getPlatformOAuthCallbackUrl(PLATFORM.SLACK);

type SlackUninstallOptions = {
  deleteChatSdkInstallation?: (teamId: string) => Promise<void>;
  deleteChatSdkIdentityCache?: (teamId: string) => Promise<void>;
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
 * Get Slack OAuth URL for initiating the OAuth flow
 */
export function getSlackOAuthUrl(state: string): string {
  if (!SLACK_CLIENT_ID) {
    throw new Error('SLACK_CLIENT_ID is not configured');
  }

  const params = new URLSearchParams({
    client_id: SLACK_CLIENT_ID,
    scope: SLACK_SCOPES.join(','),
    redirect_uri: SLACK_REDIRECT_URI,
    state,
  });

  return `https://slack.com/oauth/v2/authorize?${params.toString()}`;
}

/**
 * Revoke Slack access token
 */
export async function revokeSlackToken(accessToken: string): Promise<boolean> {
  const client = new WebClient(accessToken);

  try {
    const result = await client.auth.revoke();
    return result.ok === true;
  } catch (error) {
    console.error('Failed to revoke Slack token:', error);
    return false;
  }
}

/**
 * Get Slack installation for an owner
 * For user-owned integrations, we explicitly check that owned_by_organization_id is null
 * to avoid returning organization-owned integrations
 */
export async function getInstallation(owner: Owner): Promise<PlatformIntegration | null> {
  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(
      and(...getOwnershipConditions(owner), eq(platform_integrations.platform, PLATFORM.SLACK))
    )
    .limit(1);

  return integration || null;
}

/**
 * Get Slack installation by Slack team ID
 * Used to identify which Kilo Code user/org owns the installation when receiving Slack events
 */
export async function getInstallationByTeamId(teamId: string): Promise<PlatformIntegration | null> {
  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.platform, PLATFORM.SLACK),
        eq(platform_integrations.platform_installation_id, teamId)
      )
    )
    .limit(1);

  return integration || null;
}

function isOwnedBy(integration: PlatformIntegration, owner: Owner): boolean {
  return owner.type === 'user'
    ? integration.owned_by_user_id === owner.id && integration.owned_by_organization_id === null
    : integration.owned_by_organization_id === owner.id && integration.owned_by_user_id === null;
}

async function getConflictingSlackInstallation(
  owner: Owner,
  teamId: string
): Promise<PlatformIntegration | null> {
  const integrations = await db
    .select()
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.platform, PLATFORM.SLACK),
        eq(platform_integrations.platform_installation_id, teamId)
      )
    )
    .limit(2);

  return integrations.find(integration => !isOwnedBy(integration, owner)) ?? null;
}

function isSlackWorkspaceUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;

  if (
    'constraint' in error &&
    error.constraint === 'UQ_platform_integrations_slack_platform_inst'
  ) {
    return true;
  }

  return (
    'message' in error &&
    typeof error.message === 'string' &&
    error.message.includes('UQ_platform_integrations_slack_platform_inst')
  );
}

/**
 * Get the owner information from a Slack installation
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

/**
 * Load the bot token for an integration from the encrypted credential store.
 *
 * Returns null when no credential row exists, the row is revoked, or the row cannot
 * be read (decryption failure or an owner that does not match the encryption AAD).
 * Failures are reported to Sentry without token material; callers treat null as "no
 * access token" and surface their own user-facing error.
 */
export async function getSlackBotToken(integration: PlatformIntegration): Promise<string | null> {
  const owner = getOwnerFromInstallation(integration);
  if (!owner) {
    captureException(new Error('Slack integration has no exclusive owner'), {
      level: 'error',
      tags: { component: 'slack-service', op: 'read-slack-credential' },
      extra: { integrationId: integration.id },
    });
    return null;
  }

  let credential: SlackOAuthCredential | null;
  try {
    credential = await getSlackCredentialByIntegrationId(integration.id);
  } catch (error) {
    captureException(error, {
      level: 'error',
      tags: { component: 'slack-service', op: 'read-slack-credential' },
      extra: { integrationId: integration.id },
    });
    return null;
  }
  if (!credential) return null;

  try {
    return decryptSlackBotToken(credential, owner);
  } catch (error) {
    captureException(error, {
      level: 'error',
      tags: { component: 'slack-service', op: 'read-slack-credential' },
      extra: {
        integrationId: integration.id,
        kind: error instanceof SlackCredentialDecryptionError ? error.kind : 'unknown',
      },
    });
    return null;
  }
}

/**
 * Create or update Slack installation from the Chat SDK OAuth callback result.
 */
export async function upsertSlackInstallation({
  owner,
  teamId,
  installation,
}: {
  owner: Owner;
  teamId: string;
  installation: SlackInstallation;
}): Promise<PlatformIntegration> {
  const existing = await getInstallation(owner);
  const teamName = installation.teamName || 'Unknown Team';

  const conflicting = await getConflictingSlackInstallation(owner, teamId);
  if (conflicting) {
    throw new SlackWorkspaceAlreadyConnectedError(teamName);
  }

  // For org integrations, get a model that respects org access policy.
  // For user integrations, use the shared bot default model.
  const defaultModel =
    owner.type === 'org'
      ? await getDefaultAllowedModel(owner.id, DEFAULT_BOT_MODEL)
      : DEFAULT_BOT_MODEL;

  // Non-secret workspace identifiers only. The bot token lives solely in the
  // encrypted `slack_oauth_credentials` store; dropping `access_token` here also
  // scrubs a stale copy from rows that predate the credential store (a reinstall
  // refreshes the whole metadata object).
  const existingMetadata =
    existing?.metadata && typeof existing.metadata === 'object' ? existing.metadata : {};
  const metadata = {
    ...existingMetadata,
    bot_user_id: installation.botUserId,
    model_slug:
      'model_slug' in existingMetadata && typeof existingMetadata.model_slug === 'string'
        ? existingMetadata.model_slug
        : defaultModel,
  };
  delete (metadata as Record<string, unknown>).access_token;

  if (existing) {
    try {
      return await db.transaction(async tx => {
        const [updated] = await tx
          .update(platform_integrations)
          .set({
            platform_installation_id: teamId,
            platform_account_id: teamId,
            platform_account_login: teamName,
            scopes: SLACK_SCOPES,
            integration_status: INTEGRATION_STATUS.ACTIVE,
            metadata,
            updated_at: new Date().toISOString(),
          })
          .where(eq(platform_integrations.id, existing.id))
          .returning();

        // Both writes commit together: the integration row and its credential row
        // form one unit, and each is incomplete without the other.
        await writeSlackCredential({
          integrationId: updated.id,
          slackTeamId: teamId,
          owner,
          botToken: installation.botToken,
          botUserId: installation.botUserId ?? null,
          tx,
        });

        return updated;
      });
    } catch (error) {
      if (isSlackWorkspaceUniqueViolation(error)) {
        throw new SlackWorkspaceAlreadyConnectedError(teamName);
      }
      throw error;
    }
  }

  try {
    return await db.transaction(async tx => {
      const [created] = await tx
        .insert(platform_integrations)
        .values({
          owned_by_user_id: owner.type === 'user' ? owner.id : null,
          owned_by_organization_id: owner.type === 'org' ? owner.id : null,
          platform: PLATFORM.SLACK,
          integration_type: 'oauth',
          platform_installation_id: teamId,
          platform_account_id: teamId,
          platform_account_login: teamName,
          scopes: SLACK_SCOPES,
          integration_status: INTEGRATION_STATUS.ACTIVE,
          metadata,
          installed_at: new Date().toISOString(),
        })
        .returning();

      await writeSlackCredential({
        integrationId: created.id,
        slackTeamId: teamId,
        owner,
        botToken: installation.botToken,
        botUserId: installation.botUserId ?? null,
        tx,
      });

      return created;
    });
  } catch (error) {
    if (isSlackWorkspaceUniqueViolation(error)) {
      throw new SlackWorkspaceAlreadyConnectedError(teamName);
    }
    throw error;
  }
}

/**
 * Uninstall Slack integration for an owner
 */
export async function uninstallApp(owner: Owner, options: SlackUninstallOptions = {}) {
  const integration = await getInstallation(owner);

  if (!integration) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Slack installation not found',
    });
  }

  const shouldDeleteSlackInstallation =
    integration.integration_status === INTEGRATION_STATUS.ACTIVE;

  // Revoke the stored credential if we have one
  const botToken = await getSlackBotToken(integration);
  if (shouldDeleteSlackInstallation && botToken) {
    try {
      await revokeSlackToken(botToken);
    } catch (error) {
      console.error('Failed to revoke Slack token:', error);
    }
  }

  const teamId = integration.platform_installation_id ?? integration.platform_account_id;
  if (
    shouldDeleteSlackInstallation &&
    (options.deleteChatSdkInstallation || options.deleteChatSdkIdentityCache)
  ) {
    if (!teamId) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Slack installation is missing a team ID',
      });
    }

    await options.deleteChatSdkInstallation?.(teamId);
    await options.deleteChatSdkIdentityCache?.(teamId);
  }

  await db.delete(platform_integrations).where(eq(platform_integrations.id, integration.id));

  return { success: true };
}

export async function deleteInstallationByTeamId(teamId: string) {
  const integration = await getInstallationByTeamId(teamId);

  if (!integration) {
    return { success: true, deleted: false };
  }

  await db.delete(platform_integrations).where(eq(platform_integrations.id, integration.id));

  return { success: true, deleted: true };
}

/**
 * Remove only the database row for a Slack integration without revoking the token on Slack's side.
 * This is useful for development when you want to re-test the OAuth flow without
 * having to re-install the app in Slack.
 */
export async function removeDbRowOnly(owner: Owner) {
  const integration = await getInstallation(owner);

  if (!integration) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Slack installation not found',
    });
  }

  await db.delete(platform_integrations).where(eq(platform_integrations.id, integration.id));

  return { success: true };
}

/**
 * Test Slack connection by calling auth.test
 */
export async function testConnection(owner: Owner): Promise<{ success: boolean; error?: string }> {
  const integration = await getInstallation(owner);

  if (!integration) {
    return { success: false, error: 'No Slack installation found' };
  }

  const botToken = await getSlackBotToken(integration);

  if (!botToken) {
    return { success: false, error: 'No access token found' };
  }

  try {
    const client = new WebClient(botToken);
    const result = await client.auth.test();

    if (!result.ok) {
      return { success: false, error: result.error || 'Unknown error' };
    }

    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage };
  }
}

/**
 * Update the model for a Slack integration.
 * For organization-owned integrations, validates the model against org access policy.
 */
export async function updateModel(
  owner: Owner,
  modelSlug: string
): Promise<{ success: boolean; error?: string }> {
  const integration = await getInstallation(owner);

  if (!integration) {
    return { success: false, error: 'No Slack installation found' };
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
 * Get the model for a Slack integration
 */
export async function getModel(owner: Owner): Promise<string | null> {
  const integration = await getInstallation(owner);

  if (!integration) {
    return null;
  }

  const metadata = integration.metadata as { model_slug?: string } | null;
  return metadata?.model_slug || null;
}

/*
 * Slack message posting params
 */
export type PostSlackMessageParams = {
  channel: string;
  text: string;
  thread_ts?: string;
  blocks?: Array<{ type: string; text?: { type: string; text: string } }>;
};

/**
 * Slack message posting response
 */
export type SlackPostMessageResponse = {
  ok: boolean;
  ts?: string;
  error?: string;
};

/**
 * Post a message to Slack using an access token directly
 */
export async function postSlackMessageByAccessToken(
  accessToken: string,
  params: PostSlackMessageParams
): Promise<SlackPostMessageResponse> {
  try {
    const client = new WebClient(accessToken);
    const result = await client.chat.postMessage({
      channel: params.channel,
      text: params.text,
      thread_ts: params.thread_ts,
      blocks: params.blocks,
    });

    if (!result.ok) {
      return { ok: false, error: result.error || 'Unknown error' };
    }

    return { ok: true, ts: result.ts };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[SlackService] Error posting message:', errorMessage);
    return { ok: false, error: errorMessage };
  }
}

/**
 * Slack reaction response
 */
export type SlackReactionResponse = {
  ok: boolean;
  error?: string;
};

/**
 * Add a reaction to a message using an access token directly
 */
export async function addSlackReactionByAccessToken(
  accessToken: string,
  params: { channel: string; timestamp: string; name: string }
): Promise<SlackReactionResponse> {
  try {
    const client = new WebClient(accessToken);
    const result = await client.reactions.add({
      channel: params.channel,
      timestamp: params.timestamp,
      name: params.name,
    });

    if (!result.ok) {
      return { ok: false, error: result.error || 'Unknown error' };
    }

    return { ok: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[SlackService] Error adding reaction:', errorMessage);
    return { ok: false, error: errorMessage };
  }
}

/**
 * Remove a reaction from a message using an access token directly
 */
export async function removeSlackReactionByAccessToken(
  accessToken: string,
  params: { channel: string; timestamp: string; name: string }
): Promise<SlackReactionResponse> {
  try {
    const client = new WebClient(accessToken);
    const result = await client.reactions.remove({
      channel: params.channel,
      timestamp: params.timestamp,
      name: params.name,
    });

    if (!result.ok) {
      return { ok: false, error: result.error || 'Unknown error' };
    }

    return { ok: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[SlackService] Error removing reaction:', errorMessage);
    return { ok: false, error: errorMessage };
  }
}
