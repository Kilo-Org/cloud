import type {
  EditableOrganizationGroupPolicyType,
  OrganizationGroupPolicyTarget,
} from '@/components/organizations/groups/policies/types';

export type OrganizationGroupsDrawerRef =
  | { type: 'group-details'; mode: 'create' }
  | { type: 'group-details'; mode: 'edit'; groupId: string }
  | { type: 'policy-list'; target: OrganizationGroupPolicyTarget }
  | { type: 'policy-type-picker'; target: OrganizationGroupPolicyTarget }
  | {
      type: 'permission-policies';
      target: OrganizationGroupPolicyTarget;
      appliesTo: string;
      canEdit: boolean;
    }
  | {
      type: 'permission-policy-editor';
      target: OrganizationGroupPolicyTarget;
      appliesTo: string;
      canEdit: boolean;
      policyType: 'agent_permissions' | 'client_access';
    }
  | { type: 'permission-policy-diagnostics' }
  | {
      type: 'policy-editor';
      target: OrganizationGroupPolicyTarget;
      policyType: EditableOrganizationGroupPolicyType;
    };
