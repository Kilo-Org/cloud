import * as z from 'zod';

/**
 * Whether an organization-scoped screen may render the organization's own
 * data. A lost membership and a denied request are the same state for the
 * reader: the organization exists (or existed) but this account may not see
 * it, so a first-run or empty screen would be a false statement.
 *
 * `granted` is also the answer while the membership list is still unknown: a
 * load failure of that list is not evidence of lost access, and the product
 * queries still get their own chance to report a denial.
 */
export type OrganizationScopeAccess = 'granted' | 'denied' | 'not-found';

const DENIAL_CODES = new Set(['UNAUTHORIZED', 'FORBIDDEN']);

// A query error is a `TRPCClientErrorLike` (whose `data` is nullable and may
// carry no code) or a plain `Error`; parse the envelope instead of assuming it.
const QueryErrorShape = z.looseObject({
  data: z.looseObject({ code: z.string() }).nullish(),
});

/** The tRPC error code of a query error, or `undefined` when it carries none. */
function errorCode(error: unknown): string | undefined {
  const parsed = QueryErrorShape.safeParse(error);
  return parsed.success ? parsed.data.data?.code : undefined;
}

export function classifyOrganizationScopeAccess({
  organizationId,
  membershipIds,
  errors,
}: {
  /** The organization scope being rendered; `undefined` for the personal scope. */
  organizationId: string | undefined;
  /** Ids from the loaded membership list, `undefined` until that list settles. */
  membershipIds: readonly string[] | undefined;
  /** Errors of the queries that carry organization-scoped data. */
  errors: readonly unknown[];
}): OrganizationScopeAccess {
  if (organizationId === undefined) {
    return 'granted';
  }
  // Read the code from every error, not from each query's `isError`: a query
  // that already has cached data keeps that data beside a failed refetch, and a
  // denial must override it.
  const codes = errors.map(error => errorCode(error));
  if (codes.some(code => code !== undefined && DENIAL_CODES.has(code))) {
    return 'denied';
  }
  if (codes.includes('NOT_FOUND')) {
    return 'not-found';
  }
  if (membershipIds === undefined) {
    return 'granted';
  }
  return membershipIds.includes(organizationId) ? 'granted' : 'denied';
}
