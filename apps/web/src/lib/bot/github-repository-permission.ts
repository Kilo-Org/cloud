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

export const MAX_CACHED_REPOSITORY_PERMISSIONS = 500;

function trimPermissionCache(now: number): void {
  if (permissionCache.size <= MAX_CACHED_REPOSITORY_PERMISSIONS) return;

  for (const [key, entry] of permissionCache) {
    if (entry.expiresAtMs <= now) permissionCache.delete(key);
  }

  while (permissionCache.size > MAX_CACHED_REPOSITORY_PERMISSIONS) {
    const oldestKey = permissionCache.keys().next().value;
    if (oldestKey === undefined) return;
    permissionCache.delete(oldestKey);
  }
}

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
      input.platformIntegrationId,
      'workflow'
    );
    if (permission !== null) {
      const expiresAtMs = Date.now() + GITHUB_REPOSITORY_PERMISSION_CACHE_TTL_MS;
      permissionCache.set(cacheKey, { permission, expiresAtMs });
      trimPermissionCache(Date.now());
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

function notAllowed(repository: string | null): GitHubRepositoryAuthorization {
  return { allowed: false, markdown: writeAccessRequiredMarkdown(repository) };
}

function isSameRepository(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

async function hasRepositoryWriteAccess(params: {
  installationId: string;
  appType: GitHubAppType;
  platformIntegrationId: string;
  repository: string;
  username: string;
  fetchPermission?: FetchRepositoryPermission;
}): Promise<boolean> {
  const [owner, repo] = params.repository.split('/');
  if (!owner || !repo) return false;

  const permissionInput = {
    installationId: params.installationId,
    appType: params.appType,
    owner,
    repo,
    username: params.username,
    platformIntegrationId: params.platformIntegrationId,
  };

  try {
    await assertGitHubInstallationRuntimeAuthorized(
      params.installationId,
      params.appType,
      params.platformIntegrationId
    );
    let permission = await getGitHubRepositoryPermission(permissionInput, params.fetchPermission);
    if (permission === null) {
      // A single GitHub error (rate limit, 5xx, timeout) must not end the action.
      permission = await getGitHubRepositoryPermission(permissionInput, params.fetchPermission);
    }
    return permission === 'admin' || permission === 'maintain' || permission === 'write';
  } catch (error) {
    console.warn('[KiloBot] Failed to verify GitHub repository access:', {
      repository: params.repository,
      platformIntegrationId: params.platformIntegrationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Requires the actor's write access only for organization-owned GitHub-triggered actions.
 *
 * Chat integrations (Slack, Linear) use the organization's GitHub connection,
 * not a personal GitHub identity. `spawnCloudAgentSession` resolves repository
 * availability through that connection.
 *
 * GitHub callers without an actor login (for example a callback continuation)
 * may only use `threadRepository`, the conversation's repository.
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
  // Personally owned GitHub integrations stay owner-controlled.
  if (!platformIntegration.owned_by_organization_id) return { allowed: true };

  if (!repository) return notAllowed(null);

  if (!actorLogin) {
    if (threadRepository && isSameRepository(repository, threadRepository)) {
      return { allowed: true };
    }
    return notAllowed(repository);
  }

  const installationId = platformIntegration.platform_installation_id;
  if (!installationId) return notAllowed(repository);

  const allowed = await hasRepositoryWriteAccess({
    installationId,
    appType: platformIntegration.github_app_type ?? 'standard',
    platformIntegrationId: platformIntegration.id,
    repository,
    username: actorLogin,
    fetchPermission: params.fetchPermission,
  });
  return allowed ? { allowed: true } : notAllowed(repository);
}
