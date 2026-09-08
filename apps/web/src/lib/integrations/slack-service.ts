import 'server-only';
import { db } from '@/lib/drizzle';
import type { PlatformIntegration } from '@kilocode/db/schema';
import { platform_integrations } from '@kilocode/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import type { Owner } from '@/lib/integrations/core/types';
import { INTEGRATION_STATUS, PLATFORM } from '@/lib/integrations/core/constants';
import { getPlatformOAuthCallbackUrl } from '@/lib/integrations/oauth/urls';
import { SLACK_CLIENT_ID, SLACK_CLIENT_SECRET } from '@/lib/config.server';
import { WebClient } from '@slack/web-api';
import type { SlackInstallation } from '@chat-adapter/slack';
import { getDefaultAllowedModel } from '@/lib/slack-bot/model-allow-list';
import { DEFAULT_BOT_MODEL } from '@/lib/bot/constants';
import { isOrganizationModelUpdateAllowed } from '@/lib/organizations/effective-model-access.server';
import { writeSlackCredential } from '@/lib/integrations/platforms/slack/credential-store';
import { assertGitHubAutomationCanBeEnabled } from '@/lib/integrations/github/sharing-compatibility';
import {
  withProviderInstallationLock,
  withProviderInstallationLocks,
} from '@/lib/integrations/provider-installation-lock';

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

export async function exchangeSlackOAuthCode(code: string): Promise<{
  teamId: string;
  installation: SlackInstallation;
}> {
  if (!SLACK_CLIENT_ID || !SLACK_CLIENT_SECRET) {
    throw new Error('SLACK_CLIENT_ID / SLACK_CLIENT_SECRET are not configured');
  }
  const result = await new WebClient().oauth.v2.access({
    client_id: SLACK_CLIENT_ID,
    client_secret: SLACK_CLIENT_SECRET,
    code,
    redirect_uri: SLACK_REDIRECT_URI,
  });
  const teamId = result.is_enterprise_install ? result.enterprise?.id : result.team?.id;
  if (!result.ok || !result.access_token || !teamId) {
    throw new Error(`Slack OAuth failed: ${result.error ?? 'missing installation identity'}`);
  }
  return {
    teamId,
    installation: {
      botToken: result.access_token,
      botUserId: result.bot_user_id,
      teamName: result.team?.name ?? result.enterprise?.name,
      enterpriseId: result.enterprise?.id,
      isEnterpriseInstall: Boolean(result.is_enterprise_install),
    },
  };
}

export async function revokeSlackBotToken(token: string): Promise<void> {
  const result = await new WebClient(token).auth.revoke();
  if (!result.ok) throw new Error(result.error ?? 'Failed to revoke Slack token');
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
 * Create or update Slack installation from the Chat SDK OAuth callback result.
 */
export async function upsertSlackInstallation({
  owner,
  teamId,
  installation,
  persistInstallation,
  captureInstallation,
  restoreInstallation,
}: {
  owner: Owner;
  teamId: string;
  installation: SlackInstallation;
  persistInstallation?: () => Promise<void>;
  captureInstallation?: () => Promise<SlackInstallation | null>;
  restoreInstallation?: (installation: SlackInstallation | null) => Promise<void>;
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

  const metadata = {
    ...(existing?.metadata && typeof existing.metadata === 'object' ? existing.metadata : {}),
    access_token: installation.botToken,
    bot_user_id: installation.botUserId,
    model_slug:
      existing?.metadata &&
      typeof existing.metadata === 'object' &&
      'model_slug' in existing.metadata &&
      typeof existing.metadata.model_slug === 'string'
        ? existing.metadata.model_slug
        : defaultModel,
  };

  if (existing) {
    try {
      const updated = await withProviderInstallationLocks({
        platform: PLATFORM.SLACK,
        installationIds: [existing.platform_installation_id, teamId],
        callback: async () => {
          const previousProviderState = await captureInstallation?.();
          const row = await db.transaction(async tx => {
            await assertGitHubAutomationCanBeEnabled(owner, tx);
            const [current] = await tx
              .select({
                id: platform_integrations.id,
                installationId: platform_integrations.platform_installation_id,
              })
              .from(platform_integrations)
              .where(
                and(
                  eq(platform_integrations.platform, PLATFORM.SLACK),
                  ...getOwnershipConditions(owner)
                )
              )
              .for('update');
            if (
              !current ||
              current.id !== existing.id ||
              current.installationId !== existing.platform_installation_id
            ) {
              throw new Error('Slack installation changed concurrently');
            }
            const [updatedRow] = await tx
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
            return updatedRow;
          });
          try {
            await persistInstallation?.();
            await writeSlackCredential({
              integrationId: row.id,
              slackTeamId: teamId,
              owner,
              botToken: installation.botToken,
              botUserId: installation.botUserId ?? null,
            });
          } catch (error) {
            await restoreInstallation?.(previousProviderState ?? null);
            await db
              .update(platform_integrations)
              .set({
                platform_installation_id: existing.platform_installation_id,
                platform_account_id: existing.platform_account_id,
                platform_account_login: existing.platform_account_login,
                scopes: existing.scopes,
                integration_status: existing.integration_status,
                metadata: existing.metadata,
                auth_invalid_at: existing.auth_invalid_at,
                auth_invalid_reason: existing.auth_invalid_reason,
                updated_at: existing.updated_at,
              })
              .where(eq(platform_integrations.id, row.id));
            throw error;
          }
          return row;
        },
      });

      return updated;
    } catch (error) {
      if (isSlackWorkspaceUniqueViolation(error)) {
        throw new SlackWorkspaceAlreadyConnectedError(teamName);
      }
      throw error;
    }
  }

  try {
    const created = await withProviderInstallationLocks({
      platform: PLATFORM.SLACK,
      installationIds: [teamId],
      callback: async () => {
        const previousProviderState = await captureInstallation?.();
        const row = await db.transaction(async tx => {
          await assertGitHubAutomationCanBeEnabled(owner, tx);
          const [current] = await tx
            .select({
              id: platform_integrations.id,
              installationId: platform_integrations.platform_installation_id,
            })
            .from(platform_integrations)
            .where(
              and(
                eq(platform_integrations.platform, PLATFORM.SLACK),
                ...getOwnershipConditions(owner)
              )
            )
            .for('update');
          if (current) throw new Error('Slack installation changed concurrently');
          const [createdRow] = await tx
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
          return createdRow;
        });
        try {
          await persistInstallation?.();
          await writeSlackCredential({
            integrationId: row.id,
            slackTeamId: teamId,
            owner,
            botToken: installation.botToken,
            botUserId: installation.botUserId ?? null,
          });
        } catch (error) {
          await restoreInstallation?.(previousProviderState ?? null);
          await db.delete(platform_integrations).where(eq(platform_integrations.id, row.id));
          throw error;
        }
        return row;
      },
    });

    return created;
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

  const metadata = integration.metadata as { access_token?: string } | null;
  const teamId = integration.platform_installation_id ?? integration.platform_account_id;
  if (!teamId) {
    if (shouldDeleteSlackInstallation && metadata?.access_token) {
      try {
        await revokeSlackToken(metadata.access_token);
      } catch (error) {
        console.error('Failed to revoke Slack token:', error);
      }
    }
    if (shouldDeleteSlackInstallation && options.deleteChatSdkInstallation) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Slack installation is missing a team ID',
      });
    }
    await db.delete(platform_integrations).where(eq(platform_integrations.id, integration.id));
    return { success: true };
  }
  await withProviderInstallationLock({
    platform: PLATFORM.SLACK,
    installationId: teamId,
    callback: async () => {
      const current = await getInstallation(owner);
      if (
        current?.id !== integration.id ||
        (current.platform_installation_id ?? current.platform_account_id) !== teamId
      ) {
        throw new TRPCError({ code: 'CONFLICT', message: 'Slack installation changed; retry' });
      }
      if (shouldDeleteSlackInstallation && metadata?.access_token) {
        try {
          await revokeSlackToken(metadata.access_token);
        } catch (error) {
          console.error('Failed to revoke Slack token:', error);
        }
      }
      if (shouldDeleteSlackInstallation) {
        await options.deleteChatSdkInstallation?.(teamId);
        await options.deleteChatSdkIdentityCache?.(teamId);
      }
      await db.delete(platform_integrations).where(eq(platform_integrations.id, integration.id));
    },
  });

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

  const metadata = integration.metadata as { access_token?: string } | null;

  if (!metadata?.access_token) {
    return { success: false, error: 'No access token found' };
  }

  try {
    const client = new WebClient(metadata.access_token);
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
 * Send a message to a Slack channel using the stored integration
 */
export async function sendMessage(
  owner: Owner,
  channel: string,
  text: string
): Promise<{ success: boolean; error?: string; ts?: string }> {
  const integration = await getInstallation(owner);

  if (!integration) {
    return { success: false, error: 'No Slack installation found' };
  }

  const metadata = integration.metadata as { access_token?: string } | null;

  if (!metadata?.access_token) {
    return { success: false, error: 'No access token found' };
  }

  try {
    const client = new WebClient(metadata.access_token);
    const result = await client.chat.postMessage({
      channel,
      text,
    });

    if (!result.ok) {
      return { success: false, error: result.error || 'Unknown error' };
    }

    return { success: true, ts: result.ts };
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

  let candidate = integration;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const installationId = candidate.platform_installation_id ?? candidate.platform_account_id;
    if (!installationId) return { success: false, error: 'Slack installation is missing an ID' };
    const updated = await withProviderInstallationLock({
      platform: PLATFORM.SLACK,
      installationId,
      callback: async () => {
        const current = await getInstallation(owner);
        if (
          !current ||
          current.id !== candidate.id ||
          (current.platform_installation_id ?? current.platform_account_id) !== installationId
        )
          return false;
        const metadata = (current.metadata || {}) as Record<string, unknown>;
        await db
          .update(platform_integrations)
          .set({
            metadata: { ...metadata, model_slug: modelSlug },
            updated_at: new Date().toISOString(),
          })
          .where(eq(platform_integrations.id, current.id));
        return true;
      },
    });
    if (updated) return { success: true };
    const current = await getInstallation(owner);
    if (!current) return { success: false, error: 'No Slack installation found' };
    candidate = current;
  }
  return { success: false, error: 'Slack installation changed; retry' };
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
 * Extract access token from installation metadata
 */
export function getAccessTokenFromInstallation(
  integration: PlatformIntegration
): string | undefined {
  const metadata = integration.metadata as { access_token?: string } | null;
  return metadata?.access_token;
}

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
