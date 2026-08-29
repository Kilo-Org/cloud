import { TRPCError } from '@trpc/server';
import {
  getIntegrationForOrganization,
  updateRepositoriesForIntegration,
} from '@/lib/integrations/db/platform-integrations';
import {
  getGitLabIntegration,
  getValidGitLabToken,
  listGitLabBranches,
} from '@/lib/integrations/gitlab-service';
import { fetchGitLabProjects } from '@/lib/integrations/platforms/gitlab/adapter';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { isPlatformIntegrationSuspended } from '@/lib/integrations/core/health';
import {
  requireNumericPlatformRepositories,
  type PlatformRepository,
} from '@/lib/integrations/core/types';
import type {
  LaunchRepositoryReference,
  Owner,
} from '@kilocode/app-shared/code-review/repository-identity';
import { normalizeGitLabInstanceUrl } from '@/lib/integrations/platforms/gitlab/instance-url';

const DEFAULT_GITLAB_URL = 'https://gitlab.com';

type GitLabRepositoriesResult = {
  integrationInstalled: boolean;
  repositories: {
    id: number;
    name: string;
    fullName: string;
    private: boolean;
    defaultBranch?: string;
    platformIntegrationId: string;
    instanceUrl: string;
    repositoryReference: LaunchRepositoryReference;
  }[];
  syncedAt?: string | null;
  errorMessage?: string;
  instanceUrl?: string;
};

const mapRepositories = (
  repositories: PlatformRepository[],
  integrationId: string,
  instanceUrl: string,
  owner: Owner
): GitLabRepositoriesResult['repositories'] => {
  return repositories.map(repo => ({
    id: repo.id,
    name: repo.name,
    fullName: repo.full_name,
    private: repo.private,
    defaultBranch: repo.default_branch,
    platformIntegrationId: integrationId,
    instanceUrl,
    repositoryReference: {
      repository: {
        provider: 'gitlab',
        instanceUrl,
        repositoryId: String(repo.id),
        fullName: repo.full_name,
        // Old cache rows omit defaults. Remove this unavailable fallback only after
        // old rows/clients disappear and the 30-day ledger window expires.
        defaultBranch: repo.default_branch ?? null,
      },
      authorization: { kind: 'ownerIntegration', owner, integrationId },
    },
  }));
};

const missingIntegrationResponse = (message: string): GitLabRepositoriesResult => ({
  integrationInstalled: false,
  repositories: [],
  syncedAt: null,
  errorMessage: message,
});

type GitLabMetadata = {
  gitlab_instance_url?: string;
};

/** Get the organization's GitLab token through the credential broker. */
export async function getGitLabTokenForOrganization(
  organizationId: string,
  actorUserId: string
): Promise<string | undefined> {
  const integration = await getIntegrationForOrganization(organizationId, PLATFORM.GITLAB);
  if (!integration) return undefined;
  try {
    return await getValidGitLabToken(integration, { userId: actorUserId, organizationId });
  } catch {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to authenticate with GitLab integration',
    });
  }
}

/** Get the user's GitLab token through the credential broker. */
export async function getGitLabTokenForUser(userId: string): Promise<string | undefined> {
  const integration = await getGitLabIntegration({ type: 'user', id: userId });
  if (!integration) return undefined;
  try {
    return await getValidGitLabToken(integration, { userId });
  } catch {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to authenticate with GitLab integration',
    });
  }
}

async function fetchRepositories(
  owner: Owner,
  actorUserId: string,
  forceRefresh: boolean,
  integrationId?: string
): Promise<GitLabRepositoriesResult> {
  const integration = await getGitLabIntegration(owner, integrationId);
  if (!integration) {
    return missingIntegrationResponse(
      `No GitLab integration found for this ${owner.type === 'org' ? 'organization' : 'user'}`
    );
  }
  if (isPlatformIntegrationSuspended(integration)) {
    return missingIntegrationResponse('GitLab integration is suspended');
  }

  try {
    const metadata = integration.metadata as GitLabMetadata | null;
    const instanceUrl = normalizeGitLabInstanceUrl(metadata?.gitlab_instance_url);
    const cachedRepositories = requireNumericPlatformRepositories(integration.repositories);
    if (forceRefresh || !cachedRepositories?.length) {
      const accessToken = await getValidGitLabToken(integration, {
        userId: actorUserId,
        ...(owner.type === 'org' ? { organizationId: owner.id } : {}),
      });
      const repositories = await fetchGitLabProjects(accessToken, instanceUrl);
      await updateRepositoriesForIntegration(integration.id, repositories, integration);
      return {
        integrationInstalled: true,
        repositories: mapRepositories(repositories, integration.id, instanceUrl, owner),
        syncedAt: new Date().toISOString(),
        instanceUrl,
      };
    }
    return {
      integrationInstalled: true,
      repositories: mapRepositories(cachedRepositories, integration.id, instanceUrl, owner),
      syncedAt: integration.repositories_synced_at,
      instanceUrl,
    };
  } catch {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to fetch GitLab repositories',
    });
  }
}

export function fetchGitLabRepositoriesForOrganization(
  organizationId: string,
  actorUserId: string,
  forceRefresh: boolean = false,
  integrationId?: string
): Promise<GitLabRepositoriesResult> {
  return fetchRepositories(
    { type: 'org', id: organizationId },
    actorUserId,
    forceRefresh,
    integrationId
  );
}

export function fetchGitLabRepositoriesForUser(
  userId: string,
  forceRefresh: boolean = false,
  integrationId?: string
): Promise<GitLabRepositoriesResult> {
  return fetchRepositories({ type: 'user', id: userId }, userId, forceRefresh, integrationId);
}

export async function validateGitLabRepoAccessForUser(
  userId: string,
  projectPath: string
): Promise<boolean> {
  try {
    const result = await fetchGitLabRepositoriesForUser(userId, false);
    return (
      result.integrationInstalled &&
      result.repositories.some(repo => repo.fullName.toLowerCase() === projectPath.toLowerCase())
    );
  } catch {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to validate GitLab repository access',
    });
  }
}

export async function validateGitLabRepoAccessForOrganization(
  organizationId: string,
  actorUserId: string,
  projectPath: string
): Promise<boolean> {
  try {
    const result = await fetchGitLabRepositoriesForOrganization(organizationId, actorUserId, false);
    return (
      result.integrationInstalled &&
      result.repositories.some(repo => repo.fullName.toLowerCase() === projectPath.toLowerCase())
    );
  } catch {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to validate GitLab repository access',
    });
  }
}

export function buildGitLabCloneUrl(
  projectPath: string,
  instanceUrl: string = DEFAULT_GITLAB_URL
): string {
  const baseUrl = instanceUrl.replace(/\/$/, '');
  const cleanPath = projectPath.replace(/^\/|\/$/g, '');
  return `${baseUrl}/${cleanPath}.git`;
}

async function getInstanceUrl(owner: Owner, integrationId?: string, expectedInstanceUrl?: string) {
  const integration = await getGitLabIntegration(owner, integrationId);
  if (!integration && (integrationId || expectedInstanceUrl)) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'GitLab integration not found' });
  }
  // Old unpinned callers retain downstream authorization errors. Remove this
  // fallback only after old clients/records and the 30-day ledger window expire.
  if (
    (integrationId || expectedInstanceUrl) &&
    integration &&
    isPlatformIntegrationSuspended(integration)
  ) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'GitLab integration is suspended',
    });
  }
  const metadata = integration?.metadata as GitLabMetadata | null;
  // Old callers omit selectors and old metadata omits the host. The unambiguous
  // lookup retains gitlab.com until old clients/records and the 30-day window expire.
  const instanceUrl = normalizeGitLabInstanceUrl(metadata?.gitlab_instance_url);
  if (expectedInstanceUrl && normalizeGitLabInstanceUrl(expectedInstanceUrl) !== instanceUrl) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'GitLab integration changed' });
  }
  return instanceUrl;
}

export function getGitLabInstanceUrlForUser(
  userId: string,
  integrationId?: string,
  expectedInstanceUrl?: string
): Promise<string> {
  return getInstanceUrl({ type: 'user', id: userId }, integrationId, expectedInstanceUrl);
}

export function getGitLabInstanceUrlForOrganization(
  organizationId: string,
  integrationId?: string,
  expectedInstanceUrl?: string
): Promise<string> {
  return getInstanceUrl({ type: 'org', id: organizationId }, integrationId, expectedInstanceUrl);
}

export async function listGitLabRepositoryBranches(
  owner: Owner,
  actorUserId: string,
  reference: LaunchRepositoryReference
) {
  const { repository, authorization } = reference;
  if (
    repository.provider !== 'gitlab' ||
    authorization.owner.type !== owner.type ||
    authorization.owner.id !== owner.id
  ) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Repository owner does not match' });
  }
  const { branches } = await listGitLabBranches(
    owner,
    authorization.integrationId,
    { userId: actorUserId, ...(owner.type === 'org' ? { organizationId: owner.id } : {}) },
    repository.fullName,
    repository
  );
  return {
    branches,
    defaultBranch: branches.find(branch => branch.isDefault)?.name ?? null,
    nextCursor: null,
  };
}
