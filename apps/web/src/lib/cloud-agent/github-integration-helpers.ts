import { TRPCError } from '@trpc/server';
import type { Owner } from '@/lib/integrations/core/types';
import {
  REPOSITORY_READ_LIMITS,
  withRepositoryReadDeadline,
  type RepositoryReadOptions,
} from '@/lib/integrations/core/repository-read-limits';
import {
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

type GitHubRepositoriesResult = {
  status?:
    | 'not_connected'
    | 'available'
    | 'suspended'
    | 'reconnect_required'
    | 'misconfigured'
    | 'temporarily_unavailable'
    | 'integration_limit_exceeded';
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
        repositories: mapRepositories(repositories),
        syncedAt: new Date().toISOString(),
      };
    }
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

async function fetchBoundedGitHubRepositories(
  owner: Owner,
  forceRefresh: boolean,
  options: RepositoryReadOptions
): Promise<GitHubRepositoriesResult> {
  const unavailable = { integrationInstalled: true, repositories: [], syncedAt: null };
  try {
    return await withRepositoryReadDeadline<GitHubRepositoriesResult>(options, async signal => {
      const candidates =
        owner.type === 'org'
          ? await getIntegrationsByOrganization(owner.id, PLATFORM.GITHUB)
          : [await getIntegrationForOwner(owner, PLATFORM.GITHUB)];
      const integrations = candidates.filter(integration => integration !== null);
      if (!integrations.length) {
        return { ...unavailable, integrationInstalled: false, status: 'not_connected' };
      }
      if (integrations.length > 10) {
        return { ...unavailable, status: 'integration_limit_exceeded' };
      }
      // Check every configured installation before fetching or applying the result cap.
      for (const integration of integrations) {
        if (isPlatformIntegrationSuspended(integration)) {
          return { ...unavailable, status: 'suspended' };
        }
        if (integration.auth_invalid_at) {
          return { ...unavailable, status: 'reconnect_required' };
        }
        if (!isPlatformIntegrationHealthy(integration) || !integration.platform_installation_id) {
          return { ...unavailable, status: 'misconfigured' };
        }
      }
      const repositories: GitHubRepositoriesResult['repositories'] = [];
      let syncedAt: string | null = null;
      for (const integration of integrations) {
        signal?.throwIfAborted();
        const installationId = integration.platform_installation_id;
        if (!installationId) return { ...unavailable, status: 'misconfigured' };
        const cached = requireNumericPlatformRepositories(
          integration.repositories?.slice(0, REPOSITORY_READ_LIMITS.repositories) ?? null
        );
        const refresh = forceRefresh || !cached || !integration.repositories_synced_at;
        const selected = refresh
          ? await fetchGitHubRepositories(
              installationId,
              integration.github_app_type || 'standard',
              {
                bounded: true,
                signal,
              }
            )
          : cached;
        signal?.throwIfAborted();
        repositories.push(
          ...mapRepositories(
            selected.slice(0, REPOSITORY_READ_LIMITS.repositories - repositories.length),
            owner.type === 'org' ? integration : undefined
          )
        );
        const nextSyncedAt = refresh
          ? new Date().toISOString()
          : integration.repositories_synced_at;
        if (nextSyncedAt && (!syncedAt || nextSyncedAt < syncedAt)) syncedAt = nextSyncedAt;
      }
      // Bounded transport results are not a complete shared cache.
      return { status: 'available', integrationInstalled: true, repositories, syncedAt };
    });
  } catch {
    return { ...unavailable, status: 'temporarily_unavailable' };
  }
}

export async function fetchAllGitHubRepositoriesForOrganization(
  organizationId: string,
  forceRefresh: boolean = false,
  options?: RepositoryReadOptions
): Promise<GitHubRepositoriesResult> {
  if (options?.bounded) {
    return fetchBoundedGitHubRepositories(
      { type: 'org', id: organizationId },
      forceRefresh,
      options
    );
  }
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
    const settledResults = await Promise.allSettled(
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
    const results = settledResults
      .filter(result => result.status === 'fulfilled')
      .map(result => result.value);
    if (results.length === 0) {
      throw new Error('All GitHub repository fetches failed');
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
  options?: RepositoryReadOptions
): Promise<GitHubRepositoriesResult> {
  if (options?.bounded) {
    return fetchBoundedGitHubRepositories({ type: 'user', id: userId }, forceRefresh, options);
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
