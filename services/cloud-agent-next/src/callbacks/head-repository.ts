import type { SessionMetadata } from '../persistence/session-metadata.js';

/**
 * A session has exactly one git remote, derived from its own repository, so that repository is
 * where `lastSeenBranch` was pushed. A receiver that opens a pull request needs it separately from
 * the base repository: GitHub resolves a bare head inside the base repository, which silently
 * targets the wrong branch when the two differ. Only GitHub is addressable by `owner/repo`.
 */
export function callbackHeadRepoFullName(metadata?: SessionMetadata | null): string | undefined {
  const repository = metadata?.repository;
  return repository?.type === 'github' ? repository.repo : undefined;
}
