import type { OrganizationAlertType } from '@/lib/organizations/alerts/organization-alerts';
import { monthlySpendingAlertClientDefinition } from './monthly-spending/monthly-spending.definition.client';
import type { OrganizationAlertClientDefinition } from './types';

export const organizationAlertClientRegistry = {
  monthly_spending: monthlySpendingAlertClientDefinition,
} satisfies { [T in OrganizationAlertType]: OrganizationAlertClientDefinition<T> };

/** Every type a user may create today, in dropdown order. */
export const organizationAlertClientDefinitions = Object.values(organizationAlertClientRegistry);

/**
 * Widened registry lookup for the shared Alerts shell.
 *
 * Each entry is typed for its own discriminator, so indexing the registry with a
 * union-typed alert type would reduce the entry's definition and editor props to
 * `never`. Widening once here keeps every per-type definition strictly typed
 * while letting shared UI pass `OrganizationAlertDefinition` values. The registry
 * is keyed by the same discriminator its entries declare, so the widened pairing
 * always matches at runtime.
 */
export function organizationAlertDefinition(
  type: OrganizationAlertType
): OrganizationAlertClientDefinition<OrganizationAlertType> {
  return organizationAlertClientRegistry[
    type
  ] as OrganizationAlertClientDefinition<OrganizationAlertType>;
}
