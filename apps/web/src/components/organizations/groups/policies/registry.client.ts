import type { OrganizationGroupPolicyType } from '@/lib/organizations/group-policies/organization-group-policies';
import type { OrganizationGroupPolicyClientDefinition } from './types';
import { modelAccessPolicyClientDefinition } from './model-access/model-access.definition.client';

export const organizationGroupPolicyClientRegistry = {
  model_access: modelAccessPolicyClientDefinition,
} satisfies {
  [T in OrganizationGroupPolicyType]: OrganizationGroupPolicyClientDefinition<T>;
};

export const organizationGroupPolicyClientDefinitions = Object.values(
  organizationGroupPolicyClientRegistry
);

/**
 * Widened registry lookup for shared drawer and page code.
 *
 * Each entry is typed for its own discriminator, so indexing the registry with a
 * union-typed policy type reduces the entry's policy props and callbacks to
 * `never`. Widening once here keeps every per-policy definition strictly typed
 * while letting shared UI pass `OrganizationGroupPolicy` values. The registry is
 * keyed by the same discriminator its entries declare, so the widened pairing
 * always matches at runtime.
 */
export function organizationGroupPolicyDefinition(
  policyType: OrganizationGroupPolicyType
): OrganizationGroupPolicyClientDefinition<OrganizationGroupPolicyType> {
  return organizationGroupPolicyClientRegistry[
    policyType
  ] as OrganizationGroupPolicyClientDefinition<OrganizationGroupPolicyType>;
}
