import 'server-only';

import type {
  OrganizationGroupPolicy,
  OrganizationGroupPolicyOf,
  OrganizationGroupPolicyType,
} from '@/lib/organizations/group-policies/organization-group-policies';
import { normalizeModelAccessPolicy } from './model-access/model-access.server';

type PolicyServerRegistry = {
  [T in OrganizationGroupPolicyType]: {
    type: T;
    normalize: (policy: OrganizationGroupPolicyOf<T>) => OrganizationGroupPolicyOf<T>;
  };
};

export const organizationGroupPolicyServerRegistry = {
  model_access: {
    type: 'model_access',
    normalize: normalizeModelAccessPolicy,
  },
} satisfies PolicyServerRegistry;

export function normalizeRegisteredOrganizationGroupPolicy(
  policy: OrganizationGroupPolicy
): OrganizationGroupPolicy {
  switch (policy.type) {
    case 'model_access':
      return organizationGroupPolicyServerRegistry.model_access.normalize(policy);
  }
}
