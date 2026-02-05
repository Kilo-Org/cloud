import 'server-only';
import { db } from '@/lib/drizzle';
import type { PlatformIntegration } from '@/db/schema';
import { platform_integrations } from '@/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import type { Owner } from '@/lib/integrations/core/types';
import { INTEGRATION_STATUS, PLATFORM } from '@/lib/integrations/core/constants';
import { SLACK_CLIENT_ID, SLACK_CLIENT_SECRET } from '@/lib/config.server';
import { APP_URL } from '@/lib/constants';
import { WebClient } from '@slack/web-api';
import type { OAuthV2Response } from '@slack/oauth';
import { opus_46_free_slackbot_model } from '@/lib/providers/anthropic';
import { getOrganizationById } from '@/lib/organizations/organizations';
import { getDefaultAllowedModel } from '@/lib/slack-bot/model-allow-list';
import { createProviderAwareModelAllowPredicate } from '@/lib/model-allow.server';

// Default model for Slack integrations - separate from the global platform default
const SLACK_DEFAULT_MODEL = opus_46_free_slackbot_model.is_enabled
  ? opus_46_free_slackbot_model.public_id
  : 'minimax/minimax-m2.1';

// Slack OAuth scopes for the integration
// These should be kept in sync with the scopes requested in the Slack app configuration
const SLACK_SCOPES = [
  'app_mentions:read',
  'channels:history',
  'channels:read',
  'chat:write',
  'files:read',
  'files:write',
  'groups:history',
  'groups:read',
  'im:history',
  'im:read',
  'im:write',
  'mpim:history',
  'mpim:read',
  'reactions:read',
  'reactions:write',
  'team:read',
  'users:read',
  'users:read.email',
];

const SLACK_REDIRECT_URI = `${APP_URL}/api/integrations/slack/callback`;

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
 * Exchange OAuth code for access token
 */
export async function exchangeSlackCode(code: string): Promise<OAuthV2Response> {
  if (!SLACK_CLIENT_ID || !SLACK_CLIENT_SECRET) {
    throw new Error('Slack OAuth credentials are not configured');
  }

  const response = await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: SLACK_CLIENT_ID,
      client_secret: SLACK_CLIENT_SECRET,
      code,
      redirect_uri: SLACK_REDIRECT_URI,
    }),
  });

  const data = (await response.json()) as OAuthV2Response;

  if (!data.ok || !data.access_token) {
    throw new Error(`Slack OAuth error: ${data.error || 'No access token received'}`);
  }

  return data;
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
 * Create or update Slack installation from OAuth response
 */
export async function upsertSlackInstallation(
  owner: Owner,
  oauthResponse: OAuthV2Response
): Promise<PlatformIntegration> {
  const existing = await getInstallation(owner);

  const teamId = oauthResponse.team?.id || '';
  const teamName = oauthResponse.team?.name || 'Unknown Team';
  const scopes = oauthResponse.scope?.split(',') || null;

  // For org integrations, get a model that respects the allow list
  // For user integrations, use the Slack-specific default model
  const defaultModel =
    owner.type === 'org'
      ? await getDefaultAllowedModel(owner.id, SLACK_DEFAULT_MODEL)
      : SLACK_DEFAULT_MODEL;

  const metadata = {
    access_token: oauthResponse.access_token,
    bot_user_id: oauthResponse.bot_user_id,
    app_id: oauthResponse.app_id,
    authed_user_id: oauthResponse.authed_user?.id,
    authed_user_scope: oauthResponse.authed_user?.scope,
    authed_user_access_token: oauthResponse.authed_user?.access_token,
    incoming_webhook: oauthResponse.incoming_webhook,
    enterprise_id: oauthResponse.enterprise?.id,
    enterprise_name: oauthResponse.enterprise?.name,
    model_slug: defaultModel,
  };

  if (existing) {
    const [updated] = await db
      .update(platform_integrations)
      .set({
        platform_account_id: teamId,
        platform_account_login: teamName,
        scopes,
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
      scopes,
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
export async function uninstallApp(owner: Owner) {
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
 * Send a test message to verify the Slack integration is working
 * Uses the incoming webhook channel if available, otherwise tries to find a general channel
 */
export async function sendTestMessage(
  owner: Owner
): Promise<{ success: boolean; error?: string; channel?: string }> {
  const integration = await getInstallation(owner);

  if (!integration) {
    return { success: false, error: 'No Slack installation found' };
  }

  const metadata = integration.metadata as {
    access_token?: string;
    model_slug?: string;
    incoming_webhook?: { channel: string; channelId: string; url: string };
  } | null;

  if (!metadata?.access_token) {
    return { success: false, error: 'No access token found' };
  }

  // Build the test message including the configured model
  const modelInfo = metadata.model_slug
    ? `\n📊 Configured model: \`${metadata.model_slug}\``
    : '\n⚠️ No model configured yet';
  const testMessage = `🎉 Test message from Kilo Code! Your Slack integration is working correctly.${modelInfo}`;

  // If we have an incoming webhook URL, use it directly (doesn't require channel membership)
  if (metadata.incoming_webhook?.url) {
    try {
      const response = await fetch(metadata.incoming_webhook.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: testMessage,
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        return { success: false, error: `Webhook failed: ${text}` };
      }

      return { success: true, channel: metadata.incoming_webhook.channel };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: `Webhook error: ${errorMessage}` };
    }
  }

  // Fall back to using the API (requires bot to be in channel)
  try {
    const client = new WebClient(metadata.access_token);

    // Try to find a general or random channel to post to
    const channelsResult = await client.conversations.list({
      types: 'public_channel',
      limit: 100,
    });

    const generalChannel = channelsResult.channels?.find(
      c => c.name === 'general' || c.name === 'random'
    );

    let channel: string | undefined;
    if (generalChannel?.id) {
      channel = generalChannel.id;
    } else if (channelsResult.channels?.[0]?.id) {
      channel = channelsResult.channels[0].id;
    }

    if (!channel) {
      return { success: false, error: 'No channel found to send test message' };
    }

    const result = await client.chat.postMessage({
      channel,
      text: testMessage,
    });

    if (!result.ok) {
      return { success: false, error: result.error || 'Unknown error' };
    }

    return { success: true, channel: result.channel };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    // Provide more helpful error messages for common issues
    if (errorMessage.includes('not_in_channel')) {
      return {
        success: false,
        error: 'Bot is not in the channel. Please invite the Kilo Code bot to a channel first.',
      };
    }
    if (errorMessage.includes('channel_not_found')) {
      return {
        success: false,
        error: 'Channel not found. Please make sure the channel exists and is accessible.',
      };
    }
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
 * For organization-owned integrations, validates the model against the allow list.
 */
export async function updateModel(
  owner: Owner,
  modelSlug: string
): Promise<{ success: boolean; error?: string }> {
  const integration = await getInstallation(owner);

  if (!integration) {
    return { success: false, error: 'No Slack installation found' };
  }

  // For org integrations, validate the model against the allow list
  if (owner.type === 'org') {
    const organization = await getOrganizationById(owner.id);
    if (organization) {
      const modelAllowList = organization.settings?.model_allow_list || [];
      if (modelAllowList.length > 0) {
        const isAllowed = createProviderAwareModelAllowPredicate(modelAllowList);
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
