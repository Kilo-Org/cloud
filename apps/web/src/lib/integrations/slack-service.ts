import 'server-only';
import { db } from '@/lib/drizzle';
import type { PlatformIntegration } from '@kilocode/db/schema';
import { platform_integrations } from '@kilocode/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import type { Owner } from '@/lib/integrations/core/types';
import { INTEGRATION_STATUS, PLATFORM } from '@/lib/integrations/core/constants';
import { SLACK_CLIENT_ID } from '@/lib/config.server';
import { APP_URL } from '@/lib/constants';
import { WebClient } from '@slack/web-api';
import type { SlackInstallation } from '@chat-adapter/slack';
import { getOrganizationById } from '@/lib/organizations/organizations';
import { getDefaultAllowedModel } from '@/lib/slack-bot/model-allow-list';
import {
  createAllowPredicateFromRestrictions,
  hasActiveModelRestrictions,
} from '@/lib/model-allow.server';
import { KILO_AUTO_FREE_MODEL } from '@/lib/ai-gateway/kilo-auto';
import { getEffectiveModelRestrictions } from '@/lib/organizations/model-restrictions';

// Default model for Slack integrations - separate from the global platform default
const SLACK_DEFAULT_MODEL = KILO_AUTO_FREE_MODEL.id;

// Slack OAuth scopes for the integration
// These should be kept in sync with the scopes requested in the Slack app configuration
export const SLACK_SCOPES = [
  'app_mentions:read',
  'assistant:write',
  'channels:history',
  'channels:read',
  'chat:write',
  'files:read',
  'files:write',
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
  'users:read.email',
];

export function getMissingSlackScopes(installedScopes: string[] | null): string[] {
  const installedScopeSet = new Set(installedScopes ?? []);
  return SLACK_SCOPES.filter(scope => !installedScopeSet.has(scope));
}

const SLACK_REDIRECT_URI = `${APP_URL}/api/integrations/slack/callback`;

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
}: {
  owner: Owner;
  teamId: string;
  installation: SlackInstallation;
}): Promise<PlatformIntegration> {
  const existing = await getInstallation(owner);
  const teamName = installation.teamName || 'Unknown Team';

  // For org integrations, get a model that respects org access policy.
  // For user integrations, use the Slack-specific default model
  const defaultModel =
    owner.type === 'org'
      ? await getDefaultAllowedModel(owner.id, SLACK_DEFAULT_MODEL)
      : SLACK_DEFAULT_MODEL;

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
    const [updated] = await db
      .update(platform_integrations)
      .set({
        platform_account_id: teamId,
        platform_account_login: teamName,
        scopes: SLACK_SCOPES,
        integration_status: INTEGRATION_STATUS.ACTIVE,
        metadata,
        updated_at: new Date().toISOString(),
      })
      .where(eq(platform_integrations.id, existing.id))
      .returning();

    return updated;
  }

  const [created] = await db
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

  return created;
}

/**
 * Uninstall Slack integration for an owner
 */
export async function uninstallApp(owner: Owner, options: SlackUninstallOptions = {}) {
  const integration = await getInstallation(owner);

  if (!integration || integration.integration_status !== INTEGRATION_STATUS.ACTIVE) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Slack installation not found',
    });
  }

  // Revoke the token if we have one
  const metadata = integration.metadata as { access_token?: string } | null;
  if (metadata?.access_token) {
    try {
      await revokeSlackToken(metadata.access_token);
    } catch (error) {
      console.error('Failed to revoke Slack token:', error);
    }
  }

  const teamId = integration.platform_installation_id ?? integration.platform_account_id;
  if (options.deleteChatSdkInstallation || options.deleteChatSdkIdentityCache) {
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
    const organization = await getOrganizationById(owner.id);
    if (organization) {
      const restrictions = getEffectiveModelRestrictions(organization);
      if (hasActiveModelRestrictions(restrictions)) {
        const isAllowed = createAllowPredicateFromRestrictions(restrictions);
        if (!(await isAllowed(modelSlug))) {
          return { success: false, error: 'Model is not allowed by organization policy' };
        }
      }
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
