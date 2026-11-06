/**
 * The GitLab project scope one connection may act inside.
 *
 * The integration's cached repository set is the authorization scope for a
 * project-scoped read: a caller-supplied path qualifies only when it is one of
 * the cached full paths. This module holds that one rule so every GitLab
 * surface — the review layer's `authorizeProject` and the integration service's
 * branch listing — matches and refuses in the same words.
 *
 * It sits here, below both callers, so `gitlab-service` never imports the
 * review layer that imports it back.
 *
 * A catalogue that cannot be read (non-numeric provider ids) yields no
 * repositories, so an unreadable cache refuses: fail-closed, never widened.
 */
import 'server-only';

import type { PlatformIntegration } from '@kilocode/db/schema';
import type { PlatformRepository } from '@/lib/integrations/core/types';
import { requireNumericPlatformRepositories } from '@/lib/integrations/core/types';

/** The fixed refusal copy: names the one remedy that restores the scope. */
export const GITLAB_PROJECT_NOT_IN_CACHE_MESSAGE =
  'This project is not in your connected GitLab repositories. Refresh the repository list on the GitLab integration and try again.';

/**
 * The integration's cached repository set, read before any credential is
 * released. A catalogue that cannot be read (non-numeric provider ids) yields
 * no repositories, so neither the match below nor a workspace-wide read
 * widens past the cache.
 */
export function readCachedGitLabRepositories(
  integration: PlatformIntegration
): PlatformRepository[] {
  try {
    return requireNumericPlatformRepositories(integration.repositories) ?? [];
  } catch {
    return [];
  }
}

/**
 * The cached repository for the requested project path, or null when the
 * connection's cache does not contain it. The match is the case-insensitive
 * exact full-path compare of validateGitLabRepoAccessForUser/Organization
 * (gitlab-integration-helpers.ts:219-259): nested `group/sub/repo` must match
 * end-to-end, and `group/repo` never matches a cached `group/sub/repo`.
 */
export function matchCachedGitLabProject(
  integration: PlatformIntegration,
  projectPath: string
): PlatformRepository | null {
  // Trimmed of leading/trailing slashes, matching every caller-side cleanup.
  const requested = projectPath.trim().replace(/^\/+|\/+$/g, '');
  if (requested.length === 0) return null;
  return (
    readCachedGitLabRepositories(integration).find(
      repo => repo.full_name.toLowerCase() === requested.toLowerCase()
    ) ?? null
  );
}
