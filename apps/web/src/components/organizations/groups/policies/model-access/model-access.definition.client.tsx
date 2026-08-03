'use client';

import {
  DEFAULT_GROUP_MODEL_ACCESS_POLICY,
  DEFAULT_ORGANIZATION_MODEL_ACCESS_POLICY,
} from '@/lib/organizations/group-policies/organization-group-policies';
import { Layers } from 'lucide-react';
import type { OrganizationGroupPolicyClientDefinition } from '@/components/organizations/groups/policies/types';
import { ModelAccessPolicyEditor } from './ModelAccessPolicyEditor';
import { ModelAccessPolicyListItem, summarizeModelAccessPolicy } from './ModelAccessPolicyListItem';

export const modelAccessPolicyClientDefinition = {
  type: 'model_access',
  label: 'Model access',
  description: 'Grant all, none, or selected models and providers to members.',
  // Matches the organization "Model Access" navigation icon.
  Icon: Layers,
  summarize: summarizeModelAccessPolicy,
  createInitialPolicy(target) {
    return target.kind === 'default'
      ? DEFAULT_ORGANIZATION_MODEL_ACCESS_POLICY
      : DEFAULT_GROUP_MODEL_ACCESS_POLICY;
  },
  ListItem: ModelAccessPolicyListItem,
  Editor: ModelAccessPolicyEditor,
} satisfies OrganizationGroupPolicyClientDefinition<'model_access'>;
