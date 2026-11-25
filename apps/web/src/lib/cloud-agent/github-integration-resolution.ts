import 'server-only';

import type { Owner } from '@/lib/integrations/core/types';
import { resolveGitHubRepositoryForOwner } from '@/lib/slack-bot/github-repository-context';

/**
 * The GitHub connection that owns one repository for this caller, or `null`
 * when the caller's connected installations cannot name exactly one.
 *
 * A prepare request that names this integration makes the runtime's repository
 * preflight check that exact integration, and lets an `agent_only` connection
 * serve an `agent` request. Without an id, the preflight checks the repository
 * across the caller's connections. Resolution is best effort: an unknown
 * repository (not in any cached inventory, or listed by two connections) adds
 * no id.
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
