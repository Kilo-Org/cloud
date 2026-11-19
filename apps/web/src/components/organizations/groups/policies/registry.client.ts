import type {
  EditableOrganizationGroupPolicyType,
  OrganizationGroupPolicyClientDefinition,
} from './types';
import { modelAccessPolicyClientDefinition } from './model-access/model-access.definition.client';

export const organizationGroupPolicyClientRegistry = {
  model_access: modelAccessPolicyClientDefinition,
} satisfies {
  [T in EditableOrganizationGroupPolicyType]: OrganizationGroupPolicyClientDefinition<T>;
};

export const organizationGroupPolicyClientDefinitions = Object.values(
  organizationGroupPolicyClientRegistry
);

export function organizationGroupPolicyDefinition(policyType: EditableOrganizationGroupPolicyType) {
  return organizationGroupPolicyClientRegistry[policyType];
}
