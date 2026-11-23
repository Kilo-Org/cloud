import { TRPCError } from '@trpc/server';
import type { PlatformIntegration } from '@kilocode/db/schema';
import {
  getIntegrationsByOrganization,
  getIntegrationForOwner,
  updateRepositoriesForIntegration,
} from '@/lib/integrations/db/platform-integrations';
import {
  fetchGitHubRepositories,
  checkExistingFork,
} from '@/lib/integrations/platforms/github/adapter';
import {
  GITHUB_LISTING_BUDGET_MESSAGE,
  GitHubListingBudgetExceededError,
} from '@/lib/integrations/platforms/github/listing-budget';
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

/**
 * Aggregate the organization's GitHub installations into one repository list.
 * A listing that passed the provider's pagination budget answers a permanent
 * `PAYLOAD_TOO_LARGE` unless another installation could serve the read.
 */
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
  | { status: 'failed'; budget?: GitHubListingBudgetExceededError };

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
        } catch (error) {
          if (error instanceof GitHubListingBudgetExceededError) {
            return { status: 'failed', budget: error };
          }
          return { status: 'failed' };
        }
      })
    );
    const readable = outcomes.filter(outcome => outcome.status === 'repositories');
    if (readable.length === 0) {
      const unavailable = outcomes.find(outcome => outcome.status === 'unavailable');
      if (!unavailable) {
        // Every installation was configured but the provider rejected the read.
        // An oversized listing is permanent for the retrying picker, so it
        // answers the budget refusal instead of the generic retryable error;
        // any other provider failure keeps the generic error.
        const budget = outcomes.find(
          (outcome): outcome is { status: 'failed'; budget: GitHubListingBudgetExceededError } =>
            outcome.status === 'failed' && outcome.budget !== undefined
        );
        if (budget) {
          throw new TRPCError({
            code: 'PAYLOAD_TOO_LARGE',
            message: GITHUB_LISTING_BUDGET_MESSAGE,
            cause: budget.budget,
          });
        }
        throw new Error('All GitHub repository fetches failed');
      }
      return {
        ...unavailableIntegrationResponse(unavailable.reason),
        // A rejected read next to an unusable installation may clear on retry,
        // so the pickers keep the retry control alongside the reason.
        ...(outcomes.some(outcome => outcome.status === 'failed') ? { partial: true } : {}),
      };
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
  } catch (error) {
    // The aggregation throws `PAYLOAD_TOO_LARGE` itself for an oversized
    // listing; rethrow it unchanged so the permanence of the refusal survives
    // the retryable-looking generic wrapper below.
    if (error instanceof TRPCError && error.code === 'PAYLOAD_TOO_LARGE') {
      throw error;
    }
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to fetch GitHub repositories',
    });
  }
}

/**
 * Read the repositories a user's own GitHub installation can serve. A listing
 * that passed the provider's pagination budget answers a permanent
 * `PAYLOAD_TOO_LARGE`.
 */
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
  } catch (error) {
    // An oversized listing can never succeed on retry, so it answers the
    // permanent `PAYLOAD_TOO_LARGE` refusal instead of this generic error.
    if (error instanceof GitHubListingBudgetExceededError) {
      throw new TRPCError({
        code: 'PAYLOAD_TOO_LARGE',
        message: GITHUB_LISTING_BUDGET_MESSAGE,
        cause: error,
      });
    }
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
