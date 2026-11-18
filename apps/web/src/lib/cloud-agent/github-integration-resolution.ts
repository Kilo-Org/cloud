import 'server-only';

import type { Owner } from '@/lib/integrations/core/types';
import { resolveGitHubRepositoryForOwner } from '@/lib/slack-bot/github-repository-context';

/**
 * The GitHub connection that owns one repository for this caller, or `null`
 * when the caller's connected installations cannot name exactly one.
 *
 * The runtime's repository preflight runs only when a prepare request names the
 * integration that must serve the repository. Resolving it here lets that
 * existing check refuse a repository the installation cannot reach with a
 * classified error, instead of the request failing later on an opaque provider
 * failure. Resolution is best effort: an unknown repository (not in any cached
 * inventory, or listed by two connections) adds no id and keeps the request's
 * previous behaviour.
 */
export async function resolveGitHubIntegrationIdForRepository(
  owner: Owner,
  repositoryFullName: string
): Promise<string | null> {
  try {
    const choice = await resolveGitHubRepositoryForOwner(owner, repositoryFullName, 'agent');
    return choice?.githubIntegrationId ?? null;
  } catch {
    // Enrichment must never fail a create on its own: a read failure here
    // leaves the request unqualified, which is what it was before.
    return null;
  }
}
