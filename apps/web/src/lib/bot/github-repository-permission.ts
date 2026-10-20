import 'server-only';
import type { PlatformIntegration } from '@kilocode/db';
import {
  getCollaboratorPermissionLevel,
  type CollaboratorPermission,
  type GitHubAppType,
} from '@/lib/integrations/platforms/github/adapter';
import { assertGitHubInstallationRuntimeAuthorized } from '@/lib/integrations/github/runtime-authorization';
import { PLATFORM } from '@/lib/integrations/core/constants';

export const GITHUB_REPOSITORY_PERMISSION_CACHE_TTL_MS = 5 * 60_000;

type GitHubRepositoryPermissionInput = {
  installationId: string;
  appType: GitHubAppType;
  owner: string;
  repo: string;
  username: string;
  platformIntegrationId?: string;
};

type FetchRepositoryPermission = typeof getCollaboratorPermissionLevel;

type CachedRepositoryPermission = {
  permission: CollaboratorPermission;
  expiresAtMs: number;
};

const permissionCache = new Map<string, CachedRepositoryPermission>();
const permissionRequests = new Map<string, Promise<CollaboratorPermission | null>>();

function repositoryPermissionCacheKey(input: GitHubRepositoryPermissionInput): string {
  return [
    input.installationId.trim().toLowerCase(),
    input.appType,
    input.owner.trim().toLowerCase(),
    input.repo.trim().toLowerCase(),
    input.username.trim().toLowerCase(),
  ].join(':');
}

export async function getGitHubRepositoryPermission(
  input: GitHubRepositoryPermissionInput,
  fetchPermission: FetchRepositoryPermission = getCollaboratorPermissionLevel
): Promise<CollaboratorPermission | null> {
  const cacheKey = repositoryPermissionCacheKey(input);
  const now = Date.now();
  const cached = permissionCache.get(cacheKey);
  if (cached) {
    if (cached.expiresAtMs > now) return cached.permission;
    permissionCache.delete(cacheKey);
  }

  const pending = permissionRequests.get(cacheKey);
  if (pending) return pending;

  const request = (async () => {
    const permission = await fetchPermission(
      input.installationId,
      input.owner,
      input.repo,
      input.username,
      input.appType,
      input.platformIntegrationId
    );
    if (permission !== null) {
      permissionCache.set(cacheKey, {
        permission,
        expiresAtMs: Date.now() + GITHUB_REPOSITORY_PERMISSION_CACHE_TTL_MS,
      });
    }
    return permission;
  })();

  permissionRequests.set(cacheKey, request);

  try {
    return await request;
  } finally {
    permissionRequests.delete(cacheKey);
  }
}

export type GitHubRepositoryAuthorization =
  | { allowed: true }
  | { allowed: false; markdown: string };

function writeAccessRequiredMarkdown(repository: string | null): string {
  const target = repository ? `\`${repository}\`` : 'this repository';
  return (
    `I couldn't confirm that your GitHub account has write access to ${target}, so I didn't ` +
    'start any work. Ask a repository admin to grant you write access to it, then mention me again.'
  );
}

/**
 * Requires write access for the triggering GitHub account before a bot action
 * runs against `repository`.
 *
 * `threadRepository` is the repository the conversation belongs to. Callers
 * that have no triggering account identity (for example a callback
 * continuation) may only use that repository.
 */
export async function authorizeGitHubRepository(params: {
  platformIntegration: PlatformIntegration;
  repository: string | null | undefined;
  threadRepository?: string | null;
  actorLogin?: string;
  fetchPermission?: FetchRepositoryPermission;
}): Promise<GitHubRepositoryAuthorization> {
  const { platformIntegration, repository, threadRepository, actorLogin } = params;

  if (platformIntegration.platform !== PLATFORM.GITHUB) return { allowed: true };
  if (!platformIntegration.owned_by_organization_id) return { allowed: true };

  if (!repository) return { allowed: false, markdown: writeAccessRequiredMarkdown(null) };

  if (!actorLogin) {
    if (
      threadRepository &&
      repository.trim().toLowerCase() === threadRepository.trim().toLowerCase()
    ) {
      return { allowed: true };
    }
    return { allowed: false, markdown: writeAccessRequiredMarkdown(repository) };
  }

  const [owner, repo] = repository.split('/');
  const installationId = platformIntegration.platform_installation_id;
  if (!owner || !repo || !installationId) {
    return { allowed: false, markdown: writeAccessRequiredMarkdown(repository) };
  }

  const appType = platformIntegration.github_app_type ?? 'standard';

  try {
    await assertGitHubInstallationRuntimeAuthorized(
      installationId,
      appType,
      platformIntegration.id
    );
    const permission = await getGitHubRepositoryPermission(
      {
        installationId,
        appType,
        owner,
        repo,
        username: actorLogin,
        platformIntegrationId: platformIntegration.id,
      },
      params.fetchPermission
    );
    if (permission === 'admin' || permission === 'write') return { allowed: true };
  } catch (error) {
    console.warn('[KiloBot] Failed to verify GitHub repository access:', {
      repository,
      platformIntegrationId: platformIntegration.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return { allowed: false, markdown: writeAccessRequiredMarkdown(repository) };
}
