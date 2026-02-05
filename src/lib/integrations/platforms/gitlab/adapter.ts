/**
 * GitLab API Adapter
 *
 * Provides OAuth-based authentication and API operations for GitLab.
 * Supports both GitLab.com and self-hosted GitLab instances.
 */

import { APP_URL } from '@/lib/constants';
import { getEnvVariable } from '@/lib/dotenvx';
import type { PlatformRepository } from '@/lib/integrations/core/types';
import { logExceptInTest } from '@/lib/utils.server';
import crypto from 'crypto';

const GITLAB_CLIENT_ID = process.env.GITLAB_CLIENT_ID;
const GITLAB_CLIENT_SECRET = getEnvVariable('GITLAB_CLIENT_SECRET');
const GITLAB_REDIRECT_URI = `${APP_URL}/api/integrations/gitlab/callback`;

const DEFAULT_GITLAB_URL = 'https://gitlab.com';

/**
 * GitLab OAuth scopes required for the integration
 */
export const GITLAB_OAUTH_SCOPES = [
  'api', // Full API access (needed for MR comments, reactions)
  'read_user', // Read user info
  'read_repository', // Read repository contents
  'write_repository', // Push branches (for auto-fix)
] as const;

/**
 * GitLab API response types
 */
export type GitLabUser = {
  id: number;
  username: string;
  name: string;
  email: string;
  avatar_url: string;
  web_url: string;
};

export type GitLabProject = {
  id: number;
  name: string;
  path_with_namespace: string;
  visibility: 'private' | 'internal' | 'public';
  default_branch: string;
  web_url: string;
  archived: boolean;
};

export type GitLabBranch = {
  name: string;
  default: boolean;
  protected: boolean;
};

export type GitLabOAuthTokens = {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  created_at: number;
  scope: string;
};

/**
 * OAuth credentials type for self-hosted GitLab instances
 */
export type GitLabOAuthCredentials = {
  clientId: string;
  clientSecret: string;
};

/**
 * Builds the GitLab OAuth authorization URL
 *
 * @param state - State parameter for CSRF protection (e.g., "org_xxx" or "user_xxx")
 * @param instanceUrl - GitLab instance URL (defaults to gitlab.com)
 * @param customCredentials - Optional custom OAuth credentials for self-hosted instances
 */
export function buildGitLabOAuthUrl(
  state: string,
  instanceUrl: string = DEFAULT_GITLAB_URL,
  customCredentials?: GitLabOAuthCredentials
): string {
  const clientId = customCredentials?.clientId || GITLAB_CLIENT_ID;

  if (!clientId || !GITLAB_REDIRECT_URI) {
    throw new Error('GitLab OAuth credentials not configured');
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: GITLAB_REDIRECT_URI,
    response_type: 'code',
    state,
    scope: GITLAB_OAUTH_SCOPES.join(' '),
  });

  return `${instanceUrl}/oauth/authorize?${params.toString()}`;
}

/**
 * Exchanges an OAuth authorization code for access and refresh tokens
 *
 * @param code - The authorization code from the OAuth callback
 * @param instanceUrl - GitLab instance URL (defaults to gitlab.com)
 * @param customCredentials - Optional custom OAuth credentials for self-hosted instances
 */
export async function exchangeGitLabOAuthCode(
  code: string,
  instanceUrl: string = DEFAULT_GITLAB_URL,
  customCredentials?: GitLabOAuthCredentials
): Promise<GitLabOAuthTokens> {
  const clientId = customCredentials?.clientId || GITLAB_CLIENT_ID;
  const clientSecret = customCredentials?.clientSecret || GITLAB_CLIENT_SECRET;

  if (!clientId || !clientSecret || !GITLAB_REDIRECT_URI) {
    throw new Error('GitLab OAuth credentials not configured');
  }

  const response = await fetch(`${instanceUrl}/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: GITLAB_REDIRECT_URI,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    logExceptInTest('GitLab OAuth token exchange failed:', { status: response.status, error });
    throw new Error(`GitLab OAuth token exchange failed: ${response.status}`);
  }

  const tokens = (await response.json()) as GitLabOAuthTokens;

  logExceptInTest('GitLab OAuth tokens received', {
    hasAccessToken: !!tokens.access_token,
    hasRefreshToken: !!tokens.refresh_token,
    expiresIn: tokens.expires_in,
    scope: tokens.scope,
  });

  return tokens;
}

/**
 * Refreshes an expired OAuth access token using the refresh token
 *
 * @param refreshToken - The refresh token
 * @param instanceUrl - GitLab instance URL (defaults to gitlab.com)
 * @param customCredentials - Optional custom OAuth credentials for self-hosted instances
 */
export async function refreshGitLabOAuthToken(
  refreshToken: string,
  instanceUrl: string = DEFAULT_GITLAB_URL,
  customCredentials?: GitLabOAuthCredentials
): Promise<GitLabOAuthTokens> {
  const clientId = customCredentials?.clientId || GITLAB_CLIENT_ID;
  const clientSecret = customCredentials?.clientSecret || GITLAB_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('GitLab OAuth credentials not configured');
  }

  const response = await fetch(`${instanceUrl}/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    logExceptInTest('GitLab OAuth token refresh failed:', { status: response.status, error });
    throw new Error(`GitLab OAuth token refresh failed: ${response.status}`);
  }

  const tokens = (await response.json()) as GitLabOAuthTokens;

  logExceptInTest('GitLab OAuth tokens refreshed', {
    hasAccessToken: !!tokens.access_token,
    hasRefreshToken: !!tokens.refresh_token,
    expiresIn: tokens.expires_in,
  });

  return tokens;
}

/**
 * Fetches the authenticated GitLab user's information
 *
 * @param accessToken - OAuth access token
 * @param instanceUrl - GitLab instance URL (defaults to gitlab.com)
 */
export async function fetchGitLabUser(
  accessToken: string,
  instanceUrl: string = DEFAULT_GITLAB_URL
): Promise<GitLabUser> {
  const response = await fetch(`${instanceUrl}/api/v4/user`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    logExceptInTest('GitLab user fetch failed:', { status: response.status, error });
    throw new Error(`GitLab user fetch failed: ${response.status}`);
  }

  return (await response.json()) as GitLabUser;
}

/**
 * Fetches all projects (repositories) accessible by the authenticated user
 *
 * @param accessToken - OAuth access token
 * @param instanceUrl - GitLab instance URL (defaults to gitlab.com)
 */
export async function fetchGitLabProjects(
  accessToken: string,
  instanceUrl: string = DEFAULT_GITLAB_URL
): Promise<PlatformRepository[]> {
  const projects: PlatformRepository[] = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const response = await fetch(
      `${instanceUrl}/api/v4/projects?membership=true&per_page=${perPage}&page=${page}&archived=false`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    if (!response.ok) {
      const error = await response.text();
      logExceptInTest('GitLab projects fetch failed:', { status: response.status, error });
      throw new Error(`GitLab projects fetch failed: ${response.status}`);
    }

    const data = (await response.json()) as GitLabProject[];

    projects.push(
      ...data.map(project => ({
        id: project.id,
        name: project.name,
        full_name: project.path_with_namespace,
        private: project.visibility === 'private',
      }))
    );

    // Check if there are more pages
    const totalPages = parseInt(response.headers.get('x-total-pages') || '1', 10);
    if (page >= totalPages) break;
    page++;
  }

  logExceptInTest('GitLab projects fetched', { count: projects.length });

  return projects;
}

/**
 * Normalizes a search query by extracting the project path from a GitLab URL if provided.
 * Supports multiple input formats:
 * - Full URL: https://gitlab.com/group123/project123
 * - Path format: group123/project123
 * - Project name only: project123
 *
 * @param query - The search query (may be a URL, path, or project name)
 * @returns The normalized search query (project path or name)
 */
export function normalizeGitLabSearchQuery(query: string): string {
  const trimmedQuery = query.trim();

  // Check if it looks like a URL
  if (trimmedQuery.startsWith('http://') || trimmedQuery.startsWith('https://')) {
    try {
      const url = new URL(trimmedQuery);
      // Extract the pathname and remove leading slash
      // e.g., /group123/project123 -> group123/project123
      const path = url.pathname.replace(/^\//, '').replace(/\/$/, '');

      // Remove common GitLab URL suffixes like /-/tree/main, /-/merge_requests, etc.
      const cleanPath = path.replace(/\/-\/.*$/, '');

      if (cleanPath) {
        logExceptInTest('Normalized GitLab URL to path', {
          originalQuery: trimmedQuery,
          extractedPath: cleanPath,
        });
        return cleanPath;
      }
    } catch {
      // Not a valid URL, use as-is
    }
  }

  // Return the query as-is (could be a path like "group/project" or just "project")
  return trimmedQuery;
}

/**
 * Fetches a GitLab project by path and returns it as a PlatformRepository
 * Returns null if the project is not found or user doesn't have access
 *
 * @param accessToken - OAuth access token
 * @param projectPath - Project path (e.g., "group/project")
 * @param instanceUrl - GitLab instance URL (defaults to gitlab.com)
 */
async function fetchProjectByPath(
  accessToken: string,
  projectPath: string,
  instanceUrl: string = DEFAULT_GITLAB_URL
): Promise<PlatformRepository | null> {
  const encodedPath = encodeURIComponent(projectPath);

  const response = await fetch(`${instanceUrl}/api/v4/projects/${encodedPath}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    // 404 means project not found or no access - this is expected
    if (response.status === 404) {
      logExceptInTest('GitLab project not found by path', { projectPath });
      return null;
    }
    // Other errors - log but don't throw, we'll fall back to search
    logExceptInTest('GitLab project fetch by path failed:', {
      status: response.status,
      projectPath,
    });
    return null;
  }

  const project = (await response.json()) as GitLabProject;

  // Skip archived projects
  if (project.archived) {
    logExceptInTest('GitLab project found but is archived', { projectPath });
    return null;
  }

  logExceptInTest('GitLab project found by path', {
    projectPath,
    projectId: project.id,
    name: project.name,
  });

  return {
    id: project.id,
    name: project.name,
    full_name: project.path_with_namespace,
    private: project.visibility === 'private',
  };
}

/**
 * Searches GitLab projects by name using the GitLab API
 * Used when users have 100+ repositories and need to find specific ones
 *
 * Supports multiple input formats:
 * - Full URL: https://gitlab.com/group123/project123
 * - Path format: group123/project123
 * - Project name only: project123
 *
 * When a URL or path is provided, the function first tries to fetch the project
 * directly by path. If that fails, it falls back to a text search.
 *
 * @param accessToken - OAuth access token
 * @param query - Search query string (URL, path, or project name - minimum 2 characters recommended)
 * @param instanceUrl - GitLab instance URL (defaults to gitlab.com)
 * @param limit - Maximum number of results to return (default 20)
 */
export async function searchGitLabProjects(
  accessToken: string,
  query: string,
  instanceUrl: string = DEFAULT_GITLAB_URL,
  limit: number = 20
): Promise<PlatformRepository[]> {
  // Normalize the query to handle URLs
  const normalizedQuery = normalizeGitLabSearchQuery(query);

  // If the query looks like a project path (contains /), try direct lookup first
  if (normalizedQuery.includes('/')) {
    const directProject = await fetchProjectByPath(accessToken, normalizedQuery, instanceUrl);
    if (directProject) {
      logExceptInTest('GitLab search: returning direct path match', {
        originalQuery: query,
        normalizedQuery,
        projectId: directProject.id,
      });
      return [directProject];
    }
    // If direct lookup failed, fall through to search
    logExceptInTest('GitLab search: direct path lookup failed, falling back to search', {
      originalQuery: query,
      normalizedQuery,
    });
  }

  const response = await fetch(
    `${instanceUrl}/api/v4/projects?membership=true&search=${encodeURIComponent(normalizedQuery)}&per_page=${limit}&archived=false`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!response.ok) {
    const error = await response.text();
    logExceptInTest('GitLab projects search failed:', { status: response.status, error });
    throw new Error(`GitLab projects search failed: ${response.status}`);
  }

  const data = (await response.json()) as GitLabProject[];

  const projects = data.map(project => ({
    id: project.id,
    name: project.name,
    full_name: project.path_with_namespace,
    private: project.visibility === 'private',
  }));

  logExceptInTest('GitLab projects search completed', {
    originalQuery: query,
    normalizedQuery,
    count: projects.length,
  });

  return projects;
}

/**
 * Fetches all branches for a GitLab project
 *
 * @param accessToken - OAuth access token
 * @param projectId - GitLab project ID or path (URL-encoded)
 * @param instanceUrl - GitLab instance URL (defaults to gitlab.com)
 */
export async function fetchGitLabBranches(
  accessToken: string,
  projectId: string | number,
  instanceUrl: string = DEFAULT_GITLAB_URL
): Promise<GitLabBranch[]> {
  const encodedProjectId =
    typeof projectId === 'string' ? encodeURIComponent(projectId) : projectId;
  const branches: GitLabBranch[] = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const response = await fetch(
      `${instanceUrl}/api/v4/projects/${encodedProjectId}/repository/branches?per_page=${perPage}&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    if (!response.ok) {
      const error = await response.text();
      logExceptInTest('GitLab branches fetch failed:', { status: response.status, error });
      throw new Error(`GitLab branches fetch failed: ${response.status}`);
    }

    const data = (await response.json()) as GitLabBranch[];
    branches.push(...data);

    // Check if there are more pages
    const totalPages = parseInt(response.headers.get('x-total-pages') || '1', 10);
    if (page >= totalPages) break;
    page++;
  }

  logExceptInTest('GitLab branches fetched', { projectId, count: branches.length });

  return branches;
}

/**
 * Calculates the expiration timestamp from GitLab OAuth response
 *
 * @param createdAt - Unix timestamp when token was created
 * @param expiresIn - Seconds until expiration
 */
export function calculateTokenExpiry(createdAt: number, expiresIn: number): string {
  const expiresAtMs = (createdAt + expiresIn) * 1000;
  return new Date(expiresAtMs).toISOString();
}

/**
 * Checks if a token is expired or about to expire (within 5 minutes)
 *
 * @param expiresAt - ISO timestamp of token expiration
 */
export function isTokenExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return true;

  const expiryTime = new Date(expiresAt).getTime();
  const now = Date.now();
  const bufferMs = 5 * 60 * 1000; // 5 minutes buffer

  return now >= expiryTime - bufferMs;
}

// ============================================================================
// Webhook Verification
// ============================================================================

/**
 * Verifies GitLab webhook token
 * GitLab uses a simple secret token comparison (not HMAC like GitHub)
 *
 * @param token - The token from X-Gitlab-Token header
 * @param expectedToken - The expected webhook secret (optional, uses env var if not provided)
 */
export function verifyGitLabWebhookToken(token: string, expectedToken?: string): boolean {
  if (!expectedToken) {
    logExceptInTest('GitLab webhook secret not configured');
    return false;
  }

  // Use timing-safe comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expectedToken));
  } catch {
    return false;
  }
}

// ============================================================================
// Webhook Management API Functions
// ============================================================================

/**
 * Custom error class for webhook permission issues
 * Thrown when user doesn't have Maintainer+ role on a project
 */
export class GitLabWebhookPermissionError extends Error {
  constructor(
    public projectId: string | number,
    public statusCode: number,
    message: string
  ) {
    super(message);
    this.name = 'GitLabWebhookPermissionError';
  }
}

/**
 * GitLab Project Webhook type
 */
export type GitLabWebhook = {
  id: number;
  url: string;
  project_id: number;
  push_events: boolean;
  push_events_branch_filter: string;
  issues_events: boolean;
  confidential_issues_events: boolean;
  merge_requests_events: boolean;
  tag_push_events: boolean;
  note_events: boolean;
  confidential_note_events: boolean;
  job_events: boolean;
  pipeline_events: boolean;
  wiki_page_events: boolean;
  deployment_events: boolean;
  releases_events: boolean;
  subgroup_events: boolean;
  member_events: boolean;
  enable_ssl_verification: boolean;
  created_at: string;
};

/**
 * Lists all webhooks for a GitLab project
 *
 * @param accessToken - OAuth access token
 * @param projectId - GitLab project ID or path (URL-encoded)
 * @param instanceUrl - GitLab instance URL (defaults to gitlab.com)
 * @throws {GitLabWebhookPermissionError} When user doesn't have Maintainer+ role on the project
 */
export async function listProjectWebhooks(
  accessToken: string,
  projectId: string | number,
  instanceUrl: string = DEFAULT_GITLAB_URL
): Promise<GitLabWebhook[]> {
  const encodedProjectId =
    typeof projectId === 'string' ? encodeURIComponent(projectId) : projectId;

  const response = await fetch(`${instanceUrl}/api/v4/projects/${encodedProjectId}/hooks`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    logExceptInTest('GitLab list webhooks failed:', {
      status: response.status,
      error,
      projectId,
    });

    // 401/403 indicate permission issues - user doesn't have Maintainer+ role
    if (response.status === 401 || response.status === 403) {
      throw new GitLabWebhookPermissionError(
        projectId,
        response.status,
        `Insufficient permissions to manage webhooks for project ${projectId}. Requires Maintainer role or higher.`
      );
    }

    throw new Error(`GitLab list webhooks failed: ${response.status}`);
  }

  return (await response.json()) as GitLabWebhook[];
}

/**
 * Creates a webhook for a GitLab project
 *
 * @param accessToken - OAuth access token (requires Maintainer+ role)
 * @param projectId - GitLab project ID or path (URL-encoded)
 * @param webhookUrl - URL to receive webhook events
 * @param webhookSecret - Secret token for webhook verification
 * @param instanceUrl - GitLab instance URL (defaults to gitlab.com)
 * @throws {GitLabWebhookPermissionError} When user doesn't have Maintainer+ role on the project
 */
export async function createProjectWebhook(
  accessToken: string,
  projectId: string | number,
  webhookUrl: string,
  webhookSecret: string,
  instanceUrl: string = DEFAULT_GITLAB_URL
): Promise<GitLabWebhook> {
  const encodedProjectId =
    typeof projectId === 'string' ? encodeURIComponent(projectId) : projectId;

  const response = await fetch(`${instanceUrl}/api/v4/projects/${encodedProjectId}/hooks`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: 'Kilo Code Reviews',
      description: 'Auto-configured webhook for Kilo AI code reviews',
      url: webhookUrl,
      token: webhookSecret,
      merge_requests_events: true,
      push_events: false,
      issues_events: false,
      confidential_issues_events: false,
      tag_push_events: false,
      note_events: false,
      confidential_note_events: false,
      job_events: false,
      pipeline_events: false,
      wiki_page_events: false,
      deployment_events: false,
      releases_events: false,
      enable_ssl_verification: true,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    logExceptInTest('GitLab create webhook failed:', {
      status: response.status,
      error,
      projectId,
    });

    // 401/403 indicate permission issues - user doesn't have Maintainer+ role
    if (response.status === 401 || response.status === 403) {
      throw new GitLabWebhookPermissionError(
        projectId,
        response.status,
        `Insufficient permissions to create webhook for project ${projectId}. Requires Maintainer role or higher.`
      );
    }

    throw new Error(`GitLab create webhook failed: ${response.status} - ${error}`);
  }

  const webhook = (await response.json()) as GitLabWebhook;

  logExceptInTest('[createProjectWebhook] Created webhook', {
    projectId,
    webhookId: webhook.id,
    url: webhookUrl,
  });

  return webhook;
}

/**
 * Updates an existing webhook for a GitLab project
 *
 * @param accessToken - OAuth access token (requires Maintainer+ role)
 * @param projectId - GitLab project ID or path (URL-encoded)
 * @param hookId - ID of the webhook to update
 * @param webhookUrl - URL to receive webhook events
 * @param webhookSecret - Secret token for webhook verification
 * @param instanceUrl - GitLab instance URL (defaults to gitlab.com)
 * @throws {GitLabWebhookPermissionError} When user doesn't have Maintainer+ role on the project
 */
export async function updateProjectWebhook(
  accessToken: string,
  projectId: string | number,
  hookId: number,
  webhookUrl: string,
  webhookSecret: string,
  instanceUrl: string = DEFAULT_GITLAB_URL
): Promise<GitLabWebhook> {
  const encodedProjectId =
    typeof projectId === 'string' ? encodeURIComponent(projectId) : projectId;

  const response = await fetch(
    `${instanceUrl}/api/v4/projects/${encodedProjectId}/hooks/${hookId}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Kilo Code Reviews',
        description: 'Auto-configured webhook for Kilo AI code reviews',
        url: webhookUrl,
        token: webhookSecret,
        merge_requests_events: true,
        push_events: false,
        issues_events: false,
        confidential_issues_events: false,
        tag_push_events: false,
        note_events: false,
        confidential_note_events: false,
        job_events: false,
        pipeline_events: false,
        wiki_page_events: false,
        deployment_events: false,
        releases_events: false,
        enable_ssl_verification: true,
      }),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    logExceptInTest('GitLab update webhook failed:', {
      status: response.status,
      error,
      projectId,
      hookId,
    });

    // 401/403 indicate permission issues - user doesn't have Maintainer+ role
    if (response.status === 401 || response.status === 403) {
      throw new GitLabWebhookPermissionError(
        projectId,
        response.status,
        `Insufficient permissions to update webhook for project ${projectId}. Requires Maintainer role or higher.`
      );
    }

    throw new Error(`GitLab update webhook failed: ${response.status} - ${error}`);
  }

  const webhook = (await response.json()) as GitLabWebhook;

  logExceptInTest('[updateProjectWebhook] Updated webhook', {
    projectId,
    webhookId: webhook.id,
    url: webhookUrl,
  });

  return webhook;
}

/**
 * Deletes a webhook from a GitLab project
 *
 * @param accessToken - OAuth access token (requires Maintainer+ role)
 * @param projectId - GitLab project ID or path (URL-encoded)
 * @param hookId - ID of the webhook to delete
 * @param instanceUrl - GitLab instance URL (defaults to gitlab.com)
 */
export async function deleteProjectWebhook(
  accessToken: string,
  projectId: string | number,
  hookId: number,
  instanceUrl: string = DEFAULT_GITLAB_URL
): Promise<void> {
  const encodedProjectId =
    typeof projectId === 'string' ? encodeURIComponent(projectId) : projectId;

  const response = await fetch(
    `${instanceUrl}/api/v4/projects/${encodedProjectId}/hooks/${hookId}`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  // 404 means webhook already deleted, which is fine
  if (!response.ok && response.status !== 404) {
    const error = await response.text();
    logExceptInTest('GitLab delete webhook failed:', {
      status: response.status,
      error,
      projectId,
      hookId,
    });
    throw new Error(`GitLab delete webhook failed: ${response.status} - ${error}`);
  }

  logExceptInTest('[deleteProjectWebhook] Deleted webhook', {
    projectId,
    hookId,
    wasAlreadyDeleted: response.status === 404,
  });
}

/**
 * Normalizes a URL for comparison by decoding percent-encoded characters
 * and ensuring consistent formatting
 */
function normalizeUrlForComparison(url: string): string {
  try {
    // Decode the URL to handle percent-encoded characters
    const decoded = decodeURIComponent(url);
    // Parse and re-stringify to normalize the URL format
    const parsed = new URL(decoded);
    return parsed.toString();
  } catch {
    // If URL parsing fails, return the original URL
    return url;
  }
}

/**
 * Finds an existing Kilo webhook on a GitLab project by URL
 *
 * @param accessToken - OAuth access token
 * @param projectId - GitLab project ID or path (URL-encoded)
 * @param kiloWebhookUrl - The Kilo webhook URL to search for
 * @param instanceUrl - GitLab instance URL (defaults to gitlab.com)
 */
export async function findKiloWebhook(
  accessToken: string,
  projectId: string | number,
  kiloWebhookUrl: string,
  instanceUrl: string = DEFAULT_GITLAB_URL
): Promise<GitLabWebhook | null> {
  const webhooks = await listProjectWebhooks(accessToken, projectId, instanceUrl);

  // Normalize the target URL for comparison
  const normalizedTargetUrl = normalizeUrlForComparison(kiloWebhookUrl);

  // Find webhook by comparing normalized URLs
  const kiloWebhook = webhooks.find(
    hook => normalizeUrlForComparison(hook.url) === normalizedTargetUrl
  );

  if (kiloWebhook) {
    logExceptInTest('[findKiloWebhook] Found existing Kilo webhook', {
      projectId,
      webhookId: kiloWebhook.id,
    });
  } else {
    logExceptInTest('[findKiloWebhook] No existing Kilo webhook found', {
      projectId,
      totalWebhooks: webhooks.length,
    });
  }

  return kiloWebhook || null;
}

// ============================================================================
// Merge Request API Functions
// ============================================================================

/**
 * GitLab MR Note (comment) type
 */
export type GitLabNote = {
  id: number;
  body: string;
  author: {
    id: number;
    username: string;
    name: string;
  };
  created_at: string;
  updated_at: string;
  system: boolean;
  noteable_id: number;
  noteable_type: string;
  noteable_iid: number;
  resolvable: boolean;
  resolved?: boolean;
  resolved_by?: {
    id: number;
    username: string;
    name: string;
  };
  position?: {
    base_sha: string;
    start_sha: string;
    head_sha: string;
    old_path: string;
    new_path: string;
    position_type: string;
    old_line: number | null;
    new_line: number | null;
  };
};

/**
 * GitLab MR Discussion type (threaded comments)
 */
export type GitLabDiscussion = {
  id: string;
  individual_note: boolean;
  notes: GitLabNote[];
};

/**
 * GitLab Merge Request type
 */
export type GitLabMergeRequest = {
  id: number;
  iid: number;
  title: string;
  description: string | null;
  state: 'opened' | 'closed' | 'merged' | 'locked';
  source_branch: string;
  target_branch: string;
  sha: string;
  diff_refs: {
    base_sha: string;
    head_sha: string;
    start_sha: string;
  };
  web_url: string;
  author: {
    id: number;
    username: string;
    name: string;
  };
};

/**
 * Finds an existing Kilo review note on a GitLab MR
 * Looks for the <!-- kilo-review --> marker in MR notes
 *
 * @param accessToken - OAuth access token
 * @param projectId - GitLab project ID or path (URL-encoded)
 * @param mrIid - Merge request internal ID
 * @param instanceUrl - GitLab instance URL (defaults to gitlab.com)
 */
export async function findKiloReviewNote(
  accessToken: string,
  projectId: string | number,
  mrIid: number,
  instanceUrl: string = DEFAULT_GITLAB_URL
): Promise<{ noteId: number; body: string } | null> {
  const encodedProjectId =
    typeof projectId === 'string' ? encodeURIComponent(projectId) : projectId;

  const notes: GitLabNote[] = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const response = await fetch(
      `${instanceUrl}/api/v4/projects/${encodedProjectId}/merge_requests/${mrIid}/notes?per_page=${perPage}&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    if (!response.ok) {
      const error = await response.text();
      logExceptInTest('GitLab MR notes fetch failed:', { status: response.status, error });
      throw new Error(`GitLab MR notes fetch failed: ${response.status}`);
    }

    const data = (await response.json()) as GitLabNote[];
    notes.push(...data);

    const totalPages = parseInt(response.headers.get('x-total-pages') || '1', 10);
    if (page >= totalPages) break;
    page++;
  }

  logExceptInTest('[findKiloReviewNote] Fetched notes', {
    projectId,
    mrIid,
    totalNotes: notes.length,
  });

  // Look for notes with the kilo-review marker
  const markedNotes = notes.filter(n => n.body?.includes('<!-- kilo-review -->') && !n.system);

  if (markedNotes.length > 0) {
    // Sort by updated_at descending and pick the latest
    const latestNote = markedNotes.sort((a, b) => {
      return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    })[0];

    logExceptInTest('[findKiloReviewNote] Found note with marker', {
      projectId,
      mrIid,
      noteId: latestNote.id,
      markedNotesCount: markedNotes.length,
    });

    return { noteId: latestNote.id, body: latestNote.body };
  }

  logExceptInTest('[findKiloReviewNote] No existing Kilo review note found', {
    projectId,
    mrIid,
    totalNotes: notes.length,
  });

  return null;
}

/**
 * Fetches existing inline comments (discussions) on a GitLab MR
 * Used to detect duplicates and track outdated comments
 *
 * @param accessToken - OAuth access token
 * @param projectId - GitLab project ID or path (URL-encoded)
 * @param mrIid - Merge request internal ID
 * @param instanceUrl - GitLab instance URL (defaults to gitlab.com)
 */
export async function fetchMRInlineComments(
  accessToken: string,
  projectId: string | number,
  mrIid: number,
  instanceUrl: string = DEFAULT_GITLAB_URL
): Promise<
  Array<{
    id: number;
    discussionId: string;
    path: string;
    line: number | null;
    body: string;
    isOutdated: boolean;
    user: { username: string };
  }>
> {
  const encodedProjectId =
    typeof projectId === 'string' ? encodeURIComponent(projectId) : projectId;

  const discussions: GitLabDiscussion[] = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const response = await fetch(
      `${instanceUrl}/api/v4/projects/${encodedProjectId}/merge_requests/${mrIid}/discussions?per_page=${perPage}&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    if (!response.ok) {
      const error = await response.text();
      logExceptInTest('GitLab MR discussions fetch failed:', { status: response.status, error });
      throw new Error(`GitLab MR discussions fetch failed: ${response.status}`);
    }

    const data = (await response.json()) as GitLabDiscussion[];
    discussions.push(...data);

    const totalPages = parseInt(response.headers.get('x-total-pages') || '1', 10);
    if (page >= totalPages) break;
    page++;
  }

  // Extract inline comments from discussions
  const inlineComments: Array<{
    id: number;
    discussionId: string;
    path: string;
    line: number | null;
    body: string;
    isOutdated: boolean;
    user: { username: string };
  }> = [];

  for (const discussion of discussions) {
    // Skip individual notes (non-threaded comments)
    if (discussion.individual_note) continue;

    for (const note of discussion.notes) {
      // Only include notes with position (inline comments)
      if (note.position) {
        inlineComments.push({
          id: note.id,
          discussionId: discussion.id,
          path: note.position.new_path || note.position.old_path,
          line: note.position.new_line ?? note.position.old_line,
          body: note.body,
          // In GitLab, resolved discussions are considered "outdated" for our purposes
          isOutdated: note.resolved === true,
          user: { username: note.author.username },
        });
      }
    }
  }

  logExceptInTest('[fetchMRInlineComments] Fetched inline comments', {
    projectId,
    mrIid,
    totalDiscussions: discussions.length,
    inlineComments: inlineComments.length,
  });

  return inlineComments;
}

/**
 * Gets the HEAD commit SHA for a GitLab MR
 *
 * @param accessToken - OAuth access token
 * @param projectId - GitLab project ID or path (URL-encoded)
 * @param mrIid - Merge request internal ID
 * @param instanceUrl - GitLab instance URL (defaults to gitlab.com)
 */
export async function getMRHeadCommit(
  accessToken: string,
  projectId: string | number,
  mrIid: number,
  instanceUrl: string = DEFAULT_GITLAB_URL
): Promise<string> {
  const encodedProjectId =
    typeof projectId === 'string' ? encodeURIComponent(projectId) : projectId;

  const response = await fetch(
    `${instanceUrl}/api/v4/projects/${encodedProjectId}/merge_requests/${mrIid}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!response.ok) {
    const error = await response.text();
    logExceptInTest('GitLab MR fetch failed:', { status: response.status, error });
    throw new Error(`GitLab MR fetch failed: ${response.status}`);
  }

  const mr = (await response.json()) as GitLabMergeRequest;

  logExceptInTest('[getMRHeadCommit] Got HEAD commit', {
    projectId,
    mrIid,
    headSha: mr.sha.substring(0, 8),
  });

  return mr.sha;
}

/**
 * Gets the diff refs (base, head, start SHA) for a GitLab MR
 * Required for creating inline comments
 *
 * @param accessToken - OAuth access token
 * @param projectId - GitLab project ID or path (URL-encoded)
 * @param mrIid - Merge request internal ID
 * @param instanceUrl - GitLab instance URL (defaults to gitlab.com)
 */
export async function getMRDiffRefs(
  accessToken: string,
  projectId: string | number,
  mrIid: number,
  instanceUrl: string = DEFAULT_GITLAB_URL
): Promise<{ baseSha: string; headSha: string; startSha: string }> {
  const encodedProjectId =
    typeof projectId === 'string' ? encodeURIComponent(projectId) : projectId;

  const response = await fetch(
    `${instanceUrl}/api/v4/projects/${encodedProjectId}/merge_requests/${mrIid}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!response.ok) {
    const error = await response.text();
    logExceptInTest('GitLab MR fetch failed:', { status: response.status, error });
    throw new Error(`GitLab MR fetch failed: ${response.status}`);
  }

  const mr = (await response.json()) as GitLabMergeRequest;

  logExceptInTest('[getMRDiffRefs] Got diff refs', {
    projectId,
    mrIid,
    baseSha: mr.diff_refs.base_sha.substring(0, 8),
    headSha: mr.diff_refs.head_sha.substring(0, 8),
    startSha: mr.diff_refs.start_sha.substring(0, 8),
  });

  return {
    baseSha: mr.diff_refs.base_sha,
    headSha: mr.diff_refs.head_sha,
    startSha: mr.diff_refs.start_sha,
  };
}

/**
 * Adds an award emoji (reaction) to a GitLab MR
 * Used to show that Kilo is reviewing an MR (e.g., 👀 eyes reaction)
 *
 * @param accessToken - OAuth access token
 * @param projectId - GitLab project ID or path (URL-encoded)
 * @param mrIid - Merge request internal ID
 * @param emoji - Emoji name (e.g., 'eyes', 'thumbsup', 'thumbsdown')
 * @param instanceUrl - GitLab instance URL (defaults to gitlab.com)
 */
export async function addReactionToMR(
  accessToken: string,
  projectId: string | number,
  mrIid: number,
  emoji: string,
  instanceUrl: string = DEFAULT_GITLAB_URL
): Promise<void> {
  const encodedProjectId =
    typeof projectId === 'string' ? encodeURIComponent(projectId) : projectId;

  const response = await fetch(
    `${instanceUrl}/api/v4/projects/${encodedProjectId}/merge_requests/${mrIid}/award_emoji`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: emoji }),
    }
  );

  if (!response.ok) {
    // 404 might mean the emoji already exists, which is fine
    if (response.status === 404) {
      logExceptInTest('[addReactionToMR] Emoji may already exist or MR not found', {
        projectId,
        mrIid,
        emoji,
      });
      return;
    }

    const error = await response.text();
    logExceptInTest('GitLab add reaction failed:', { status: response.status, error });
    throw new Error(`GitLab add reaction failed: ${response.status}`);
  }

  logExceptInTest('[addReactionToMR] Added reaction', {
    projectId,
    mrIid,
    emoji,
  });
}

/**
 * Gets a GitLab project by path
 *
 * @param accessToken - OAuth access token
 * @param projectPath - Project path (e.g., "group/project")
 * @param instanceUrl - GitLab instance URL (defaults to gitlab.com)
 */
export async function getGitLabProject(
  accessToken: string,
  projectPath: string,
  instanceUrl: string = DEFAULT_GITLAB_URL
): Promise<GitLabProject> {
  const encodedPath = encodeURIComponent(projectPath);

  const response = await fetch(`${instanceUrl}/api/v4/projects/${encodedPath}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    logExceptInTest('GitLab project fetch failed:', { status: response.status, error });
    throw new Error(`GitLab project fetch failed: ${response.status}`);
  }

  return (await response.json()) as GitLabProject;
}

// ============================================================================
// Instance Validation
// ============================================================================

/**
 * GitLab version response type
 */
export type GitLabVersion = {
  version: string;
  revision: string;
  kas: {
    enabled: boolean;
    externalUrl: string | null;
    version: string | null;
  };
  enterprise: boolean;
};

/**
 * Result of validating a GitLab instance
 */
export type GitLabInstanceValidationResult = {
  valid: boolean;
  version?: string;
  revision?: string;
  enterprise?: boolean;
  error?: string;
};

/**
 * Validates that a URL points to a valid GitLab instance
 *
 * Uses the public /api/v4/version endpoint which doesn't require authentication.
 * This allows users to verify their self-hosted GitLab URL before attempting OAuth.
 *
 * @param instanceUrl - The GitLab instance URL to validate
 * @returns Validation result with version info if successful
 */
export async function validateGitLabInstance(
  instanceUrl: string
): Promise<GitLabInstanceValidationResult> {
  // Normalize the URL
  let normalizedUrl = instanceUrl.trim();

  // Remove trailing slash if present
  if (normalizedUrl.endsWith('/')) {
    normalizedUrl = normalizedUrl.slice(0, -1);
  }

  // Validate URL format
  try {
    const url = new URL(normalizedUrl);
    if (!['http:', 'https:'].includes(url.protocol)) {
      return {
        valid: false,
        error: 'Invalid URL protocol. Must be http or https.',
      };
    }
  } catch {
    return {
      valid: false,
      error: 'Invalid URL format.',
    };
  }

  try {
    // The /api/v4/version endpoint is public and doesn't require authentication
    const response = await fetch(`${normalizedUrl}/api/v4/version`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
      // Set a reasonable timeout for the request
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      // 401/403 still indicates a valid GitLab instance (just requires auth for version)
      // Some self-hosted instances may restrict the version endpoint
      if (response.status === 401 || response.status === 403) {
        logExceptInTest(
          '[validateGitLabInstance] Version endpoint requires auth, but instance is valid',
          {
            instanceUrl: normalizedUrl,
            status: response.status,
          }
        );
        return {
          valid: true,
          error: 'GitLab instance found, but version info requires authentication.',
        };
      }

      logExceptInTest('[validateGitLabInstance] Invalid response from instance', {
        instanceUrl: normalizedUrl,
        status: response.status,
      });

      return {
        valid: false,
        error: `GitLab instance returned status ${response.status}. Please verify the URL.`,
      };
    }

    const data = (await response.json()) as GitLabVersion;

    // Validate that the response looks like a GitLab version response
    if (!data.version || typeof data.version !== 'string') {
      return {
        valid: false,
        error: 'Response does not appear to be from a GitLab instance.',
      };
    }

    logExceptInTest('[validateGitLabInstance] Valid GitLab instance found', {
      instanceUrl: normalizedUrl,
      version: data.version,
      enterprise: data.enterprise,
    });

    return {
      valid: true,
      version: data.version,
      revision: data.revision,
      enterprise: data.enterprise,
    };
  } catch (error) {
    // Handle timeout
    if (error instanceof Error && error.name === 'TimeoutError') {
      return {
        valid: false,
        error: 'Connection timed out. Please verify the URL is accessible.',
      };
    }

    // Handle network errors
    if (error instanceof TypeError && error.message.includes('fetch')) {
      return {
        valid: false,
        error: 'Could not connect to the GitLab instance. Please verify the URL is accessible.',
      };
    }

    logExceptInTest('[validateGitLabInstance] Error validating instance', {
      instanceUrl: normalizedUrl,
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      valid: false,
      error: 'Failed to validate GitLab instance. Please verify the URL is correct and accessible.',
    };
  }
}

// ============================================================================
// Project Access Token (PrAT) Management
// ============================================================================

/**
 * GitLab access level constants
 * @see https://docs.gitlab.com/ee/api/members.html#valid-access-levels
 */
export const GITLAB_ACCESS_LEVELS = {
  NO_ACCESS: 0,
  MINIMAL_ACCESS: 5,
  GUEST: 10,
  REPORTER: 20,
  DEVELOPER: 30,
  MAINTAINER: 40,
  OWNER: 50,
} as const;

/**
 * GitLab Project Access Token type
 * @see https://docs.gitlab.com/ee/api/project_access_tokens.html
 */
export type GitLabProjectAccessToken = {
  id: number;
  name: string;
  /** Only present on creation - must be stored immediately */
  token?: string;
  expires_at: string;
  scopes: string[];
  access_level: number;
  active: boolean;
  revoked: boolean;
  created_at: string;
  last_used_at: string | null;
  user_id: number;
};

/**
 * Custom error class for Project Access Token permission issues
 * Thrown when user doesn't have Maintainer+ role on a project
 */
export class GitLabProjectAccessTokenPermissionError extends Error {
  constructor(
    public projectId: string | number,
    public statusCode: number,
    message: string
  ) {
    super(message);
    this.name = 'GitLabProjectAccessTokenPermissionError';
  }
}

/**
 * Creates a Project Access Token for a GitLab project
 *
 * Project Access Tokens allow bot-like access to a project without using a user's credentials.
 * Comments made with a PrAT appear as "project_XXX_bot" or the custom name.
 *
 * Requirements:
 * - User must have Maintainer+ role on the project
 * - GitLab Free tier or higher (available on all tiers)
 * - Token expires in max 1 year
 *
 * @param accessToken - OAuth access token (requires Maintainer+ role)
 * @param projectId - GitLab project ID or path (URL-encoded)
 * @param tokenName - Name for the token (e.g., "Kilo Code Review Bot")
 * @param expiresAt - Expiration date in YYYY-MM-DD format (max 1 year from now)
 * @param scopes - Token scopes (default: ['api', 'self_rotate'])
 * @param accessLevel - Access level for the token (default: DEVELOPER = 30)
 * @param instanceUrl - GitLab instance URL (defaults to gitlab.com)
 * @throws {GitLabProjectAccessTokenPermissionError} When user doesn't have Maintainer+ role
 *
 * @see https://docs.gitlab.com/ee/api/project_access_tokens.html#create-a-project-access-token
 */
export async function createProjectAccessToken(
  accessToken: string,
  projectId: string | number,
  tokenName: string,
  expiresAt: string,
  scopes: string[] = ['api', 'self_rotate'],
  accessLevel: number = GITLAB_ACCESS_LEVELS.DEVELOPER,
  instanceUrl: string = DEFAULT_GITLAB_URL
): Promise<GitLabProjectAccessToken> {
  const encodedProjectId =
    typeof projectId === 'string' ? encodeURIComponent(projectId) : projectId;

  const response = await fetch(`${instanceUrl}/api/v4/projects/${encodedProjectId}/access_tokens`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: tokenName,
      scopes,
      access_level: accessLevel,
      expires_at: expiresAt,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    logExceptInTest('[createProjectAccessToken] Failed:', {
      status: response.status,
      error,
      projectId,
    });

    // 401/403 indicate permission issues - user doesn't have Maintainer+ role
    if (response.status === 401 || response.status === 403) {
      throw new GitLabProjectAccessTokenPermissionError(
        projectId,
        response.status,
        `Insufficient permissions to create Project Access Token for project ${projectId}. Requires Maintainer role or higher.`
      );
    }

    // 404 might mean the project doesn't exist or feature is disabled
    if (response.status === 404) {
      throw new Error(
        `Project ${projectId} not found or Project Access Tokens are disabled for this project.`
      );
    }

    throw new Error(`GitLab create Project Access Token failed: ${response.status} - ${error}`);
  }

  const token = (await response.json()) as GitLabProjectAccessToken;

  logExceptInTest('[createProjectAccessToken] Created token', {
    projectId,
    tokenId: token.id,
    tokenName: token.name,
    expiresAt: token.expires_at,
    // Note: token.token is only available on creation and should be stored securely
    hasToken: !!token.token,
  });

  return token;
}

/**
 * Lists all Project Access Tokens for a GitLab project
 *
 * @param accessToken - OAuth access token (requires Maintainer+ role)
 * @param projectId - GitLab project ID or path (URL-encoded)
 * @param instanceUrl - GitLab instance URL (defaults to gitlab.com)
 * @throws {GitLabProjectAccessTokenPermissionError} When user doesn't have Maintainer+ role
 *
 * @see https://docs.gitlab.com/ee/api/project_access_tokens.html#list-project-access-tokens
 */
export async function listProjectAccessTokens(
  accessToken: string,
  projectId: string | number,
  instanceUrl: string = DEFAULT_GITLAB_URL
): Promise<GitLabProjectAccessToken[]> {
  const encodedProjectId =
    typeof projectId === 'string' ? encodeURIComponent(projectId) : projectId;

  const response = await fetch(`${instanceUrl}/api/v4/projects/${encodedProjectId}/access_tokens`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    logExceptInTest('[listProjectAccessTokens] Failed:', {
      status: response.status,
      error,
      projectId,
    });

    if (response.status === 401 || response.status === 403) {
      throw new GitLabProjectAccessTokenPermissionError(
        projectId,
        response.status,
        `Insufficient permissions to list Project Access Tokens for project ${projectId}. Requires Maintainer role or higher.`
      );
    }

    throw new Error(`GitLab list Project Access Tokens failed: ${response.status}`);
  }

  const tokens = (await response.json()) as GitLabProjectAccessToken[];

  logExceptInTest('[listProjectAccessTokens] Listed tokens', {
    projectId,
    count: tokens.length,
  });

  return tokens;
}

/**
 * Gets a specific Project Access Token by ID
 *
 * @param accessToken - OAuth access token (requires Maintainer+ role)
 * @param projectId - GitLab project ID or path (URL-encoded)
 * @param tokenId - ID of the Project Access Token
 * @param instanceUrl - GitLab instance URL (defaults to gitlab.com)
 *
 * @see https://docs.gitlab.com/ee/api/project_access_tokens.html#get-a-project-access-token
 */
export async function getProjectAccessToken(
  accessToken: string,
  projectId: string | number,
  tokenId: number,
  instanceUrl: string = DEFAULT_GITLAB_URL
): Promise<GitLabProjectAccessToken | null> {
  const encodedProjectId =
    typeof projectId === 'string' ? encodeURIComponent(projectId) : projectId;

  const response = await fetch(
    `${instanceUrl}/api/v4/projects/${encodedProjectId}/access_tokens/${tokenId}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!response.ok) {
    if (response.status === 404) {
      logExceptInTest('[getProjectAccessToken] Token not found', {
        projectId,
        tokenId,
      });
      return null;
    }

    const error = await response.text();
    logExceptInTest('[getProjectAccessToken] Failed:', {
      status: response.status,
      error,
      projectId,
      tokenId,
    });

    throw new Error(`GitLab get Project Access Token failed: ${response.status}`);
  }

  return (await response.json()) as GitLabProjectAccessToken;
}

/**
 * Rotates (refreshes) a Project Access Token
 *
 * This creates a new token with a new expiration date and revokes the old one.
 * The new token value is returned and must be stored immediately.
 *
 * @param accessToken - OAuth access token (requires Maintainer+ role)
 * @param projectId - GitLab project ID or path (URL-encoded)
 * @param tokenId - ID of the Project Access Token to rotate
 * @param expiresAt - New expiration date in YYYY-MM-DD format (max 1 year from now)
 * @param instanceUrl - GitLab instance URL (defaults to gitlab.com)
 *
 * @see https://docs.gitlab.com/ee/api/project_access_tokens.html#rotate-a-project-access-token
 */
export async function rotateProjectAccessToken(
  accessToken: string,
  projectId: string | number,
  tokenId: number,
  expiresAt: string,
  instanceUrl: string = DEFAULT_GITLAB_URL
): Promise<GitLabProjectAccessToken> {
  const encodedProjectId =
    typeof projectId === 'string' ? encodeURIComponent(projectId) : projectId;

  const response = await fetch(
    `${instanceUrl}/api/v4/projects/${encodedProjectId}/access_tokens/${tokenId}/rotate`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        expires_at: expiresAt,
      }),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    logExceptInTest('[rotateProjectAccessToken] Failed:', {
      status: response.status,
      error,
      projectId,
      tokenId,
    });

    if (response.status === 401 || response.status === 403) {
      throw new GitLabProjectAccessTokenPermissionError(
        projectId,
        response.status,
        `Insufficient permissions to rotate Project Access Token for project ${projectId}. Requires Maintainer role or higher.`
      );
    }

    if (response.status === 404) {
      throw new Error(`Project Access Token ${tokenId} not found in project ${projectId}.`);
    }

    throw new Error(`GitLab rotate Project Access Token failed: ${response.status} - ${error}`);
  }

  const token = (await response.json()) as GitLabProjectAccessToken;

  logExceptInTest('[rotateProjectAccessToken] Rotated token', {
    projectId,
    oldTokenId: tokenId,
    newTokenId: token.id,
    expiresAt: token.expires_at,
    hasToken: !!token.token,
  });

  return token;
}

/**
 * Revokes (deletes) a Project Access Token
 *
 * @param accessToken - OAuth access token (requires Maintainer+ role)
 * @param projectId - GitLab project ID or path (URL-encoded)
 * @param tokenId - ID of the Project Access Token to revoke
 * @param instanceUrl - GitLab instance URL (defaults to gitlab.com)
 *
 * @see https://docs.gitlab.com/ee/api/project_access_tokens.html#revoke-a-project-access-token
 */
export async function revokeProjectAccessToken(
  accessToken: string,
  projectId: string | number,
  tokenId: number,
  instanceUrl: string = DEFAULT_GITLAB_URL
): Promise<void> {
  const encodedProjectId =
    typeof projectId === 'string' ? encodeURIComponent(projectId) : projectId;

  const response = await fetch(
    `${instanceUrl}/api/v4/projects/${encodedProjectId}/access_tokens/${tokenId}`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  // 404 means token already deleted, which is fine
  if (!response.ok && response.status !== 404) {
    const error = await response.text();
    logExceptInTest('[revokeProjectAccessToken] Failed:', {
      status: response.status,
      error,
      projectId,
      tokenId,
    });

    if (response.status === 401 || response.status === 403) {
      throw new GitLabProjectAccessTokenPermissionError(
        projectId,
        response.status,
        `Insufficient permissions to revoke Project Access Token for project ${projectId}. Requires Maintainer role or higher.`
      );
    }

    throw new Error(`GitLab revoke Project Access Token failed: ${response.status} - ${error}`);
  }

  logExceptInTest('[revokeProjectAccessToken] Revoked token', {
    projectId,
    tokenId,
    wasAlreadyRevoked: response.status === 404,
  });
}

/**
 * Finds an existing Kilo Code Review Bot token on a GitLab project
 *
 * @param accessToken - OAuth access token (requires Maintainer+ role)
 * @param projectId - GitLab project ID or path (URL-encoded)
 * @param tokenName - Name of the token to find (default: "Kilo Code Review Bot")
 * @param instanceUrl - GitLab instance URL (defaults to gitlab.com)
 */
export async function findKiloProjectAccessToken(
  accessToken: string,
  projectId: string | number,
  tokenName: string = 'Kilo Code Review Bot',
  instanceUrl: string = DEFAULT_GITLAB_URL
): Promise<GitLabProjectAccessToken | null> {
  const tokens = await listProjectAccessTokens(accessToken, projectId, instanceUrl);

  // Find active token with matching name
  const kiloToken = tokens.find(t => t.name === tokenName && t.active && !t.revoked);

  if (kiloToken) {
    logExceptInTest('[findKiloProjectAccessToken] Found existing token', {
      projectId,
      tokenId: kiloToken.id,
      expiresAt: kiloToken.expires_at,
    });
  } else {
    logExceptInTest('[findKiloProjectAccessToken] No existing token found', {
      projectId,
      totalTokens: tokens.length,
    });
  }

  return kiloToken || null;
}

/**
 * Calculates the expiration date for a new Project Access Token
 * GitLab allows max 1 year expiration
 *
 * @param daysFromNow - Number of days from now (default: 365, max: 365)
 * @returns Date string in YYYY-MM-DD format
 */
export function calculateProjectAccessTokenExpiry(daysFromNow: number = 365): string {
  const maxDays = 365;
  const days = Math.min(daysFromNow, maxDays);

  const expiryDate = new Date();
  expiryDate.setDate(expiryDate.getDate() + days);

  return expiryDate.toISOString().split('T')[0];
}

/**
 * Checks if a Project Access Token is expiring soon (within specified days)
 *
 * @param expiresAt - Expiration date in YYYY-MM-DD format
 * @param withinDays - Number of days to consider "soon" (default: 7)
 * @returns true if token expires within the specified days
 */
export function isProjectAccessTokenExpiringSoon(
  expiresAt: string,
  withinDays: number = 7
): boolean {
  const expiryDate = new Date(expiresAt);
  const now = new Date();
  const daysUntilExpiry = Math.floor(
    (expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
  );

  return daysUntilExpiry <= withinDays;
}

/**
 * Validates a Project Access Token by making a test API call
 *
 * This is useful to check if a stored token is still valid on GitLab
 * (e.g., it might have been manually revoked by the user)
 *
 * @param token - The Project Access Token to validate
 * @param instanceUrl - GitLab instance URL (defaults to gitlab.com)
 * @returns true if the token is valid, false otherwise
 */
export async function validateProjectAccessToken(
  token: string,
  instanceUrl: string = DEFAULT_GITLAB_URL
): Promise<boolean> {
  try {
    // Use the /user endpoint to validate the token
    // This is a lightweight call that works with any valid token
    const response = await fetch(`${instanceUrl}/api/v4/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (response.ok) {
      logExceptInTest('[validateProjectAccessToken] Token is valid');
      return true;
    }

    if (response.status === 401) {
      logExceptInTest('[validateProjectAccessToken] Token is invalid (401)');
      return false;
    }

    // Other errors - log but assume token might still be valid
    logExceptInTest('[validateProjectAccessToken] Unexpected response', {
      status: response.status,
    });
    return true;
  } catch (error) {
    // Network errors - assume token might still be valid
    logExceptInTest('[validateProjectAccessToken] Error validating token', {
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
}

// ============================================================================
// Personal Access Token (PAT) Validation
// ============================================================================

/**
 * Required scopes for PAT-based authentication
 * - api: Full API access (needed for webhooks, MR comments, PrAT creation)
 *
 * We always require 'api' scope as it covers all needed operations:
 * - Creating webhooks
 * - Posting MR comments
 * - Creating Project Access Tokens
 * - Reading repositories
 */
export const GITLAB_PAT_REQUIRED_SCOPES = ['api'] as const;

/**
 * GitLab Personal Access Token info response type
 * @see https://docs.gitlab.com/ee/api/personal_access_tokens.html#get-single-personal-access-token
 */
export type GitLabPersonalAccessTokenInfo = {
  id: number;
  name: string;
  revoked: boolean;
  created_at: string;
  scopes: string[];
  user_id: number;
  last_used_at: string | null;
  active: boolean;
  expires_at: string | null;
};

/**
 * Result of validating a Personal Access Token
 */
export type GitLabPATValidationResult = {
  valid: boolean;
  user?: GitLabUser;
  tokenInfo?: {
    id: number;
    name: string;
    scopes: string[];
    expiresAt: string | null;
    active: boolean;
    lastUsedAt: string | null;
  };
  error?: string;
  missingScopes?: string[];
  warnings?: string[];
};

/**
 * Validates a GitLab Personal Access Token
 *
 * This function:
 * 1. Calls /api/v4/personal_access_tokens/self to get token info (requires GitLab 14.0+)
 * 2. Validates that 'api' scope is present
 * 3. Fetches user info from /api/v4/user
 * 4. Checks for expiration and adds warnings if expiring soon
 *
 * @param token - The Personal Access Token to validate
 * @param instanceUrl - GitLab instance URL (defaults to gitlab.com)
 * @returns Validation result with user info, scopes, and any warnings
 */
export async function validatePersonalAccessToken(
  token: string,
  instanceUrl: string = DEFAULT_GITLAB_URL
): Promise<GitLabPATValidationResult> {
  const warnings: string[] = [];

  // Step 1: Get token info from /api/v4/personal_access_tokens/self
  // This endpoint requires GitLab 14.0+
  const tokenInfoResponse = await fetch(`${instanceUrl}/api/v4/personal_access_tokens/self`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!tokenInfoResponse.ok) {
    if (tokenInfoResponse.status === 401) {
      logExceptInTest('[validatePersonalAccessToken] Invalid token (401)');
      return {
        valid: false,
        error: 'Invalid Personal Access Token. Please check the token and try again.',
      };
    }

    if (tokenInfoResponse.status === 404) {
      logExceptInTest('[validatePersonalAccessToken] Endpoint not found (404) - GitLab < 14.0?');
      return {
        valid: false,
        error:
          'GitLab 14.0 or higher is required for PAT authentication. Please use OAuth instead or upgrade your GitLab instance.',
      };
    }

    const errorText = await tokenInfoResponse.text();
    logExceptInTest('[validatePersonalAccessToken] Token info fetch failed', {
      status: tokenInfoResponse.status,
      error: errorText,
    });
    return {
      valid: false,
      error: `Failed to validate token: ${tokenInfoResponse.status}`,
    };
  }

  const tokenInfo = (await tokenInfoResponse.json()) as GitLabPersonalAccessTokenInfo;

  // Check if token is revoked or inactive
  if (tokenInfo.revoked || !tokenInfo.active) {
    logExceptInTest('[validatePersonalAccessToken] Token is revoked or inactive', {
      revoked: tokenInfo.revoked,
      active: tokenInfo.active,
    });
    return {
      valid: false,
      error: 'This Personal Access Token has been revoked or is inactive.',
    };
  }

  // Step 2: Validate required scopes
  const missingScopes = GITLAB_PAT_REQUIRED_SCOPES.filter(
    scope => !tokenInfo.scopes.includes(scope)
  );

  if (missingScopes.length > 0) {
    logExceptInTest('[validatePersonalAccessToken] Missing required scopes', {
      required: GITLAB_PAT_REQUIRED_SCOPES,
      actual: tokenInfo.scopes,
      missing: missingScopes,
    });
    return {
      valid: false,
      error: `Token is missing required scope(s): ${missingScopes.join(', ')}. Please create a new token with the 'api' scope.`,
      missingScopes: [...missingScopes],
    };
  }

  // Step 3: Check expiration and add warnings
  if (tokenInfo.expires_at) {
    const expiresAt = new Date(tokenInfo.expires_at);
    const now = new Date();
    const daysUntilExpiry = Math.floor(
      (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
    );

    if (daysUntilExpiry < 0) {
      logExceptInTest('[validatePersonalAccessToken] Token has expired', {
        expiresAt: tokenInfo.expires_at,
      });
      return {
        valid: false,
        error: 'This Personal Access Token has expired. Please create a new token.',
      };
    }

    if (daysUntilExpiry <= 30) {
      warnings.push(
        `Token expires in ${daysUntilExpiry} day${daysUntilExpiry === 1 ? '' : 's'}. Consider creating a new token with a longer expiration.`
      );
    }
  }

  // Step 4: Fetch user info
  const userResponse = await fetch(`${instanceUrl}/api/v4/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!userResponse.ok) {
    const errorText = await userResponse.text();
    logExceptInTest('[validatePersonalAccessToken] User fetch failed', {
      status: userResponse.status,
      error: errorText,
    });
    return {
      valid: false,
      error: `Failed to fetch user info: ${userResponse.status}`,
    };
  }

  const user = (await userResponse.json()) as GitLabUser;

  logExceptInTest('[validatePersonalAccessToken] Token validated successfully', {
    userId: user.id,
    username: user.username,
    tokenId: tokenInfo.id,
    tokenName: tokenInfo.name,
    scopes: tokenInfo.scopes,
    expiresAt: tokenInfo.expires_at,
    warnings,
  });

  return {
    valid: true,
    user,
    tokenInfo: {
      id: tokenInfo.id,
      name: tokenInfo.name,
      scopes: tokenInfo.scopes,
      expiresAt: tokenInfo.expires_at,
      active: tokenInfo.active,
      lastUsedAt: tokenInfo.last_used_at,
    },
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}
