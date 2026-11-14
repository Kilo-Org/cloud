import type { ClaudeBillingConnectionRow } from '@kilocode/db/schema';

/**
 * Who a Claude billing connection belongs to: the person's personal account,
 * the person's own requests in one organization, or the organization's shared
 * services. A request uses only the connection of the owner it runs for.
 */
export type ClaudeBillingOwner =
  | { kind: 'personal'; kiloUserId: string }
  | { kind: 'member'; kiloUserId: string; organizationId: string }
  | { kind: 'shared_services'; organizationId: string };

/**
 * The owner columns of a connection. The cross-region read applies the
 * predicate to a wire answer that may omit a column, so a column can be absent.
 */
type ClaudeBillingOwnerColumns = Partial<
  Pick<ClaudeBillingConnectionRow, 'kilo_user_id' | 'organization_id'>
>;

/**
 * Whether a connection belongs to an owner, which is the predicate
 * `claudeBillingOwnerWhere` applies in the database. The local read uses it on a
 * row it selected and the cross-region read uses it on the row another
 * deployment answers with, so both reads bind a connection to the same owner.
 * A personal connection may omit the organization column.
 *
 * The organization identifiers compare without case, because a UUID column
 * compares by value and a request may name the organization in any case.
 */
export function claudeBillingOwnerMatches(
  columns: ClaudeBillingOwnerColumns,
  owner: ClaudeBillingOwner
): boolean {
  const organizationId = columns.organization_id?.toLowerCase();
  switch (owner.kind) {
    case 'personal':
      return columns.kilo_user_id === owner.kiloUserId && organizationId == null;
    case 'member':
      return (
        columns.kilo_user_id === owner.kiloUserId &&
        organizationId === owner.organizationId.toLowerCase()
      );
    case 'shared_services':
      return organizationId === owner.organizationId.toLowerCase() && columns.kilo_user_id == null;
  }
}
