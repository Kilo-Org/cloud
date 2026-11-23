import { APP_URL } from '@kilocode/web-shared/lib/constants';
import { logExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import {
  createProjectWebhook,
  deleteProjectWebhook,
  findKiloWebhook,
  updateProjectWebhook,
  GitLabAuthenticationError,
  GitLabWebhookPermissionError,
} from './adapter';

const DEFAULT_GITLAB_URL = 'https://gitlab.com';

/**
 * GitLab requires special characters like colons to be percent-encoded.
 */
function encodeWebhookUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // GitLab requires the colon in "localhost:3000" to be encoded as %3A
    const encodedHost = encodeURIComponent(parsed.host);
    return `${parsed.protocol}//${encodedHost}${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return url;
  }
}

export const KILO_GITLAB_WEBHOOK_URL = encodeWebhookUrl(`${APP_URL}/api/webhooks/gitlab`);

export type ConfiguredWebhook = {
  hook_id: number;
  created_at: string;
  updated_at?: string;
};

/**
 * Turns any provider failure into one actionable message, so a create, an
 * update and a retry of a kept delete all report the same guidance instead of
 * a raw provider status line.
 */
function describeWebhookSyncError(error: unknown): string {
  if (error instanceof GitLabAuthenticationError) {
    return `GitLab rejected the connected credential: reconnect the GitLab integration, then retry. You can still configure the webhook manually in GitLab.`;
  }

  if (error instanceof GitLabWebhookPermissionError) {
    return `Permission denied: You need Maintainer role or higher on this project to configure webhooks automatically. You can still configure the webhook manually in GitLab.`;
  }

  return error instanceof Error ? error.message : String(error);
}

/**
 * Narrows a secret rotation to the stored webhook handles. A rotation re-signs
 * only hooks it already stores, so a selected project with no stored handle is
 * left to the save path and rotation never creates a hook. The stored-id
 * fallback keeps a rotation from becoming a bulk removal when the stored
 * selection is absent, unusable or empty.
 */
export function rotationRepositorySelection(
  configuredWebhooks: Record<string, ConfiguredWebhook>,
  storedSelection: number[] | undefined
): number[] {
  const storedIds = Object.keys(configuredWebhooks)
    .map(key => Number.parseInt(key, 10))
    .filter(id => Number.isFinite(id));

  if (storedSelection === undefined) {
    return storedIds;
  }

  const selectedStoredIds = storedSelection.filter(
    id => configuredWebhooks[String(id)] !== undefined
  );

  return selectedStoredIds.length > 0 ? selectedStoredIds : storedIds;
}

export type WebhookSyncResult = {
  created: Array<{ projectId: number; hookId: number }>;
  updated: Array<{ projectId: number; hookId: number }>;
  deleted: Array<{ projectId: number; hookId: number }>;
  errors: Array<{
    projectId: number;
    error: string;
    operation: 'create' | 'update' | 'delete';
    /** Set on a delete failure: the stored handle the platform kept for a retry. */
    hookId?: number;
  }>;
};

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

  const updatedWebhooks: Record<string, ConfiguredWebhook> = { ...configuredWebhooks };

  // A selected repository needs a Kilo webhook unless the stored configuration
  // already records one, so a create that failed is attempted again. A removal
  // keeps its stored handle, so the next save retries a delete that failed.
  const addedRepos = selectedRepositoryIds.filter(
    id => !previousRepositoryIds.includes(id) || configuredWebhooks[String(id)] === undefined
  );

  // A removal is any stored handle whose project left the selection. A delete
  // that failed keeps its stored handle so the next save retries it, and the
  // stored map is then the only place that still names the project. The entry
  // key travels with its handle, so the handle is read without a second lookup.
  const removedRepos = Object.entries(configuredWebhooks).flatMap(([key, webhook]) => {
    const projectId = Number.parseInt(key, 10);
    if (!Number.isFinite(projectId) || selectedRepositoryIds.includes(projectId)) return [];
    return [{ key, projectId, webhook }];
  });

  logExceptInTest('[syncWebhooksForRepositories] Starting sync', {
    selectedCount: selectedRepositoryIds.length,
    previousCount: previousRepositoryIds.length,
    addedCount: addedRepos.length,
    removedCount: removedRepos.length,
    webhookUrl: KILO_GITLAB_WEBHOOK_URL,
  });

  for (const projectId of addedRepos) {
    try {
      const existingWebhook = await findKiloWebhook(
        accessToken,
        projectId,
        KILO_GITLAB_WEBHOOK_URL,
        instanceUrl
      );

      if (existingWebhook) {
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
      const errorMessage = describeWebhookSyncError(error);

      result.errors.push({
        projectId,
        error: errorMessage,
        operation: 'create',
      });

      logExceptInTest('[syncWebhooksForRepositories] Failed to create/update webhook', {
        projectId,
        error: errorMessage,
        isPermissionError: error instanceof GitLabWebhookPermissionError,
        isAuthenticationError: error instanceof GitLabAuthenticationError,
      });
    }
  }

  for (const { key, projectId, webhook: webhookInfo } of removedRepos) {
    try {
      await deleteProjectWebhook(accessToken, projectId, webhookInfo.hook_id, instanceUrl);

      result.deleted.push({ projectId, hookId: webhookInfo.hook_id });
      delete updatedWebhooks[key];

      logExceptInTest('[syncWebhooksForRepositories] Deleted webhook', {
        projectId,
        hookId: webhookInfo.hook_id,
      });
    } catch (error) {
      const errorMessage = describeWebhookSyncError(error);
      result.errors.push({
        projectId,
        error: errorMessage,
        operation: 'delete',
        hookId: webhookInfo.hook_id,
      });

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
