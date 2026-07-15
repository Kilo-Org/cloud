import 'server-only';
import { db } from '@/lib/drizzle';
import type { PlatformIntegration } from '@kilocode/db/schema';
import {
  platform_access_token_credentials,
  platform_integrations,
  platform_oauth_credentials,
} from '@kilocode/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { requireNumericPlatformRepositories, type Owner } from '@/lib/integrations/core/types';
import { INTEGRATION_STATUS, PLATFORM } from '@/lib/integrations/core/constants';
import { updateRepositoriesForIntegration } from '@/lib/integrations/db/platform-integrations';
import { resetCodeReviewConfigForOwner } from '@/lib/agent-config/db/agent-configs';
import {
  fetchGitLabProjects,
  fetchGitLabBranches,
  createProjectAccessToken,
  findKiloProjectAccessToken,
  rotateProjectAccessToken,
  revokeProjectAccessToken,
  calculateProjectAccessTokenExpiry,
  isProjectAccessTokenExpiringSoon,
  validateProjectAccessToken,
  validatePersonalAccessToken,
  type GitLabProjectAccessToken,
  type GitLabPATValidationResult,
  GitLabProjectAccessTokenPermissionError,
} from '@/lib/integrations/platforms/gitlab/adapter';
import { randomBytes, randomUUID } from 'crypto';
import { logExceptInTest } from '@/lib/utils.server';
import {
  DEFAULT_GITLAB_INSTANCE_URL,
  GitLabInstanceUrlError,
  normalizeGitLabInstanceUrl,
} from '@/lib/integrations/platforms/gitlab/instance-url';
import {
  mutateGitLabMetadataInTransaction,
  readGitLabMetadataInTransaction,
} from '@/lib/integrations/platforms/gitlab/metadata-mutation';
import {
  encryptGitLabPersonalAccessToken,
  encryptGitLabProjectAccessToken,
} from '@/lib/integrations/platforms/gitlab/credential-encryption';
import {
  GitLabPersonalAccessTokenMetadataSchema,
  GitLabProjectAccessTokenCredentialRowSchema,
  GitLabProjectAccessTokenMetadataSchema,
} from '@kilocode/worker-utils/gitlab-credential';
import {
  fetchGitLabCredential,
  type GitLabCredentialActor,
  type GitLabCredentialBrokerResult,
} from '@/lib/integrations/platforms/gitlab/credential-broker-client';

/**
 * GitLab Integration Service
 *
 * Provides business logic for GitLab OAuth integrations.
 * Handles token refresh, repository listing, and integration management.
 */

/**
 * Normalizes a GitLab instance URL for comparison.
 * Strips trailing slashes, lowercases, and treats undefined/empty as gitlab.com.
 */
export function normalizeInstanceUrl(url?: string): string {
  return normalizeGitLabInstanceUrl(url || DEFAULT_GITLAB_INSTANCE_URL);
}

/**
 * Returns true if the GitLab instance URL has changed between
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
  if (typeof value !== 'string') throw new Error(`GitLab metadata ${key} must be a string`);
  return value;
}

function requireMetadataRecord(metadata: unknown): Readonly<Record<string, unknown>> {
  if (metadata === null) return {};
  if (typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Invalid GitLab integration metadata' });
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
    throw new Error(`GitLab metadata ${key} must be an object`);
  }
  return { ...value };
}

function countMetadataObjectEntries(value: unknown): number {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.keys(value).length
    : 0;
}

function getGitLabIntegrationOwner(integration: PlatformIntegration): Owner {
  if (integration.owned_by_user_id && !integration.owned_by_organization_id) {
    return { type: 'user', id: integration.owned_by_user_id };
  }
  if (integration.owned_by_organization_id && !integration.owned_by_user_id) {
    return { type: 'org', id: integration.owned_by_organization_id };
  }
  throw new Error('GitLab integration must have exactly one owner');
}

function requireGitLabProjectId(projectId: string | number): string {
  const value = String(projectId);
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error('GitLab project ID must be a positive decimal');
  }
  return value;
}

/**
 * Get GitLab integration for an owner
 */
export async function getGitLabIntegration(owner: Owner): Promise<PlatformIntegration | null> {
  const ownershipCondition =
    owner.type === 'user'
      ? eq(platform_integrations.owned_by_user_id, owner.id)
      : eq(platform_integrations.owned_by_organization_id, owner.id);

  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(and(ownershipCondition, eq(platform_integrations.platform, PLATFORM.GITLAB)))
    .limit(1);

  return integration || null;
}

/**
 * Resolve a GitLab credential through the private-key holding token service.
 */
function requireAvailableGitLabCredential(
  result: GitLabCredentialBrokerResult,
  expectedInstanceUrl: string
): string {
  if (result.status === 'available') {
    if (result.instanceUrl !== expectedInstanceUrl) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'GitLab integration changed while resolving credentials',
      });
    }
    return result.token;
  }

  switch (result.status) {
    case 'invalid_request':
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid GitLab credential request' });
    case 'not_connected':
      throw new TRPCError({ code: 'NOT_FOUND', message: 'GitLab integration not found' });
    case 'reconnect_required':
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'GitLab integration must be reconnected',
      });
    case 'temporarily_unavailable':
      throw new TRPCError({
        code: 'SERVICE_UNAVAILABLE',
        message: 'GitLab credentials are temporarily unavailable',
      });
  }
}

export async function getValidGitLabToken(
  integration: PlatformIntegration,
  actor: GitLabCredentialActor
): Promise<string> {
  const metadata = requireMetadataRecord(integration.metadata);
  const expectedInstanceUrl = normalizeInstanceUrl(
    readOptionalMetadataString(metadata, 'gitlab_instance_url')
  );
  return requireAvailableGitLabCredential(
    await fetchGitLabCredential(actor, {
      credential: 'integration',
      integrationId: integration.id,
    }),
    expectedInstanceUrl
  );
}

export async function getValidGitLabProjectAccessToken(
  integration: PlatformIntegration,
  projectId: string | number,
  actor: GitLabCredentialActor
): Promise<string> {
  const metadata = requireMetadataRecord(integration.metadata);
  const expectedInstanceUrl = normalizeInstanceUrl(
    readOptionalMetadataString(metadata, 'gitlab_instance_url')
  );
  return requireAvailableGitLabCredential(
    await fetchGitLabCredential(actor, {
      credential: 'project-exact',
      integrationId: integration.id,
      projectId: requireGitLabProjectId(projectId),
    }),
    expectedInstanceUrl
  );
}

/**
 * List repositories accessible by a GitLab integration
 * Returns cached repositories by default, fetches fresh from GitLab when forceRefresh is true
 */
export async function listGitLabRepositories(
  owner: Owner,
  integrationId: string,
  actor: GitLabCredentialActor,
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
        eq(platform_integrations.platform, PLATFORM.GITLAB)
      )
    )
    .limit(1);

  if (!integration) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'GitLab integration not found',
    });
  }

  const cachedRepositories = requireNumericPlatformRepositories(integration.repositories);
  // If forceRefresh, no cached repos, or never synced before, fetch from GitLab and update cache
  if (forceRefresh || !cachedRepositories?.length || !integration.repositories_synced_at) {
    const accessToken = await getValidGitLabToken(integration, actor);
    const metadata = integration.metadata as { gitlab_instance_url?: string } | null;
    const instanceUrl = normalizeInstanceUrl(metadata?.gitlab_instance_url);

    const repos = await fetchGitLabProjects(accessToken, instanceUrl);
    await updateRepositoriesForIntegration(integrationId, repos);

    return {
      repositories: repos,
      syncedAt: new Date().toISOString(),
    };
  }

  // Return cached repos
  return {
    repositories: cachedRepositories,
    syncedAt: integration.repositories_synced_at,
  };
}

/**
 * List branches for a GitLab project
 * Always fetches fresh from GitLab (no caching)
 */
export async function listGitLabBranches(
  owner: Owner,
  integrationId: string,
  actor: GitLabCredentialActor,
  projectPath: string // e.g., "group/project" or project ID
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
        eq(platform_integrations.platform, PLATFORM.GITLAB)
      )
    )
    .limit(1);

  if (!integration) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'GitLab integration not found',
    });
  }

  const accessToken = await getValidGitLabToken(integration, actor);
  const metadata = integration.metadata as { gitlab_instance_url?: string } | null;
  const instanceUrl = normalizeInstanceUrl(metadata?.gitlab_instance_url);

  const branches = await fetchGitLabBranches(accessToken, projectPath, instanceUrl);

  return {
    branches: branches.map(b => ({
      name: b.name,
      isDefault: b.default,
    })),
  };
}

/**
 * Disconnect GitLab integration for an owner
 *
 * Instead of deleting the integration record, we mark it as disconnected.
 * This preserves the webhook_secret, configured_webhooks, and project_tokens
 * so that when the user reconnects (via OAuth or PAT), existing webhook
 * configurations continue to work.
 */
export async function disconnectGitLabIntegration(owner: Owner) {
  const ownershipCondition =
    owner.type === 'user'
      ? eq(platform_integrations.owned_by_user_id, owner.id)
      : eq(platform_integrations.owned_by_organization_id, owner.id);

  // Get the integration
  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(
      and(
        ownershipCondition,
        eq(platform_integrations.platform, PLATFORM.GITLAB),
        eq(platform_integrations.integration_status, INTEGRATION_STATUS.ACTIVE)
      )
    )
    .limit(1);

  if (!integration) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'GitLab integration not found',
    });
  }

  const updatedMetadata = await db.transaction(async tx => {
    const nextMetadata = await mutateGitLabMetadataInTransaction(tx, integration.id, {
      delete: [
        'access_token',
        'refresh_token',
        'token_expires_at',
        'client_id',
        'client_secret',
        'auth_type',
      ],
    });
    await tx
      .update(platform_integrations)
      .set({
        integration_status: INTEGRATION_STATUS.SUSPENDED,
        updated_at: new Date().toISOString(),
      })
      .where(eq(platform_integrations.id, integration.id));
    await tx
      .delete(platform_oauth_credentials)
      .where(eq(platform_oauth_credentials.platform_integration_id, integration.id));
    await tx
      .delete(platform_access_token_credentials)
      .where(
        and(
          eq(platform_access_token_credentials.platform_integration_id, integration.id),
          isNull(platform_access_token_credentials.provider_resource_id)
        )
      );
    return nextMetadata;
  });

  logExceptInTest(
    '[disconnectGitLabIntegration] Integration suspended (preserved webhook config)',
    {
      integrationId: integration.id,
      preservedWebhookSecret: !!updatedMetadata.webhook_secret,
      preservedWebhooks: countMetadataObjectEntries(updatedMetadata.configured_webhooks),
      preservedProjectTokens: countMetadataObjectEntries(updatedMetadata.project_tokens),
    }
  );

  return { success: true };
}

/**
 * Regenerate webhook secret for a GitLab integration
 * This is useful when the user has lost the webhook secret and needs to reconfigure
 * their GitLab webhook settings
 */
export async function regenerateWebhookSecret(owner: Owner): Promise<{ webhookSecret: string }> {
  const ownershipCondition =
    owner.type === 'user'
      ? eq(platform_integrations.owned_by_user_id, owner.id)
      : eq(platform_integrations.owned_by_organization_id, owner.id);

  // Get the integration
  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(
      and(
        ownershipCondition,
        eq(platform_integrations.platform, PLATFORM.GITLAB),
        eq(platform_integrations.integration_status, INTEGRATION_STATUS.ACTIVE)
      )
    )
    .limit(1);

  if (!integration) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'GitLab integration not found',
    });
  }

  // Generate new webhook secret
  const newWebhookSecret = randomBytes(32).toString('hex');

  const existingMetadata = (integration.metadata || {}) as Record<string, unknown>;
  const updatedMetadata = {
    ...existingMetadata,
    webhook_secret: newWebhookSecret,
  };

  await db
    .update(platform_integrations)
    .set({
      metadata: updatedMetadata,
      updated_at: new Date().toISOString(),
    })
    .where(eq(platform_integrations.id, integration.id));

  return { webhookSecret: newWebhookSecret };
}

// ============================================================================
// Project Access Token (PrAT) Management
// ============================================================================

/** Legacy plaintext project credential retained only until backfill and scrub. */
export type StoredProjectAccessToken = {
  /** GitLab token ID (for rotation/revocation) */
  token_id: number;
  /** The token value retained only during the migration window. */
  token: string;
  /** Expiration date in YYYY-MM-DD format */
  expires_at: string;
  /** When the token was created */
  created_at: string;
  /** Token name for identification */
  name: string;
};

/**
 * GitLab integration metadata type with PrAT support
 */
export type GitLabIntegrationMetadata = {
  access_token?: string;
  refresh_token?: string;
  token_expires_at?: string;
  gitlab_instance_url?: string;
  client_id?: string;
  client_secret?: string;
  webhook_secret?: string;
  auth_type?: 'oauth' | 'pat';
  /** Configured webhooks per project */
  configured_webhooks?: Record<
    string,
    {
      hook_id: number;
      created_at: string;
    }
  >;
  /** Project Access Tokens per project (keyed by project ID) */
  project_tokens?: Record<string, StoredProjectAccessToken>;
};

/**
 * Default name for Kilo Code Review Bot tokens
 */
const KILO_BOT_TOKEN_NAME = 'Kilo Code Review Bot';

async function getStoredProjectCredential(integrationId: string, projectId: string) {
  return db.transaction(async tx => {
    const metadata = await readGitLabMetadataInTransaction(tx, integrationId);
    const [row] = await tx
      .select()
      .from(platform_access_token_credentials)
      .where(
        and(
          eq(platform_access_token_credentials.platform_integration_id, integrationId),
          eq(platform_access_token_credentials.provider_credential_type, 'project_access_token'),
          eq(platform_access_token_credentials.provider_resource_id, projectId)
        )
      )
      .limit(1);

    if (row) {
      const parsed = GitLabProjectAccessTokenCredentialRowSchema.safeParse(row);
      const tokenId = parsed.success
        ? Number(parsed.data.provider_metadata.providerCredentialId)
        : Number.NaN;
      if (!parsed.success || !Number.isSafeInteger(tokenId)) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'GitLab project credential must be recreated',
        });
      }
      return {
        source: 'encrypted' as const,
        credentialId: parsed.data.id,
        credentialVersion: parsed.data.credential_version,
        tokenId,
        expiresAt: parsed.data.provider_metadata.expiresOn,
      };
    }

    const projectTokens = metadata.project_tokens;
    if (projectTokens === undefined) return null;
    if (
      typeof projectTokens !== 'object' ||
      projectTokens === null ||
      Array.isArray(projectTokens)
    ) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'GitLab project credential must be recreated',
      });
    }
    const candidate = (projectTokens as Record<string, unknown>)[projectId];
    if (candidate === undefined) return null;
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'GitLab project credential must be recreated',
      });
    }
    const legacy = candidate as Record<string, unknown>;
    const keys = Object.keys(legacy).sort();
    const expectedKeys = ['created_at', 'expires_at', 'name', 'token', 'token_id'];
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key, index) => key !== expectedKeys[index]) ||
      !Number.isSafeInteger(legacy.token_id) ||
      Number(legacy.token_id) <= 0 ||
      typeof legacy.token !== 'string' ||
      legacy.token.length === 0 ||
      typeof legacy.expires_at !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(legacy.expires_at) ||
      typeof legacy.created_at !== 'string' ||
      legacy.created_at.length === 0 ||
      typeof legacy.name !== 'string' ||
      legacy.name.length === 0
    ) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'GitLab project credential must be recreated',
      });
    }
    return {
      source: 'legacy' as const,
      tokenId: Number(legacy.token_id),
      expiresAt: legacy.expires_at,
    };
  });
}

/**
 * Gets or creates a Project Access Token for a GitLab project
 *
 * This function:
 * 1. Checks if an encrypted PrAT credential already exists for the project
 * 2. If exists and not expiring soon, returns it
 * 3. If exists but expiring soon, rotates it
 * 4. If doesn't exist, creates a new one
 *
 * @param integration - The GitLab integration record
 * @param projectId - GitLab project ID
 * @returns The Project Access Token to use for API calls
 */
export async function getOrCreateProjectAccessToken(
  integration: PlatformIntegration,
  projectId: string | number,
  actor: GitLabCredentialActor
): Promise<string> {
  const metadata = integration.metadata as GitLabIntegrationMetadata | null;
  const instanceUrl = normalizeInstanceUrl(metadata?.gitlab_instance_url);
  const projectIdStr = requireGitLabProjectId(projectId);

  // Credential metadata is authoritative; the plaintext project map is migration-only.
  const storedCredential = await getStoredProjectCredential(integration.id, projectIdStr);

  if (storedCredential) {
    // Check if token is expiring soon (within 7 days)
    const isExpiringSoon = isProjectAccessTokenExpiringSoon(storedCredential.expiresAt, 7);

    if (!isExpiringSoon) {
      // Validate the token is still valid on GitLab (might have been manually revoked)
      const projectToken = await getValidGitLabProjectAccessToken(integration, projectIdStr, actor);
      const isValid = await validateProjectAccessToken(projectToken, instanceUrl);

      if (isValid) {
        logExceptInTest('[getOrCreateProjectAccessToken] Using existing token', {
          projectId,
          tokenId: storedCredential.tokenId,
          expiresAt: storedCredential.expiresAt,
        });
        return projectToken;
      }

      // Token is invalid (revoked), remove from storage and create a new one
      logExceptInTest('[getOrCreateProjectAccessToken] Stored token is invalid, creating new one', {
        projectId,
        tokenId: storedCredential.tokenId,
      });

      // Remove the invalid token from storage and skip to creating a new one
      await removeInvalidStoredToken(integration.id, projectIdStr, storedCredential);
      // Don't try to rotate - fall through to create new token below
    } else {
      // Token is expiring soon, try to rotate it
      logExceptInTest('[getOrCreateProjectAccessToken] Token expiring soon, rotating', {
        projectId,
        tokenId: storedCredential.tokenId,
        expiresAt: storedCredential.expiresAt,
      });

      let rotatedToken: GitLabProjectAccessToken | null = null;
      try {
        // Get a valid user token for the rotation API call
        const userToken = await getValidGitLabToken(integration, actor);
        const newExpiresAt = calculateProjectAccessTokenExpiry(365);

        rotatedToken = await rotateProjectAccessToken(
          userToken,
          projectId,
          storedCredential.tokenId,
          newExpiresAt,
          instanceUrl
        );

        // Token value is only returned on rotation
        if (!rotatedToken.token) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'GitLab did not return token value after rotation',
          });
        }
      } catch (error) {
        // If rotation fails, try to create a new token
        logExceptInTest('[getOrCreateProjectAccessToken] Rotation failed, creating new token', {
          projectId,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      if (rotatedToken?.token) {
        // Keep persistence outside the provider fallback so a version conflict fails closed.
        await updateStoredProjectAccessToken(integration, projectIdStr, rotatedToken);

        logExceptInTest('[getOrCreateProjectAccessToken] Token rotated successfully', {
          projectId,
          newTokenId: rotatedToken.id,
          newExpiresAt: rotatedToken.expires_at,
        });

        return rotatedToken.token;
      }
    }
  }

  // No existing token or rotation failed, create a new one
  logExceptInTest('[getOrCreateProjectAccessToken] Creating new token', {
    projectId,
  });

  const userToken = await getValidGitLabToken(integration, actor);
  const expiresAt = calculateProjectAccessTokenExpiry(365);

  try {
    const newToken = await createProjectAccessToken(
      userToken,
      projectId,
      KILO_BOT_TOKEN_NAME,
      expiresAt,
      ['api', 'self_rotate'], // api for full access, self_rotate for token rotation
      30, // Developer access level
      instanceUrl
    );

    // Token value is only returned on creation
    if (!newToken.token) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'GitLab did not return token value after creation',
      });
    }

    // Store the new token
    await updateStoredProjectAccessToken(integration, projectIdStr, newToken);

    logExceptInTest('[getOrCreateProjectAccessToken] Token created successfully', {
      projectId,
      tokenId: newToken.id,
      expiresAt: newToken.expires_at,
    });

    return newToken.token;
  } catch (error) {
    if (error instanceof GitLabProjectAccessTokenPermissionError) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: `Cannot create bot token for project ${projectId}. You need Maintainer role or higher.`,
        cause: error,
      });
    }
    throw error;
  }
}

/**
 * Removes an invalid stored token from the integration metadata
 * Called when a stored token is found to be invalid (e.g., manually revoked on GitLab)
 */
async function removeInvalidStoredToken(
  integrationId: string,
  projectId: string,
  credential:
    | { source: 'encrypted'; credentialId: string; credentialVersion: number }
    | { source: 'legacy' }
): Promise<void> {
  await db.transaction(async tx => {
    await mutateGitLabMetadataInTransaction(tx, integrationId, currentMetadata => {
      const projectTokens = copyMetadataObject(currentMetadata, 'project_tokens');
      delete projectTokens[projectId];
      return { set: { project_tokens: projectTokens } };
    });
    if (credential.source === 'encrypted') {
      const deleted = await tx
        .delete(platform_access_token_credentials)
        .where(
          and(
            eq(platform_access_token_credentials.id, credential.credentialId),
            eq(platform_access_token_credentials.credential_version, credential.credentialVersion)
          )
        )
        .returning({ id: platform_access_token_credentials.id });
      if (deleted.length !== 1) {
        throw new Error('GitLab project access token was replaced concurrently');
      }
    }
  });

  logExceptInTest('[removeInvalidStoredToken] Removed invalid token from storage', {
    integrationId,
    projectId,
  });
}

/**
 * Stores only the exact encrypted project credential.
 */
async function updateStoredProjectAccessToken(
  integration: PlatformIntegration,
  projectId: string,
  providerToken: GitLabProjectAccessToken
): Promise<void> {
  if (!providerToken.token) {
    throw new Error('GitLab project access token value is required');
  }
  const token = providerToken.token;
  const integrationType = integration.integration_type;
  if (integrationType !== 'oauth' && integrationType !== 'pat') {
    throw new Error('GitLab integration type must be OAuth or PAT');
  }

  const owner = getGitLabIntegrationOwner(integration);
  const metadata = integration.metadata as GitLabIntegrationMetadata | null;
  const providerBaseUrl = normalizeInstanceUrl(metadata?.gitlab_instance_url);
  const providerMetadata = GitLabProjectAccessTokenMetadataSchema.parse({
    providerCredentialId: String(providerToken.id),
    expiresOn: providerToken.expires_at,
  });
  const validatedAt = new Date().toISOString();

  await db.transaction(async tx => {
    const currentMetadata = await readGitLabMetadataInTransaction(tx, integration.id);
    const currentProviderBaseUrl = normalizeInstanceUrl(
      readOptionalMetadataString(currentMetadata, 'gitlab_instance_url')
    );
    const currentIntegrationType = readOptionalMetadataString(currentMetadata, 'auth_type');
    if (currentProviderBaseUrl !== providerBaseUrl || currentIntegrationType !== integrationType) {
      throw new Error('GitLab integration changed while storing project credential');
    }
    const [existingCredential] = await tx
      .select()
      .from(platform_access_token_credentials)
      .where(
        and(
          eq(platform_access_token_credentials.platform_integration_id, integration.id),
          eq(platform_access_token_credentials.provider_credential_type, 'project_access_token'),
          eq(platform_access_token_credentials.provider_resource_id, projectId)
        )
      )
      .limit(1);
    const credentialId = existingCredential?.id ?? randomUUID();
    const credentialVersion = (existingCredential?.credential_version ?? 0) + 1;
    const tokenEncrypted = encryptGitLabProjectAccessToken({
      token,
      credentialId,
      integrationId: integration.id,
      providerBaseUrl,
      owner,
      providerResourceId: projectId,
      credentialVersion,
    });

    if (existingCredential) {
      const updatedCredential = await tx
        .update(platform_access_token_credentials)
        .set({
          token_encrypted: tokenEncrypted,
          expires_at: null,
          provider_credential_type: 'project_access_token',
          provider_resource_id: projectId,
          provider_base_url: providerBaseUrl,
          authorized_by_user_id: null,
          provider_metadata: providerMetadata,
          provider_scopes: providerToken.scopes,
          provider_verified_at: validatedAt,
          credential_version: credentialVersion,
          last_validated_at: validatedAt,
        })
        .where(
          and(
            eq(platform_access_token_credentials.id, existingCredential.id),
            eq(
              platform_access_token_credentials.credential_version,
              existingCredential.credential_version
            )
          )
        )
        .returning({ id: platform_access_token_credentials.id });
      if (updatedCredential.length !== 1) {
        throw new Error('GitLab project access token was replaced concurrently');
      }
      return;
    }

    await tx.insert(platform_access_token_credentials).values({
      id: credentialId,
      platform_integration_id: integration.id,
      token_encrypted: tokenEncrypted,
      expires_at: null,
      provider_credential_type: 'project_access_token',
      provider_resource_id: projectId,
      provider_base_url: providerBaseUrl,
      authorized_by_user_id: null,
      provider_metadata: providerMetadata,
      provider_scopes: providerToken.scopes,
      provider_verified_at: validatedAt,
      credential_version: credentialVersion,
      last_validated_at: validatedAt,
    });
  });
}

/**
 * Removes the stored Project Access Token for a project
 * Called when a project is removed from code reviews
 */
export async function removeStoredProjectAccessToken(
  integration: PlatformIntegration,
  projectId: string | number,
  actor: GitLabCredentialActor
): Promise<void> {
  const metadata = integration.metadata as GitLabIntegrationMetadata | null;
  const projectIdStr = requireGitLabProjectId(projectId);
  const storedCredential = await getStoredProjectCredential(integration.id, projectIdStr);
  if (!storedCredential) return;
  const instanceUrl = normalizeInstanceUrl(metadata?.gitlab_instance_url);

  // Try to revoke the token in GitLab
  try {
    const userToken = await getValidGitLabToken(integration, actor);
    await revokeProjectAccessToken(userToken, projectId, storedCredential.tokenId, instanceUrl);
    logExceptInTest('[removeStoredProjectAccessToken] Token revoked in GitLab', {
      projectId,
      tokenId: storedCredential.tokenId,
    });
  } catch (error) {
    // Log but don't fail - the token might already be revoked
    logExceptInTest('[removeStoredProjectAccessToken] Failed to revoke token in GitLab', {
      projectId,
      tokenId: storedCredential.tokenId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  await db.transaction(async tx => {
    await mutateGitLabMetadataInTransaction(tx, integration.id, currentMetadata => {
      const projectTokens = copyMetadataObject(currentMetadata, 'project_tokens');
      delete projectTokens[projectIdStr];
      return { set: { project_tokens: projectTokens } };
    });
    if (storedCredential.source === 'encrypted') {
      const deleted = await tx
        .delete(platform_access_token_credentials)
        .where(
          and(
            eq(platform_access_token_credentials.id, storedCredential.credentialId),
            eq(
              platform_access_token_credentials.credential_version,
              storedCredential.credentialVersion
            )
          )
        )
        .returning({ id: platform_access_token_credentials.id });
      if (deleted.length !== 1) {
        throw new Error('GitLab project access token was replaced concurrently');
      }
    } else {
      await tx
        .delete(platform_access_token_credentials)
        .where(
          and(
            eq(platform_access_token_credentials.platform_integration_id, integration.id),
            eq(platform_access_token_credentials.provider_credential_type, 'project_access_token'),
            eq(platform_access_token_credentials.provider_resource_id, projectIdStr)
          )
        );
    }
  });

  logExceptInTest('[removeStoredProjectAccessToken] Token removed from metadata', {
    projectId,
  });
}

/**
 * Finds an existing Kilo bot token on GitLab and imports it into metadata
 * Useful for recovering from lost metadata or migrating existing tokens
 */
export async function importExistingProjectAccessToken(
  integration: PlatformIntegration,
  projectId: string | number,
  actor: GitLabCredentialActor
): Promise<GitLabProjectAccessToken | null> {
  const metadata = integration.metadata as GitLabIntegrationMetadata | null;
  const instanceUrl = normalizeInstanceUrl(metadata?.gitlab_instance_url);
  const userToken = await getValidGitLabToken(integration, actor);

  // Find existing Kilo token on GitLab
  const existingToken = await findKiloProjectAccessToken(
    userToken,
    projectId,
    KILO_BOT_TOKEN_NAME,
    instanceUrl
  );

  if (existingToken) {
    logExceptInTest('[importExistingProjectAccessToken] Found existing token on GitLab', {
      projectId,
      tokenId: existingToken.id,
      expiresAt: existingToken.expires_at,
    });

    // Note: We can't get the token value from the API, only on creation
    // So we can only store the metadata, not the actual token
    // The caller will need to rotate the token to get a new value
  }

  return existingToken;
}

// ============================================================================
// Personal Access Token (PAT) Connection
// ============================================================================

/**
 * Re-export validatePersonalAccessToken for use in tRPC router
 */
export { validatePersonalAccessToken, type GitLabPATValidationResult };

/**
 * Connects GitLab using a Personal Access Token
 *
 * This is an alternative to OAuth for users who prefer PAT-based auth.
 * The PAT is used for:
 * - Account connection and identity verification
 * - Listing accessible repositories
 * - Creating webhooks (requires Maintainer role)
 * - Creating Project Access Tokens for code reviews
 *
 * Code reviews use Project Access Tokens (PrAT) so comments appear as a bot.
 *
 * If an existing integration exists, this function will update it instead of
 * creating a new one. This preserves webhook secrets and configured webhooks
 * so existing webhook configurations continue to work.
 *
 * @param owner - User or organization owner
 * @param token - Personal Access Token
 * @param instanceUrl - GitLab instance URL
 * @param authorizedByUserId - Authenticated Kilo user who supplied the PAT
 */
export async function connectWithPAT(
  owner: Owner,
  token: string,
  instanceUrl: string = 'https://gitlab.com',
  authorizedByUserId: string
): Promise<{
  success: boolean;
  integration: {
    id: string;
    accountLogin: string;
    accountId: string;
    instanceUrl: string;
  };
  warnings?: string[];
}> {
  let normalizedInstanceUrl: string;
  try {
    normalizedInstanceUrl = normalizeInstanceUrl(instanceUrl);
  } catch (error) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message:
        error instanceof GitLabInstanceUrlError ? error.message : 'Invalid GitLab instance URL',
    });
  }

  // 1. Validate the PAT
  const validation = await validatePersonalAccessToken(token, normalizedInstanceUrl);

  if (!validation.valid || !validation.user) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: validation.error || 'Invalid Personal Access Token',
    });
  }
  const validatedUser = validation.user;
  const validatedAt = new Date().toISOString();
  const providerMetadata = GitLabPersonalAccessTokenMetadataSchema.parse({
    providerCredentialId:
      validation.tokenInfo?.id === undefined ? undefined : String(validation.tokenInfo.id),
    expiresOn: validation.tokenInfo?.expiresAt ?? undefined,
  });

  // 2. Check for existing integration - update it instead of creating new
  const existingIntegration = await getGitLabIntegration(owner);

  if (existingIntegration) {
    let existingMetadata: Record<string, unknown> = {};
    let isInstanceChange = false;

    await db.transaction(async tx => {
      existingMetadata = await readGitLabMetadataInTransaction(tx, existingIntegration.id);
      isInstanceChange = instanceUrlChanged(
        readOptionalMetadataString(existingMetadata, 'gitlab_instance_url'),
        normalizedInstanceUrl
      );
      const [existingPrimaryCredential] = await tx
        .select()
        .from(platform_access_token_credentials)
        .where(
          and(
            eq(platform_access_token_credentials.platform_integration_id, existingIntegration.id),
            isNull(platform_access_token_credentials.provider_resource_id)
          )
        )
        .limit(1);
      const credentialId = existingPrimaryCredential?.id ?? randomUUID();
      const credentialVersion = (existingPrimaryCredential?.credential_version ?? 0) + 1;
      const tokenEncrypted = encryptGitLabPersonalAccessToken({
        token,
        credentialId,
        integrationId: existingIntegration.id,
        providerBaseUrl: normalizedInstanceUrl,
        owner,
        authorizedByUserId,
        credentialVersion,
      });

      await mutateGitLabMetadataInTransaction(tx, existingIntegration.id, {
        set: {
          gitlab_instance_url: normalizedInstanceUrl,
          auth_type: 'pat',
          webhook_secret: isInstanceChange
            ? randomBytes(32).toString('hex')
            : (readOptionalMetadataString(existingMetadata, 'webhook_secret') ??
              randomBytes(32).toString('hex')),
        },
        delete: [
          'access_token',
          'refresh_token',
          'token_expires_at',
          'client_id',
          'client_secret',
          ...(isInstanceChange ? ['configured_webhooks', 'project_tokens'] : []),
        ],
      });

      await tx
        .update(platform_integrations)
        .set({
          integration_type: 'pat',
          platform_installation_id: String(validatedUser.id),
          platform_account_id: String(validatedUser.id),
          platform_account_login: validatedUser.username,
          scopes: validation.tokenInfo?.scopes ?? ['api'],
          integration_status: INTEGRATION_STATUS.ACTIVE,
          updated_at: new Date().toISOString(),
        })
        .where(eq(platform_integrations.id, existingIntegration.id));

      if (isInstanceChange) {
        await tx
          .delete(platform_access_token_credentials)
          .where(
            eq(platform_access_token_credentials.platform_integration_id, existingIntegration.id)
          );
      }

      if (existingPrimaryCredential && !isInstanceChange) {
        const updatedCredential = await tx
          .update(platform_access_token_credentials)
          .set({
            token_encrypted: tokenEncrypted,
            expires_at: null,
            provider_credential_type: 'personal_access_token',
            provider_resource_id: null,
            provider_base_url: normalizedInstanceUrl,
            authorized_by_user_id: authorizedByUserId,
            provider_metadata: providerMetadata,
            provider_scopes: validation.tokenInfo?.scopes ?? null,
            provider_verified_at: validatedAt,
            credential_version: credentialVersion,
            last_validated_at: validatedAt,
          })
          .where(
            and(
              eq(platform_access_token_credentials.id, existingPrimaryCredential.id),
              eq(
                platform_access_token_credentials.credential_version,
                existingPrimaryCredential.credential_version
              )
            )
          )
          .returning({ id: platform_access_token_credentials.id });
        if (updatedCredential.length !== 1) {
          throw new Error('GitLab PAT was replaced concurrently');
        }
      } else {
        await tx.insert(platform_access_token_credentials).values({
          id: credentialId,
          platform_integration_id: existingIntegration.id,
          token_encrypted: tokenEncrypted,
          expires_at: null,
          provider_credential_type: 'personal_access_token',
          provider_resource_id: null,
          provider_base_url: normalizedInstanceUrl,
          authorized_by_user_id: authorizedByUserId,
          provider_metadata: providerMetadata,
          provider_scopes: validation.tokenInfo?.scopes ?? null,
          provider_verified_at: validatedAt,
          credential_version: credentialVersion,
          last_validated_at: validatedAt,
        });
      }

      await tx
        .delete(platform_oauth_credentials)
        .where(eq(platform_oauth_credentials.platform_integration_id, existingIntegration.id));
    });

    if (isInstanceChange) {
      logExceptInTest('[connectWithPAT] Instance URL changed — clearing stale config', {
        integrationId: existingIntegration.id,
        oldInstanceUrl: readOptionalMetadataString(existingMetadata, 'gitlab_instance_url'),
        newInstanceUrl: normalizedInstanceUrl,
      });
    }

    // If instance changed, reset the code review agent config
    // (selected repos and manually added repos belong to the old instance)
    if (isInstanceChange) {
      await resetCodeReviewConfigForOwner(owner, PLATFORM.GITLAB);
    }

    logExceptInTest('[connectWithPAT] Integration updated', {
      integrationId: existingIntegration.id,
      userId: validatedUser.id,
      username: validatedUser.username,
      instanceUrl: normalizedInstanceUrl,
      authType: 'pat',
      instanceChanged: isInstanceChange,
      preservedWebhookSecret:
        !isInstanceChange && !!readOptionalMetadataString(existingMetadata, 'webhook_secret'),
      preservedWebhooks: isInstanceChange
        ? 0
        : countMetadataObjectEntries(existingMetadata.configured_webhooks),
    });

    // Fetch and cache repositories
    const repos = await fetchGitLabProjects(token, normalizedInstanceUrl);
    await updateRepositoriesForIntegration(existingIntegration.id, repos);

    return {
      success: true,
      integration: {
        id: existingIntegration.id,
        accountLogin: validatedUser.username,
        accountId: String(validatedUser.id),
        instanceUrl: normalizedInstanceUrl,
      },
      warnings: validation.warnings,
    };
  }

  // 3. No existing integration - create new one with fresh webhook secret
  const webhookSecret = randomBytes(32).toString('hex');

  // 4. Prepare metadata
  const metadata: GitLabIntegrationMetadata = {
    // No refresh_token for PAT (PATs don't refresh)
    gitlab_instance_url: normalizedInstanceUrl,
    webhook_secret: webhookSecret,
    auth_type: 'pat',
  };

  const integrationId = randomUUID();
  const credentialId = randomUUID();
  const credentialVersion = 1;
  const tokenEncrypted = encryptGitLabPersonalAccessToken({
    token,
    credentialId,
    integrationId,
    providerBaseUrl: normalizedInstanceUrl,
    owner,
    authorizedByUserId,
    credentialVersion,
  });

  // 5. Create the parent and encrypted credential atomically.
  const integration = await db.transaction(async tx => {
    const [createdIntegration] = await tx
      .insert(platform_integrations)
      .values({
        id: integrationId,
        owned_by_user_id: owner.type === 'user' ? owner.id : null,
        owned_by_organization_id: owner.type === 'org' ? owner.id : null,
        platform: PLATFORM.GITLAB,
        integration_type: 'pat',
        platform_installation_id: String(validatedUser.id), // Use GitLab user ID as "installation" ID
        platform_account_id: String(validatedUser.id),
        platform_account_login: validatedUser.username,
        permissions: null, // PAT doesn't have granular permissions like GitHub Apps
        scopes: validation.tokenInfo?.scopes ?? ['api'],
        repository_access: 'all', // PAT grants access to all user's projects
        integration_status: INTEGRATION_STATUS.ACTIVE,
        metadata,
        installed_at: validatedAt,
      })
      .returning();

    await tx.insert(platform_access_token_credentials).values({
      id: credentialId,
      platform_integration_id: integrationId,
      token_encrypted: tokenEncrypted,
      expires_at: null,
      provider_credential_type: 'personal_access_token',
      provider_resource_id: null,
      provider_base_url: normalizedInstanceUrl,
      authorized_by_user_id: authorizedByUserId,
      provider_metadata: providerMetadata,
      provider_scopes: validation.tokenInfo?.scopes ?? null,
      provider_verified_at: validatedAt,
      credential_version: credentialVersion,
      last_validated_at: validatedAt,
    });
    await tx
      .delete(platform_oauth_credentials)
      .where(eq(platform_oauth_credentials.platform_integration_id, integrationId));

    return createdIntegration;
  });

  logExceptInTest('[connectWithPAT] Integration created', {
    integrationId: integration.id,
    userId: validatedUser.id,
    username: validatedUser.username,
    instanceUrl: normalizedInstanceUrl,
    authType: 'pat',
  });

  // 6. Fetch and cache repositories
  const repos = await fetchGitLabProjects(token, normalizedInstanceUrl);
  await updateRepositoriesForIntegration(integration.id, repos);

  logExceptInTest('[connectWithPAT] Repositories cached', {
    integrationId: integration.id,
    repoCount: repos.length,
  });

  return {
    success: true,
    integration: {
      id: integration.id,
      accountLogin: validatedUser.username,
      accountId: String(validatedUser.id),
      instanceUrl: normalizedInstanceUrl,
    },
    warnings: validation.warnings,
  };
}
