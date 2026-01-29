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
const GITLAB_WEBHOOK_SECRET = getEnvVariable('GITLAB_WEBHOOK_SECRET');

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
  const secret = expectedToken || GITLAB_WEBHOOK_SECRET;

  if (!secret) {
    logExceptInTest('GitLab webhook secret not configured');
    return false;
  }

  // Use timing-safe comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(secret));
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
