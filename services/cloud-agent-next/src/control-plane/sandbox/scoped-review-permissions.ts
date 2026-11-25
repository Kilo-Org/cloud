import { reviewCapabilityPrefix } from '@kilocode/worker-utils/scm-capability-contract';
import { scopedReviewPermissions } from '../../session/command-guard.js';
import type { RouteRecord } from './routes.js';

/** Route reads resolve the current persisted grant. Keep the stored restrictive
 * policy for legacy registrations, expired grants and previous allocations. */
export function activeReviewPermissions(
  route: Pick<RouteRecord, 'spec' | 'credentialSource' | 'grant'>,
  allocation: string | null,
  now: number
) {
  const { spec, grant, credentialSource: source } = route;
  const reviewId = source?.reviewId;
  if (
    !reviewId ||
    source.createdOnPlatform !== 'code-review' ||
    !grant?.review ||
    grant.review.reviewId !== reviewId ||
    grant.review.sessionId !== spec.sessionId ||
    grant.directory !== spec.directory ||
    !allocation ||
    grant.outboundContainerId !== allocation ||
    grant.preparedAt > now ||
    grant.expiresAt <= now ||
    !grant.scm ||
    grant.scm.purpose !== spec.git?.platform ||
    grant.scm.alias !== spec.git.token
  )
    return undefined;
  const entries = [grant.scm, ...(grant.additionalRepositories ?? []).map(member => member.scm)];
  if (
    entries.some(
      ({ purpose, capability }) =>
        !capability ||
        capability.outboundContainerId !== allocation ||
        capability.issuedAt > now ||
        capability.expiresAt <= now ||
        !capability.credential.startsWith(reviewCapabilityPrefix(purpose))
    )
  )
    return undefined;
  return scopedReviewPermissions(grant.scm.purpose, spec.directory, reviewId);
}
