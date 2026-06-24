import { TRPCError } from '@trpc/server';
import {
  getIntegrationForOrganization,
  getIntegrationForOwner,
  updateRepositoriesForIntegration,
} from '@/lib/integrations/db/platform-integrations';
import { getGitLabIntegration, getValidGitLabToken } from '@/lib/integrations/gitlab-service';
import { fetchGitLabProjects } from '@/lib/integrations/platforms/gitlab/adapter';
import { PLATFORM } from '@/lib/integrations/core/constants';
import type { PlatformRepository } from '@/lib/integrations/core/types';

const DEFAULT_GITLAB_URL = 'https://gitlab.com';

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
  organizationId: string
): Promise<string | undefined> {
  const integration = await getIntegrationForOrganization(organizationId, PLATFORM.GITLAB);

  if (!integration) {
    return undefined;
  }

  try {
    const token = await getValidGitLabToken(integration);
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
    const token = await getValidGitLabToken(integration);
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
  forceRefresh: boolean = false
): Promise<GitLabRepositoriesResult> {
  const integration = await getIntegrationForOrganization(organizationId, PLATFORM.GITLAB);

  if (!integration) {
    return missingIntegrationResponse('No GitLab integration found for this organization');
  }

  const metadata = integration.metadata as GitLabMetadata | null;
  const instanceUrl = metadata?.gitlab_instance_url || DEFAULT_GITLAB_URL;

  try {
    // If forceRefresh or no cached repos, fetch from GitLab and update cache
    if (forceRefresh || !integration.repositories?.length) {
      const accessToken = await getValidGitLabToken(integration);
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
      repositories: mapRepositories(integration.repositories),
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

  const metadata = integration.metadata as GitLabMetadata | null;
  const instanceUrl = metadata?.gitlab_instance_url || DEFAULT_GITLAB_URL;

  try {
    // If forceRefresh or no cached repos, fetch from GitLab and update cache
    if (forceRefresh || !integration.repositories?.length) {
      const accessToken = await getValidGitLabToken(integration);
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
      repositories: mapRepositories(integration.repositories),
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
  projectPath: string
): Promise<boolean> {
  try {
    const result = await fetchGitLabRepositoriesForOrganization(organizationId, false);

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
