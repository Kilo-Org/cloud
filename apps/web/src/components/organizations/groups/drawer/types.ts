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
      type: 'named-policy-assignments';
      scope: { type: 'default' } | { type: 'group'; groupId: string };
      appliesTo: string;
      canEdit: boolean;
    }
  | { type: 'named-policy-library' }
  | {
      type: 'named-policy-editor';
      policyId: string | null;
      defaultKind: 'agent_permissions' | 'client_configuration';
    }
  | { type: 'permission-policy-diagnostics' }
  | {
      type: 'policy-editor';
      target: OrganizationGroupPolicyTarget;
      policyType: EditableOrganizationGroupPolicyType;
    };
