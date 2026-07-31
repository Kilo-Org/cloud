'use client';

import type { DrawerStackHelpers } from '@/components/drawer';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { organizationGroupPolicyClientDefinitions } from '@/components/organizations/groups/policies/registry.client';
import type { OrganizationGroupPolicyTarget } from '@/components/organizations/groups/policies/types';
import { useTRPC } from '@/lib/trpc/utils';
import type { OrganizationGroupsDrawerRef } from './types';

const EMPTY_GROUP_ID = '00000000-0000-0000-0000-000000000000';

export function PolicyTypePickerPanel({
  organizationId,
  target,
  helpers,
}: {
  organizationId: string;
  target: OrganizationGroupPolicyTarget;
  helpers: DrawerStackHelpers<OrganizationGroupsDrawerRef>;
}) {
  const trpc = useTRPC();
  const groupQuery = useQuery({
    ...trpc.organizations.groups.get.queryOptions({
      organizationId,
      groupId: target.kind === 'group' ? target.groupId : EMPTY_GROUP_ID,
    }),
    enabled: target.kind === 'group',
  });
  const settingsQuery = useQuery({
    ...trpc.organizations.groups.getPolicySettings.queryOptions({ organizationId }),
    enabled: target.kind === 'default',
  });
  const existingTypes = new Set(
    (target.kind === 'group'
      ? groupQuery.data?.group.policies
      : settingsQuery.data?.defaultPolicies
    )?.map(policy => policy.type) ?? []
  );
  const activeQuery = target.kind === 'group' ? groupQuery : settingsQuery;
  if (activeQuery.isLoading) {
    return <p className="type-body text-muted-foreground p-5">Loading policies...</p>;
  }
  if (activeQuery.isError || !activeQuery.data) {
    return (
      <p role="alert" className="type-body text-status-destructive p-5">
        Unable to load policies.
      </p>
    );
  }
  const available = organizationGroupPolicyClientDefinitions.filter(
    definition => !existingTypes.has(definition.type)
  );
  return (
    <div className="grid gap-3 p-5">
      <p className="type-body text-muted-foreground">Each policy type can be added once.</p>
      <div className="divide-y overflow-hidden rounded-lg border">
        {available.length === 0 ? (
          <p className="type-body text-muted-foreground p-4 text-center">
            All available policy types are already configured.
          </p>
        ) : (
          available.map(definition => {
            const Icon = definition.Icon;
            return (
              <button
                key={definition.type}
                className="flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left hover:bg-surface-hover"
                onClick={() =>
                  helpers.replace({ type: 'policy-editor', target, policyType: definition.type })
                }
              >
                <Icon className="size-5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="type-body block font-medium">{definition.label}</span>
                  <span className="type-label text-muted-foreground block">
                    {definition.description}
                  </span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
