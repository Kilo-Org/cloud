import 'server-only';
import type { PlatformIntegration } from '@kilocode/db';
import {
  getCollaboratorPermissionLevel,
  GitHubRateLimitError,
  type CollaboratorPermission,
  type GitHubAppType,
} from '@/lib/integrations/platforms/github/adapter';
import {
  assertGitHubInstallationRuntimeAuthorized,
  GitHubRuntimeAuthorizationError,
} from '@/lib/integrations/github/runtime-authorization';
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
      input.platformIntegrationId
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

/**
 * Read as a temporary failure, not a permission refusal: GitHub could not be
 * reached to answer the question at all.
 */
function transientAccessRequiredMarkdown(repository: string | null): string {
  const target = repository ? `\`${repository}\`` : 'this repository';
  return (
    `I couldn't reach GitHub to check whether your account has permission on ${target}, so I ` +
    "didn't start any work. This is usually temporary, so mention me again in a moment."
  );
}

/**
 * The permission check was rate limited. The retry window stretches as long as
 * GitHub's rate-limit window (up to an hour), so the copy names it instead of
 * overpromising a moment.
 */
function rateLimitedAccessRequiredMarkdown(repository: string): string {
  return (
    `GitHub is rate limiting my checks right now, so I couldn't confirm whether your account ` +
    `has permission on \`${repository}\`, and I didn't start any work. Try again after the ` +
    'rate-limit window passes — usually within the hour.'
  );
}

/**
 * Not a permission refusal: the installation's runtime authorization is
 * rejected (disconnected, suspended, or removed), so the question could not be
 * asked at all.
 */
function installationUnavailableMarkdown(repository: string): string {
  return (
    `I couldn't check \`${repository}\` because its GitHub connection is currently ` +
    "unavailable, so I didn't start any work. Ask an organization admin to reconnect the " +
    'GitHub app, then mention me again.'
  );
}

function notAllowed(repository: string | null): GitHubRepositoryAuthorization {
  return { allowed: false, markdown: writeAccessRequiredMarkdown(repository) };
}

function isSameRepository(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

type WriteAccessResult =
  | 'allowed'
  | 'denied'
  | 'transient'
  | 'rate_limited'
  | 'installation_unavailable';

type PermissionLookup =
  | { status: 'answered'; permission: CollaboratorPermission | null }
  | { status: 'unreachable'; error: string }
  | { status: 'rate_limited'; error: GitHubRateLimitError };

/**
 * Asks GitHub for the collaborator permission at most twice: a single thrown
 * failure must not end the action. A null settles the lookup as the definitive
 * no-answer (unknown actor or removed installation), so it is never retried;
 * only thrown failures take the second attempt. Two thrown failures in a row
 * mean GitHub stayed unreachable. A typed rate-limit failure is not retried:
 * another request before `resetAt` cannot succeed and extends GitHub's
 * penalty, so that attempt ends the lookup.
 */
async function lookupRepositoryPermission(
  permissionInput: GitHubRepositoryPermissionInput,
  fetchPermission: FetchRepositoryPermission | undefined
): Promise<PermissionLookup> {
  try {
    const permission = await getGitHubRepositoryPermission(permissionInput, fetchPermission);
    return { status: 'answered', permission };
  } catch (error) {
    if (error instanceof GitHubRateLimitError) return { status: 'rate_limited', error };
  }
  // Retry once for a thrown failure; a null answer never reaches here.
  try {
    const permission = await getGitHubRepositoryPermission(permissionInput, fetchPermission);
    return { status: 'answered', permission };
  } catch (error) {
    if (error instanceof GitHubRateLimitError) return { status: 'rate_limited', error };
    return {
      status: 'unreachable',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function hasRepositoryWriteAccess(params: {
  installationId: string;
  appType: GitHubAppType;
  platformIntegrationId: string;
  repository: string;
  username: string;
  fetchPermission?: FetchRepositoryPermission;
}): Promise<WriteAccessResult> {
  const [owner, repo] = params.repository.split('/');
  if (!owner || !repo) return 'denied';

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
  } catch (error) {
    if (error instanceof GitHubRuntimeAuthorizationError) {
      console.warn('[KiloBot] GitHub installation is unavailable for runtime use:', {
        repository: params.repository,
        platformIntegrationId: params.platformIntegrationId,
        reason: error.reason,
      });
      return 'installation_unavailable';
    }
    console.warn('[KiloBot] Failed to verify GitHub repository access:', {
      repository: params.repository,
      platformIntegrationId: params.platformIntegrationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 'transient';
  }

  const lookup = await lookupRepositoryPermission(permissionInput, params.fetchPermission);
  if (lookup.status === 'unreachable') {
    console.warn('[KiloBot] Could not reach GitHub to verify repository access:', {
      repository: params.repository,
      platformIntegrationId: params.platformIntegrationId,
      error: lookup.error,
    });
    return 'transient';
  }
  if (lookup.status === 'rate_limited') {
    console.warn('[KiloBot] GitHub rate limited the repository access check:', {
      repository: params.repository,
      platformIntegrationId: params.platformIntegrationId,
      error: lookup.error.message,
    });
    return 'rate_limited';
  }

  const { permission } = lookup;
  return permission === 'admin' || permission === 'maintain' || permission === 'write'
    ? 'allowed'
    : 'denied';
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

  const writeAccess = await hasRepositoryWriteAccess({
    installationId,
    appType: platformIntegration.github_app_type ?? 'standard',
    platformIntegrationId: platformIntegration.id,
    repository,
    username: actorLogin,
    fetchPermission: params.fetchPermission,
  });
  if (writeAccess === 'allowed') return { allowed: true };
  if (writeAccess === 'transient') {
    return { allowed: false, markdown: transientAccessRequiredMarkdown(repository) };
  }
  if (writeAccess === 'installation_unavailable') {
    return { allowed: false, markdown: installationUnavailableMarkdown(repository) };
  }
  if (writeAccess === 'rate_limited') {
    return { allowed: false, markdown: rateLimitedAccessRequiredMarkdown(repository) };
  }
  return notAllowed(repository);
}
