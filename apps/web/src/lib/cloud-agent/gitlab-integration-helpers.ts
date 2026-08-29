import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { Owner } from '@/lib/integrations/core/types';
import {
  REPOSITORY_READ_LIMITS,
  withRepositoryReadDeadline,
  type RepositoryReadOptions,
} from '@/lib/integrations/core/repository-read-limits';
import {
  GitLabInstanceUrlError,
  normalizeGitLabInstanceUrl,
} from '@/lib/integrations/platforms/gitlab/instance-url';
import {
  getIntegrationForOrganization,
  getIntegrationForOwner,
  updateRepositoriesForIntegration,
} from '@/lib/integrations/db/platform-integrations';
import { getGitLabIntegration, getValidGitLabToken } from '@/lib/integrations/gitlab-service';
import { fetchGitLabProjects } from '@/lib/integrations/platforms/gitlab/adapter';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { isPlatformIntegrationSuspended } from '@/lib/integrations/core/health';
import {
  requireNumericPlatformRepositories,
  type PlatformRepository,
} from '@/lib/integrations/core/types';

const DEFAULT_GITLAB_URL = 'https://gitlab.com';

type GitLabRepositoriesResult = {
  status?:
    | 'not_connected'
    | 'available'
    | 'suspended'
    | 'reconnect_required'
    | 'misconfigured'
    | 'temporarily_unavailable';
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

async function fetchBoundedGitLabRepositories(
  owner: Owner,
  actorUserId: string,
  forceRefresh: boolean,
  options: RepositoryReadOptions
): Promise<GitLabRepositoriesResult> {
  const unavailable = { integrationInstalled: true, repositories: [], syncedAt: null };
  try {
    return await withRepositoryReadDeadline<GitLabRepositoriesResult>(options, async signal => {
      const integration =
        owner.type === 'org'
          ? await getIntegrationForOrganization(owner.id, PLATFORM.GITLAB)
          : await getIntegrationForOwner(owner, PLATFORM.GITLAB);
      if (!integration) {
        return { ...unavailable, integrationInstalled: false, status: 'not_connected' };
      }
      if (isPlatformIntegrationSuspended(integration))
        return { ...unavailable, status: 'suspended' };
      if (integration.auth_invalid_at) return { ...unavailable, status: 'reconnect_required' };
      const metadata = z
        .object({ gitlab_instance_url: z.string().optional() })
        .safeParse(integration.metadata ?? {});
      if (integration.integration_status !== 'active' || !metadata.success) {
        return { ...unavailable, status: 'misconfigured' };
      }
      const instanceUrl = normalizeGitLabInstanceUrl(metadata.data.gitlab_instance_url);
      const cached = requireNumericPlatformRepositories(
        integration.repositories?.slice(0, REPOSITORY_READ_LIMITS.repositories) ?? null
      );
      let repositories = cached;
      let syncedAt = integration.repositories_synced_at;
      if (forceRefresh || !cached || !syncedAt) {
        signal?.throwIfAborted();
        const token = await getValidGitLabToken(integration, {
          userId: actorUserId,
          ...(owner.type === 'org' ? { organizationId: owner.id } : {}),
        });
        signal?.throwIfAborted();
        repositories = await fetchGitLabProjects(token, instanceUrl, { bounded: true, signal });
        syncedAt = new Date().toISOString();
      }
      signal?.throwIfAborted();
      return {
        status: 'available',
        integrationInstalled: true,
        repositories: mapRepositories(
          (repositories ?? []).slice(0, REPOSITORY_READ_LIMITS.repositories)
        ),
        syncedAt,
        instanceUrl,
      };
    });
  } catch (error) {
    const status =
      error instanceof GitLabInstanceUrlError && error.reason !== 'resolution_failed'
        ? 'misconfigured'
        : error instanceof TRPCError &&
            (error.code === 'UNAUTHORIZED' || error.code === 'FORBIDDEN')
          ? 'reconnect_required'
          : 'temporarily_unavailable';
    return { ...unavailable, status };
  }
}

/**
 * Fetch GitLab repositories for an organization
 * Returns cached repositories by default, fetches fresh from GitLab when forceRefresh is true
 */
export async function fetchGitLabRepositoriesForOrganization(
  organizationId: string,
  actorUserId: string,
  forceRefresh: boolean = false,
  options?: RepositoryReadOptions
): Promise<GitLabRepositoriesResult> {
  if (options?.bounded) {
    return fetchBoundedGitLabRepositories(
      { type: 'org', id: organizationId },
      actorUserId,
      forceRefresh,
      options
    );
  }
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
    // If forceRefresh or no cached repos, fetch from GitLab and update cache
    if (forceRefresh || !cachedRepositories?.length) {
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

    // Return cached repos
    return {
      integrationInstalled: true,
      repositories: mapRepositories(cachedRepositories),
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
  forceRefresh: boolean = false,
  options?: RepositoryReadOptions
): Promise<GitLabRepositoriesResult> {
  if (options?.bounded) {
    return fetchBoundedGitLabRepositories(
      { type: 'user', id: userId },
      userId,
      forceRefresh,
      options
    );
  }
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
    // If forceRefresh or no cached repos, fetch from GitLab and update cache
    if (forceRefresh || !cachedRepositories?.length) {
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

    // Return cached repos
    return {
      integrationInstalled: true,
      repositories: mapRepositories(cachedRepositories),
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
