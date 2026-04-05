import { TRPCError } from '@trpc/server';
import {
  getIntegrationForOrganization,
  getIntegrationForOwner,
  updateRepositoriesForIntegration,
} from '@/lib/integrations/db/platform-integrations';
import {
  fetchGitHubRepositories,
  generateGitHubInstallationToken,
  checkExistingFork,
} from '@/lib/integrations/platforms/github/adapter';
import { DEMO_SOURCE_OWNER, DEMO_SOURCE_REPO_NAME } from '@/components/cloud-agent/demo-config';
import { PLATFORM } from '@/lib/integrations/core/constants';
import type { PlatformRepository } from '@/lib/integrations/core/types';

type GitHubRepositoriesResult = {
  integrationInstalled: boolean;
  repositories: {
    id: number;
    name: string;
    fullName: string;
    private: boolean;
  }[];
  syncedAt?: string | null;
  errorMessage?: string;
};

const mapRepositories = (
  repositories: PlatformRepository[]
): GitHubRepositoriesResult['repositories'] => {
  return repositories.map(repo => ({
    id: repo.id,
    name: repo.name,
    fullName: repo.full_name,
    private: repo.private,
  }));
};

const missingIntegrationResponse = (message: string): GitHubRepositoriesResult => ({
  integrationInstalled: false,
  repositories: [],
  syncedAt: null,
  errorMessage: message,
});

export async function getGitHubTokenForOrganization(
  organizationId: string
): Promise<string | undefined> {
  const integration = await getIntegrationForOrganization(organizationId, PLATFORM.GITHUB);

  if (!integration?.platform_installation_id) {
    return undefined;
  }

  const appType = integration.github_app_type || 'standard';

  try {
    const tokenData = await generateGitHubInstallationToken(
      integration.platform_installation_id,
      appType
    );
    return tokenData.token;
  } catch (_error) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to authenticate with GitHub integration',
    });
  }
}

export async function getGitHubTokenForUser(userId: string): Promise<string | undefined> {
  const integration = await getIntegrationForOwner({ type: 'user', id: userId }, PLATFORM.GITHUB);

  if (!integration?.platform_installation_id) {
    return undefined;
  }

  const appType = integration.github_app_type || 'standard';

  try {
    const tokenData = await generateGitHubInstallationToken(
      integration.platform_installation_id,
      appType
    );
    return tokenData.token;
  } catch (_error) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to authenticate with GitHub integration',
    });
  }
}

/**
 * Get the GitHub App installation ID for an organization.
 * Used by cloud-agent to generate tokens on-demand with KV caching.
 */
export async function getGitHubInstallationIdForOrganization(
  organizationId: string
): Promise<string | undefined> {
  const integration = await getIntegrationForOrganization(organizationId, PLATFORM.GITHUB);
  return integration?.platform_installation_id ?? undefined;
}

/**
 * Get the GitHub App installation ID for a user.
 * Used by cloud-agent to generate tokens on-demand with KV caching.
 */
export async function getGitHubInstallationIdForUser(userId: string): Promise<string | undefined> {
  const integration = await getIntegrationForOwner({ type: 'user', id: userId }, PLATFORM.GITHUB);
  return integration?.platform_installation_id ?? undefined;
}

/**
 * Fetch GitHub repositories for an organization
 * Returns cached repositories by default, fetches fresh from GitHub when forceRefresh is true
 */
export async function fetchGitHubRepositoriesForOrganization(
  organizationId: string,
  forceRefresh: boolean = false
): Promise<GitHubRepositoriesResult> {
  const integration = await getIntegrationForOrganization(organizationId, PLATFORM.GITHUB);

  if (!integration) {
    return missingIntegrationResponse('No GitHub integration found for this organization');
  }

  if (!integration.platform_installation_id) {
    return missingIntegrationResponse('GitHub integration is not properly configured');
  }

  try {
    // If forceRefresh or no cached repos, fetch from GitHub and update cache
    if (forceRefresh || !integration.repositories?.length) {
      const appType = integration.github_app_type || 'standard';
      const repositories = await fetchGitHubRepositories(
        integration.platform_installation_id,
        appType
      );
      await updateRepositoriesForIntegration(integration.id, repositories);
      return {
        integrationInstalled: true,
        repositories: mapRepositories(repositories),
        syncedAt: new Date().toISOString(),
      };
    }

    // Return cached repos
    return {
      integrationInstalled: true,
      repositories: mapRepositories(integration.repositories),
      syncedAt: integration.repositories_synced_at,
    };
  } catch (_error) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to fetch GitHub repositories',
    });
  }
}

export async function fetchGitHubRepositoriesForUser(
  userId: string,
  forceRefresh: boolean = false
): Promise<GitHubRepositoriesResult> {
  const integration = await getIntegrationForOwner({ type: 'user', id: userId }, PLATFORM.GITHUB);

  if (!integration) {
    return missingIntegrationResponse('No GitHub integration found for this user');
  }

  if (!integration.platform_installation_id) {
    return missingIntegrationResponse('GitHub integration is not properly configured');
  }

  try {
    // If forceRefresh or no cached repos, fetch from GitHub and update cache
    if (forceRefresh || !integration.repositories?.length) {
      const appType = integration.github_app_type || 'standard';
      const repositories = await fetchGitHubRepositories(
        integration.platform_installation_id,
        appType
      );
      await updateRepositoriesForIntegration(integration.id, repositories);
      return {
        integrationInstalled: true,
        repositories: mapRepositories(repositories),
        syncedAt: new Date().toISOString(),
      };
    }

    // Return cached repos
    return {
      integrationInstalled: true,
      repositories: mapRepositories(integration.repositories),
      syncedAt: integration.repositories_synced_at,
    };
  } catch (_error) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to fetch GitHub repositories',
    });
  }
}

export async function validateGitHubRepoAccessForUser(
  userId: string,
  githubRepo: string
): Promise<boolean> {
  try {
    const result = await fetchGitHubRepositoriesForUser(userId, false);

    if (!result.integrationInstalled || !result.repositories.length) {
      return false;
    }

    return result.repositories.some(
      repo => repo.fullName.toLowerCase() === githubRepo.toLowerCase()
    );
  } catch (_error) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to validate repository access',
    });
  }
}

export async function validateGitHubRepoAccessForOrganization(
  organizationId: string,
  githubRepo: string
): Promise<boolean> {
  try {
    const result = await fetchGitHubRepositoriesForOrganization(organizationId, false);

    if (!result.integrationInstalled || !result.repositories.length) {
      return false;
    }

    return result.repositories.some(
      repo => repo.fullName.toLowerCase() === githubRepo.toLowerCase()
    );
  } catch (_error) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to validate repository access',
    });
  }
}

export async function checkDemoRepositoryFork(
  userId: string
): Promise<{ exists: boolean; forkedRepo: string | null; githubUsername: string | null }> {
  const integration = await getIntegrationForOwner({ type: 'user', id: userId }, PLATFORM.GITHUB);

  if (!integration?.platform_installation_id) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'GitHub integration required to check demo repository',
    });
  }

  const accountLogin = integration.platform_account_login;
  if (!accountLogin) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'GitHub account login not found in integration',
    });
  }

  const result = await checkExistingFork(
    integration.platform_installation_id,
    accountLogin,
    DEMO_SOURCE_OWNER,
    DEMO_SOURCE_REPO_NAME
  );

  return {
    exists: result.exists,
    forkedRepo: result.fullName,
    githubUsername: accountLogin,
  };
}
