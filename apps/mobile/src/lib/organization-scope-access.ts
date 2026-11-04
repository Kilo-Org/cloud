import { isPermissionDeniedError, readTrpcErrorField } from '@/lib/trpc-error';

/**
 * Whether an organization-scoped screen may render the organization's own
 * data. A denied request is the only evidence that access is gone: the server
 * decides access from more than the membership list (a Kilo admin reaches any
 * organization, and a parent owner, admin or billing manager reaches each child
 * organization), so absence from the client's list is not proof of lost access.
 *
 * `granted` is also the answer while the scope's queries are still in flight or
 * failed for an unrelated reason; the caller keeps its own loading and
 * retryable-error states.
 */
export type OrganizationScopeAccess = 'granted' | 'denied' | 'not-found';

export function classifyOrganizationScopeAccess({
  isOrganizationScope,
  errors,
}: {
  /** False for a personal scope, which has no membership to lose. */
  isOrganizationScope: boolean;
  /** Errors of the queries that carry the scope's own data. */
  errors: readonly unknown[];
}): OrganizationScopeAccess {
  if (!isOrganizationScope) {
    return 'granted';
  }
  // Read every query's error, not its `isError`: a query that still holds
  // cached data keeps that data beside a failed refetch, and a denial must
  // override it.
  if (errors.some(error => isPermissionDeniedError(error))) {
    return 'denied';
  }
  if (errors.some(error => readTrpcErrorField(error, 'code') === 'NOT_FOUND')) {
    return 'not-found';
  }
  return 'granted';
}
