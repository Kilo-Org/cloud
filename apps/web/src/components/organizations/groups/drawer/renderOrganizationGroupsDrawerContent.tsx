import type { DrawerRenderResult, DrawerStackHelpers } from '@/components/drawer';
import { GroupDetailsPanel } from './GroupDetailsPanel';
import { GroupPoliciesPanel } from './GroupPoliciesPanel';
import { PolicyEditorPanel } from './PolicyEditorPanel';
import { PolicyTypePickerPanel } from './PolicyTypePickerPanel';
import type { OrganizationGroupsDrawerRef } from './types';
import { organizationGroupPolicyClientRegistry } from '@/components/organizations/groups/policies/registry.client';
import {
  NamedPolicyAssignmentsPanel,
  NamedPolicyEditorPanel,
  NamedPolicyLibraryPanel,
} from '../policies/permission-policy/NamedPolicyPanels';
import { PermissionPolicyDiagnostics } from '../policies/permission-policy/PermissionPolicyDiagnostics';

export function renderOrganizationGroupsDrawerContent(
  organizationId: string,
  entry: OrganizationGroupsDrawerRef,
  helpers: DrawerStackHelpers<OrganizationGroupsDrawerRef>
): DrawerRenderResult {
  switch (entry.type) {
    case 'named-policy-assignments':
      return {
        header: <h2 className="type-body font-medium">Group Defaults</h2>,
        body: (
          <NamedPolicyAssignmentsPanel
            organizationId={organizationId}
            scope={entry.scope}
            appliesTo={entry.appliesTo}
            canEdit={entry.canEdit}
            helpers={helpers}
          />
        ),
      };
    case 'named-policy-library':
      return {
        header: <h2 className="type-body font-medium">Policies</h2>,
        body: (
          <NamedPolicyLibraryPanel
            organizationId={organizationId}
            canManage={entry.canManage}
            helpers={helpers}
          />
        ),
      };
    case 'named-policy-editor':
      return {
        header: (
          <h2 className="type-body font-medium">{entry.policyId ? 'Edit policy' : 'New policy'}</h2>
        ),
        body: (
          <NamedPolicyEditorPanel
            organizationId={organizationId}
            policyId={entry.policyId}
            defaultKind={entry.defaultKind}
            onClose={helpers.pop}
          />
        ),
      };
    case 'permission-policy-diagnostics':
      return {
        header: <h2 className="type-body font-medium">Effective member policy</h2>,
        body: <PermissionPolicyDiagnostics organizationId={organizationId} />,
      };
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
