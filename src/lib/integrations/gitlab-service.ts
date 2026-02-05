import 'server-only';
import { db } from '@/lib/drizzle';
import type { PlatformIntegration } from '@/db/schema';
import { platform_integrations } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import type { Owner } from '@/lib/integrations/core/types';
import { INTEGRATION_STATUS, PLATFORM } from '@/lib/integrations/core/constants';
import { updateRepositoriesForIntegration } from '@/lib/integrations/db/platform-integrations';
import {
  fetchGitLabProjects,
  fetchGitLabBranches,
  refreshGitLabOAuthToken,
  isTokenExpired,
  calculateTokenExpiry,
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
import { randomBytes } from 'crypto';
import { logExceptInTest } from '@/lib/utils.server';

/**
 * GitLab Integration Service
 *
 * Provides business logic for GitLab OAuth integrations.
 * Handles token refresh, repository listing, and integration management.
 */

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
 * Get a valid access token for a GitLab integration
 *
 * @param integration - The GitLab integration record
 * @returns Valid access token
 */
export async function getValidGitLabToken(integration: PlatformIntegration): Promise<string> {
  const metadata = integration.metadata as GitLabIntegrationMetadata | null;

  if (!metadata?.access_token) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'GitLab integration missing access token',
    });
  }

  // PAT tokens don't expire in the same way as OAuth tokens
  // They have a fixed expiration date set at creation
  if (metadata.auth_type === 'pat') {
    // For PAT, we can't refresh - just return the token
    // The user will need to create a new PAT if it expires
    return metadata.access_token;
  }

  // OAuth token refresh logic
  if (metadata.token_expires_at && isTokenExpired(metadata.token_expires_at)) {
    if (!metadata.refresh_token) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'GitLab token expired and no refresh token available. Please reconnect.',
      });
    }

    const instanceUrl = metadata.gitlab_instance_url || 'https://gitlab.com';

    const customCredentials =
      metadata.client_id && metadata.client_secret
        ? { clientId: metadata.client_id, clientSecret: metadata.client_secret }
        : undefined;

    const newTokens = await refreshGitLabOAuthToken(
      metadata.refresh_token,
      instanceUrl,
      customCredentials
    );

    const newExpiresAt = calculateTokenExpiry(newTokens.created_at, newTokens.expires_in);

    await db
      .update(platform_integrations)
      .set({
        metadata: {
          ...metadata,
          access_token: newTokens.access_token,
          refresh_token: newTokens.refresh_token,
          token_expires_at: newExpiresAt,
        },
        updated_at: new Date().toISOString(),
      })
      .where(eq(platform_integrations.id, integration.id));

    return newTokens.access_token;
  }

  return metadata.access_token;
}

/**
 * List repositories accessible by a GitLab integration
 * Returns cached repositories by default, fetches fresh from GitLab when forceRefresh is true
 */
export async function listGitLabRepositories(
  owner: Owner,
  integrationId: string,
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

  // If forceRefresh, no cached repos, or never synced before, fetch from GitLab and update cache
  if (forceRefresh || !integration.repositories?.length || !integration.repositories_synced_at) {
    const accessToken = await getValidGitLabToken(integration);
    const metadata = integration.metadata as { gitlab_instance_url?: string } | null;
    const instanceUrl = metadata?.gitlab_instance_url || 'https://gitlab.com';

    const repos = await fetchGitLabProjects(accessToken, instanceUrl);
    await updateRepositoriesForIntegration(integrationId, repos);

    return {
      repositories: repos,
      syncedAt: new Date().toISOString(),
    };
  }

  // Return cached repos
  return {
    repositories: integration.repositories,
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

  const accessToken = await getValidGitLabToken(integration);
  const metadata = integration.metadata as { gitlab_instance_url?: string } | null;
  const instanceUrl = metadata?.gitlab_instance_url || 'https://gitlab.com';

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

  // Mark as disconnected instead of deleting
  // This preserves webhook_secret, configured_webhooks, and project_tokens
  // so reconnecting (via OAuth or PAT) will keep existing webhook configurations working
  const existingMetadata = (integration.metadata || {}) as GitLabIntegrationMetadata;

  // Clear sensitive tokens but preserve webhook configuration
  const updatedMetadata: GitLabIntegrationMetadata = {
    // Clear tokens
    access_token: undefined,
    refresh_token: undefined,
    token_expires_at: undefined,
    // Preserve instance URL for reconnection
    gitlab_instance_url: existingMetadata.gitlab_instance_url,
    // Clear OAuth credentials
    client_id: undefined,
    client_secret: undefined,
    // PRESERVE webhook secret so existing webhooks continue to work
    webhook_secret: existingMetadata.webhook_secret,
    // Clear auth type (will be set on reconnect)
    auth_type: undefined,
    // PRESERVE configured webhooks
    configured_webhooks: existingMetadata.configured_webhooks,
    // PRESERVE project tokens (they're still valid on GitLab)
    project_tokens: existingMetadata.project_tokens,
  };

  await db
    .update(platform_integrations)
    .set({
      integration_status: INTEGRATION_STATUS.SUSPENDED,
      metadata: updatedMetadata,
      updated_at: new Date().toISOString(),
    })
    .where(eq(platform_integrations.id, integration.id));

  logExceptInTest(
    '[disconnectGitLabIntegration] Integration suspended (preserved webhook config)',
    {
      integrationId: integration.id,
      preservedWebhookSecret: !!existingMetadata.webhook_secret,
      preservedWebhooks: Object.keys(existingMetadata.configured_webhooks || {}).length,
      preservedProjectTokens: Object.keys(existingMetadata.project_tokens || {}).length,
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

  // Update the metadata with the new webhook secret
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

/**
 * Stored Project Access Token metadata
 * This is stored per-project in the integration metadata
 */
export type StoredProjectAccessToken = {
  /** GitLab token ID (for rotation/revocation) */
  token_id: number;
  /** The actual token value (should be encrypted in production) */
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

/**
 * Gets or creates a Project Access Token for a GitLab project
 *
 * This function:
 * 1. Checks if a PrAT already exists for the project in metadata
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
  projectId: string | number
): Promise<string> {
  const metadata = integration.metadata as GitLabIntegrationMetadata | null;

  if (!metadata?.access_token) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'GitLab integration missing access token',
    });
  }

  const instanceUrl = metadata.gitlab_instance_url || 'https://gitlab.com';
  const projectIdStr = String(projectId);

  // Check if we already have a stored token for this project
  const storedToken = metadata.project_tokens?.[projectIdStr];

  if (storedToken) {
    // Check if token is expiring soon (within 7 days)
    const isExpiringSoon = isProjectAccessTokenExpiringSoon(storedToken.expires_at, 7);

    if (!isExpiringSoon) {
      // Validate the token is still valid on GitLab (might have been manually revoked)
      const isValid = await validateProjectAccessToken(storedToken.token, instanceUrl);

      if (isValid) {
        logExceptInTest('[getOrCreateProjectAccessToken] Using existing token', {
          projectId,
          tokenId: storedToken.token_id,
          expiresAt: storedToken.expires_at,
        });
        return storedToken.token;
      }

      // Token is invalid (revoked), remove from storage and create a new one
      logExceptInTest('[getOrCreateProjectAccessToken] Stored token is invalid, creating new one', {
        projectId,
        tokenId: storedToken.token_id,
      });

      // Remove the invalid token from storage and skip to creating a new one
      await removeInvalidStoredToken(integration.id, projectIdStr, metadata);
      // Don't try to rotate - fall through to create new token below
    } else {
      // Token is expiring soon, try to rotate it
      logExceptInTest('[getOrCreateProjectAccessToken] Token expiring soon, rotating', {
        projectId,
        tokenId: storedToken.token_id,
        expiresAt: storedToken.expires_at,
      });

      try {
        // Get a valid user token for the rotation API call
        const userToken = await getValidGitLabToken(integration);
        const newExpiresAt = calculateProjectAccessTokenExpiry(365);

        const rotatedToken = await rotateProjectAccessToken(
          userToken,
          projectId,
          storedToken.token_id,
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

        // Update stored token
        await updateStoredProjectAccessToken(integration.id, projectIdStr, {
          token_id: rotatedToken.id,
          token: rotatedToken.token,
          expires_at: rotatedToken.expires_at,
          created_at: new Date().toISOString(),
          name: rotatedToken.name,
        });

        logExceptInTest('[getOrCreateProjectAccessToken] Token rotated successfully', {
          projectId,
          newTokenId: rotatedToken.id,
          newExpiresAt: rotatedToken.expires_at,
        });

        return rotatedToken.token;
      } catch (error) {
        // If rotation fails, try to create a new token
        logExceptInTest('[getOrCreateProjectAccessToken] Rotation failed, creating new token', {
          projectId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  // No existing token or rotation failed, create a new one
  logExceptInTest('[getOrCreateProjectAccessToken] Creating new token', {
    projectId,
  });

  const userToken = await getValidGitLabToken(integration);
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
    await updateStoredProjectAccessToken(integration.id, projectIdStr, {
      token_id: newToken.id,
      token: newToken.token,
      expires_at: newToken.expires_at,
      created_at: new Date().toISOString(),
      name: newToken.name,
    });

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
  metadata: GitLabIntegrationMetadata
): Promise<void> {
  const projectTokens = { ...metadata.project_tokens };
  delete projectTokens[projectId];

  await db
    .update(platform_integrations)
    .set({
      metadata: {
        ...metadata,
        project_tokens: projectTokens,
      },
      updated_at: new Date().toISOString(),
    })
    .where(eq(platform_integrations.id, integrationId));

  logExceptInTest('[removeInvalidStoredToken] Removed invalid token from storage', {
    integrationId,
    projectId,
  });
}

/**
 * Updates the stored Project Access Token for a project in the integration metadata
 */
async function updateStoredProjectAccessToken(
  integrationId: string,
  projectId: string,
  tokenData: StoredProjectAccessToken
): Promise<void> {
  // Get current metadata
  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(eq(platform_integrations.id, integrationId))
    .limit(1);

  if (!integration) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Integration not found',
    });
  }

  const metadata = (integration.metadata || {}) as GitLabIntegrationMetadata;
  const projectTokens = metadata.project_tokens || {};

  // Update the token for this project
  projectTokens[projectId] = tokenData;

  // Save back to database
  await db
    .update(platform_integrations)
    .set({
      metadata: {
        ...metadata,
        project_tokens: projectTokens,
      },
      updated_at: new Date().toISOString(),
    })
    .where(eq(platform_integrations.id, integrationId));
}

/**
 * Removes the stored Project Access Token for a project
 * Called when a project is removed from code reviews
 */
export async function removeStoredProjectAccessToken(
  integration: PlatformIntegration,
  projectId: string | number
): Promise<void> {
  const metadata = integration.metadata as GitLabIntegrationMetadata | null;
  const projectIdStr = String(projectId);

  if (!metadata?.project_tokens?.[projectIdStr]) {
    // No token stored, nothing to do
    return;
  }

  const storedToken = metadata.project_tokens[projectIdStr];
  const instanceUrl = metadata.gitlab_instance_url || 'https://gitlab.com';

  // Try to revoke the token in GitLab
  try {
    const userToken = await getValidGitLabToken(integration);
    await revokeProjectAccessToken(userToken, projectId, storedToken.token_id, instanceUrl);
    logExceptInTest('[removeStoredProjectAccessToken] Token revoked in GitLab', {
      projectId,
      tokenId: storedToken.token_id,
    });
  } catch (error) {
    // Log but don't fail - the token might already be revoked
    logExceptInTest('[removeStoredProjectAccessToken] Failed to revoke token in GitLab', {
      projectId,
      tokenId: storedToken.token_id,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Remove from metadata
  const projectTokens = { ...metadata.project_tokens };
  delete projectTokens[projectIdStr];

  await db
    .update(platform_integrations)
    .set({
      metadata: {
        ...metadata,
        project_tokens: projectTokens,
      },
      updated_at: new Date().toISOString(),
    })
    .where(eq(platform_integrations.id, integration.id));

  logExceptInTest('[removeStoredProjectAccessToken] Token removed from metadata', {
    projectId,
  });
}

/**
 * Gets the stored Project Access Token for a project (if exists)
 * Returns null if no token is stored
 */
export function getStoredProjectAccessToken(
  integration: PlatformIntegration,
  projectId: string | number
): StoredProjectAccessToken | null {
  const metadata = integration.metadata as GitLabIntegrationMetadata | null;
  const projectIdStr = String(projectId);

  return metadata?.project_tokens?.[projectIdStr] || null;
}

/**
 * Checks if a Project Access Token exists and is valid for a project
 */
export function hasValidProjectAccessToken(
  integration: PlatformIntegration,
  projectId: string | number
): boolean {
  const storedToken = getStoredProjectAccessToken(integration, projectId);

  if (!storedToken) {
    return false;
  }

  // Check if token is not expiring within 1 day
  return !isProjectAccessTokenExpiringSoon(storedToken.expires_at, 1);
}

/**
 * Finds an existing Kilo bot token on GitLab and imports it into metadata
 * Useful for recovering from lost metadata or migrating existing tokens
 */
export async function importExistingProjectAccessToken(
  integration: PlatformIntegration,
  projectId: string | number
): Promise<GitLabProjectAccessToken | null> {
  const metadata = integration.metadata as GitLabIntegrationMetadata | null;

  if (!metadata?.access_token) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'GitLab integration missing access token',
    });
  }

  const instanceUrl = metadata.gitlab_instance_url || 'https://gitlab.com';
  const userToken = await getValidGitLabToken(integration);

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
 */
export async function connectWithPAT(
  owner: Owner,
  token: string,
  instanceUrl: string = 'https://gitlab.com'
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
  // 1. Validate the PAT
  const validation = await validatePersonalAccessToken(token, instanceUrl);

  if (!validation.valid || !validation.user) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: validation.error || 'Invalid Personal Access Token',
    });
  }

  // 2. Check for existing integration - update it instead of creating new
  const existingIntegration = await getGitLabIntegration(owner);

  if (existingIntegration) {
    // Update existing integration, preserving webhook_secret, configured_webhooks, and project_tokens
    const existingMetadata = (existingIntegration.metadata || {}) as GitLabIntegrationMetadata;

    const updatedMetadata: GitLabIntegrationMetadata = {
      access_token: token,
      // No refresh_token for PAT (PATs don't refresh)
      gitlab_instance_url: instanceUrl,
      // Preserve existing webhook secret so configured webhooks continue to work
      webhook_secret: existingMetadata.webhook_secret || randomBytes(32).toString('hex'),
      auth_type: 'pat',
      // Preserve configured webhooks
      configured_webhooks: existingMetadata.configured_webhooks,
      // Preserve project access tokens
      project_tokens: existingMetadata.project_tokens,
    };

    await db
      .update(platform_integrations)
      .set({
        integration_type: 'pat',
        platform_installation_id: String(validation.user.id),
        platform_account_id: String(validation.user.id),
        platform_account_login: validation.user.username,
        scopes: validation.tokenInfo?.scopes ?? ['api'],
        integration_status: INTEGRATION_STATUS.ACTIVE,
        metadata: updatedMetadata,
        updated_at: new Date().toISOString(),
      })
      .where(eq(platform_integrations.id, existingIntegration.id));

    logExceptInTest('[connectWithPAT] Integration updated (preserved webhook config)', {
      integrationId: existingIntegration.id,
      userId: validation.user.id,
      username: validation.user.username,
      instanceUrl,
      authType: 'pat',
      preservedWebhookSecret: !!existingMetadata.webhook_secret,
      preservedWebhooks: Object.keys(existingMetadata.configured_webhooks || {}).length,
    });

    // Fetch and cache repositories
    const repos = await fetchGitLabProjects(token, instanceUrl);
    await updateRepositoriesForIntegration(existingIntegration.id, repos);

    return {
      success: true,
      integration: {
        id: existingIntegration.id,
        accountLogin: validation.user.username,
        accountId: String(validation.user.id),
        instanceUrl,
      },
      warnings: validation.warnings,
    };
  }

  // 3. No existing integration - create new one with fresh webhook secret
  const webhookSecret = randomBytes(32).toString('hex');

  // 4. Prepare metadata
  const metadata: GitLabIntegrationMetadata = {
    access_token: token,
    // No refresh_token for PAT (PATs don't refresh)
    gitlab_instance_url: instanceUrl,
    webhook_secret: webhookSecret,
    auth_type: 'pat',
  };

  // 5. Create integration
  const [integration] = await db
    .insert(platform_integrations)
    .values({
      owned_by_user_id: owner.type === 'user' ? owner.id : null,
      owned_by_organization_id: owner.type === 'org' ? owner.id : null,
      platform: PLATFORM.GITLAB,
      integration_type: 'pat',
      platform_installation_id: String(validation.user.id), // Use GitLab user ID as "installation" ID
      platform_account_id: String(validation.user.id),
      platform_account_login: validation.user.username,
      permissions: null, // PAT doesn't have granular permissions like GitHub Apps
      scopes: validation.tokenInfo?.scopes ?? ['api'],
      repository_access: 'all', // PAT grants access to all user's projects
      integration_status: INTEGRATION_STATUS.ACTIVE,
      metadata,
      installed_at: new Date().toISOString(),
    })
    .returning();

  logExceptInTest('[connectWithPAT] Integration created', {
    integrationId: integration.id,
    userId: validation.user.id,
    username: validation.user.username,
    instanceUrl,
    authType: 'pat',
  });

  // 6. Fetch and cache repositories
  const repos = await fetchGitLabProjects(token, instanceUrl);
  await updateRepositoriesForIntegration(integration.id, repos);

  logExceptInTest('[connectWithPAT] Repositories cached', {
    integrationId: integration.id,
    repoCount: repos.length,
  });

  return {
    success: true,
    integration: {
      id: integration.id,
      accountLogin: validation.user.username,
      accountId: String(validation.user.id),
      instanceUrl,
    },
    warnings: validation.warnings,
  };
}
