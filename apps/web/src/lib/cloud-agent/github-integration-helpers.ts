import { TRPCError } from '@trpc/server';
import {
  getIntegrationsByOrganization,
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
import {
  isPlatformIntegrationHealthy,
  isPlatformIntegrationSuspended,
} from '@/lib/integrations/core/health';
import {
  requireNumericPlatformRepositories,
  type PlatformRepository,
} from '@/lib/integrations/core/types';

type GitHubRepositoriesResult = {
  integrationInstalled: boolean;
  repositories: {
    id: number;
    name: string;
    fullName: string;
    private: boolean;
    platformIntegrationId?: string;
    platformAccountLogin?: string;
  }[];
  syncedAt?: string | null;
  errorMessage?: string;
};

const mapRepositories = (
  repositories: PlatformRepository[],
  integration?: { id: string; platform_account_login: string | null }
): GitHubRepositoriesResult['repositories'] => {
  return repositories.map(repo => ({
    id: repo.id,
    name: repo.name,
    fullName: repo.full_name,
    private: repo.private,
    ...(integration
      ? {
          platformIntegrationId: integration.id,
          platformAccountLogin: integration.platform_account_login ?? undefined,
        }
      : {}),
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
  return fetchRepositoriesForIntegrations(
    integration && isPlatformIntegrationHealthy(integration) ? [integration] : [],
    forceRefresh
  );
}

export async function fetchAllGitHubRepositoriesForOrganization(
  organizationId: string,
  forceRefresh: boolean = false
): Promise<GitHubRepositoriesResult> {
  const integrations = (
    await getIntegrationsByOrganization(organizationId, PLATFORM.GITHUB)
  ).filter(isPlatformIntegrationHealthy);
  return fetchRepositoriesForIntegrations(integrations, forceRefresh);
}

async function fetchRepositoriesForIntegrations(
  integrations: Awaited<ReturnType<typeof getIntegrationsByOrganization>>,
  forceRefresh: boolean
): Promise<GitHubRepositoriesResult> {
  if (integrations.length === 0) {
    return missingIntegrationResponse('No GitHub integration found for this organization');
  }

  try {
    const results = await Promise.all(
      integrations.map(async integration => {
        if (!integration.platform_installation_id) return { repositories: [], syncedAt: null };
        const cachedRepositories = requireNumericPlatformRepositories(integration.repositories);
        if (forceRefresh || !cachedRepositories?.length) {
          const repositories = await fetchGitHubRepositories(
            integration.platform_installation_id,
            integration.github_app_type || 'standard'
          );
          await updateRepositoriesForIntegration(integration.id, repositories);
          return {
            repositories: mapRepositories(repositories, integration),
            syncedAt: new Date().toISOString(),
          };
        }
        return {
          repositories: mapRepositories(cachedRepositories, integration),
          syncedAt: integration.repositories_synced_at,
        };
      })
    );
    return {
      integrationInstalled: true,
      repositories: results.flatMap(result => result.repositories),
      syncedAt: results
        .map(result => result.syncedAt)
        .filter((value): value is string => value !== null)
        .sort()
        .at(0),
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

  if (isPlatformIntegrationSuspended(integration)) {
    return missingIntegrationResponse('GitHub integration is suspended');
  }

  if (!integration.platform_installation_id) {
    return missingIntegrationResponse('GitHub integration is not properly configured');
  }

  try {
    const cachedRepositories = requireNumericPlatformRepositories(integration.repositories);
    // If forceRefresh or no cached repos, fetch from GitHub and update cache
    if (forceRefresh || !cachedRepositories?.length) {
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
      repositories: mapRepositories(cachedRepositories),
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
