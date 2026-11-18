// Whether the PR inbox may render the selected organization's rows.
//
// A lost organization (the membership removed, or the organization deleted)
// denies the scope's own reads, and the denial outranks whatever the providers
// report: a refused status read otherwise looks like nothing is connected, and a
// refused inbox page like a transient outage whose Retry can never succeed.
//
// The organization status reads carry the whole verdict. Each runs
// `ensureOrganizationAccess` as its first statement and nothing else about it
// can deny, so a FORBIDDEN / UNAUTHORIZED / NOT_FOUND there is the
// organization's own access outcome (the last one its deletion). A refused inbox
// page adds the same denial when the status queries still hold their cached
// answer, but only its procedure-level UNAUTHORIZED counts: the provider layers
// turn their own credential and role refusals into PRECONDITION_FAILED or
// FORBIDDEN, while the access guard's refusal arrives exactly as that
// UNAUTHORIZED.
//
// Pure so the whole matrix runs without mounting the inbox.

import {
  classifyOrganizationScopeAccess,
  type OrganizationScopeAccess,
} from '@/lib/organization-scope-access';
import { isPermissionDeniedError, readTrpcErrorField } from '@/lib/trpc-error';

export function classifyInboxOrganizationScopeAccess(args: {
  /** The selected scope; null is the personal scope, which has no membership. */
  organizationId: string | null;
  /** Errors of the organization's own status reads (the scope's gate). */
  statusErrors: readonly unknown[];
  /** Errors of the organization-scoped inbox pages. */
  inboxErrors: readonly unknown[];
}): OrganizationScopeAccess {
  const statusAccess = classifyOrganizationScopeAccess({
    isOrganizationScope: args.organizationId !== null,
    errors: args.statusErrors,
  });
  if (statusAccess !== 'granted' || args.organizationId === null) {
    return statusAccess;
  }
  const inboxDenied = args.inboxErrors.some(
    error => readTrpcErrorField(error, 'code') === 'UNAUTHORIZED' && isPermissionDeniedError(error)
  );
  return inboxDenied ? 'denied' : 'granted';
}
