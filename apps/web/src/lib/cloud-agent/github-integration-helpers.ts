import { TRPCError } from '@trpc/server';
import type { PlatformIntegration } from '@kilocode/db/schema';
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
  shouldSyncProviderRepositories,
  type PlatformRepository,
} from '@/lib/integrations/core/types';

/**
 * Why a stored GitHub installation cannot serve repositories. Repository
 * pickers show the reconnect step for these instead of the plain
 * "not connected" state, because the installation exists but needs an admin
 * action before it can list anything.
 */
export type GitHubRepositoriesUnavailableReason =
  | 'suspended'
  | 'disconnected'
  | 'reauth_required'
  | 'not_configured';

type GitHubRepositoriesResult = {
  integrationInstalled: boolean;
  repositories: {
    id: number;
    name: string;
    fullName: string;
    private: boolean;
    platformIntegrationId?: string;
    platformAccountLogin?: string;
    githubAppType?: 'standard' | 'lite';
  }[];
  syncedAt?: string | null;
  errorMessage?: string;
  /** Set when an installation exists but none can serve repositories. */
  unavailableReason?: GitHubRepositoriesUnavailableReason;
  /**
   * Set when at least one installation answered and at least one did not, so
   * `repositories` is a partial list rather than the full set.
   */
  partial?: boolean;
};

const mapRepositories = (
  repositories: PlatformRepository[],
  integration?: {
    id: string;
    platform_account_login: string | null;
    github_app_type: 'standard' | 'lite' | null;
  }
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
          githubAppType: integration.github_app_type ?? 'standard',
        }
      : {}),
  }));
};

// Repositories are intentionally listed once per granting installation: two
// installations that both grant access to the same repo resolve to different
// tokens/permissions at session start, so the UI (NewSessionPanel) keys and
// selects rows by `(platformIntegrationId, id)`, not by repo id alone. This
// only removes exact duplicate entries within the same installation's own
// repository list (for example, a corrupted or duplicated cache), which would
// otherwise silently double-count that installation's repo count in callers
// like `hasGitHubRepository`.
const dedupeRepositories = (
  repositories: GitHubRepositoriesResult['repositories']
): GitHubRepositoriesResult['repositories'] => {
  const seen = new Set<string>();
  return repositories.filter(repo => {
    const key = `${repo.platformIntegrationId ?? ''}:${repo.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const missingIntegrationResponse = (message: string): GitHubRepositoriesResult => ({
  integrationInstalled: false,
  repositories: [],
  syncedAt: null,
  errorMessage: message,
});

const UNAVAILABLE_REASON_MESSAGES: Record<GitHubRepositoriesUnavailableReason, string> = {
  suspended: 'GitHub integration is suspended',
  disconnected: 'GitHub integration is disconnected',
  reauth_required: 'GitHub integration requires reauthorization',
  not_configured: 'GitHub integration is not properly configured',
};

/**
 * Why a stored installation cannot list repositories. A locally disconnected
 * row is reported before a suspension because disconnecting sets both, and the
 * person who disconnected needs the reconnect step, not a suspension notice.
 */
const unavailableReasonForIntegration = (integration: {
  integration_status: string | null;
  suspended_at: string | null;
  auth_invalid_at: string | null;
  github_disconnected_at?: string | null;
}): GitHubRepositoriesUnavailableReason => {
  if (integration.github_disconnected_at) return 'disconnected';
  if (isPlatformIntegrationSuspended(integration)) return 'suspended';
  if (integration.auth_invalid_at) return 'reauth_required';
  return 'not_configured';
};

const unavailableIntegrationResponse = (
  reason: GitHubRepositoriesUnavailableReason
): GitHubRepositoriesResult => ({
  ...missingIntegrationResponse(UNAVAILABLE_REASON_MESSAGES[reason]),
  unavailableReason: reason,
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

  if (!isPlatformIntegrationHealthy(integration) || !integration.platform_installation_id) {
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
  return isPlatformIntegrationHealthy(integration)
    ? (integration.platform_installation_id ?? undefined)
    : undefined;
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
    if (unavailableIntegration) {
      return unavailableIntegrationResponse(
        unavailableReasonForIntegration(unavailableIntegration)
      );
    }
    return missingIntegrationResponse('No GitHub integration found for this organization');
  }

  if (!integration.platform_installation_id) {
    return unavailableIntegrationResponse('not_configured');
  }

  try {
    const cachedRepositories = requireNumericPlatformRepositories(integration.repositories);
    // Answer from the cached snapshot unless the caller forces a sync or the
    // integration has never synced: a synced empty snapshot is the
    // connected-empty state, not a reason to re-query GitHub on every read.
    if (
      shouldSyncProviderRepositories({
        forceRefresh,
        cachedRepositories,
        repositoriesSyncedAt: integration.repositories_synced_at,
      })
    ) {
      const repositories = await fetchGitHubRepositories(
        integration.platform_installation_id,
        integration.github_app_type || 'standard',
        integration.id
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
      repositories: mapRepositories(cachedRepositories ?? []),
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
  purpose: 'workflow' | 'agent' = 'workflow'
): Promise<GitHubRepositoriesResult> {
  // Every stored installation is passed through: an unhealthy one explains why
  // the list is short, and dropping it before aggregation made a suspended
  // connection read as "no integration found".
  const integrations = await getIntegrationsByOrganization(
    organizationId,
    PLATFORM.GITHUB,
    purpose
  );
  return fetchRepositoriesForIntegrations(integrations, forceRefresh, purpose);
}

type IntegrationRepositoriesOutcome =
  | {
      status: 'repositories';
      repositories: GitHubRepositoriesResult['repositories'];
      syncedAt: string | null;
    }
  | { status: 'unavailable'; reason: GitHubRepositoriesUnavailableReason }
  | { status: 'failed' };

async function readIntegrationRepositories(
  integration: PlatformIntegration,
  forceRefresh: boolean,
  purpose: 'workflow' | 'agent'
): Promise<IntegrationRepositoriesOutcome> {
  if (!integration.platform_installation_id) {
    return { status: 'unavailable', reason: 'not_configured' };
  }
  const cachedRepositories = requireNumericPlatformRepositories(integration.repositories);
  if (
    shouldSyncProviderRepositories({
      forceRefresh,
      cachedRepositories,
      repositoriesSyncedAt: integration.repositories_synced_at,
    })
  ) {
    const repositories = await fetchGitHubRepositories(
      integration.platform_installation_id,
      integration.github_app_type || 'standard',
      integration.id,
      purpose
    );
    await updateRepositoriesForIntegration(integration.id, repositories);
    return {
      status: 'repositories',
      repositories: mapRepositories(repositories, integration),
      syncedAt: new Date().toISOString(),
    };
  }
  return {
    status: 'repositories',
    repositories: mapRepositories(cachedRepositories ?? [], integration),
    syncedAt: integration.repositories_synced_at,
  };
}

async function fetchRepositoriesForIntegrations(
  integrations: PlatformIntegration[],
  forceRefresh: boolean,
  purpose: 'workflow' | 'agent'
): Promise<GitHubRepositoriesResult> {
  if (integrations.length === 0) {
    return missingIntegrationResponse('No GitHub integration found for this organization');
  }

  try {
    const outcomes = await Promise.all(
      integrations.map(async (integration): Promise<IntegrationRepositoriesOutcome> => {
        if (!isPlatformIntegrationHealthy(integration)) {
          return { status: 'unavailable', reason: unavailableReasonForIntegration(integration) };
        }
        try {
          return await readIntegrationRepositories(integration, forceRefresh, purpose);
        } catch {
          return { status: 'failed' };
        }
      })
    );
    const readable = outcomes.filter(outcome => outcome.status === 'repositories');
    if (readable.length === 0) {
      const unavailable = outcomes.find(outcome => outcome.status === 'unavailable');
      if (!unavailable) {
        // Every installation was configured but the provider rejected the read.
        // The caller retries, so this stays an error rather than a state.
        throw new Error('All GitHub repository fetches failed');
      }
      return unavailableIntegrationResponse(unavailable.reason);
    }
    return {
      integrationInstalled: true,
      repositories: dedupeRepositories(readable.flatMap(outcome => outcome.repositories)),
      syncedAt: readable
        .map(outcome => outcome.syncedAt)
        .filter((value): value is string => value !== null)
        .sort()
        .at(0),
      // A short list is not a complete one: say so instead of reporting an
      // unqualified success for the installations that answered.
      ...(readable.length < outcomes.length ? { partial: true } : {}),
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

  if (!isPlatformIntegrationHealthy(integration)) {
    return unavailableIntegrationResponse(unavailableReasonForIntegration(integration));
  }

  if (!integration.platform_installation_id) {
    return unavailableIntegrationResponse('not_configured');
  }

  try {
    const cachedRepositories = requireNumericPlatformRepositories(integration.repositories);
    // Answer from the cached snapshot unless the caller forces a sync or the
    // integration has never synced: a synced empty snapshot is the
    // connected-empty state, not a reason to re-query GitHub on every read.
    if (
      shouldSyncProviderRepositories({
        forceRefresh,
        cachedRepositories,
        repositoriesSyncedAt: integration.repositories_synced_at,
      })
    ) {
      const appType = integration.github_app_type || 'standard';
      const repositories = await fetchGitHubRepositories(
        integration.platform_installation_id,
        appType,
        integration.id
      );
      await updateRepositoriesForIntegration(integration.id, repositories);
      return {
        integrationInstalled: true,
        repositories: mapRepositories(repositories, integration),
        syncedAt: new Date().toISOString(),
      };
    }

    return {
      integrationInstalled: true,
      repositories: mapRepositories(cachedRepositories ?? [], integration),
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

  if (!isPlatformIntegrationHealthy(integration) || !integration?.platform_installation_id) {
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
