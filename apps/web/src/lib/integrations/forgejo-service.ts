import 'server-only';
import { db } from '@kilocode/web-shared/lib/drizzle';
import type { PlatformIntegration } from '@kilocode/db/schema';
import { platform_integrations, platform_oauth_credentials } from '@kilocode/db/schema';
import { eq, and } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import {
  type ForgejoOAuthCredentialActor,
  fetchForgejoCredential,
  type ForgejoCredentialBrokerResult,
} from '@/lib/integrations/platforms/forgejo/credential-broker-client';
import {
  fetchForgejoProjects,
  fetchForgejoBranches,
  DEFAULT_FORGEJO_INSTANCE_URL,
  normalizeForgejoInstanceUrl,
} from '@/lib/integrations/platforms/forgejo/adapter';
import {
  mutateForgejoMetadataInTransaction,
  readForgejoMetadataInTransaction,
} from '@/lib/integrations/platforms/forgejo/metadata-mutation';
import { requireNumericPlatformRepositories, type Owner } from '@/lib/integrations/core/types';
import { INTEGRATION_STATUS, PLATFORM } from '@/lib/integrations/core/constants';
import { updateRepositoriesForIntegration } from '@/lib/integrations/db/platform-integrations';
import { resetCodeReviewConfigForOwner } from '@/lib/agent-config/db/agent-configs';
import { logExceptInTest } from '@kilocode/web-shared/lib/utils.server';

/**
 * Forgejo Integration Service
 *
 * Provides business logic for Forgejo OAuth integrations.
 * Handles token refresh, repository listing, and integration management.
 */

/**
 * Normalizes a Forgejo instance URL for comparison.
 * Strips trailing slashes, lowercases, and treats undefined/empty as codeberg.org.
 */
export function normalizeInstanceUrl(url?: string): string {
  return normalizeForgejoInstanceUrl(url || DEFAULT_FORGEJO_INSTANCE_URL);
}

/**
 * Returns true if the Forgejo instance URL has changed between
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
  if (typeof value !== 'string') throw new Error(`Forgejo metadata ${key} must be a string`);
  return value;
}

function requireMetadataRecord(metadata: unknown): Readonly<Record<string, unknown>> {
  if (metadata === null) return {};
  if (typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Invalid Forgejo integration metadata',
    });
  }
  return { ...metadata };
}

function getForgejoIntegrationOwner(integration: PlatformIntegration): Owner {
  if (integration.owned_by_user_id && !integration.owned_by_organization_id) {
    return { type: 'user', id: integration.owned_by_user_id };
  }
  if (integration.owned_by_organization_id && !integration.owned_by_user_id) {
    return { type: 'org', id: integration.owned_by_organization_id };
  }
  throw new Error('Forgejo integration must have exactly one owner');
}

/**
 * Get Forgejo integration for an owner
 */
export async function getForgejoIntegration(owner: Owner): Promise<PlatformIntegration | null> {
  const ownershipCondition =
    owner.type === 'user'
      ? eq(platform_integrations.owned_by_user_id, owner.id)
      : eq(platform_integrations.owned_by_organization_id, owner.id);

  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(and(ownershipCondition, eq(platform_integrations.platform, PLATFORM.FORGEJO)))
    .limit(1);

  return integration || null;
}

/**
 * Resolve a Forgejo credential through the private-key holding token service.
 */
function requireAvailableForgejoCredential(
  result: ForgejoCredentialBrokerResult,
  expectedInstanceUrl: string
): string {
  if (result.status === 'available') {
    if (result.instanceUrl !== expectedInstanceUrl) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'Forgejo integration changed while resolving credentials',
      });
    }
    return result.token;
  }

  switch (result.status) {
    case 'invalid_request':
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid Forgejo credential request' });
    case 'not_connected':
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Forgejo integration not found' });
    case 'reconnect_required':
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'Forgejo integration must be reconnected',
      });
    case 'temporarily_unavailable':
      throw new TRPCError({
        code: 'SERVICE_UNAVAILABLE',
        message: 'Forgejo credentials are temporarily unavailable',
      });
  }
}

export async function getValidForgejoToken(
  integration: PlatformIntegration,
  actor: ForgejoOAuthCredentialActor
): Promise<string> {
  const metadata = requireMetadataRecord(integration.metadata);
  const expectedInstanceUrl = normalizeInstanceUrl(
    readOptionalMetadataString(metadata, 'forgejo_instance_url')
  );
  return requireAvailableForgejoCredential(
    await fetchForgejoCredential(actor, {
      credential: 'integration',
      integrationId: integration.id,
    }),
    expectedInstanceUrl
  );
}

export async function getValidForgejoProjectAccessToken(
  integration: PlatformIntegration,
  projectId: string | number,
  actor: ForgejoOAuthCredentialActor
): Promise<string> {
  const metadata = requireMetadataRecord(integration.metadata);
  const expectedInstanceUrl = normalizeInstanceUrl(
    readOptionalMetadataString(metadata, 'forgejo_instance_url')
  );
  return requireAvailableForgejoCredential(
    await fetchForgejoCredential(actor, {
      credential: 'project-exact',
      integrationId: integration.id,
      projectId: String(projectId),
    }),
    expectedInstanceUrl
  );
}

/**
 * List repositories accessible by a Forgejo integration
 * Returns cached repositories by default, fetches fresh from Forgejo when forceRefresh is true
 */
export async function listForgejoRepositories(
  owner: Owner,
  integrationId: string,
  actor: ForgejoOAuthCredentialActor,
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
        eq(platform_integrations.platform, PLATFORM.FORGEJO)
      )
    )
    .limit(1);

  if (!integration) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Forgejo integration not found',
    });
  }

  const cachedRepositories = requireNumericPlatformRepositories(integration.repositories);
  if (forceRefresh || !cachedRepositories?.length || !integration.repositories_synced_at) {
    const accessToken = await getValidForgejoToken(integration, actor);
    const metadata = integration.metadata as { forgejo_instance_url?: string } | null;
    const instanceUrl = normalizeInstanceUrl(metadata?.forgejo_instance_url);

    const repos = await fetchForgejoProjects(accessToken, instanceUrl);
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
 * List branches for a Forgejo repository
 * Always fetches fresh from Forgejo (no caching)
 */
export async function listForgejoBranches(
  owner: Owner,
  integrationId: string,
  actor: ForgejoOAuthCredentialActor,
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
        eq(platform_integrations.platform, PLATFORM.FORGEJO)
      )
    )
    .limit(1);

  if (!integration) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Forgejo integration not found',
    });
  }

  const accessToken = await getValidForgejoToken(integration, actor);
  const metadata = integration.metadata as { forgejo_instance_url?: string } | null;
  const instanceUrl = normalizeInstanceUrl(metadata?.forgejo_instance_url);

  const branches = await fetchForgejoBranches(accessToken, repoPath, instanceUrl);

  return {
    branches: branches.map(b => ({
      name: b.name,
      isDefault: b.default,
    })),
  };
}

/**
 * Disconnect Forgejo integration for an owner
 *
 * Instead of deleting the integration record, we mark it as disconnected.
 * This preserves the webhook_secret, configured_webhooks, and project_tokens
 * so that when the user reconnects (via OAuth), existing webhook
 * configurations continue to work.
 */
export async function disconnectForgejoIntegration(owner: Owner) {
  const ownershipCondition =
    owner.type === 'user'
      ? eq(platform_integrations.owned_by_user_id, owner.id)
      : eq(platform_integrations.owned_by_organization_id, owner.id);

  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(and(ownershipCondition, eq(platform_integrations.platform, PLATFORM.FORGEJO)))
    .limit(1);

  if (!integration) {
    return { success: false, message: 'Integration not found' };
  }

  await db.transaction(async tx => {
    await tx
      .update(platform_integrations)
      .set({
        integration_status: INTEGRATION_STATUS.SUSPENDED,
        suspended_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .where(eq(platform_integrations.id, integration.id));

    await tx
      .delete(platform_oauth_credentials)
      .where(eq(platform_oauth_credentials.platform_integration_id, integration.id));
  });

  await resetCodeReviewConfigForOwner(owner, PLATFORM.FORGEJO);

  return { success: true, message: 'Integration disconnected' };
}

export async function disconnectForgejoIntegrationForUser(
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
        eq(platform_integrations.platform, PLATFORM.FORGEJO)
      )
    )
    .limit(1);

  if (!integration) return false;

  return disconnectForgejoIntegration({ type: 'user', id: userId }).then(r => r.success);
}

export async function disconnectForgejoIntegrationForOrganization(
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
        eq(platform_integrations.platform, PLATFORM.FORGEJO)
      )
    )
    .limit(1);

  if (!integration) return false;

  return disconnectForgejoIntegration({ type: 'org', id: organizationId }).then(r => r.success);
}
