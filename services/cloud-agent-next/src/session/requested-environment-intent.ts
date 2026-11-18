import { normalizeRepoFullName } from '@kilocode/cloud-agent-profile';
import type { SessionCreateRequest } from './session-requests.js';

type RequestedEnvironment = NonNullable<SessionCreateRequest['requestedEnvironment']>;

/**
 * The environment selection as the create-intent fingerprint hashes it. The
 * server matches additional repositories by normalized name and ignores their
 * order, so two clients that send the same selection differently must hash the
 * same: entries are normalized and sorted, and an empty list is dropped.
 */
export function canonicalRequestedEnvironment(
  requested: RequestedEnvironment | undefined
): RequestedEnvironment | undefined {
  if (requested === undefined) return undefined;
  const entries = (requested.repositories ?? [])
    .map(entry => ({ ...entry, repoFullName: normalizeRepoFullName(entry.repoFullName) }))
    .sort((left, right) =>
      left.repoFullName < right.repoFullName ? -1 : left.repoFullName > right.repoFullName ? 1 : 0
    );
  return entries.length === 0 ? { id: requested.id } : { id: requested.id, repositories: entries };
}
