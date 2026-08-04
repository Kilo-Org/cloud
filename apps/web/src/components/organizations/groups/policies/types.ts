import type {
  OrganizationGroupPolicy,
  OrganizationGroupPolicyOf,
  OrganizationGroupPolicyType,
} from '@/lib/organizations/group-policies/organization-group-policies';
import type { LucideIcon } from 'lucide-react';
import type { ComponentType } from 'react';

export type OrganizationGroupPolicyTarget =
  | { kind: 'group'; groupId: string }
  | { kind: 'default' };

export type OrganizationGroupPolicyEditorProps<T extends OrganizationGroupPolicyType> = {
  organizationId: string;
  policy: OrganizationGroupPolicyOf<T>;
  isSaving: boolean;
  onSave: (policy: OrganizationGroupPolicyOf<T>) => void;
  onCancel: () => void;
  /**
   * Removes the persisted policy. Omitted while adding a policy that has not
   * been persisted yet, and expected to report its own failures.
   */
  onDelete?: () => Promise<void> | void;
  isDeleting?: boolean;
};

export type OrganizationGroupPolicyListItemProps<T extends OrganizationGroupPolicyType> = {
  policy: OrganizationGroupPolicyOf<T>;
};

export type OrganizationGroupPolicyClientDefinition<T extends OrganizationGroupPolicyType> = {
  type: T;
  label: string;
  description: string;
  /** Matches the icon the policy's own product surface uses in navigation. */
  Icon: LucideIcon;
  summarize: (policy: OrganizationGroupPolicyOf<T>) => string;
  createInitialPolicy: (target: OrganizationGroupPolicyTarget) => OrganizationGroupPolicyOf<T>;
  ListItem: ComponentType<OrganizationGroupPolicyListItemProps<T>>;
  Editor: ComponentType<OrganizationGroupPolicyEditorProps<T>>;
};

export type AnyOrganizationGroupPolicyClientDefinition = {
  [T in OrganizationGroupPolicyType]: OrganizationGroupPolicyClientDefinition<T>;
}[OrganizationGroupPolicyType];

export function policyMatchesType<T extends OrganizationGroupPolicyType>(
  policy: OrganizationGroupPolicy,
  type: T
): policy is OrganizationGroupPolicyOf<T> {
  return policy.type === type;
}
