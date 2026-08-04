import type { OrganizationGroupPolicyType } from '@/lib/organizations/group-policies/organization-group-policies';
import type { OrganizationGroupPolicyTarget } from '@/components/organizations/groups/policies/types';

export type OrganizationGroupsDrawerRef =
  | { type: 'group-details'; mode: 'create' }
  | { type: 'group-details'; mode: 'edit'; groupId: string }
  | { type: 'policy-list'; target: OrganizationGroupPolicyTarget }
  | { type: 'policy-type-picker'; target: OrganizationGroupPolicyTarget }
  | {
      type: 'policy-editor';
      target: OrganizationGroupPolicyTarget;
      policyType: OrganizationGroupPolicyType;
    };
