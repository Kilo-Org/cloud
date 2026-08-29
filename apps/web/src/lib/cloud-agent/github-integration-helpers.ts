import { TRPCError } from '@trpc/server';
import {
  getAllIntegrationsForOwner,
  getIntegrationsByOrganization,
  getIntegrationForOrganization,
  getIntegrationForOwner,
  getPrimaryGitHubIntegrationForOrganization,
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

import type {
  LaunchRepositoryReference,
  Owner,
} from '@kilocode/app-shared/code-review/repository-identity';

type GitHubRepositoriesResult = {
  integrationInstalled: boolean;
  repositories: {
    id: number;
    name: string;
    fullName: string;
    private: boolean;
    defaultBranch?: string;
    platformIntegrationId: string;
    platformAccountLogin?: string;
    instanceUrl: string;
    repositoryReference: LaunchRepositoryReference;
  }[];
  syncedAt?: string | null;
  errorMessage?: string;
};

const mapRepositories = (
  repositories: PlatformRepository[],
  integration: { id: string; platform_account_login: string | null },
  owner: Owner
): GitHubRepositoriesResult['repositories'] => {
  return repositories.map(repo => ({
    id: repo.id,
    name: repo.name,
    fullName: repo.full_name,
    private: repo.private,
    defaultBranch: repo.default_branch,
    platformIntegrationId: integration.id,
    platformAccountLogin: integration.platform_account_login ?? undefined,
    instanceUrl: 'https://github.com',
    repositoryReference: {
      repository: {
        provider: 'github',
        instanceUrl: 'https://github.com',
        repositoryId: String(repo.id),
        fullName: repo.full_name,
        // Old cache rows omit defaults. Remove this unavailable fallback only after
        // old rows/clients disappear and the 30-day ledger window expires.
        defaultBranch: repo.default_branch ?? null,
      },
      authorization: { kind: 'ownerIntegration', owner, integrationId: integration.id },
    },
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
  const integration = await getPrimaryGitHubIntegrationForOrganization(organizationId);

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
  const integration = await getPrimaryGitHubIntegrationForOrganization(organizationId);
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
  const owner: Owner = { type: 'org', id: organizationId };
  const integration = await getPrimaryGitHubIntegrationForOrganization(organizationId);

  if (!integration) {
    const unavailableIntegration = await getIntegrationForOrganization(
      organizationId,
      PLATFORM.GITHUB
    );
    if (isPlatformIntegrationSuspended(unavailableIntegration)) {
      return missingIntegrationResponse('GitHub integration is suspended');
    }
    if (unavailableIntegration?.auth_invalid_at) {
      return missingIntegrationResponse('GitHub integration requires reauthorization');
    }
    if (unavailableIntegration) {
      return missingIntegrationResponse('GitHub integration is not properly configured');
    }
    return missingIntegrationResponse('No GitHub integration found for this organization');
  }

  if (!integration.platform_installation_id) {
    return missingIntegrationResponse('GitHub integration is not properly configured');
  }

  try {
    const cachedRepositories = requireNumericPlatformRepositories(integration.repositories);
    if (forceRefresh || !cachedRepositories?.length) {
      const repositories = await fetchGitHubRepositories(
        integration.platform_installation_id,
        integration.github_app_type || 'standard'
      );
      await updateRepositoriesForIntegration(integration.id, repositories);
      return {
        integrationInstalled: true,
        repositories: mapRepositories(repositories, integration, owner),
        syncedAt: new Date().toISOString(),
      };
    }
    return {
      integrationInstalled: true,
      repositories: mapRepositories(cachedRepositories, integration, owner),
      syncedAt: integration.repositories_synced_at,
    };
  } catch (_error) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to fetch GitHub repositories',
    });
  }
}

export async function fetchAllGitHubRepositoriesForOrganization(
  organizationId: string,
  forceRefresh: boolean = false,
  { requireComplete = false }: { requireComplete?: boolean } = {}
): Promise<GitHubRepositoriesResult> {
  const integrations = (
    await getIntegrationsByOrganization(organizationId, PLATFORM.GITHUB)
  ).filter(isPlatformIntegrationHealthy);
  return fetchRepositoriesForIntegrations(
    integrations,
    forceRefresh,
    { type: 'org', id: organizationId },
    requireComplete
  );
}

async function fetchRepositoriesForIntegrations(
  integrations: Awaited<ReturnType<typeof getIntegrationsByOrganization>>,
  forceRefresh: boolean,
  owner: Owner,
  requireComplete: boolean
): Promise<GitHubRepositoriesResult> {
  if (integrations.length === 0) {
    return missingIntegrationResponse('No GitHub integration found for this organization');
  }

  try {
    const settledResults = await Promise.allSettled(
      integrations.map(async integration => {
        if (!integration.platform_installation_id) {
          if (requireComplete) throw new Error('GitHub installation is not configured');
          return { repositories: [], syncedAt: null };
        }
        const cachedRepositories = requireNumericPlatformRepositories(integration.repositories);
        if (forceRefresh || !cachedRepositories?.length) {
          const repositories = await fetchGitHubRepositories(
            integration.platform_installation_id,
            integration.github_app_type || 'standard'
          );
          await updateRepositoriesForIntegration(integration.id, repositories);
          return {
            repositories: mapRepositories(repositories, integration, owner),
            syncedAt: new Date().toISOString(),
          };
        }
        return {
          repositories: mapRepositories(cachedRepositories, integration, owner),
          syncedAt: integration.repositories_synced_at,
        };
      })
    );
    const results = settledResults
      .filter(result => result.status === 'fulfilled')
      .map(result => result.value);
    // Browsing keeps partial results; URL-only identity resolution cannot use them.
    if (results.length === 0 || (requireComplete && results.length !== integrations.length)) {
      throw new Error('GitHub repository discovery is incomplete');
    }
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
  forceRefresh: boolean = false,
  { requireComplete = false }: { requireComplete?: boolean } = {}
): Promise<GitHubRepositoriesResult> {
  const owner: Owner = { type: 'user', id: userId };
  // URL-only history needs every authorized installation; preserve the browsing default.
  if (requireComplete) {
    const integrations = (await getAllIntegrationsForOwner(owner)).filter(
      integration =>
        integration.platform === PLATFORM.GITHUB && isPlatformIntegrationHealthy(integration)
    );
    if (integrations.length === 0) {
      return missingIntegrationResponse('No GitHub integration found for this user');
    }
    return fetchRepositoriesForIntegrations(integrations, forceRefresh, owner, true);
  }
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
        repositories: mapRepositories(repositories, integration, owner),
        syncedAt: new Date().toISOString(),
      };
    }

    // Return cached repos
    return {
      integrationInstalled: true,
      repositories: mapRepositories(cachedRepositories, integration, owner),
      syncedAt: integration.repositories_synced_at,
    };
  } catch (_error) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to fetch GitHub repositories',
    });
  }
}

export async function listGitHubRepositoryBranches(
  owner: Owner,
  reference: LaunchRepositoryReference
) {
  const { repository, authorization } = reference;
  if (
    repository.provider !== 'github' ||
    authorization.owner.type !== owner.type ||
    authorization.owner.id !== owner.id
  ) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Repository owner does not match' });
  }
  if (repository.instanceUrl !== 'https://github.com') {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'GitHub repository not found' });
  }
  const { getGitHubIntegrationById } = await import('@/lib/integrations/db/platform-integrations');
  const integration = await getGitHubIntegrationById(owner, authorization.integrationId);
  if (
    !integration ||
    !isPlatformIntegrationHealthy(integration) ||
    !integration.platform_installation_id
  ) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'GitHub integration not found' });
  }
  const repositories =
    requireNumericPlatformRepositories(integration.repositories) ??
    (await fetchGitHubRepositories(
      integration.platform_installation_id,
      integration.github_app_type || 'standard'
    ));
  const selected = repositories.find(
    candidate =>
      String(candidate.id) === repository.repositoryId &&
      candidate.full_name.toLowerCase() === repository.fullName.toLowerCase()
  );
  if (!selected) throw new TRPCError({ code: 'NOT_FOUND', message: 'GitHub repository not found' });
  const { fetchGitHubBranches } = await import('@/lib/integrations/platforms/github/adapter');
  const branches = await fetchGitHubBranches(
    integration.platform_installation_id,
    selected.full_name,
    integration.github_app_type || 'standard',
    repository.repositoryId
  );
  return {
    branches,
    defaultBranch: branches.find(branch => branch.isDefault)?.name ?? null,
    nextCursor: null,
  };
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
