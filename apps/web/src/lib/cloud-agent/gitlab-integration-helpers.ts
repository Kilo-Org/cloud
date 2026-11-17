import { TRPCError } from '@trpc/server';
import type { PlatformIntegration } from '@kilocode/db/schema';
import {
  getIntegrationForOrganization,
  getIntegrationForOwner,
  updateRepositoriesForIntegration,
} from '@/lib/integrations/db/platform-integrations';
import { getGitLabIntegration, getValidGitLabToken } from '@/lib/integrations/gitlab-service';
import { fetchGitLabProjects } from '@/lib/integrations/platforms/gitlab/adapter';
import type { GitLabCredentialActor } from '@/lib/integrations/platforms/gitlab/credential-broker-client';
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

const DEFAULT_GITLAB_URL = 'https://gitlab.com';

const gitLabInstanceUrlFromIntegration = (integration: { metadata: unknown }): string => {
  const metadata = integration.metadata as GitLabMetadata | null;
  return metadata?.gitlab_instance_url || DEFAULT_GITLAB_URL;
};

async function resolveGitLabToken(
  integration: Pick<PlatformIntegration, 'id' | 'metadata'>,
  actor: GitLabCredentialActor
): Promise<string> {
  try {
    return await getValidGitLabToken(integration, actor);
  } catch {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to authenticate with GitLab integration',
    });
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

/**
 * The message a stored GitLab connection answers with when the shared health
 * predicate declines it. A suspension is reported first: the disconnect and
 * authorizing-user-removal writers both set a credential marker as well, and
 * the reconnect step is the action that helps.
 */
const unavailableMessageForIntegration = (integration: {
  integration_status: string | null;
  suspended_at: string | null;
  auth_invalid_at: string | null;
}): string => {
  if (isPlatformIntegrationSuspended(integration)) {
    return 'GitLab integration is suspended';
  }
  if (integration.auth_invalid_at) {
    return 'GitLab integration requires reauthorization';
  }
  return 'GitLab integration is not properly configured';
};

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

  return resolveGitLabToken(integration, {
    userId: actorUserId,
    organizationId,
  });
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

  return resolveGitLabToken(integration, { userId });
}

/**
 * Fetch GitLab repositories for an organization
 * Returns cached repositories by default, fetches fresh from GitLab when forceRefresh is true.
 * Only a connection the shared health predicate accepts answers from the
 * snapshot; any other connection answers the unavailable result.
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

  if (!isPlatformIntegrationHealthy(integration)) {
    return missingIntegrationResponse(unavailableMessageForIntegration(integration));
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
 * Returns cached repositories by default, fetches fresh from GitLab when forceRefresh is true.
 * Only a connection the shared health predicate accepts answers from the
 * snapshot; any other connection answers the unavailable result.
 */
export async function fetchGitLabRepositoriesForUser(
  userId: string,
  forceRefresh: boolean = false
): Promise<GitLabRepositoriesResult> {
  const integration = await getIntegrationForOwner({ type: 'user', id: userId }, PLATFORM.GITLAB);

  if (!integration) {
    return missingIntegrationResponse('No GitLab integration found for this user');
  }

  if (!isPlatformIntegrationHealthy(integration)) {
    return missingIntegrationResponse(unavailableMessageForIntegration(integration));
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

  return gitLabInstanceUrlFromIntegration(integration);
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

  return gitLabInstanceUrlFromIntegration(integration);
}
