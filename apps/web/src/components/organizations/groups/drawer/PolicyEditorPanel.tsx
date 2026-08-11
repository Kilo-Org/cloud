'use client';

import type { DrawerStackHelpers } from '@/components/drawer';
import type { OrganizationGroupPolicyType } from '@/lib/organizations/group-policies/organization-group-policies';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { organizationGroupPolicyDefinition } from '@/components/organizations/groups/policies/registry.client';
import type { OrganizationGroupPolicyTarget } from '@/components/organizations/groups/policies/types';
import { useTRPC } from '@/lib/trpc/utils';
import type { OrganizationGroupsDrawerRef } from './types';

const EMPTY_GROUP_ID = '00000000-0000-0000-0000-000000000000';

export function PolicyEditorPanel({
  organizationId,
  target,
  policyType,
  helpers,
}: {
  organizationId: string;
  target: OrganizationGroupPolicyTarget;
  policyType: OrganizationGroupPolicyType;
  helpers: DrawerStackHelpers<OrganizationGroupsDrawerRef>;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
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
  const groupMutation = useMutation(trpc.organizations.groups.setPolicy.mutationOptions());
  const defaultMutation = useMutation(trpc.organizations.groups.setDefaultPolicy.mutationOptions());
  const removeGroupMutation = useMutation(trpc.organizations.groups.removePolicy.mutationOptions());
  const removeDefaultMutation = useMutation(
    trpc.organizations.groups.removeDefaultPolicy.mutationOptions()
  );
  const definition = organizationGroupPolicyDefinition(policyType);
  const policies =
    target.kind === 'group' ? groupQuery.data?.group.policies : settingsQuery.data?.defaultPolicies;
  const activeQuery = target.kind === 'group' ? groupQuery : settingsQuery;
  const isRemoving = removeGroupMutation.isPending || removeDefaultMutation.isPending;

  async function invalidate() {
    await queryClient.invalidateQueries({ queryKey: trpc.organizations.groups.pathKey() });
  }

  async function remove() {
    try {
      if (target.kind === 'group')
        await removeGroupMutation.mutateAsync({
          organizationId,
          groupId: target.groupId,
          policyType,
        });
      else await removeDefaultMutation.mutateAsync({ organizationId, policyType });
      await invalidate();
      toast.success('Policy removed');
      helpers.pop();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to remove policy');
    }
  }

  if (activeQuery.isLoading) {
    return <p className="type-body text-muted-foreground p-5">Loading policy...</p>;
  }
  if (activeQuery.isError || !policies) {
    return (
      <p role="alert" className="type-body text-status-destructive p-5">
        Unable to load this policy.
      </p>
    );
  }
  const existing = policies.find(policy => policy.type === policyType);
  const policy = existing ?? definition.createInitialPolicy(target);
  const Editor = definition.Editor;

  return (
    <Editor
      organizationId={organizationId}
      target={target}
      policy={policy}
      isSaving={groupMutation.isPending || defaultMutation.isPending}
      onCancel={helpers.pop}
      // Only a persisted policy can be removed; adding one is cancelled instead.
      onDelete={existing ? remove : undefined}
      isDeleting={isRemoving}
      onSave={async nextPolicy => {
        try {
          if (target.kind === 'group')
            await groupMutation.mutateAsync({
              organizationId,
              groupId: target.groupId,
              policy: nextPolicy,
            });
          else await defaultMutation.mutateAsync({ organizationId, policy: nextPolicy });
          await invalidate();
          helpers.pop();
        } catch (error) {
          toast.error(error instanceof Error ? error.message : 'Failed to save policy');
        }
      }}
    />
  );
}
