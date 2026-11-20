import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { useTRPC } from '@/lib/trpc/utils';
import type { OrganizationGroupsDrawerRef } from '../../drawer/types';
import { PermissionPolicyEditor } from './PermissionPolicyEditor';
import { emptyAgentPolicy, policySummary } from './permission-policy-ui';
import {
  OrganizationPermissionPolicySchema,
  type OrganizationPermissionPolicy,
} from '@kilocode/web-shared/lib/organizations/group-policies/permission-policy/permission-policy.schema';

function SettingsMessage({ loading, error }: { loading: boolean; error: boolean }) {
  return (
    <p role={error ? 'alert' : 'status'} className="type-body text-muted-foreground p-5">
      {error
        ? 'Could not load permission policies. Close this panel and try again.'
        : loading
          ? 'Loading permission policies...'
          : 'Permission policies are not available for this organization.'}
    </p>
  );
}

function editLockReason(canEdit: boolean, writesEnabled: boolean) {
  if (!canEdit)
    return 'Read only. Only organization owners and admins can edit permission policies.';
  if (!writesEnabled)
    return 'Read only. Permission policy writes are disabled for this deployment.';
  return '';
}

export function PermissionPolicyEditorPanel({
  organizationId,
  entry,
  onClose,
}: {
  organizationId: string;
  entry: Extract<OrganizationGroupsDrawerRef, { type: 'permission-policy-editor' }>;
  onClose: () => void;
}) {
  const trpc = useTRPC();
  const client = useQueryClient();
  const groupId = entry.target.kind === 'group' ? entry.target.groupId : undefined;
  const input = groupId ? { organizationId, groupId } : { organizationId };
  const api = trpc.organizations.groups.adminPermissionPolicy;
  const defaults = useQuery(api.settings.queryOptions({ organizationId }));
  const group = useQuery({
    ...api.settings.queryOptions(input),
    enabled: Boolean(groupId) && defaults.data?.managed === true,
  });
  const active = groupId ? group : defaults;
  const saveMutation = useMutation(
    api.set.mutationOptions({
      onSuccess: () => client.invalidateQueries({ queryKey: api.pathKey() }),
    })
  );
  const removeMutation = useMutation(
    api.remove.mutationOptions({
      onSuccess: () => client.invalidateQueries({ queryKey: api.pathKey() }),
    })
  );
  if (!defaults.data?.managed || !active.data?.managed || defaults.isError || active.isError) {
    return (
      <SettingsMessage
        loading={defaults.isLoading || active.isLoading}
        error={defaults.isError || active.isError}
      />
    );
  }
  const stored = active.data.policies[0];
  const inheritedDefault = groupId ? defaults.data.policies[0] : undefined;
  const saved = stored && OrganizationPermissionPolicySchema.safeParse(stored);
  const inherited =
    inheritedDefault && OrganizationPermissionPolicySchema.safeParse(inheritedDefault);
  if (saved?.success === false || inherited?.success === false) {
    return <SettingsMessage loading={false} error />;
  }
  const lockReason = editLockReason(entry.canEdit, active.data.writesEnabled);

  async function save(policy: OrganizationPermissionPolicy) {
    try {
      const { policyRevision } = await saveMutation.mutateAsync({ ...input, policy });
      toast.success(`Policy saved · Revision ${policyRevision}`, {
        description: policySummary(policy),
      });
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save the policy.');
      return false;
    }
  }

  async function remove() {
    try {
      const { policyRevision } = await removeMutation.mutateAsync({
        ...input,
        policyType: 'agent_permissions',
      });
      toast.success(`Policy removed · Revision ${policyRevision}`);
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not remove the policy.');
      return false;
    }
  }

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex flex-wrap items-start justify-between gap-2 px-5 pt-4">
        <div className="min-w-0">
          <p className="type-body font-medium break-words">{entry.appliesTo}</p>
          <p className="type-label text-muted-foreground">
            {groupId
              ? 'A group can add restrictions, never relax the organization default.'
              : 'The default applies to every direct member.'}
          </p>
        </div>
        <Badge variant="outline">Revision {active.data.policyRevision}</Badge>
      </div>
      <div className="flex flex-1 flex-col [&>div]:flex-1">
        <PermissionPolicyEditor
          initial={saved?.data ?? emptyAgentPolicy}
          inherited={inherited?.data}
          canEdit={!lockReason}
          lockReason={lockReason}
          isSaving={saveMutation.isPending}
          isRemoving={removeMutation.isPending}
          onSave={save}
          onRemove={saved && !lockReason ? remove : undefined}
          onClose={onClose}
        />
      </div>
    </div>
  );
}
