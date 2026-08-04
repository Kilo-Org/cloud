'use client';

import type { DrawerStackHelpers } from '@/components/drawer';
import type { OrganizationGroupPolicies } from '@/lib/organizations/group-policies/organization-group-policies';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Plus } from 'lucide-react';
import { organizationGroupPolicyDefinition } from '@/components/organizations/groups/policies/registry.client';
import type { OrganizationGroupPolicyTarget } from '@/components/organizations/groups/policies/types';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useTRPC } from '@/lib/trpc/utils';
import type { OrganizationGroupsDrawerRef } from './types';

const EMPTY_GROUP_ID = '00000000-0000-0000-0000-000000000000';

export function GroupPoliciesPanel({
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
  const policies: OrganizationGroupPolicies | undefined =
    target.kind === 'group' ? groupQuery.data?.group.policies : settingsQuery.data?.defaultPolicies;

  if (!policies)
    return (
      <div className="grid gap-3 p-5">
        <Skeleton className="h-14" />
        <Skeleton className="h-14" />
      </div>
    );
  return (
    <div className="grid gap-3 p-5">
      <p className="type-body text-muted-foreground">
        Applied to every direct member before their group policies are combined.
      </p>
      {policies.length === 0 ? (
        <p className="type-body text-muted-foreground rounded-lg border border-dashed px-4 py-3">
          No default policies yet.
        </p>
      ) : (
        <div className="divide-y overflow-hidden rounded-lg border">
          {policies.map(policy => {
            const definition = organizationGroupPolicyDefinition(policy.type);
            const ListItem = definition.ListItem;
            const Icon = definition.Icon;
            return (
              <button
                key={policy.type}
                className="flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-hover"
                onClick={() =>
                  helpers.push({ type: 'policy-editor', target, policyType: policy.type })
                }
              >
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <ListItem policy={policy} />
                <ChevronRight className="ml-auto size-4 shrink-0 text-muted-foreground" />
              </button>
            );
          })}
        </div>
      )}
      <Button
        variant="outline"
        className="w-fit"
        onClick={() => helpers.push({ type: 'policy-type-picker', target })}
      >
        <Plus className="size-4" />
        Add policy
      </Button>
    </div>
  );
}
