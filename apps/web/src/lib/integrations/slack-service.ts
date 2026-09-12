import 'server-only';
import { db } from '@/lib/drizzle';
import type { PlatformIntegration } from '@kilocode/db/schema';
import {
  platform_integrations,
  organizations,
  provider_installation_reservations,
  provider_installation_pending_credentials,
  provider_oauth_attempts,
  slack_oauth_credentials,
} from '@kilocode/db/schema';
import { eq, and, isNull, or, sql } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import type { Owner } from '@/lib/integrations/core/types';
import { isPlatformIntegrationHealthy } from '@/lib/integrations/core/health';
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
import {
  lockProviderOAuthOwnerRow,
  ownerHasSharedGitHubInstallation,
} from '@/lib/integrations/provider-oauth-attempts';
import {
  activateSlackReservation,
  expireSlackReservations,
  expireStaleSlackReservation,
  getRecoverableSlackReservation,
  lockSlackReservation,
  type SlackReservationClaim,
} from '@/lib/integrations/provider-installation-reservations';
import {
  decryptSlackCredentialSecret,
  encryptSlackCredentialSecret,
} from '@/lib/integrations/platforms/slack/credential-encryption';

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
  } catch {
    return false;
  }
}

async function getSlackAccessToken(integration: PlatformIntegration): Promise<string | null> {
  const owner = getOwnerFromInstallation(integration);
  if (!owner) return null;
  const credential = await getSlackCredentialByIntegrationId(integration.id);
  if (credential) {
    return decryptSlackBotToken(credential, owner);
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

export async function getSlackCleanupState(integration: PlatformIntegration): Promise<{
  cleanupPending: boolean;
  cleanupStage: 'revoke' | 'sdk' | 'identity' | null;
}> {
  const teamId = integration.platform_installation_id ?? integration.platform_account_id;
  if (!teamId) return { cleanupPending: false, cleanupStage: null };
  const [reservation] = await db
    .select({ stage: provider_installation_reservations.cleanup_stage })
    .from(provider_installation_reservations)
    .where(
      and(
        eq(provider_installation_reservations.provider, 'slack'),
        eq(provider_installation_reservations.provider_installation_id, teamId),
        eq(provider_installation_reservations.platform_integration_id, integration.id),
        eq(provider_installation_reservations.status, 'deleting')
      )
    )
    .limit(1);
  return reservation
    ? { cleanupPending: true, cleanupStage: reservation.stage }
    : { cleanupPending: false, cleanupStage: null };
}

export async function getActiveSlackInstallationForRuntime(
  teamId: string
): Promise<SlackInstallation | null> {
  const [row] = await db
    .select({ integration: platform_integrations })
    .from(platform_integrations)
    .innerJoin(
      provider_installation_reservations,
      and(
        eq(provider_installation_reservations.platform_integration_id, platform_integrations.id),
        eq(provider_installation_reservations.provider, 'slack'),
        eq(provider_installation_reservations.provider_installation_id, teamId),
        or(
          eq(provider_installation_reservations.status, 'active'),
          and(
            eq(provider_installation_reservations.status, 'pending'),
            sql`${provider_installation_reservations.active_generation} IS NOT NULL`
          )
        )
      )
    )
    .where(
      and(
        eq(platform_integrations.platform, PLATFORM.SLACK),
        eq(platform_integrations.platform_installation_id, teamId),
        eq(platform_integrations.integration_status, INTEGRATION_STATUS.ACTIVE)
      )
    )
    .limit(1);
  if (!row) {
    const legacy = await getInstallationByTeamId(teamId);
    const owner = legacy ? getOwnerFromInstallation(legacy) : null;
    if (
      !legacy ||
      !owner ||
      legacy.integration_status !== INTEGRATION_STATUS.ACTIVE ||
      !isPlatformIntegrationHealthy(legacy) ||
      (await ownerHasSharedGitHubInstallation(owner))
    ) {
      return null;
    }
    if (owner.type === 'org') {
      const [organization] = await db
        .select({ deletedAt: organizations.deleted_at })
        .from(organizations)
        .where(eq(organizations.id, owner.id))
        .limit(1);
      if (!organization || organization.deletedAt) return null;
    }
    const botToken = await getSlackAccessToken(legacy);
    if (!botToken) return null;
    return { botToken };
  }
  const owner = getOwnerFromInstallation(row.integration);
  if (!owner || !isPlatformIntegrationHealthy(row.integration)) return null;
  if (owner.type === 'org') {
    const [organization] = await db
      .select({ deletedAt: organizations.deleted_at })
      .from(organizations)
      .where(eq(organizations.id, owner.id))
      .limit(1);
    if (!organization || organization.deletedAt) return null;
  }
  const credential = await getSlackCredentialByIntegrationId(row.integration.id);
  const metadata = row.integration.metadata as {
    access_token?: string;
    bot_user_id?: string;
  } | null;
  const botToken = credential
    ? decryptSlackBotToken(credential, owner)
    : (metadata?.access_token ?? null);
  if (!botToken) return null;
  return {
    botToken,
    ...(credential?.bot_user_id || metadata?.bot_user_id
      ? { botUserId: credential?.bot_user_id ?? metadata?.bot_user_id }
      : {}),
    ...(row.integration.platform_account_login
      ? { teamName: row.integration.platform_account_login }
      : {}),
    ...(credential?.slack_enterprise_id ? { enterpriseId: credential.slack_enterprise_id } : {}),
    ...(credential?.is_enterprise_install ? { isEnterpriseInstall: true } : {}),
  };
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
    slackEnterpriseId: installation.enterpriseId ?? null,
    isEnterpriseInstall: installation.isEnterpriseInstall ?? false,
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

const SLACK_SDK_OPERATION_TIMEOUT_MS = 5_000;

export async function withSlackSdkTimeout<T>(
  operation: Promise<T>,
  timeoutMs = SLACK_SDK_OPERATION_TIMEOUT_MS
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Slack Chat SDK operation timed out')),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

type ReservedSlackInstallationInput = {
  owner: Owner;
  teamId: string;
  installation: SlackInstallation;
  grantedScopes: string[] | null;
  claim: SlackReservationClaim;
  setChatSdkInstallation: (teamId: string, installation: SlackInstallation) => Promise<void>;
  writeCredential?: typeof writeSlackCredentialInTransaction;
  sdkTimeoutMs?: number;
  encryptPendingCredential?: typeof encryptSlackCredentialSecret;
  decryptPendingCredential?: typeof decryptSlackCredentialSecret;
};

async function prepareReservedSlackInstallation(
  input: ReservedSlackInstallationInput
): Promise<string> {
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
        ? [existing]
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

      const accessTokenEncrypted = (input.encryptPendingCredential ?? encryptSlackCredentialSecret)(
        input.installation.botToken,
        {
          credentialId: input.claim.reservationId,
          integrationId: integration.id,
          slackTeamId: input.teamId,
          owner: input.owner,
          credentialVersion: input.claim.generation,
        },
        'access'
      );
      await tx
        .update(provider_installation_reservations)
        .set({
          platform_integration_id: integration.id,
          updated_at: new Date().toISOString(),
        })
        .where(
          and(
            eq(provider_installation_reservations.id, input.claim.reservationId),
            eq(provider_installation_reservations.generation, input.claim.generation),
            eq(provider_installation_reservations.status, 'pending')
          )
        );
      await tx
        .insert(provider_installation_pending_credentials)
        .values({
          reservation_id: input.claim.reservationId,
          platform_integration_id: integration.id,
          generation: input.claim.generation,
          access_token_encrypted: accessTokenEncrypted,
          bot_user_id: input.installation.botUserId ?? null,
          team_name: teamName,
          slack_enterprise_id: input.installation.enterpriseId ?? null,
          is_enterprise_install: input.installation.isEnterpriseInstall ?? false,
          granted_scopes: input.grantedScopes,
        })
        .onConflictDoUpdate({
          target: provider_installation_pending_credentials.reservation_id,
          set: {
            platform_integration_id: integration.id,
            generation: input.claim.generation,
            access_token_encrypted: accessTokenEncrypted,
            bot_user_id: input.installation.botUserId ?? null,
            team_name: teamName,
            slack_enterprise_id: input.installation.enterpriseId ?? null,
            is_enterprise_install: input.installation.isEnterpriseInstall ?? false,
            granted_scopes: input.grantedScopes,
            updated_at: new Date().toISOString(),
          },
        });
      return integration.id;
    });
  } catch (error) {
    if (isSlackWorkspaceUniqueViolation(error)) {
      throw new SlackWorkspaceAlreadyConnectedError(teamName);
    }
    throw error;
  }
}

async function completeReservedSlackInstallation(
  input: Omit<ReservedSlackInstallationInput, 'installation' | 'grantedScopes'>
): Promise<PlatformIntegration> {
  return db.transaction(async tx => {
    await lockProviderOAuthOwnerRow(tx, input.owner);
    const reservation = await lockSlackReservation(tx, input.claim, input.owner, input.teamId);
    if (!reservation?.platform_integration_id) {
      throw new Error('Slack installation reservation is stale or incomplete');
    }
    const [pending] = await tx
      .select()
      .from(provider_installation_pending_credentials)
      .where(
        and(
          eq(provider_installation_pending_credentials.reservation_id, input.claim.reservationId),
          eq(provider_installation_pending_credentials.generation, input.claim.generation),
          eq(
            provider_installation_pending_credentials.platform_integration_id,
            reservation.platform_integration_id
          )
        )
      )
      .for('update');
    if (!pending) throw new Error('Slack installation material is unavailable');
    const botToken = (input.decryptPendingCredential ?? decryptSlackCredentialSecret)(
      pending.access_token_encrypted,
      {
        credentialId: input.claim.reservationId,
        integrationId: pending.platform_integration_id,
        slackTeamId: input.teamId,
        owner: input.owner,
        credentialVersion: input.claim.generation,
      },
      'access'
    );
    const installation: SlackInstallation = {
      botToken,
      ...(pending.bot_user_id ? { botUserId: pending.bot_user_id } : {}),
      ...(pending.team_name ? { teamName: pending.team_name } : {}),
      ...(pending.slack_enterprise_id ? { enterpriseId: pending.slack_enterprise_id } : {}),
      ...(pending.is_enterprise_install ? { isEnterpriseInstall: true } : {}),
    };

    await withSlackSdkTimeout(
      input.setChatSdkInstallation(input.teamId, installation),
      input.sdkTimeoutMs
    );

    const [integration] = await tx
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, pending.platform_integration_id))
      .for('update');
    if (!integration || !isOwnedBy(integration, input.owner)) {
      throw new Error('Slack pending association is unavailable');
    }
    const previousTeamId = integration.platform_installation_id;
    const metadata =
      integration.metadata && typeof integration.metadata === 'object' ? integration.metadata : {};
    const { access_token: _legacyToken, ...safeMetadata } = metadata as Record<string, unknown>;
    const [active] = await tx
      .update(platform_integrations)
      .set({
        platform_installation_id: input.teamId,
        platform_account_id: input.teamId,
        platform_account_login: pending.team_name ?? 'Unknown Team',
        scopes: pending.granted_scopes ?? SLACK_SCOPES,
        integration_status: INTEGRATION_STATUS.ACTIVE,
        metadata: { ...safeMetadata, bot_user_id: pending.bot_user_id },
        updated_at: new Date().toISOString(),
      })
      .where(eq(platform_integrations.id, integration.id))
      .returning();
    await (input.writeCredential ?? writeSlackCredentialInTransaction)(tx, {
      integrationId: integration.id,
      slackTeamId: input.teamId,
      owner: input.owner,
      botToken,
      botUserId: pending.bot_user_id,
      slackEnterpriseId: pending.slack_enterprise_id,
      isEnterpriseInstall: pending.is_enterprise_install,
      grantedScopes: pending.granted_scopes,
    });
    if (previousTeamId && previousTeamId !== input.teamId) {
      await tx
        .delete(provider_installation_reservations)
        .where(
          and(
            eq(provider_installation_reservations.provider_installation_id, previousTeamId),
            eq(provider_installation_reservations.platform_integration_id, integration.id)
          )
        );
    }
    if (!(await activateSlackReservation(tx, input.claim, integration.id))) {
      throw new Error('Slack installation reservation changed during activation');
    }
    await tx
      .delete(provider_installation_pending_credentials)
      .where(
        eq(provider_installation_pending_credentials.reservation_id, input.claim.reservationId)
      );
    return active;
  });
}

export async function activateReservedSlackInstallation(
  input: ReservedSlackInstallationInput
): Promise<PlatformIntegration> {
  if (input.installation.isEnterpriseInstall) {
    throw new Error('Enterprise Grid is not supported for shared Slack activation');
  }
  await prepareReservedSlackInstallation(input);
  return completeReservedSlackInstallation(input);
}

export async function recoverSlackInstallation(
  teamId: string,
  setChatSdkInstallation: (teamId: string, installation: SlackInstallation) => Promise<void>,
  options: {
    sdkTimeoutMs?: number;
    decryptPendingCredential?: typeof decryptSlackCredentialSecret;
    writeCredential?: typeof writeSlackCredentialInTransaction;
  } = {}
): Promise<boolean> {
  const recoverable = await getRecoverableSlackReservation(teamId);
  if (!recoverable) {
    await expireStaleSlackReservation(teamId);
    return false;
  }
  await completeReservedSlackInstallation({
    owner: recoverable.owner,
    teamId,
    claim: recoverable.claim,
    setChatSdkInstallation,
    sdkTimeoutMs: options.sdkTimeoutMs,
    decryptPendingCredential: options.decryptPendingCredential,
    writeCredential: options.writeCredential,
  });
  return true;
}

/**
 * Uninstall Slack integration for an owner
 */
async function deactivateSlackInstallation(
  owner: Owner,
  expectedTeamId?: string,
  eventTime?: number,
  readAccessToken = true,
  cleanupRequiresRevoke = readAccessToken
) {
  const [candidate] = await db
    .select()
    .from(platform_integrations)
    .where(
      and(
        ...getOwnershipConditions(owner),
        eq(platform_integrations.platform, PLATFORM.SLACK),
        expectedTeamId
          ? eq(platform_integrations.platform_installation_id, expectedTeamId)
          : undefined
      )
    )
    .limit(1);
  if (!candidate) return null;
  const teamId = candidate.platform_installation_id ?? candidate.platform_account_id;
  if (!teamId) throw new Error('Slack installation is missing a team ID');
  return db.transaction(async tx => {
    await lockProviderOAuthOwnerRow(tx, owner, { allowDeletedOrganization: true });
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
          or(
            eq(platform_integrations.platform_installation_id, teamId),
            eq(platform_integrations.platform_account_id, teamId)
          )
        )
      )
      .for('update');
    if (!integration) return null;
    const wasActive =
      integration.integration_status === INTEGRATION_STATUS.ACTIVE ||
      reservation?.status === 'deleting';
    if (
      reservation &&
      eventTime !== undefined &&
      eventTime < Math.floor(new Date(reservation.updated_at).getTime() / 1000)
    ) {
      return null;
    }

    const [credential] = readAccessToken
      ? await tx
          .select()
          .from(slack_oauth_credentials)
          .where(eq(slack_oauth_credentials.platform_integration_id, integration.id))
          .for('update')
      : [];
    const ownerForCredential = getOwnerFromInstallation(integration);
    const legacyMetadata = integration.metadata as { access_token?: string } | null;
    const accessToken =
      credential && ownerForCredential
        ? decryptSlackBotToken(credential, ownerForCredential)
        : (legacyMetadata?.access_token ?? null);
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
    if (reservation) {
      await tx
        .delete(provider_installation_pending_credentials)
        .where(eq(provider_installation_pending_credentials.reservation_id, reservation.id));
      await tx
        .update(provider_installation_reservations)
        .set({
          status: 'deleting',
          active_generation: null,
          oauth_attempt_id: null,
          cleanup_requires_revoke:
            reservation.status === 'deleting'
              ? reservation.cleanup_requires_revoke
              : cleanupRequiresRevoke && wasActive,
          cleanup_stage:
            reservation.status === 'deleting'
              ? reservation.cleanup_stage
              : cleanupRequiresRevoke && wasActive
                ? 'revoke'
                : 'sdk',
          expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
          updated_at: new Date().toISOString(),
        })
        .where(eq(provider_installation_reservations.id, reservation.id));
    }
    await tx
      .update(platform_integrations)
      .set({
        integration_status: INTEGRATION_STATUS.SUSPENDED,
        suspended_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .where(eq(platform_integrations.id, integration.id));
    return {
      integrationId: integration.id,
      owner,
      teamId,
      accessToken,
      wasActive,
      reservationId: reservation?.id ?? null,
      generation: reservation?.generation ?? null,
      cleanupRequiresRevoke:
        reservation?.cleanup_requires_revoke ?? (cleanupRequiresRevoke && wasActive),
      cleanupStage:
        reservation?.cleanup_stage ?? (cleanupRequiresRevoke && wasActive ? 'revoke' : 'sdk'),
    };
  });
}

async function cleanupDeactivatedSlackInstallation(
  deactivated: NonNullable<Awaited<ReturnType<typeof deactivateSlackInstallation>>>,
  options: SlackUninstallOptions
): Promise<boolean> {
  if (deactivated.cleanupStage === 'revoke') {
    if (!deactivated.accessToken) {
      if (!deactivated.reservationId) throw new Error('Slack credential is unavailable');
      return false;
    }
    try {
      if (!(await withSlackSdkTimeout(revokeSlackToken(deactivated.accessToken)))) {
        if (!deactivated.reservationId) throw new Error('Slack token revocation failed');
        return false;
      }
    } catch (error) {
      captureException(error, {
        tags: { component: 'slack-service', op: 'revoke-on-uninstall' },
        extra: { integrationId: deactivated.integrationId },
      });
      if (!deactivated.reservationId) throw error;
      return false;
    }
    await db
      .update(provider_installation_reservations)
      .set({ cleanup_stage: 'sdk', updated_at: new Date().toISOString() })
      .where(
        and(
          eq(provider_installation_reservations.id, deactivated.reservationId ?? ''),
          eq(provider_installation_reservations.generation, deactivated.generation ?? 0),
          eq(provider_installation_reservations.status, 'deleting'),
          eq(provider_installation_reservations.cleanup_stage, 'revoke')
        )
      );
  }

  if (!deactivated.reservationId) {
    if (deactivated.wasActive && options.deleteChatSdkInstallation) {
      await withSlackSdkTimeout(options.deleteChatSdkInstallation(deactivated.teamId));
    }
    if (deactivated.wasActive && options.deleteChatSdkIdentityCache) {
      await withSlackSdkTimeout(options.deleteChatSdkIdentityCache(deactivated.teamId));
    }
    await db
      .delete(platform_integrations)
      .where(
        and(
          eq(platform_integrations.id, deactivated.integrationId),
          eq(platform_integrations.integration_status, INTEGRATION_STATUS.SUSPENDED)
        )
      );
    return true;
  }

  return db.transaction(async tx => {
    await lockProviderOAuthOwnerRow(tx, deactivated.owner, {
      allowDeletedOrganization: true,
    });
    const [replacement] = await tx
      .select()
      .from(provider_installation_reservations)
      .where(
        and(
          eq(provider_installation_reservations.provider, 'slack'),
          eq(provider_installation_reservations.provider_installation_id, deactivated.teamId),
          eq(provider_installation_reservations.status, 'deleting'),
          deactivated.generation
            ? eq(provider_installation_reservations.generation, deactivated.generation)
            : undefined
        )
      )
      .for('update');
    if (!replacement || replacement.id !== deactivated.reservationId) {
      return false;
    }
    let installationDeleted = true;
    let cleanupStage = replacement.cleanup_stage ?? 'sdk';
    if (cleanupStage === 'sdk' && deactivated.wasActive && options.deleteChatSdkInstallation) {
      try {
        await withSlackSdkTimeout(options.deleteChatSdkInstallation(deactivated.teamId));
      } catch (error) {
        installationDeleted = false;
        captureException(error, {
          tags: { component: 'slack-service', op: 'delete-sdk-installation' },
          extra: { integrationId: deactivated.integrationId },
        });
        return false;
      }
      await tx
        .update(provider_installation_reservations)
        .set({ cleanup_stage: 'identity', updated_at: new Date().toISOString() })
        .where(eq(provider_installation_reservations.id, replacement.id));
      cleanupStage = 'identity';
    }
    if (!installationDeleted) return false;
    if (cleanupStage === 'identity' && deactivated.wasActive) {
      if (!options.deleteChatSdkIdentityCache) return false;
      try {
        await withSlackSdkTimeout(options.deleteChatSdkIdentityCache(deactivated.teamId));
      } catch (error) {
        captureException(error, {
          tags: { component: 'slack-service', op: 'delete-sdk-identity' },
          extra: { integrationId: deactivated.integrationId },
        });
        return false;
      }
    }
    await tx
      .delete(platform_integrations)
      .where(
        and(
          eq(platform_integrations.id, deactivated.integrationId),
          eq(platform_integrations.integration_status, INTEGRATION_STATUS.SUSPENDED),
          or(
            eq(platform_integrations.platform_installation_id, deactivated.teamId),
            eq(platform_integrations.platform_account_id, deactivated.teamId)
          )
        )
      );
    return true;
  });
}

export async function uninstallApp(owner: Owner, options: SlackUninstallOptions = {}) {
  const deactivated = await deactivateSlackInstallation(owner);
  if (!deactivated) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Slack installation not found' });
  }
  const completed = await cleanupDeactivatedSlackInstallation(deactivated, options);
  return { success: true, cleanupPending: !completed };
}

export async function deleteInstallationByTeamId(
  teamId: string,
  options: {
    eventTime?: number;
    deleteChatSdkInstallation?: (teamId: string) => Promise<void>;
    deleteChatSdkIdentityCache?: (teamId: string) => Promise<void>;
  } = {}
) {
  const candidate = await getInstallationByTeamId(teamId);
  if (!candidate) return { success: true, deleted: false };
  const owner = getOwnerFromInstallation(candidate);
  if (!owner) return { success: true, deleted: false };
  const deactivated = await deactivateSlackInstallation(owner, teamId, options.eventTime, false);
  if (!deactivated) return { success: true, deleted: false };
  const completed = await cleanupDeactivatedSlackInstallation(deactivated, {
    deleteChatSdkInstallation: options.deleteChatSdkInstallation,
    deleteChatSdkIdentityCache: options.deleteChatSdkIdentityCache,
  });
  return { success: true, deleted: completed };
}

export async function completePendingSlackDeletion(
  teamId: string,
  deleteChatSdkInstallation: (teamId: string) => Promise<void>,
  deleteChatSdkIdentityCache?: (teamId: string) => Promise<void>
): Promise<boolean> {
  const [reservation] = await db
    .select()
    .from(provider_installation_reservations)
    .where(
      and(
        eq(provider_installation_reservations.provider, 'slack'),
        eq(provider_installation_reservations.provider_installation_id, teamId),
        eq(provider_installation_reservations.status, 'deleting')
      )
    )
    .limit(1);
  if (!reservation?.platform_integration_id) return false;
  const owner: Owner | null = reservation.owned_by_organization_id
    ? { type: 'org', id: reservation.owned_by_organization_id }
    : reservation.owned_by_user_id
      ? { type: 'user', id: reservation.owned_by_user_id }
      : null;
  if (!owner) return false;
  const integration = await getInstallationByTeamId(teamId);
  const accessToken =
    reservation.cleanup_requires_revoke && integration
      ? await getSlackAccessToken(integration)
      : null;
  const completed = await cleanupDeactivatedSlackInstallation(
    {
      integrationId: reservation.platform_integration_id,
      owner,
      teamId,
      accessToken,
      wasActive: true,
      reservationId: reservation.id,
      generation: reservation.generation,
      cleanupRequiresRevoke: reservation.cleanup_requires_revoke,
      cleanupStage: reservation.cleanup_stage,
    },
    { deleteChatSdkInstallation, deleteChatSdkIdentityCache }
  );
  if (completed) return true;
  return false;
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
