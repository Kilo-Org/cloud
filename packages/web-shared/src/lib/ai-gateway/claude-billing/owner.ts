import type { ClaudeBillingConnectionRow } from '@kilocode/db/schema';

/**
 * Who a Claude billing connection belongs to: one person's own account, or one
 * organization, whose connection serves every request made in it. A request
 * uses only the connection of the owner it runs for.
 */
export type ClaudeBillingOwner =
  | { kind: 'personal'; kiloUserId: string }
  | { kind: 'organization'; organizationId: string };

/**
 * The owner columns of a connection: a personal connection names the user id,
 * an organization connection the organization id, and neither names both.
 */
export type ClaudeBillingOwnerColumns = Pick<
  ClaudeBillingConnectionRow,
  'kilo_user_id' | 'organization_id'
>;

/**
 * Whether a connection belongs to an owner, which is the predicate
 * `claudeBillingOwnerWhere` applies in the database. The local read uses it on a
 * row it selected and the cross-region read uses it on the row another
 * deployment answers with, which may omit a column, so the columns are partial.
 * Both reads bind a connection to the same owner.
 *
 * The organization identifiers compare without case, because a UUID column
 * compares by value and a request may name the organization in any case.
 */
export function claudeBillingOwnerMatches(
  columns: Partial<ClaudeBillingOwnerColumns>,
  owner: ClaudeBillingOwner
): boolean {
  const organizationId = columns.organization_id?.toLowerCase();
  switch (owner.kind) {
    case 'personal':
      return columns.kilo_user_id === owner.kiloUserId && organizationId == null;
    case 'organization':
      return organizationId === owner.organizationId.toLowerCase() && columns.kilo_user_id == null;
  }
}
