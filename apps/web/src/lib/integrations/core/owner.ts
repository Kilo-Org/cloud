import type { Owner } from './types';

type OwnerColumns = {
  owned_by_organization_id: string | null;
  owned_by_user_id: string | null;
};

/**
 * Narrow a row's XOR `owned_by_organization_id` / `owned_by_user_id` columns
 * into a discriminated `Owner`. The DB schema enforces that exactly one of
 * the two columns is non-null (see the `*_owner_check` CHECK constraints).
 */
export function ownerFromIntegration(row: OwnerColumns): Owner {
  if (row.owned_by_organization_id) return { type: 'org', id: row.owned_by_organization_id };
  return { type: 'user', id: row.owned_by_user_id as string };
}
