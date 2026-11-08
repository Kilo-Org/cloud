import { TRPCError } from '@trpc/server';
import {
  getIntegrationForOrganization,
  getIntegrationForOwner,
  updateRepositoriesForIntegration,
} from '@/lib/integrations/db/platform-integrations';
import { getGitLabIntegration, getValidGitLabToken } from '@/lib/integrations/gitlab-service';
import {
  fetchGitLabProjects,
  getGitLabProject as readGitLabProject,
} from '@/lib/integrations/platforms/gitlab/adapter';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { isPlatformIntegrationSuspended } from '@/lib/integrations/core/health';
import {
  requireNumericPlatformRepositories,
  shouldSyncProviderRepositories,
  type PlatformRepository,
} from '@/lib/integrations/core/types';

const DEFAULT_GITLAB_URL = 'https://gitlab.com';

/**
 * An HTTP refusal from the GitLab single-project read. The status is the only
 * provider detail a caller can act on; the response body is never included,
 * so a message built from this error cannot leak a token or a project path.
 */
export class GitLabProjectLookupError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'GitLabProjectLookupError';
  }
}

/**
 * Read one GitLab project by path with explicit credentials, converting the
 * adapter's status-bearing failure text into a typed status refusal.
 */
async function getGitLabProjectForCredentials(
  accessToken: string,
  projectPath: string,
  instanceUrl: string
): Promise<void> {
  try {
    await readGitLabProject(accessToken, projectPath, instanceUrl);
  } catch (error) {
    const statusPattern = /(\d{3})$/;
    const message = error instanceof Error ? error.message : '';
    const match = statusPattern.exec(message);
    throw new GitLabProjectLookupError(
      match ? Number(match[1]) : 0,
      'GitLab project lookup failed'
    );
  }
}

type GitLabRepositoriesResult = {
  integrationInstalled: boolean;
  repositories: {
    id: number;
    name: string;
    fullName: string;
    private: boolean;
  }[];
  syncedAt?: string | null;
  errorMessage?: string;
  instanceUrl?: string;
};

const mapRepositories = (
  repositories: PlatformRepository[]
): GitLabRepositoriesResult['repositories'] => {
  return repositories.map(repo => ({
    id: repo.id,
    name: repo.name,
    fullName: repo.full_name,
    private: repo.private,
  }));
};

const missingIntegrationResponse = (message: string): GitLabRepositoriesResult => ({
  integrationInstalled: false,
  repositories: [],
  syncedAt: null,
  errorMessage: message,
});

type GitLabMetadata = {
  access_token?: string;
  refresh_token?: string;
  token_expires_at?: string;
  gitlab_instance_url?: string;
  client_id?: string;
  client_secret?: string;
};

/**
 * Get GitLab OAuth token for an organization
 * Automatically refreshes the token if expired
 */
export async function getGitLabTokenForOrganization(
  organizationId: string,
  actorUserId: string
): Promise<string | undefined> {
  const integration = await getIntegrationForOrganization(organizationId, PLATFORM.GITLAB);

  if (!integration) {
    return undefined;
  }

  try {
    const token = await getValidGitLabToken(integration, {
      userId: actorUserId,
      organizationId,
    });
    return token;
  } catch (_error) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to authenticate with GitLab integration',
    });
  }
}

/**
 * Get GitLab OAuth token for a user
 * Automatically refreshes the token if expired
 */
export async function getGitLabTokenForUser(userId: string): Promise<string | undefined> {
  const integration = await getGitLabIntegration({ type: 'user', id: userId });

  if (!integration) {
    return undefined;
  }

  try {
    const token = await getValidGitLabToken(integration, { userId });
    return token;
  } catch (_error) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to authenticate with GitLab integration',
    });
  }
}

/**
 * Fetch GitLab repositories for an organization
 * Returns cached repositories by default, fetches fresh from GitLab when forceRefresh is true
 */
export async function fetchGitLabRepositoriesForOrganization(
  organizationId: string,
  actorUserId: string,
  forceRefresh: boolean = false
): Promise<GitLabRepositoriesResult> {
  const integration = await getIntegrationForOrganization(organizationId, PLATFORM.GITLAB);

  if (!integration) {
    return missingIntegrationResponse('No GitLab integration found for this organization');
  }

  if (isPlatformIntegrationSuspended(integration)) {
    return missingIntegrationResponse('GitLab integration is suspended');
  }

  const metadata = integration.metadata as GitLabMetadata | null;
  const instanceUrl = metadata?.gitlab_instance_url || DEFAULT_GITLAB_URL;

  try {
    const cachedRepositories = requireNumericPlatformRepositories(integration.repositories);
    // Answer from the cached snapshot unless the caller forces a sync or the
    // integration has never synced: a synced empty snapshot is the
    // connected-empty state, not a reason to re-query GitLab on every read.
    if (
      shouldSyncProviderRepositories({
        forceRefresh,
        cachedRepositories,
        repositoriesSyncedAt: integration.repositories_synced_at,
      })
    ) {
      const accessToken = await getValidGitLabToken(integration, {
        userId: actorUserId,
        organizationId,
      });
      const repositories = await fetchGitLabProjects(accessToken, instanceUrl);
      await updateRepositoriesForIntegration(integration.id, repositories);
      return {
        integrationInstalled: true,
        repositories: mapRepositories(repositories),
        syncedAt: new Date().toISOString(),
        instanceUrl,
      };
    }

    return {
      integrationInstalled: true,
      repositories: mapRepositories(cachedRepositories ?? []),
      syncedAt: integration.repositories_synced_at,
      instanceUrl,
    };
  } catch (_error) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to fetch GitLab repositories',
    });
  }
}

/**
 * Fetch GitLab repositories for a user
 * Returns cached repositories by default, fetches fresh from GitLab when forceRefresh is true
 */
export async function fetchGitLabRepositoriesForUser(
  userId: string,
  forceRefresh: boolean = false
): Promise<GitLabRepositoriesResult> {
  const integration = await getIntegrationForOwner({ type: 'user', id: userId }, PLATFORM.GITLAB);

  if (!integration) {
    return missingIntegrationResponse('No GitLab integration found for this user');
  }

  if (isPlatformIntegrationSuspended(integration)) {
    return missingIntegrationResponse('GitLab integration is suspended');
  }

  const metadata = integration.metadata as GitLabMetadata | null;
  const instanceUrl = metadata?.gitlab_instance_url || DEFAULT_GITLAB_URL;

  try {
    const cachedRepositories = requireNumericPlatformRepositories(integration.repositories);
    // Answer from the cached snapshot unless the caller forces a sync or the
    // integration has never synced: a synced empty snapshot is the
    // connected-empty state, not a reason to re-query GitLab on every read.
    if (
      shouldSyncProviderRepositories({
        forceRefresh,
        cachedRepositories,
        repositoriesSyncedAt: integration.repositories_synced_at,
      })
    ) {
      const accessToken = await getValidGitLabToken(integration, { userId });
      const repositories = await fetchGitLabProjects(accessToken, instanceUrl);
      await updateRepositoriesForIntegration(integration.id, repositories);
      return {
        integrationInstalled: true,
        repositories: mapRepositories(repositories),
        syncedAt: new Date().toISOString(),
        instanceUrl,
      };
    }

    return {
      integrationInstalled: true,
      repositories: mapRepositories(cachedRepositories ?? []),
      syncedAt: integration.repositories_synced_at,
      instanceUrl,
    };
  } catch (_error) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to fetch GitLab repositories',
    });
  }
}

/**
 * Validate that a user has access to a specific GitLab project
 * @param userId - The user ID
 * @param projectPath - GitLab project path (e.g., "group/project" or "group/subgroup/project")
 */
export async function validateGitLabRepoAccessForUser(
  userId: string,
  projectPath: string
): Promise<boolean> {
  try {
    const result = await fetchGitLabRepositoriesForUser(userId, false);

    if (!result.integrationInstalled || !result.repositories.length) {
      return false;
    }

    return result.repositories.some(
      repo => repo.fullName.toLowerCase() === projectPath.toLowerCase()
    );
  } catch (_error) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to validate GitLab repository access',
    });
  }
}

/**
 * Access verdict for a requester's own GitLab connection, resolved live: the
 * requester's credential reads the project from their own GitLab instance.
 */
export type GitLabRequesterAccess = { outcome: 'allowed' } | { outcome: 'refused' };

/**
 * What a Kilo account's own GitLab connection can see live.
 *
 * `refused`: the account holds no GitLab connection of its own, or its
 * credential's instance answered that the account cannot read the project
 * (404, or a 401/403 the account's own credential cannot clear). All three
 * are verdicts about this requester, so the caller answers with the
 * refusal line and starts no session.
 *
 * Everything else (a 5xx, a rate limit, a transport failure, a credential
 * resolution outage) propagates: the caller's failure path answers with the
 * retryable message and starts no session.
 * @param userId - The Kilo user ID
 * @param projectPath - GitLab project path (e.g., "group/project" or "group/subgroup/project")
 */
export async function getGitLabProjectAccessForRequester(
  userId: string,
  projectPath: string
): Promise<GitLabRequesterAccess> {
  const instanceUrl = await getGitLabInstanceUrlForUser(userId);
  const token = await getGitLabTokenForUser(userId);
  if (!token) return { outcome: 'refused' };

  try {
    await getGitLabProjectForCredentials(token, projectPath, instanceUrl);
  } catch (error) {
    if (
      error instanceof GitLabProjectLookupError &&
      (error.status === 404 || error.status === 401 || error.status === 403)
    ) {
      return { outcome: 'refused' };
    }
    throw error;
  }
  return { outcome: 'allowed' };
}

/**
 * Validate that an organization has access to a specific GitLab project
 * @param organizationId - The organization ID
 * @param projectPath - GitLab project path (e.g., "group/project" or "group/subgroup/project")
 */
export async function validateGitLabRepoAccessForOrganization(
  organizationId: string,
  actorUserId: string,
  projectPath: string
): Promise<boolean> {
  try {
    const result = await fetchGitLabRepositoriesForOrganization(organizationId, actorUserId, false);

    if (!result.integrationInstalled || !result.repositories.length) {
      return false;
    }

    return result.repositories.some(
      repo => repo.fullName.toLowerCase() === projectPath.toLowerCase()
    );
  } catch (_error) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to validate GitLab repository access',
    });
  }
}

/**
 * Build a GitLab clone URL from a project path
 * @param projectPath - GitLab project path (e.g., "group/project" or "group/subgroup/project")
 * @param instanceUrl - GitLab instance URL (defaults to https://gitlab.com)
 * @returns HTTPS clone URL for the project
 */
export function buildGitLabCloneUrl(
  projectPath: string,
  instanceUrl: string = DEFAULT_GITLAB_URL
): string {
  // Ensure instanceUrl doesn't have a trailing slash
  const baseUrl = instanceUrl.replace(/\/$/, '');
  // Ensure projectPath doesn't have leading/trailing slashes
  const cleanPath = projectPath.replace(/^\/|\/$/g, '');
  return `${baseUrl}/${cleanPath}.git`;
}

/**
 * Get the GitLab instance URL for a user's integration
 * @param userId - The user ID
 * @returns The GitLab instance URL or default gitlab.com
 */
export async function getGitLabInstanceUrlForUser(userId: string): Promise<string> {
  const integration = await getGitLabIntegration({ type: 'user', id: userId });

  if (!integration) {
    return DEFAULT_GITLAB_URL;
  }

  const metadata = integration.metadata as GitLabMetadata | null;
  return metadata?.gitlab_instance_url || DEFAULT_GITLAB_URL;
}

/**
 * Get the GitLab instance URL for an organization's integration
 * @param organizationId - The organization ID
 * @returns The GitLab instance URL or default gitlab.com
 */
export async function getGitLabInstanceUrlForOrganization(organizationId: string): Promise<string> {
  const integration = await getIntegrationForOrganization(organizationId, PLATFORM.GITLAB);

  if (!integration) {
    return DEFAULT_GITLAB_URL;
  }

  const metadata = integration.metadata as GitLabMetadata | null;
  return metadata?.gitlab_instance_url || DEFAULT_GITLAB_URL;
}
