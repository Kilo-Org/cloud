import { TRPCError } from '@trpc/server';
import type { PlatformIntegration } from '@kilocode/db/schema';
import z from 'zod';
import {
  getIntegrationForOrganization,
  getIntegrationForOwner,
  updateRepositoriesForIntegration,
} from '@/lib/integrations/db/platform-integrations';
import { getGitLabIntegration, getValidGitLabToken } from '@/lib/integrations/gitlab-service';
import {
  fetchGitLabProjects,
  getGitLabProject as readGitLabProject,
  GitLabProjectFetchError,
  GITLAB_ACCESS_LEVELS,
} from '@/lib/integrations/platforms/gitlab/adapter';
import type { GitLabCredentialActor } from '@/lib/integrations/platforms/gitlab/credential-broker-client';
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
 * A status of 0 means the read did not produce a provider HTTP status; the
 * original failure stays attached as the cause.
 */
export class GitLabProjectLookupError extends Error {
  constructor(
    readonly status: number,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'GitLabProjectLookupError';
  }
}

/**
 * The access levels the instance reports for the credential that read one
 * project. `project_access` covers direct membership; `group_access` covers a
 * membership inherited from a group. Either is absent when the credential can
 * read the project without holding a role on it.
 */
const gitLabProjectPermissionsSchema = z
  .object({
    project_access: z.object({ access_level: z.number() }).nullish(),
    group_access: z.object({ access_level: z.number() }).nullish(),
  })
  .nullish();

/**
 * Read one GitLab project by path with explicit credentials and return the
 * access level the instance reports for that credential. A response without a
 * readable level counts as no access, so a caller that gates on a level fails
 * closed. A provider refusal keeps its status, and any other failure keeps its
 * original error as the cause.
 */
async function getGitLabProjectAccessLevel(
  accessToken: string,
  projectPath: string,
  instanceUrl: string
): Promise<number> {
  const project = await readGitLabProject(accessToken, projectPath, instanceUrl).catch(
    (error: unknown) => {
      throw new GitLabProjectLookupError(
        error instanceof GitLabProjectFetchError ? error.status : 0,
        'GitLab project lookup failed',
        { cause: error }
      );
    }
  );

  const permissions = gitLabProjectPermissionsSchema.safeParse(project.permissions);
  if (!permissions.success) {
    return GITLAB_ACCESS_LEVELS.NO_ACCESS;
  }
  const levels = [
    permissions.data?.project_access?.access_level,
    permissions.data?.group_access?.access_level,
  ].filter((level): level is number => typeof level === 'number');
  return levels.length > 0 ? Math.max(...levels) : GITLAB_ACCESS_LEVELS.NO_ACCESS;
}

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
 * requester's credential reads the project from their own GitLab instance and
 * the instance reports the level that credential holds.
 */
export type GitLabRequesterAccess = { outcome: 'allowed' } | { outcome: 'refused' };

/**
 * What a Kilo account's own GitLab connection can see live, and whether it can
 * write there.
 *
 * `allowed` means the project read succeeded under the account's own
 * credential and the instance reports Developer or above for that credential,
 * which is the level that can push. `refused`: the account holds no GitLab
 * connection of its own, its connection is suspended, the instance keeps the
 * project from its credential (404, or a 401/403 the account's own credential
 * cannot clear), or the reported level is below Developer. All of these are
 * verdicts about this requester, so the caller answers with the refusal line
 * and starts no session. A suspended connection is refused before any
 * credential or project read.
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
  const integration = await getGitLabIntegration({ type: 'user', id: userId });
  if (!integration || isPlatformIntegrationSuspended(integration)) {
    return { outcome: 'refused' };
  }

  const token = await resolveGitLabToken(integration, { userId });
  try {
    const accessLevel = await getGitLabProjectAccessLevel(
      token,
      projectPath,
      gitLabInstanceUrlFromIntegration(integration)
    );
    return accessLevel >= GITLAB_ACCESS_LEVELS.DEVELOPER
      ? { outcome: 'allowed' }
      : { outcome: 'refused' };
  } catch (error) {
    if (
      error instanceof GitLabProjectLookupError &&
      (error.status === 404 || error.status === 401 || error.status === 403)
    ) {
      return { outcome: 'refused' };
    }
    throw error;
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
