/**
 * App Builder Service Client
 *
 * Communicates with the App Builder API (Cloudflare worker) for managing
 * project initialization, preview deployments, and builds.
 */

import { APP_BUILDER_URL, APP_BUILDER_AUTH_TOKEN } from '@/lib/config.server';

// Import shared schemas from cloudflare-app-builder
import {
  InitSuccessResponseSchema,
  GetPreviewResponseSchema,
  TokenSuccessResponseSchema,
  MigrateToGithubResponseSchema,
  type InitSuccessResponse,
  type InitRequest,
  type GetPreviewResponse,
  type PreviewState,
  type TokenRequest,
  type MigrateToGithubRequest,
  type MigrateToGithubResponse,
} from '../../../cloudflare-app-builder/src/api-schemas';

// Re-export types for consumers
export type {
  InitSuccessResponse,
  GetPreviewResponse,
  PreviewState,
  MigrateToGithubRequest,
  MigrateToGithubResponse,
};

// Error type for API errors
class AppBuilderError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public endpoint?: string
  ) {
    super(message);
    this.name = 'AppBuilderError';
  }
}

export { AppBuilderError };

function getBaseUrl(): string {
  const url = APP_BUILDER_URL;
  if (!url) {
    throw new AppBuilderError('APP_BUILDER_URL environment variable is not configured');
  }
  return url.replace(/\/$/, ''); // Remove trailing slash if present
}

/**
 * Initialize a git repository for a project.
 *
 * @param projectId - The unique identifier for the project
 * @param options - Optional initialization options
 * @param options.template - Template name to use
 * @returns Object containing success, app_id, and git_url for the initialized repository
 * @throws AppBuilderError if the request fails
 */
export async function initProject(
  projectId: string,
  options: InitRequest
): Promise<InitSuccessResponse> {
  const baseUrl = getBaseUrl();
  const endpoint = `${baseUrl}/apps/${encodeURIComponent(projectId)}/init`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(APP_BUILDER_AUTH_TOKEN && { Authorization: `Bearer ${APP_BUILDER_AUTH_TOKEN}` }),
    },
    body: JSON.stringify(options ?? {}),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new AppBuilderError(
      `Failed to initialize project ${projectId}: ${response.status} ${response.statusText} - ${errorText}`,
      response.status,
      endpoint
    );
  }

  const data = await response.json();
  const parsed = InitSuccessResponseSchema.parse(data);

  return parsed;
}

/**
 * Get the preview URL and build status for a project.
 *
 * @param projectId - The unique identifier for the project
 * @returns Object containing the status ('idle' | 'building' | 'running' | 'error') and previewUrl (nullable)
 * @throws AppBuilderError if the request fails
 */
export async function getPreview(projectId: string): Promise<GetPreviewResponse> {
  const baseUrl = getBaseUrl();
  const endpoint = `${baseUrl}/apps/${encodeURIComponent(projectId)}/preview`;

  const response = await fetch(endpoint, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(APP_BUILDER_AUTH_TOKEN && { Authorization: `Bearer ${APP_BUILDER_AUTH_TOKEN}` }),
    },
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new AppBuilderError(
      `Failed to get preview for project ${projectId}: ${response.status} ${response.statusText} - ${errorText}`,
      response.status,
      endpoint
    );
  }

  const data = await response.json();
  const parsed = GetPreviewResponseSchema.parse(data);

  return parsed;
}

/**
 * Trigger a build for a project.
 *
 * This is a fire-and-forget operation. The build runs asynchronously.
 * Use getPreview() to poll for status or streamBuildLogs() to watch progress.
 *
 * @param projectId - The unique identifier for the project
 * @throws AppBuilderError if the request fails
 */
export async function triggerBuild(projectId: string): Promise<void> {
  const baseUrl = getBaseUrl();
  const endpoint = `${baseUrl}/apps/${encodeURIComponent(projectId)}/build`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(APP_BUILDER_AUTH_TOKEN && { Authorization: `Bearer ${APP_BUILDER_AUTH_TOKEN}` }),
    },
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new AppBuilderError(
      `Failed to trigger build for project ${projectId}: ${response.status} ${response.statusText} - ${errorText}`,
      response.status,
      endpoint
    );
  }
}

/**
 * Stream build logs for a project via Server-Sent Events.
 *
 * @param projectId - The unique identifier for the project
 * @returns A ReadableStream of SSE events containing build logs
 * @throws AppBuilderError if the request fails or no logs are available
 */
export async function streamBuildLogs(projectId: string): Promise<ReadableStream<Uint8Array>> {
  const baseUrl = getBaseUrl();
  const endpoint = `${baseUrl}/apps/${encodeURIComponent(projectId)}/build/logs`;

  const response = await fetch(endpoint, {
    method: 'GET',
    headers: {
      Accept: 'text/event-stream',
      ...(APP_BUILDER_AUTH_TOKEN && { Authorization: `Bearer ${APP_BUILDER_AUTH_TOKEN}` }),
    },
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new AppBuilderError(
      `Failed to stream build logs for project ${projectId}: ${response.status} ${response.statusText} - ${errorText}`,
      response.status,
      endpoint
    );
  }

  if (!response.body) {
    throw new AppBuilderError(
      `No response body for build logs stream for project ${projectId}`,
      response.status,
      endpoint
    );
  }

  return response.body;
}

/**
 * Generate a short-lived JWT token for git repository access
 * @param appId - The app/repository ID
 * @param permission - 'full' for read+write (Cloud Agent), 'ro' for read-only (deployments)
 * @returns Token and expiry information
 */
export async function generateGitToken(
  appId: string,
  permission: TokenRequest['permission']
): Promise<{ token: string; expiresAt: string; permission: TokenRequest['permission'] }> {
  const baseUrl = getBaseUrl();
  const endpoint = `${baseUrl}/apps/${encodeURIComponent(appId)}/token`;

  const body: TokenRequest = { permission };
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(APP_BUILDER_AUTH_TOKEN && { Authorization: `Bearer ${APP_BUILDER_AUTH_TOKEN}` }),
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new AppBuilderError(
      `Failed to generate git token for app ${appId}: ${response.status} ${response.statusText} - ${errorText}`,
      response.status,
      endpoint
    );
  }

  const data = await response.json();
  const parsed = TokenSuccessResponseSchema.parse(data);

  return {
    token: parsed.token,
    expiresAt: parsed.expires_at,
    permission: parsed.permission,
  };
}

/**
 * Delete a project and all associated resources from the App Builder service.
 *
 * @param projectId - The unique identifier for the project
 * @throws AppBuilderError if the request fails
 */
export async function deleteProject(projectId: string): Promise<void> {
  const baseUrl = getBaseUrl();
  const endpoint = `${baseUrl}/apps/${encodeURIComponent(projectId)}`;

  const response = await fetch(endpoint, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      ...(APP_BUILDER_AUTH_TOKEN && { Authorization: `Bearer ${APP_BUILDER_AUTH_TOKEN}` }),
    },
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new AppBuilderError(
      `Failed to delete project ${projectId}: ${response.status} ${response.statusText} - ${errorText}`,
      response.status,
      endpoint
    );
  }
}

/**
 * Migrate a project to GitHub.
 *
 * Pushes the internal git repository to GitHub, then configures the preview
 * to clone from GitHub and schedules deletion of the internal git repository.
 *
 * @param projectId - The unique identifier for the project
 * @param config - Remote push credentials, GitHub repo, and user context
 * @returns Object indicating success/failure
 * @throws AppBuilderError if the request fails
 */
export async function migrateToGithub(
  projectId: string,
  config: MigrateToGithubRequest
): Promise<MigrateToGithubResponse> {
  const baseUrl = getBaseUrl();
  const endpoint = `${baseUrl}/apps/${encodeURIComponent(projectId)}/migrate-to-github`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(APP_BUILDER_AUTH_TOKEN && { Authorization: `Bearer ${APP_BUILDER_AUTH_TOKEN}` }),
    },
    body: JSON.stringify(config),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new AppBuilderError(
      `Failed to migrate project ${projectId} to GitHub: ${response.status} ${response.statusText} - ${errorText}`,
      response.status,
      endpoint
    );
  }

  const data = await response.json();
  return MigrateToGithubResponseSchema.parse(data);
}
