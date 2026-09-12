import 'server-only';
import { db } from '@/lib/drizzle';
import type { PlatformIntegration } from '@kilocode/db/schema';
import {
  platform_integrations,
  provider_installation_reservations,
  provider_oauth_attempts,
  slack_oauth_credentials,
} from '@kilocode/db/schema';
import { eq, and, isNull, or, sql } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import type { Owner } from '@/lib/integrations/core/types';
import { INTEGRATION_STATUS, PLATFORM } from '@/lib/integrations/core/constants';
import { getPlatformOAuthCallbackUrl } from '@/lib/integrations/oauth/urls';
import { SLACK_CLIENT_ID } from '@/lib/config.server';
import { WebClient } from '@slack/web-api';
import type { SlackInstallation } from '@chat-adapter/slack';
import { getDefaultAllowedModel } from '@/lib/slack-bot/model-allow-list';
import { DEFAULT_BOT_MODEL } from '@/lib/bot/constants';
import { isOrganizationModelUpdateAllowed } from '@/lib/organizations/effective-model-access.server';
import {
  writeSlackCredential,
  writeSlackCredentialInTransaction,
  decryptSlackBotToken,
  getSlackCredentialByIntegrationId,
} from '@/lib/integrations/platforms/slack/credential-store';
import { captureException } from '@sentry/nextjs';
import { lockProviderOAuthOwnerRow } from '@/lib/integrations/provider-oauth-attempts';
import {
  activateSlackReservation,
  adoptLegacySlackReservation,
  expireSlackReservations,
  expireStaleSlackReservation,
  getRecoverableSlackReservation,
  lockSlackReservation,
  type SlackReservationClaim,
} from '@/lib/integrations/provider-installation-reservations';

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

async function getSlackAccessToken(integration: PlatformIntegration): Promise<string | null> {
  const owner = getOwnerFromInstallation(integration);
  if (!owner) return null;
  const credential = await getSlackCredentialByIntegrationId(integration.id);
  if (credential) {
    const token = decryptSlackBotToken(credential, owner);
    if (token) {
      await db
        .update(platform_integrations)
        .set({ metadata: sql`${platform_integrations.metadata} - 'access_token'` })
        .where(
          and(
            eq(platform_integrations.id, integration.id),
            sql`${platform_integrations.metadata} ? 'access_token'`
          )
        );
    }
    return token;
  }
  const metadata = integration.metadata as { access_token?: string } | null;
  return metadata?.access_token ?? null;
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

  if (
    integration?.integration_status === INTEGRATION_STATUS.ACTIVE &&
    integration.platform_installation_id
  ) {
    await adoptLegacySlackReservation(owner, integration.id, integration.platform_installation_id);
  }
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
 * Dual-write the bot token into the encrypted `slack_oauth_credentials` store.
 *
 * Deliberately best-effort for now: nothing reads that store yet, so an unconfigured
 * or failing encryption keyset must not break Slack installs. Step 3 moves the read
 * paths onto the store, at which point this write becomes required and must move
 * inside the same transaction as the `platform_integrations` write.
 */
async function persistSlackCredential({
  integration,
  owner,
  teamId,
  installation,
}: {
  integration: PlatformIntegration;
  owner: Owner;
  teamId: string;
  installation: SlackInstallation;
}): Promise<void> {
  await writeSlackCredential({
    integrationId: integration.id,
    slackTeamId: teamId,
    owner,
    botToken: installation.botToken,
    botUserId: installation.botUserId ?? null,
  });
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

  const existingMetadata =
    existing?.metadata && typeof existing.metadata === 'object' ? existing.metadata : {};
  const { access_token: _legacyToken, ...safeMetadata } = existingMetadata as Record<
    string,
    unknown
  >;
  const metadata = {
    ...safeMetadata,
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
      const [updated] = await db
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

      await persistSlackCredential({ integration: updated, owner, teamId, installation });
      if (existing.platform_installation_id && existing.platform_installation_id !== teamId) {
        await expireSlackReservations({ teamId: existing.platform_installation_id });
      }

      return updated;
    } catch (error) {
      if (isSlackWorkspaceUniqueViolation(error)) {
        throw new SlackWorkspaceAlreadyConnectedError(teamName);
      }
      throw error;
    }
  }

  try {
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

    await persistSlackCredential({ integration: created, owner, teamId, installation });

    return created;
  } catch (error) {
    if (isSlackWorkspaceUniqueViolation(error)) {
      throw new SlackWorkspaceAlreadyConnectedError(teamName);
    }
    throw error;
  }
}

export async function activateReservedSlackInstallation(input: {
  owner: Owner;
  teamId: string;
  installation: SlackInstallation;
  grantedScopes: string[] | null;
  claim: SlackReservationClaim;
  setChatSdkInstallation: (teamId: string, installation: SlackInstallation) => Promise<void>;
  deleteChatSdkInstallation?: (teamId: string) => Promise<void>;
  writeCredential?: typeof writeSlackCredentialInTransaction;
}): Promise<PlatformIntegration> {
  const defaultModel =
    input.owner.type === 'org'
      ? await getDefaultAllowedModel(input.owner.id, DEFAULT_BOT_MODEL)
      : DEFAULT_BOT_MODEL;
  const teamName = input.installation.teamName || 'Unknown Team';

  try {
    return await db.transaction(async tx => {
      await lockProviderOAuthOwnerRow(tx, input.owner);
      const reservation = await lockSlackReservation(tx, input.claim, input.owner, input.teamId);
      if (!reservation) throw new Error('Slack installation reservation is stale or expired');

      const ownerRows = await tx
        .select()
        .from(platform_integrations)
        .where(
          and(
            ...getOwnershipConditions(input.owner),
            eq(platform_integrations.platform, PLATFORM.SLACK)
          )
        )
        .for('update');
      if (ownerRows.length > 1) throw new Error('Slack owner has ambiguous integrations');
      const existing = ownerRows[0];
      const previousTeamId = existing?.platform_installation_id;

      if (previousTeamId && previousTeamId !== input.teamId) {
        const [previousReservation] = await tx
          .select({ id: provider_installation_reservations.id })
          .from(provider_installation_reservations)
          .where(
            and(
              eq(provider_installation_reservations.provider, 'slack'),
              eq(provider_installation_reservations.provider_installation_id, previousTeamId),
              eq(provider_installation_reservations.platform_integration_id, existing.id)
            )
          )
          .for('update');
        if (previousReservation) {
          await tx
            .delete(provider_installation_reservations)
            .where(eq(provider_installation_reservations.id, previousReservation.id));
        }
      }

      const workspaceRows = await tx
        .select()
        .from(platform_integrations)
        .where(
          and(
            eq(platform_integrations.platform, PLATFORM.SLACK),
            eq(platform_integrations.platform_installation_id, input.teamId)
          )
        )
        .for('update');
      if (workspaceRows.some(integration => !isOwnedBy(integration, input.owner))) {
        throw new SlackWorkspaceAlreadyConnectedError(teamName);
      }

      const existingMetadata =
        existing?.metadata && typeof existing.metadata === 'object' ? existing.metadata : {};
      const { access_token: _legacyToken, ...safeMetadata } = existingMetadata as Record<
        string,
        unknown
      >;
      const metadata = {
        ...safeMetadata,
        bot_user_id: input.installation.botUserId,
        model_slug:
          typeof safeMetadata.model_slug === 'string' ? safeMetadata.model_slug : defaultModel,
      };
      const values = {
        platform_installation_id: input.teamId,
        platform_account_id: input.teamId,
        platform_account_login: teamName,
        scopes: input.grantedScopes ?? SLACK_SCOPES,
        integration_status: INTEGRATION_STATUS.PENDING,
        metadata,
        updated_at: new Date().toISOString(),
      };
      const [integration] = existing
        ? await tx
            .update(platform_integrations)
            .set(values)
            .where(eq(platform_integrations.id, existing.id))
            .returning()
        : await tx
            .insert(platform_integrations)
            .values({
              owned_by_user_id: input.owner.type === 'user' ? input.owner.id : null,
              owned_by_organization_id: input.owner.type === 'org' ? input.owner.id : null,
              platform: PLATFORM.SLACK,
              integration_type: 'oauth',
              installed_at: new Date().toISOString(),
              ...values,
            })
            .returning();

      await (input.writeCredential ?? writeSlackCredentialInTransaction)(tx, {
        integrationId: integration.id,
        slackTeamId: input.teamId,
        owner: input.owner,
        botToken: input.installation.botToken,
        botUserId: input.installation.botUserId ?? null,
        slackEnterpriseId: input.installation.enterpriseId ?? null,
        isEnterpriseInstall: input.installation.isEnterpriseInstall ?? false,
        grantedScopes: input.grantedScopes,
      });

      await input.setChatSdkInstallation(input.teamId, input.installation);
      if (previousTeamId && previousTeamId !== input.teamId) {
        await input.deleteChatSdkInstallation?.(previousTeamId);
      }

      const active = await tx
        .update(platform_integrations)
        .set({
          integration_status: INTEGRATION_STATUS.ACTIVE,
          updated_at: new Date().toISOString(),
        })
        .where(
          and(
            eq(platform_integrations.id, integration.id),
            eq(platform_integrations.integration_status, INTEGRATION_STATUS.PENDING)
          )
        )
        .returning();
      if (
        active.length !== 1 ||
        !(await activateSlackReservation(tx, input.claim, integration.id))
      ) {
        throw new Error('Slack installation reservation changed during activation');
      }
      return active[0];
    });
  } catch (error) {
    if (isSlackWorkspaceUniqueViolation(error)) {
      throw new SlackWorkspaceAlreadyConnectedError(teamName);
    }
    throw error;
  }
}

export async function recoverSlackInstallation(
  teamId: string,
  getChatSdkInstallation: (teamId: string) => Promise<SlackInstallation | null>,
  setChatSdkInstallation: (teamId: string, installation: SlackInstallation) => Promise<void>
): Promise<boolean> {
  const recoverable = await getRecoverableSlackReservation(teamId);
  if (!recoverable) {
    await expireStaleSlackReservation(teamId);
    return false;
  }
  const installation = await getChatSdkInstallation(teamId);
  if (!installation) return false;
  await activateReservedSlackInstallation({
    owner: recoverable.owner,
    teamId,
    installation,
    grantedScopes: null,
    claim: recoverable.claim,
    setChatSdkInstallation,
  });
  return true;
}

export async function adoptLegacySlackInstallationByTeamId(teamId: string): Promise<void> {
  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.platform, PLATFORM.SLACK),
        eq(platform_integrations.platform_installation_id, teamId),
        eq(platform_integrations.integration_status, INTEGRATION_STATUS.ACTIVE)
      )
    )
    .limit(1);
  if (!integration) return;
  const owner = getOwnerFromInstallation(integration);
  if (!owner) return;
  await adoptLegacySlackReservation(owner, integration.id, teamId);
}

/**
 * Uninstall Slack integration for an owner
 */
export async function uninstallApp(owner: Owner, options: SlackUninstallOptions = {}) {
  return db.transaction(async tx => {
    await lockProviderOAuthOwnerRow(tx, owner);
    const [integration] = await tx
      .select()
      .from(platform_integrations)
      .where(
        and(...getOwnershipConditions(owner), eq(platform_integrations.platform, PLATFORM.SLACK))
      )
      .for('update');
    if (!integration) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Slack installation not found' });
    }

    const shouldDeleteSlackInstallation =
      integration.integration_status === INTEGRATION_STATUS.ACTIVE;
    const teamId = integration.platform_installation_id ?? integration.platform_account_id;
    if (
      shouldDeleteSlackInstallation &&
      (options.deleteChatSdkInstallation || options.deleteChatSdkIdentityCache) &&
      !teamId
    ) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Slack installation is missing a team ID',
      });
    }

    const [credential] = await tx
      .select()
      .from(slack_oauth_credentials)
      .where(eq(slack_oauth_credentials.platform_integration_id, integration.id))
      .for('update');
    const ownerForCredential = getOwnerFromInstallation(integration);
    const legacyMetadata = integration.metadata as { access_token?: string } | null;
    const accessToken =
      credential && ownerForCredential
        ? decryptSlackBotToken(credential, ownerForCredential)
        : (legacyMetadata?.access_token ?? null);
    if (shouldDeleteSlackInstallation && accessToken) {
      try {
        await revokeSlackToken(accessToken);
      } catch (error) {
        captureException(error, {
          tags: { component: 'slack-service', op: 'revoke-on-uninstall' },
          extra: { integrationId: integration.id },
        });
      }
    }
    if (shouldDeleteSlackInstallation && teamId) {
      await options.deleteChatSdkInstallation?.(teamId);
      await options.deleteChatSdkIdentityCache?.(teamId);
    }

    await tx
      .update(provider_oauth_attempts)
      .set({ status: 'expired' })
      .where(
        and(
          owner.type === 'org'
            ? eq(provider_oauth_attempts.owned_by_organization_id, owner.id)
            : eq(provider_oauth_attempts.owned_by_user_id, owner.id),
          eq(provider_oauth_attempts.provider, 'slack'),
          or(
            eq(provider_oauth_attempts.status, 'pending'),
            eq(provider_oauth_attempts.status, 'captured')
          )
        )
      );
    await tx
      .delete(provider_installation_reservations)
      .where(
        and(
          eq(provider_installation_reservations.provider, 'slack'),
          owner.type === 'org'
            ? eq(provider_installation_reservations.owned_by_organization_id, owner.id)
            : eq(provider_installation_reservations.owned_by_user_id, owner.id)
        )
      );
    await tx.delete(platform_integrations).where(eq(platform_integrations.id, integration.id));
    return { success: true };
  });
}

export async function deleteInstallationByTeamId(
  teamId: string,
  options: {
    eventTime?: number;
    deleteChatSdkInstallation?: (teamId: string) => Promise<void>;
  } = {}
) {
  const candidate = await getInstallationByTeamId(teamId);
  if (!candidate) return { success: true, deleted: false };
  const owner = getOwnerFromInstallation(candidate);
  if (!owner) return { success: true, deleted: false };

  return db.transaction(async tx => {
    await lockProviderOAuthOwnerRow(tx, owner);
    const [reservation] = await tx
      .select()
      .from(provider_installation_reservations)
      .where(
        and(
          eq(provider_installation_reservations.provider, 'slack'),
          eq(provider_installation_reservations.provider_installation_id, teamId)
        )
      )
      .for('update');
    const [integration] = await tx
      .select()
      .from(platform_integrations)
      .where(
        and(
          eq(platform_integrations.id, candidate.id),
          eq(platform_integrations.platform_installation_id, teamId)
        )
      )
      .for('update');
    if (!integration) return { success: true, deleted: false };
    if (
      reservation &&
      options.eventTime !== undefined &&
      options.eventTime * 1000 < new Date(reservation.updated_at).getTime()
    ) {
      return { success: true, deleted: false };
    }

    await options.deleteChatSdkInstallation?.(teamId);
    if (reservation) {
      await tx
        .delete(provider_installation_reservations)
        .where(eq(provider_installation_reservations.id, reservation.id));
    }
    await tx.delete(platform_integrations).where(eq(platform_integrations.id, integration.id));
    return { success: true, deleted: true };
  });
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

  const accessToken = await getSlackAccessToken(integration);
  if (!accessToken) {
    return { success: false, error: 'No access token found' };
  }

  try {
    const client = new WebClient(accessToken);
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

  const accessToken = await getSlackAccessToken(integration);
  if (!accessToken) {
    return { success: false, error: 'No access token found' };
  }

  try {
    const client = new WebClient(accessToken);
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
export async function getAccessTokenFromInstallation(
  integration: PlatformIntegration
): Promise<string | null> {
  return getSlackAccessToken(integration);
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
