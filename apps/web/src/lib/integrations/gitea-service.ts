import 'server-only';
import { db } from '@kilocode/web-shared/lib/drizzle';
import type { PlatformIntegration } from '@kilocode/db/schema';
import { platform_integrations, platform_oauth_credentials } from '@kilocode/db/schema';
import { eq, and } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import {
  type GiteaOAuthCredentialActor,
  fetchGiteaCredential,
  type GiteaCredentialBrokerResult,
} from '@/lib/integrations/platforms/gitea/credential-broker-client';
import {
  fetchGiteaProjects,
  fetchGiteaBranches,
  DEFAULT_GITEA_INSTANCE_URL,
  normalizeGiteaInstanceUrl,
} from '@/lib/integrations/platforms/gitea/adapter';
import {
  mutateGiteaMetadataInTransaction,
  readGiteaMetadataInTransaction,
} from '@/lib/integrations/platforms/gitea/metadata-mutation';
import { requireNumericPlatformRepositories, type Owner } from '@/lib/integrations/core/types';
import { INTEGRATION_STATUS, PLATFORM } from '@/lib/integrations/core/constants';
import { updateRepositoriesForIntegration } from '@/lib/integrations/db/platform-integrations';
import { resetCodeReviewConfigForOwner } from '@/lib/agent-config/db/agent-configs';
import { logExceptInTest } from '@kilocode/web-shared/lib/utils.server';

/**
 * Gitea Integration Service
 *
 * Provides business logic for Gitea OAuth integrations.
 * Handles token refresh, repository listing, and integration management.
 */

/**
 * Normalizes a Gitea instance URL for comparison.
 * Strips trailing slashes, lowercases, and treats undefined/empty as gitea.com.
 */
export function normalizeInstanceUrl(url?: string): string {
  return normalizeGiteaInstanceUrl(url || DEFAULT_GITEA_INSTANCE_URL);
}

/**
 * Returns true if the Gitea instance URL has changed between
 * the existing integration and the new connection.
 */
export function instanceUrlChanged(existingUrl: string | undefined, newUrl: string): boolean {
  const normalizedNewUrl = normalizeInstanceUrl(newUrl);
  try {
    return normalizeInstanceUrl(existingUrl) !== normalizedNewUrl;
  } catch {
    return true;
  }
}

function readOptionalMetadataString(
  metadata: Readonly<Record<string, unknown>>,
  key: string
): string | undefined {
  const value = metadata[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`Gitea metadata ${key} must be a string`);
  return value;
}

function requireMetadataRecord(metadata: unknown): Readonly<Record<string, unknown>> {
  if (metadata === null) return {};
  if (typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Invalid Gitea integration metadata' });
  }
  return { ...metadata };
}

function copyMetadataObject(
  metadata: Readonly<Record<string, unknown>>,
  key: string
): Record<string, unknown> {
  const value = metadata[key];
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Gitea metadata ${key} must be an object`);
  }
  return { ...value };
}

function countMetadataObjectEntries(value: unknown): number {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.keys(value).length
    : 0;
}

function getGiteaIntegrationOwner(integration: PlatformIntegration): Owner {
  if (integration.owned_by_user_id && !integration.owned_by_organization_id) {
    return { type: 'user', id: integration.owned_by_user_id };
  }
  if (integration.owned_by_organization_id && !integration.owned_by_user_id) {
    return { type: 'org', id: integration.owned_by_organization_id };
  }
  throw new Error('Gitea integration must have exactly one owner');
}

function requireGiteaProjectId(projectId: string | number): string {
  const value = String(projectId);
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error('Gitea project ID must be a positive decimal');
  }
  return value;
}

/**
 * Get Gitea integration for an owner
 */
export async function getGiteaIntegration(owner: Owner): Promise<PlatformIntegration | null> {
  const ownershipCondition =
    owner.type === 'user'
      ? eq(platform_integrations.owned_by_user_id, owner.id)
      : eq(platform_integrations.owned_by_organization_id, owner.id);

  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(and(ownershipCondition, eq(platform_integrations.platform, PLATFORM.GITEA)))
    .limit(1);

  return integration || null;
}

/**
 * Resolve a Gitea credential through the private-key holding token service.
 */
function requireAvailableGiteaCredential(
  result: GiteaCredentialBrokerResult,
  expectedInstanceUrl: string
): string {
  if (result.status === 'available') {
    if (result.instanceUrl !== expectedInstanceUrl) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'Gitea integration changed while resolving credentials',
      });
    }
    return result.token;
  }

  switch (result.status) {
    case 'invalid_request':
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid Gitea credential request' });
    case 'not_connected':
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Gitea integration not found' });
    case 'reconnect_required':
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'Gitea integration must be reconnected',
      });
    case 'temporarily_unavailable':
      throw new TRPCError({
        code: 'SERVICE_UNAVAILABLE',
        message: 'Gitea credentials are temporarily unavailable',
      });
  }
}

export async function getValidGiteaToken(
  integration: PlatformIntegration,
  actor: GiteaOAuthCredentialActor
): Promise<string> {
  const metadata = requireMetadataRecord(integration.metadata);
  const expectedInstanceUrl = normalizeInstanceUrl(
    readOptionalMetadataString(metadata, 'gitea_instance_url')
  );
  return requireAvailableGiteaCredential(
    await fetchGiteaCredential(actor, {
      credential: 'integration',
      integrationId: integration.id,
    }),
    expectedInstanceUrl
  );
}

export async function getValidGiteaProjectAccessToken(
  integration: PlatformIntegration,
  projectId: string | number,
  actor: GiteaOAuthCredentialActor
): Promise<string> {
  const metadata = requireMetadataRecord(integration.metadata);
  const expectedInstanceUrl = normalizeInstanceUrl(
    readOptionalMetadataString(metadata, 'gitea_instance_url')
  );
  return requireAvailableGiteaCredential(
    await fetchGiteaCredential(actor, {
      credential: 'project-exact',
      integrationId: integration.id,
      projectId: requireGiteaProjectId(projectId),
    }),
    expectedInstanceUrl
  );
}

/**
 * List repositories accessible by a Gitea integration
 * Returns cached repositories by default, fetches fresh from Gitea when forceRefresh is true
 */
export async function listGiteaRepositories(
  owner: Owner,
  integrationId: string,
  actor: GiteaOAuthCredentialActor,
  forceRefresh: boolean = false
) {
  const ownershipCondition =
    owner.type === 'user'
      ? eq(platform_integrations.owned_by_user_id, owner.id)
      : eq(platform_integrations.owned_by_organization_id, owner.id);

  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.id, integrationId),
        ownershipCondition,
        eq(platform_integrations.platform, PLATFORM.GITEA)
      )
    )
    .limit(1);

  if (!integration) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Gitea integration not found',
    });
  }

  const cachedRepositories = requireNumericPlatformRepositories(integration.repositories);
  if (forceRefresh || !cachedRepositories?.length || !integration.repositories_synced_at) {
    const accessToken = await getValidGiteaToken(integration, actor);
    const metadata = integration.metadata as { gitea_instance_url?: string } | null;
    const instanceUrl = normalizeInstanceUrl(metadata?.gitea_instance_url);

    const repos = await fetchGiteaProjects(accessToken, instanceUrl);
    await updateRepositoriesForIntegration(integrationId, repos);

    return {
      repositories: repos,
      syncedAt: new Date().toISOString(),
    };
  }

  return {
    repositories: cachedRepositories,
    syncedAt: integration.repositories_synced_at,
  };
}

/**
 * List branches for a Gitea repository
 * Always fetches fresh from Gitea (no caching)
 */
export async function listGiteaBranches(
  owner: Owner,
  integrationId: string,
  actor: GiteaOAuthCredentialActor,
  repoPath: string
) {
  const ownershipCondition =
    owner.type === 'user'
      ? eq(platform_integrations.owned_by_user_id, owner.id)
      : eq(platform_integrations.owned_by_organization_id, owner.id);

  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.id, integrationId),
        ownershipCondition,
        eq(platform_integrations.platform, PLATFORM.GITEA)
      )
    )
    .limit(1);

  if (!integration) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Gitea integration not found',
    });
  }

  const accessToken = await getValidGiteaToken(integration, actor);
  const metadata = integration.metadata as { gitea_instance_url?: string } | null;
  const instanceUrl = normalizeInstanceUrl(metadata?.gitea_instance_url);

  const branches = await fetchGiteaBranches(accessToken, repoPath, instanceUrl);

  return {
    branches: branches.map(b => ({
      name: b.name,
      isDefault: b.default,
    })),
  };
}

/**
 * Disconnect Gitea integration for an owner
 *
 * Instead of deleting the integration record, we mark it as disconnected.
 * This preserves the webhook_secret, configured_webhooks, and project_tokens
 * so that when the user reconnects (via OAuth), existing webhook
 * configurations continue to work.
 */
export async function disconnectGiteaIntegration(owner: Owner) {
  const ownershipCondition =
    owner.type === 'user'
      ? eq(platform_integrations.owned_by_user_id, owner.id)
      : eq(platform_integrations.owned_by_organization_id, owner.id);

  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(and(ownershipCondition, eq(platform_integrations.platform, PLATFORM.GITEA)))
    .limit(1);

  if (!integration) {
    return { success: false, message: 'Integration not found' };
  }

  await db.transaction(async tx => {
    await tx
      .update(platform_integrations)
      .set({
        integration_status: INTEGRATION_STATUS.SUSPENDED,
        disconnected_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .where(eq(platform_integrations.id, integration.id));

    await tx
      .delete(platform_oauth_credentials)
      .where(eq(platform_oauth_credentials.platform_integration_id, integration.id));
  });

  await resetCodeReviewConfigForOwner(owner, PLATFORM.GITEA);

  return { success: true, message: 'Integration disconnected' };
}

export async function disconnectGiteaIntegrationForUser(
  userId: string,
  integrationId: string
): Promise<boolean> {
  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.id, integrationId),
        eq(platform_integrations.owned_by_user_id, userId),
        eq(platform_integrations.platform, PLATFORM.GITEA)
      )
    )
    .limit(1);

  if (!integration) return false;

  return disconnectGiteaIntegration({ type: 'user', id: userId }).then(r => r.success);
}

export async function disconnectGiteaIntegrationForOrganization(
  organizationId: string,
  integrationId: string
): Promise<boolean> {
  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.id, integrationId),
        eq(platform_integrations.owned_by_organization_id, organizationId),
        eq(platform_integrations.platform, PLATFORM.GITEA)
      )
    )
    .limit(1);

  if (!integration) return false;

  return disconnectGiteaIntegration({ type: 'org', id: organizationId }).then(r => r.success);
}
