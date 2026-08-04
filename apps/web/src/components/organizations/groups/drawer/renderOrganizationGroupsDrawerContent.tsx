import type { DrawerRenderResult, DrawerStackHelpers } from '@/components/drawer';
import { GroupDetailsPanel } from './GroupDetailsPanel';
import { GroupPoliciesPanel } from './GroupPoliciesPanel';
import { PolicyEditorPanel } from './PolicyEditorPanel';
import { PolicyTypePickerPanel } from './PolicyTypePickerPanel';
import type { OrganizationGroupsDrawerRef } from './types';
import { organizationGroupPolicyClientRegistry } from '@/components/organizations/groups/policies/registry.client';

export function renderOrganizationGroupsDrawerContent(
  organizationId: string,
  entry: OrganizationGroupsDrawerRef,
  helpers: DrawerStackHelpers<OrganizationGroupsDrawerRef>
): DrawerRenderResult {
  switch (entry.type) {
    case 'group-details':
      return {
        header: (
          <h2 className="type-body font-medium">
            {entry.mode === 'create' ? 'Create group' : 'Group details'}
          </h2>
        ),
        body: <GroupDetailsPanel organizationId={organizationId} entry={entry} helpers={helpers} />,
      };
    case 'policy-list':
      return {
        header: (
          <h2 className="type-body font-medium">
            {entry.target.kind === 'default' ? 'Default policies' : 'Group policies'}
          </h2>
        ),
        body: (
          <GroupPoliciesPanel
            organizationId={organizationId}
            target={entry.target}
            helpers={helpers}
          />
        ),
      };
    case 'policy-type-picker':
      return {
        header: <h2 className="type-body font-medium">Add policy</h2>,
        body: (
          <PolicyTypePickerPanel
            organizationId={organizationId}
            target={entry.target}
            helpers={helpers}
          />
        ),
      };
    case 'policy-editor': {
      const definition = organizationGroupPolicyClientRegistry[entry.policyType];
      const Icon = definition.Icon;
      return {
        header: (
          <h2 className="type-body flex min-w-0 items-center gap-2 font-medium">
            <Icon className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{definition.label} policy</span>
          </h2>
        ),
        body: (
          <PolicyEditorPanel
            organizationId={organizationId}
            target={entry.target}
            policyType={entry.policyType}
            helpers={helpers}
          />
        ),
      };
    }
  }
}
