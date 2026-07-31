'use client';

import type { OrganizationRole } from '@/lib/organizations/organization-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, ShieldCheck, Trash2, UsersRound } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  OrganizationGroupsDrawerStackProvider,
  useOrganizationGroupsDrawerStack,
} from '@/components/organizations/groups/drawer/OrganizationGroupsDrawerStack';
import { organizationGroupPolicyDefinition } from '@/components/organizations/groups/policies/registry.client';
import { OrganizationPageHeader } from '@/components/organizations/OrganizationPageHeader';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useTRPC } from '@/lib/trpc/utils';

function GroupsPageContent({
  organizationId,
  role,
}: {
  organizationId: string;
  role: OrganizationRole;
}) {
  const trpc = useTRPC();
  const drawer = useOrganizationGroupsDrawerStack();
  const queryClient = useQueryClient();
  const [groupSearch, setGroupSearch] = useState('');
  const canManage = role === 'owner';
  const canViewSettings = role === 'owner' || role === 'billing_manager';
  const groupsQuery = useQuery(trpc.organizations.groups.list.queryOptions({ organizationId }));
  const settingsQuery = useQuery({
    ...trpc.organizations.groups.getPolicySettings.queryOptions({ organizationId }),
    enabled: canViewSettings,
  });
  async function invalidate() {
    await queryClient.invalidateQueries({ queryKey: trpc.organizations.groups.pathKey() });
  }

  const deleteMutation = useMutation(
    trpc.organizations.groups.delete.mutationOptions({
      onSuccess: () => {
        toast.success('Group deleted');
        void invalidate();
      },
      onError: error => toast.error(error.message || 'Failed to delete group'),
    })
  );

  const managerGroups = groupsQuery.data?.access === 'manager' ? groupsQuery.data.groups : [];
  const memberGroups = groupsQuery.data?.access === 'member' ? groupsQuery.data.groups : [];
  const visibleManagerGroups = managerGroups.filter(group =>
    `${group.name} ${group.description ?? ''}`.toLowerCase().includes(groupSearch.toLowerCase())
  );
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="grid gap-2">
          <OrganizationPageHeader organizationId={organizationId} title="Groups" />
          <p className="type-body text-muted-foreground">
            Organize members and compose policies without creating sub-organizations.
          </p>
        </div>
        {canManage && (
          <Button onClick={() => drawer.open({ type: 'group-details', mode: 'create' })}>
            <Plus className="size-4" />
            Create group
          </Button>
        )}
      </div>

      {canViewSettings && (
        <Card>
          <CardHeader>
            <CardTitle>Group policies</CardTitle>
            <CardDescription>
              Configure organization defaults, then add independent policies to each group.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="type-body font-medium">Default policies</p>
                <p className="type-label text-muted-foreground">
                  Applied to every direct member before their group policies are combined.
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {settingsQuery.data?.defaultPolicies.map(policy => {
                    const definition = organizationGroupPolicyDefinition(policy.type);
                    return (
                      <Badge key={policy.type} variant="outline">
                        {definition.label}: {definition.summarize(policy)}
                      </Badge>
                    );
                  })}
                </div>
              </div>
              <Button
                variant="outline"
                disabled={!canManage}
                onClick={() => drawer.open({ type: 'policy-list', target: { kind: 'default' } })}
              >
                <ShieldCheck className="size-4" />
                Manage defaults
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {groupsQuery.isLoading ? (
        <div className="grid gap-3">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      ) : groupsQuery.isError ? (
        <p role="alert" className="type-body text-status-destructive">
          {groupsQuery.error.message}
        </p>
      ) : groupsQuery.data?.access === 'member' ? (
        <Card>
          <CardHeader>
            <CardTitle>Your groups</CardTitle>
            <CardDescription>
              Your group memberships determine which policies apply to you.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {memberGroups.length === 0 ? (
              <p className="type-body text-muted-foreground">You are not assigned to any groups.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {memberGroups.map(group => (
                  <Badge key={group.id} variant="outline">
                    {group.name}
                  </Badge>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          <Input
            value={groupSearch}
            onChange={event => setGroupSearch(event.target.value)}
            placeholder="Search groups"
            aria-label="Search groups"
            className="sm:max-w-xs"
          />
          <div className="overflow-hidden rounded-xl border bg-surface-raised">
            {managerGroups.length === 0 ? (
              <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
                <UsersRound className="size-8 text-muted-foreground" />
                <div>
                  <p className="type-heading">No groups yet</p>
                  <p className="type-body text-muted-foreground">
                    Create a group, then add members and policies.
                  </p>
                </div>
              </div>
            ) : visibleManagerGroups.length === 0 ? (
              <p className="type-body text-muted-foreground px-4 py-8 text-center">
                No groups match your search.
              </p>
            ) : (
              visibleManagerGroups.map(group => (
                <div
                  key={group.id}
                  className="group/row flex min-h-14 items-center gap-3 border-b px-4 py-2.5 last:border-b-0 hover:bg-surface-hover"
                >
                  <button
                    className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 text-left disabled:cursor-default"
                    disabled={!canManage}
                    onClick={() =>
                      drawer.open({ type: 'group-details', mode: 'edit', groupId: group.id })
                    }
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="type-body font-medium">{group.name}</span>
                      <Badge variant="outline">
                        {group.memberIds.length}{' '}
                        {group.memberIds.length === 1 ? 'member' : 'members'}
                      </Badge>
                      {group.policies.length > 0 && (
                        <Badge variant="outline">
                          {group.policies
                            .map(policy => organizationGroupPolicyDefinition(policy.type).label)
                            .join(', ')}
                        </Badge>
                      )}
                    </div>
                    {group.description && (
                      <span className="type-label text-muted-foreground block truncate">
                        {group.description}
                      </span>
                    )}
                  </button>
                  {canManage && (
                    <div className="flex items-center gap-1">
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Delete ${group.name}`}
                            className="text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100"
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete {group.name}?</AlertDialogTitle>
                            <AlertDialogDescription>
                              This removes the group, its policies, and member assignments.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              variant="destructive"
                              onClick={() =>
                                deleteMutation.mutate({ organizationId, groupId: group.id })
                              }
                            >
                              Delete group
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function OrganizationGroupsPage(props: { organizationId: string; role: OrganizationRole }) {
  return (
    <OrganizationGroupsDrawerStackProvider organizationId={props.organizationId}>
      <GroupsPageContent {...props} />
    </OrganizationGroupsDrawerStackProvider>
  );
}
