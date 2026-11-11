import 'server-only';
import type { PlatformIntegration } from '@kilocode/db';
import {
  getCollaboratorPermissionLevel,
  type CollaboratorPermission,
  type GitHubAppType,
} from '@/lib/integrations/platforms/github/adapter';
import { assertGitHubInstallationRuntimeAuthorized } from '@/lib/integrations/github/runtime-authorization';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { getLinkedGitHubLogin } from '@/lib/integrations/platforms/github/identity-store';
import { ownerFromIntegration } from '@/lib/integrations/core/owner';
import { resolveGitHubRepositoryForOwner } from '@/lib/slack-bot/github-repository-context';
import { getGitHubIntegrationById } from '@/lib/integrations/db/platform-integrations';

export const GITHUB_REPOSITORY_PERMISSION_CACHE_TTL_MS = 5 * 60_000;

type GitHubRepositoryPermissionInput = {
  installationId: string;
  appType: GitHubAppType;
  owner: string;
  repo: string;
  username: string;
  platformIntegrationId?: string;
  /** Kept out of the cache key: a permission does not depend on the purpose. */
  purpose?: GitHubAccessPurpose;
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
      input.purpose ?? 'workflow'
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

export type GitHubAccessPurpose = 'workflow' | 'agent';

type LinkedGitHubLoginLookup = (kiloUserId: string) => Promise<string | null>;

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

/**
 * One permission verification shared by every platform path: the installation
 * that serves the repository asks GitHub for the account's permission level.
 */
async function hasRepositoryWriteAccess(params: {
  installationId: string;
  appType: GitHubAppType;
  platformIntegrationId: string;
  repository: string;
  username: string;
  purpose?: GitHubAccessPurpose;
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
    purpose: params.purpose,
  };

  try {
    await assertGitHubInstallationRuntimeAuthorized(
      params.installationId,
      params.appType,
      params.platformIntegrationId,
      params.purpose
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
 * Authorizes a bot action that can change code against `repository`.
 *
 * Every integration that can start work on a repository is authorized against
 * the account that asked for it. A GitHub integration uses the conversation's
 * repository and the triggering GitHub login. A chat integration (Slack,
 * Linear) carries no GitHub identity of its own and runs with the account's
 * GitHub connection, so the login bound to the requesting Kilo account must
 * hold write access to the repository through that connection.
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
  /** Kilo account that triggered the run, when the platform can name one. */
  requesterUserId?: string;
  /** Purpose the session will use, so the check reads the same connection. */
  purpose?: GitHubAccessPurpose;
  fetchPermission?: FetchRepositoryPermission;
  getRequesterLogin?: LinkedGitHubLoginLookup;
}): Promise<GitHubRepositoryAuthorization> {
  const { platformIntegration, repository, threadRepository, actorLogin } = params;

  // Organization-owned integrations get repository-level verification. Personally
  // owned integrations stay owner-controlled, which is documented here because
  // the gate deliberately does not run for them.
  if (!platformIntegration.owned_by_organization_id) return { allowed: true };

  if (!repository) return notAllowed(null);

  if (platformIntegration.platform === PLATFORM.GITHUB) {
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

  if (!params.requesterUserId) {
    if (threadRepository && isSameRepository(repository, threadRepository)) {
      return { allowed: true };
    }
    return notAllowed(repository);
  }

  const purpose = params.purpose ?? 'workflow';
  try {
    const requesterLogin = await (params.getRequesterLogin ?? getLinkedGitHubLogin)(
      params.requesterUserId
    );
    if (!requesterLogin) return notAllowed(repository);

    const owner = ownerFromIntegration(platformIntegration);
    const connection = await resolveGitHubRepositoryForOwner(owner, repository, purpose);
    if (!connection) return notAllowed(repository);

    const integration = await getGitHubIntegrationById(owner, connection.githubIntegrationId);
    const installationId = integration?.platform_installation_id;
    if (!integration || !installationId) return notAllowed(repository);

    const allowed = await hasRepositoryWriteAccess({
      installationId,
      appType: integration.github_app_type ?? connection.githubAppType,
      platformIntegrationId: integration.id,
      repository,
      username: requesterLogin,
      purpose,
      fetchPermission: params.fetchPermission,
    });
    return allowed ? { allowed: true } : notAllowed(repository);
  } catch (error) {
    console.warn('[KiloBot] Failed to resolve the requesting GitHub identity:', {
      repository,
      platformIntegrationId: platformIntegration.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return notAllowed(repository);
  }
}
