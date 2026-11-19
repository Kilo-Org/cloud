import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, ShieldCheck, UsersRound } from 'lucide-react';
import { toast } from 'sonner';
import type { DrawerStackHelpers } from '@/components/drawer';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useTRPC } from '@/lib/trpc/utils';
import type { OrganizationGroupsDrawerRef } from '../../drawer/types';
import { PermissionPolicyEditor } from './PermissionPolicyEditor';
import {
  permissionPolicyLabels,
  policySummary,
  type PolicyDraft,
  type PolicyType,
} from './permission-policy-ui';
import {
  OrganizationPermissionPolicySchema,
  type OrganizationPermissionPolicy,
} from '@kilocode/web-shared/lib/organizations/group-policies/permission-policy/permission-policy.schema';

const policyTypes = ['agent_permissions', 'client_access'] as const;
const policyIcons = { agent_permissions: ShieldCheck, client_access: UsersRound };

type PanelProps<T extends 'permission-policies' | 'permission-policy-editor'> = {
  organizationId: string;
  entry: Extract<OrganizationGroupsDrawerRef, { type: T }>;
  helpers: DrawerStackHelpers<OrganizationGroupsDrawerRef>;
};

function usePermissionPolicySettings(
  organizationId: string,
  target: PanelProps<'permission-policies'>['entry']['target']
) {
  const trpc = useTRPC();
  const input =
    target.kind === 'group' ? { organizationId, groupId: target.groupId } : { organizationId };
  const api = trpc.organizations.groups.adminPermissionPolicy;
  const defaults = useQuery(api.settings.queryOptions({ organizationId }));
  const group = useQuery({
    ...api.settings.queryOptions(input),
    enabled: target.kind === 'group' && defaults.data?.managed === true,
  });
  const active = target.kind === 'default' ? defaults : group;
  return { input, defaults, active };
}

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

export function PermissionPoliciesPanel({
  organizationId,
  entry,
  helpers,
}: PanelProps<'permission-policies'>) {
  const { defaults, active } = usePermissionPolicySettings(organizationId, entry.target);
  if (!defaults.data?.managed || !active.data?.managed || defaults.isError || active.isError) {
    return (
      <SettingsMessage
        loading={defaults.isLoading || active.isLoading}
        error={defaults.isError || active.isError}
      />
    );
  }
  const lockReason = editLockReason(entry.canEdit, active.data.writesEnabled);
  const { policies, policyRevision } = active.data;

  return (
    <div className="grid gap-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="type-body font-medium break-words">{entry.appliesTo}</p>
          <p className="type-label text-muted-foreground">
            {entry.target.kind === 'group'
              ? 'A group can add restrictions, never relax the organization default.'
              : 'These policies apply to every direct member.'}
          </p>
        </div>
        <Badge variant="outline">Revision {policyRevision}</Badge>
      </div>
      {lockReason && (
        <p className="type-label text-muted-foreground rounded-md border px-3 py-2">{lockReason}</p>
      )}
      <div className="divide-y overflow-hidden rounded-lg border">
        {policyTypes.map(policyType => {
          const persisted = policies.find(policy => policy.type === policyType);
          const Icon = policyIcons[policyType];
          return (
            <Button
              key={policyType}
              variant="ghost"
              className="h-auto min-h-14 w-full justify-start gap-3 rounded-none px-3 py-2 text-left whitespace-normal"
              disabled={!persisted && Boolean(lockReason)}
              onClick={() =>
                helpers.push({ ...entry, type: 'permission-policy-editor', policyType })
              }
            >
              <Icon className="size-4 shrink-0 text-muted-foreground" />
              <span className="grid flex-1 gap-0.5">
                <span>{permissionPolicyLabels[policyType]}</span>
                <span className="type-label text-muted-foreground font-normal">
                  {persisted
                    ? policySummary(persisted)
                    : entry.target.kind === 'group'
                      ? 'No group policy'
                      : 'No organization default'}
                </span>
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
            </Button>
          );
        })}
      </div>
    </div>
  );
}

export function PermissionPolicyEditorPanel({
  organizationId,
  entry,
  helpers,
}: PanelProps<'permission-policy-editor'>) {
  const trpc = useTRPC();
  const client = useQueryClient();
  const { input, defaults, active } = usePermissionPolicySettings(organizationId, entry.target);
  const api = trpc.organizations.groups.adminPermissionPolicy;
  const saveMutation = useMutation(api.set.mutationOptions());
  const removeMutation = useMutation(api.remove.mutationOptions());
  if (!defaults.data?.managed || !active.data?.managed || defaults.isError || active.isError) {
    return (
      <SettingsMessage
        loading={defaults.isLoading || active.isLoading}
        error={defaults.isError || active.isError}
      />
    );
  }
  const { policyType } = entry;
  const stored = active.data.policies.find(policy => policy.type === policyType);
  const inheritedDefault =
    entry.target.kind === 'group'
      ? defaults.data.policies.find(policy => policy.type === policyType)
      : undefined;
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
      await client.invalidateQueries({ queryKey: api.pathKey() });
      toast.success(`Policy saved · Revision ${policyRevision}`, {
        description: policySummary(policy),
      });
      helpers.pop();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save the policy.');
    }
  }

  async function remove() {
    try {
      const { policyRevision } = await removeMutation.mutateAsync({ ...input, policyType });
      await client.invalidateQueries({ queryKey: api.pathKey() });
      toast.success(`Policy removed · Revision ${policyRevision}`);
      helpers.pop();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not remove the policy.');
    }
  }

  return (
    <div className="flex min-h-full flex-col">
      <div className="type-label text-muted-foreground px-5 pt-4">
        Applies to:{' '}
        <span className="text-foreground font-medium break-words">{entry.appliesTo}</span>
      </div>
      <div className="flex flex-1 flex-col [&>div]:flex-1">
        <PermissionPolicyEditor
          initial={saved?.data ?? initialPolicy(policyType)}
          inherited={inherited?.data}
          canEdit={!lockReason}
          lockReason={lockReason}
          isSaving={saveMutation.isPending}
          isRemoving={removeMutation.isPending}
          onSave={policy => void save(policy)}
          onRemove={saved && !lockReason ? remove : undefined}
          onClose={helpers.pop}
        />
      </div>
    </div>
  );
}

function initialPolicy(type: PolicyType): PolicyDraft {
  return type === 'agent_permissions'
    ? { type, data: { schema_version: 1 } }
    : { type, data: { schema_version: 1, clients: [] } };
}
