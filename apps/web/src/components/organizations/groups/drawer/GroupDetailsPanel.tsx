'use client';

import type { DrawerStackHelpers } from '@/components/drawer';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useOrganizationWithMembers } from '@/app/api/organizations/hooks';
import { organizationGroupPolicyDefinition } from '@/components/organizations/groups/policies/registry.client';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { useTRPC } from '@/lib/trpc/utils';
import type { OrganizationGroupsDrawerRef } from './types';

const EMPTY_GROUP_ID = '00000000-0000-0000-0000-000000000000';

export function GroupDetailsPanel({
  organizationId,
  entry,
  helpers,
}: {
  organizationId: string;
  entry: Extract<OrganizationGroupsDrawerRef, { type: 'group-details' }>;
  helpers: DrawerStackHelpers<OrganizationGroupsDrawerRef>;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const organizationQuery = useOrganizationWithMembers(organizationId);
  const groupQuery = useQuery({
    ...trpc.organizations.groups.get.queryOptions({
      organizationId,
      groupId: entry.mode === 'edit' ? entry.groupId : EMPTY_GROUP_ID,
    }),
    enabled: entry.mode === 'edit',
  });
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [memberSearch, setMemberSearch] = useState('');
  const initializedGroupIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (
      entry.mode !== 'edit' ||
      !groupQuery.data ||
      initializedGroupIdRef.current === groupQuery.data.group.id
    )
      return;
    initializedGroupIdRef.current = groupQuery.data.group.id;
    setName(groupQuery.data.group.name);
    setDescription(groupQuery.data.group.description ?? '');
    setMemberIds(groupQuery.data.group.memberIds);
  }, [entry.mode, groupQuery.data]);

  const createMutation = useMutation(trpc.organizations.groups.create.mutationOptions());
  const updateMutation = useMutation(trpc.organizations.groups.updateDetails.mutationOptions());
  const isSaving = createMutation.isPending || updateMutation.isPending;

  async function invalidate() {
    await queryClient.invalidateQueries({ queryKey: trpc.organizations.groups.pathKey() });
  }

  async function save() {
    try {
      if (entry.mode === 'create') {
        await createGroup(false);
        return;
      }
      await updateMutation.mutateAsync({
        organizationId,
        groupId: entry.groupId,
        name,
        description: description || null,
        userIds: memberIds,
      });
      await invalidate();
      toast.success('Group updated');
      helpers.pop();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save group');
    }
  }

  async function createGroup(openPolicyPicker: boolean) {
    try {
      const created = await createMutation.mutateAsync({
        organizationId,
        name,
        description: description || null,
        policies: [],
      });
      await invalidate();
      const groupId = created.result.id;
      helpers.replace({ type: 'group-details', mode: 'edit', groupId });
      if (openPolicyPicker) {
        helpers.push({
          type: 'policy-type-picker',
          target: { kind: 'group', groupId },
        });
      }
      toast.success('Group created.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to create group');
    }
  }

  if (entry.mode === 'edit' && groupQuery.isLoading) {
    return (
      <div className="grid gap-3 p-5">
        <Skeleton className="h-10" />
        <Skeleton className="h-40" />
      </div>
    );
  }
  if (entry.mode === 'edit' && !groupQuery.data) {
    return (
      <p role="alert" className="type-body text-status-destructive p-5">
        Unable to load this group.
      </p>
    );
  }

  const group = entry.mode === 'edit' ? groupQuery.data?.group : undefined;
  const members =
    organizationQuery.data?.members.filter(member => member.status === 'active') ?? [];
  const visibleMembers = members.filter(member =>
    `${member.name} ${member.email}`.toLowerCase().includes(memberSearch.toLowerCase())
  );
  const visibleMemberIds = visibleMembers.map(member => member.id);
  const selectedVisibleCount = visibleMemberIds.filter(id => memberIds.includes(id)).length;
  const allVisibleSelected =
    visibleMembers.length > 0 && selectedVisibleCount === visibleMembers.length;
  const isFilteringMembers = memberSearch.trim().length > 0;

  // Selecting all applies to the current search results and leaves selections
  // outside the filter untouched.
  function toggleAllVisibleMembers(checked: boolean) {
    setMemberIds(current =>
      checked
        ? [...new Set([...current, ...visibleMemberIds])]
        : current.filter(id => !visibleMemberIds.includes(id))
    );
  }

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex flex-1 flex-col gap-5 p-5">
        <section className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="group-name">Name</Label>
            <Input
              id="group-name"
              value={name}
              maxLength={80}
              placeholder="e.g. Engineering"
              onChange={event => setName(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="group-description">Description</Label>
            <Textarea
              id="group-description"
              value={description}
              maxLength={500}
              rows={2}
              placeholder="Optional"
              onChange={event => setDescription(event.target.value)}
            />
          </div>
        </section>

        <section className="grid gap-2 border-t pt-5">
          <div className="flex items-center justify-between gap-3">
            <h3 className="type-label text-muted-foreground uppercase tracking-wide">Policies</h3>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-muted-foreground hover:text-foreground"
              disabled={!name.trim() || isSaving}
              onClick={() =>
                group
                  ? helpers.push({
                      type: 'policy-type-picker',
                      target: { kind: 'group', groupId: group.id },
                    })
                  : void createGroup(true)
              }
            >
              <Plus className="size-4" />
              Add policy
            </Button>
          </div>
          {!group || group.policies.length === 0 ? (
            <p className="type-body text-muted-foreground rounded-lg border border-dashed px-4 py-3">
              No policies yet. Members inherit organization defaults.
            </p>
          ) : (
            <div className="divide-y overflow-hidden rounded-lg border">
              {group.policies.map(policy => {
                const definition = organizationGroupPolicyDefinition(policy.type);
                const ListItem = definition.ListItem;
                const Icon = definition.Icon;
                return (
                  <button
                    key={policy.type}
                    className="flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-hover"
                    onClick={() =>
                      helpers.push({
                        type: 'policy-editor',
                        target: { kind: 'group', groupId: group.id },
                        policyType: policy.type,
                      })
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
        </section>

        {group && (
          <section className="grid gap-2 border-t pt-5">
            <div className="flex items-center justify-between gap-3">
              <h3 className="type-label text-muted-foreground uppercase tracking-wide">Members</h3>
              <span className="type-label text-muted-foreground">{memberIds.length} selected</span>
            </div>
            <Input
              value={memberSearch}
              onChange={event => setMemberSearch(event.target.value)}
              placeholder="Search members"
              aria-label="Search members"
            />
            <div className="overflow-hidden rounded-lg border">
              {visibleMembers.length > 0 && (
                <label className="flex min-h-11 cursor-pointer items-center gap-3 border-b bg-muted/50 px-3 py-2">
                  <Checkbox
                    checked={
                      allVisibleSelected ? true : selectedVisibleCount > 0 ? 'indeterminate' : false
                    }
                    aria-label={isFilteringMembers ? 'Select all matches' : 'Select all members'}
                    onCheckedChange={toggleAllVisibleMembers}
                  />
                  <span className="type-label font-medium">
                    {isFilteringMembers ? 'Select all matches' : 'Select all'}
                  </span>
                  <span className="type-label text-muted-foreground ml-auto tabular-nums">
                    {selectedVisibleCount}/{visibleMembers.length}
                  </span>
                </label>
              )}
              {visibleMembers.length === 0 ? (
                <p className="type-body text-muted-foreground px-3 py-4 text-center">
                  No members match your search.
                </p>
              ) : (
                visibleMembers.map(member => (
                  <label
                    key={member.id}
                    className="flex min-h-11 cursor-pointer items-center gap-3 border-b px-3 py-2 last:border-b-0 hover:bg-surface-hover"
                  >
                    <Checkbox
                      checked={memberIds.includes(member.id)}
                      onCheckedChange={checked =>
                        setMemberIds(current =>
                          checked
                            ? [...new Set([...current, member.id])]
                            : current.filter(id => id !== member.id)
                        )
                      }
                    />
                    <span className="min-w-0">
                      <span className="type-body block truncate">
                        {member.name || member.email}
                      </span>
                      <span className="type-label text-muted-foreground block truncate">
                        {member.email}
                      </span>
                    </span>
                  </label>
                ))
              )}
            </div>
          </section>
        )}
      </div>
      <div className="sticky bottom-0 flex justify-end gap-2 border-t bg-surface-raised px-5 py-3">
        <Button variant="outline" onClick={helpers.closeAll}>
          Close
        </Button>
        <Button disabled={!name.trim() || isSaving} onClick={() => void save()}>
          {isSaving ? 'Saving...' : entry.mode === 'create' ? 'Create group' : 'Save changes'}
        </Button>
      </div>
    </div>
  );
}
