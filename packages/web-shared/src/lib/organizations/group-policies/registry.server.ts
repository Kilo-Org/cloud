import 'server-only';

import type {
  OrganizationGroupPolicy,
  OrganizationGroupPolicyOf,
  OrganizationGroupPolicyType,
} from '@kilocode/web-shared/lib/organizations/group-policies/organization-group-policies';
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
  agent_permissions: {
    type: 'agent_permissions',
    normalize: policy => policy,
  },
  client_access: {
    type: 'client_access',
    normalize: policy => policy,
  },
} satisfies PolicyServerRegistry;

export function normalizeRegisteredOrganizationGroupPolicy(
  policy: OrganizationGroupPolicy
): OrganizationGroupPolicy {
  switch (policy.type) {
    case 'model_access':
      return organizationGroupPolicyServerRegistry.model_access.normalize(policy);
    case 'agent_permissions':
      return organizationGroupPolicyServerRegistry.agent_permissions.normalize(policy);
    case 'client_access':
      return organizationGroupPolicyServerRegistry.client_access.normalize(policy);
  }
}
