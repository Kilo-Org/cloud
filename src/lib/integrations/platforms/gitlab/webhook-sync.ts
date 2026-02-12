/**
 * GitLab Webhook Sync
 *
 * Handles automatic creation and deletion of webhooks when users
 * configure code reviews for their GitLab repositories.
 */

import { APP_URL } from '@/lib/constants';
import { logExceptInTest } from '@/lib/utils.server';
import {
  createProjectWebhook,
  deleteProjectWebhook,
  findKiloWebhook,
  updateProjectWebhook,
  GitLabWebhookPermissionError,
} from './adapter';

const DEFAULT_GITLAB_URL = 'https://gitlab.com';

/**
 * Encodes a webhook URL for GitLab API.
 * GitLab requires special characters like colons to be percent-encoded.
 *
 * @param url - The webhook URL to encode
 * @returns The encoded URL
 */
function encodeWebhookUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // Encode the host (which includes the port with colon)
    // GitLab requires the colon in "localhost:3000" to be encoded as %3A
    const encodedHost = encodeURIComponent(parsed.host);
    return `${parsed.protocol}//${encodedHost}${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    // If URL parsing fails, return the original URL
    return url;
  }
}

/**
 * Kilo webhook URL for GitLab (encoded for GitLab API)
 */
export const KILO_GITLAB_WEBHOOK_URL = encodeWebhookUrl(`${APP_URL}/api/webhooks/gitlab`);

/**
 * Configured webhook info stored in integration metadata
 */
export type ConfiguredWebhook = {
  hook_id: number;
  created_at: string;
  updated_at?: string;
};

/**
 * Result of a webhook sync operation
 */
export type WebhookSyncResult = {
  created: Array<{ projectId: number; hookId: number }>;
  updated: Array<{ projectId: number; hookId: number }>;
  deleted: Array<{ projectId: number; hookId: number }>;
  errors: Array<{ projectId: number; error: string; operation: 'create' | 'update' | 'delete' }>;
};

/**
 * Syncs webhooks for the given repositories.
 *
 * - Creates webhooks for newly selected repositories
 * - Deletes webhooks for repositories that were removed from selection
 * - Updates webhooks if they already exist but need reconfiguration
 *
 * @param accessToken - OAuth access token (requires Maintainer+ role on projects)
 * @param webhookSecret - The webhook secret for this integration
 * @param selectedRepositoryIds - Currently selected repository IDs
 * @param previousRepositoryIds - Previously selected repository IDs
 * @param configuredWebhooks - Map of project ID to webhook info from metadata
 * @param instanceUrl - GitLab instance URL (defaults to gitlab.com)
 */
export async function syncWebhooksForRepositories(
  accessToken: string,
  webhookSecret: string,
  selectedRepositoryIds: number[],
  previousRepositoryIds: number[],
  configuredWebhooks: Record<string, ConfiguredWebhook>,
  instanceUrl: string = DEFAULT_GITLAB_URL
): Promise<{
  result: WebhookSyncResult;
  updatedWebhooks: Record<string, ConfiguredWebhook>;
}> {
  const result: WebhookSyncResult = {
    created: [],
    updated: [],
    deleted: [],
    errors: [],
  };

  // Clone the configured webhooks to track updates
  const updatedWebhooks: Record<string, ConfiguredWebhook> = { ...configuredWebhooks };

  // Find repos that were added (need webhook creation)
  const addedRepos = selectedRepositoryIds.filter(id => !previousRepositoryIds.includes(id));

  // Find repos that were removed (need webhook deletion)
  const removedRepos = previousRepositoryIds.filter(id => !selectedRepositoryIds.includes(id));

  logExceptInTest('[syncWebhooksForRepositories] Starting sync', {
    selectedCount: selectedRepositoryIds.length,
    previousCount: previousRepositoryIds.length,
    addedCount: addedRepos.length,
    removedCount: removedRepos.length,
    webhookUrl: KILO_GITLAB_WEBHOOK_URL,
  });

  // Create webhooks for added repos
  for (const projectId of addedRepos) {
    try {
      // Check if webhook already exists (e.g., from a previous configuration)
      const existingWebhook = await findKiloWebhook(
        accessToken,
        projectId,
        KILO_GITLAB_WEBHOOK_URL,
        instanceUrl
      );

      if (existingWebhook) {
        // Update existing webhook to ensure it has the correct secret
        const updated = await updateProjectWebhook(
          accessToken,
          projectId,
          existingWebhook.id,
          KILO_GITLAB_WEBHOOK_URL,
          webhookSecret,
          instanceUrl
        );

        result.updated.push({ projectId, hookId: updated.id });
        updatedWebhooks[String(projectId)] = {
          hook_id: updated.id,
          created_at: existingWebhook.created_at,
          updated_at: new Date().toISOString(),
        };

        logExceptInTest('[syncWebhooksForRepositories] Updated existing webhook', {
          projectId,
          hookId: updated.id,
        });
      } else {
        // Create new webhook
        const created = await createProjectWebhook(
          accessToken,
          projectId,
          KILO_GITLAB_WEBHOOK_URL,
          webhookSecret,
          instanceUrl
        );

        result.created.push({ projectId, hookId: created.id });
        updatedWebhooks[String(projectId)] = {
          hook_id: created.id,
          created_at: new Date().toISOString(),
        };

        logExceptInTest('[syncWebhooksForRepositories] Created new webhook', {
          projectId,
          hookId: created.id,
        });
      }
    } catch (error) {
      // Provide a more user-friendly error message for permission errors
      let errorMessage: string;
      if (error instanceof GitLabWebhookPermissionError) {
        errorMessage = `Permission denied: You need Maintainer role or higher on this project to configure webhooks automatically. You can still configure the webhook manually in GitLab.`;
      } else {
        errorMessage = error instanceof Error ? error.message : String(error);
      }

      result.errors.push({
        projectId,
        error: errorMessage,
        operation: 'create',
      });

      logExceptInTest('[syncWebhooksForRepositories] Failed to create/update webhook', {
        projectId,
        error: errorMessage,
        isPermissionError: error instanceof GitLabWebhookPermissionError,
      });
    }
  }

  // Delete webhooks for removed repos
  for (const projectId of removedRepos) {
    const webhookInfo = configuredWebhooks[String(projectId)];

    if (!webhookInfo) {
      // No webhook was configured for this project, skip
      logExceptInTest('[syncWebhooksForRepositories] No webhook to delete', { projectId });
      continue;
    }

    try {
      await deleteProjectWebhook(accessToken, projectId, webhookInfo.hook_id, instanceUrl);

      result.deleted.push({ projectId, hookId: webhookInfo.hook_id });
      delete updatedWebhooks[String(projectId)];

      logExceptInTest('[syncWebhooksForRepositories] Deleted webhook', {
        projectId,
        hookId: webhookInfo.hook_id,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      result.errors.push({
        projectId,
        error: errorMessage,
        operation: 'delete',
      });

      // Still remove from our tracking since we can't manage it
      delete updatedWebhooks[String(projectId)];

      logExceptInTest('[syncWebhooksForRepositories] Failed to delete webhook', {
        projectId,
        hookId: webhookInfo.hook_id,
        error: errorMessage,
      });
    }
  }

  logExceptInTest('[syncWebhooksForRepositories] Sync complete', {
    created: result.created.length,
    updated: result.updated.length,
    deleted: result.deleted.length,
    errors: result.errors.length,
  });

  return { result, updatedWebhooks };
}

/**
 * Creates webhooks for all selected repositories.
 * Used for initial setup when auto-configure is enabled.
 *
 * @param accessToken - OAuth access token (requires Maintainer+ role on projects)
 * @param webhookSecret - The webhook secret for this integration
 * @param repositoryIds - Repository IDs to create webhooks for
 * @param instanceUrl - GitLab instance URL (defaults to gitlab.com)
 */
export async function createWebhooksForRepositories(
  accessToken: string,
  webhookSecret: string,
  repositoryIds: number[],
  instanceUrl: string = DEFAULT_GITLAB_URL
): Promise<{
  result: WebhookSyncResult;
  configuredWebhooks: Record<string, ConfiguredWebhook>;
}> {
  return syncWebhooksForRepositories(
    accessToken,
    webhookSecret,
    repositoryIds,
    [], // No previous repos
    {}, // No existing webhooks
    instanceUrl
  ).then(({ result, updatedWebhooks }) => ({
    result,
    configuredWebhooks: updatedWebhooks,
  }));
}

/**
 * Deletes all configured webhooks.
 * Used when disabling code reviews or disconnecting the integration.
 *
 * @param accessToken - OAuth access token (requires Maintainer+ role on projects)
 * @param configuredWebhooks - Map of project ID to webhook info from metadata
 * @param instanceUrl - GitLab instance URL (defaults to gitlab.com)
 */
export async function deleteAllWebhooks(
  accessToken: string,
  configuredWebhooks: Record<string, ConfiguredWebhook>,
  instanceUrl: string = DEFAULT_GITLAB_URL
): Promise<WebhookSyncResult> {
  const projectIds = Object.keys(configuredWebhooks).map(id => parseInt(id, 10));

  const { result } = await syncWebhooksForRepositories(
    accessToken,
    '', // Secret not needed for deletion
    [], // No selected repos (delete all)
    projectIds, // All previous repos
    configuredWebhooks,
    instanceUrl
  );

  return result;
}
