import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { DrawerStackHelpers } from '@/components/drawer';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useTRPC } from '@/lib/trpc/utils';
import { NamedPolicyDocumentSchema } from '@kilocode/web-shared/lib/organizations/group-policies/permission-policy/named-policy.schema';
import type { OrganizationGroupsDrawerRef } from '../../drawer/types';
import { parsePlainJsonDocument } from './permission-policy-json';
import {
  namedPolicyExamples,
  namedPolicyKindLabels,
  namedPolicyKindOptions,
  type NamedPolicyKind,
} from './named-policy-ui';

type Scope = { type: 'default' } | { type: 'group'; groupId: string };

function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  description,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
  description?: string;
}) {
  return (
    <div className="grid min-w-0 gap-1.5">
      <Label htmlFor={label}>{label}</Label>
      <select
        id={label}
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={event => onChange(event.target.value as T)}
        className="border-input bg-background text-foreground focus-visible:border-ring focus-visible:ring-ring/50 h-9 w-full rounded-md border px-2 text-sm focus-visible:ring-[3px] disabled:opacity-50 pointer-coarse:h-11"
      >
        {options.map(option => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {description && <p className="type-label text-muted-foreground">{description}</p>}
    </div>
  );
}

function useNamedPolicies(organizationId: string) {
  const trpc = useTRPC();
  const api = trpc.organizations.groups.adminPermissionPolicy;
  const list = useQuery(api.list.queryOptions({ organizationId }));
  return { api, list };
}

function currentLink(
  policies: NonNullable<Awaited<ReturnType<typeof useNamedPolicies>>['list']['data']>['policies'],
  scope: Scope,
  kind: NamedPolicyKind
): string {
  const match = policies.find(policy =>
    policy.kind === kind
      ? policy.attachments.some(attachment =>
          scope.type === 'default'
            ? attachment.type === 'default'
            : attachment.type === 'group' && attachment.groupId === scope.groupId
        )
      : false
  );
  return match?.id ?? '';
}

export function NamedPolicyAssignmentsPanel({
  organizationId,
  scope,
  appliesTo,
  canEdit,
  helpers,
}: {
  organizationId: string;
  scope: Scope;
  appliesTo: string;
  canEdit: boolean;
  helpers: DrawerStackHelpers<OrganizationGroupsDrawerRef>;
}) {
  const { api, list } = useNamedPolicies(organizationId);
  const queryClient = useQueryClient();
  const setLink = useMutation(
    api.setLink.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: api.list.pathKey() });
        await queryClient.invalidateQueries({ queryKey: api.diagnostics.pathKey() });
      },
    })
  );

  if (list.isError) {
    return (
      <p role="alert" className="type-body text-muted-foreground p-5">
        Unable to load policies.
      </p>
    );
  }
  if (!list.data) {
    return (
      <p role="status" className="type-body text-muted-foreground p-5">
        Loading policies...
      </p>
    );
  }
  if (!list.data.managed) {
    return (
      <p className="type-body text-muted-foreground p-5">
        Organization permission policies are not enabled.
      </p>
    );
  }

  const editable = canEdit && list.data.writesEnabled;
  const policies = list.data.policies;

  async function link(kind: NamedPolicyKind, policyId: string) {
    try {
      await setLink.mutateAsync({
        organizationId,
        scope,
        kind,
        policyId: policyId === '' ? null : policyId,
      });
      toast.success('Permissions updated.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update the policy link.');
    }
  }

  return (
    <div className="grid gap-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="type-body font-medium break-words">{appliesTo}</p>
          <p className="type-label text-muted-foreground">
            {scope.type === 'group'
              ? 'A group can add restrictions, never relax the organization default.'
              : 'These named policies apply to every direct member.'}
          </p>
        </div>
        <Badge variant="outline">Revision {list.data.policyRevision}</Badge>
      </div>
      {!editable && (
        <p className="type-label text-muted-foreground rounded-md border px-3 py-2">
          {canEdit ? 'Policy writes are disabled for this deployment.' : 'Read only.'}
        </p>
      )}
      {(['agent_permissions', 'client_configuration'] as const).map(kind => {
        const options = policies
          .filter(policy => policy.kind === kind)
          .map(policy => ({ value: policy.id, label: policy.name }));
        return (
          <SelectField
            key={kind}
            label={namedPolicyKindLabels[kind]}
            value={currentLink(policies, scope, kind)}
            disabled={!editable}
            options={[{ value: '', label: 'None' }, ...options]}
            onChange={policyId => void link(kind, policyId)}
            description={
              options.length
                ? undefined
                : `Create a ${namedPolicyKindLabels[kind].toLowerCase()} policy in Policies first.`
            }
          />
        );
      })}
      <Button
        variant="outline"
        className="w-fit"
        onClick={() => helpers.push({ type: 'named-policy-library', canManage: canEdit })}
      >
        Manage policies
      </Button>
    </div>
  );
}

export function NamedPolicyLibraryPanel({
  organizationId,
  canManage,
  helpers,
}: {
  organizationId: string;
  canManage: boolean;
  helpers: DrawerStackHelpers<OrganizationGroupsDrawerRef>;
}) {
  const { api, list } = useNamedPolicies(organizationId);
  const queryClient = useQueryClient();
  const remove = useMutation(
    api.delete.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: api.list.pathKey() });
        await queryClient.invalidateQueries({ queryKey: api.diagnostics.pathKey() });
      },
    })
  );
  const [confirming, setConfirming] = useState<string | null>(null);

  if (list.isError) {
    return (
      <p role="alert" className="type-body text-muted-foreground p-5">
        Unable to load policies.
      </p>
    );
  }
  if (!list.data) {
    return (
      <p role="status" className="type-body text-muted-foreground p-5">
        Loading policies...
      </p>
    );
  }
  if (!list.data.managed) {
    return (
      <p className="type-body text-muted-foreground p-5">
        Organization permission policies are not enabled.
      </p>
    );
  }

  const editable = canManage && list.data.writesEnabled;
  return (
    <div className="grid gap-4 p-5">
      {editable && (
        <Button
          className="w-fit"
          onClick={() =>
            helpers.push({
              type: 'named-policy-editor',
              policyId: null,
              defaultKind: 'agent_permissions',
            })
          }
        >
          New policy
        </Button>
      )}
      {list.data.policies.length === 0 ? (
        <p className="type-body text-muted-foreground">No named policies yet.</p>
      ) : (
        <ul className="grid gap-2">
          {list.data.policies.map(policy => (
            <li key={policy.id} className="grid gap-2 rounded-md border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="grid gap-0.5">
                  <p className="type-body font-medium break-words">{policy.name}</p>
                  <p className="type-label text-muted-foreground">
                    {namedPolicyKindLabels[policy.kind]} ·{' '}
                    {policy.attachments.length
                      ? `${policy.attachments.length} ${policy.attachments.length === 1 ? 'attachment' : 'attachments'}`
                      : 'Unlinked'}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      helpers.push({
                        type: 'named-policy-editor',
                        policyId: policy.id,
                        defaultKind: policy.kind,
                      })
                    }
                  >
                    Edit
                  </Button>
                  {confirming === policy.id ? (
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={policy.attachments.length > 0 || remove.isPending}
                      onClick={async () => {
                        try {
                          await remove.mutateAsync({ organizationId, policyId: policy.id });
                          toast.success('Policy deleted.');
                          setConfirming(null);
                        } catch (error) {
                          toast.error(
                            error instanceof Error ? error.message : 'Could not delete the policy.'
                          );
                        }
                      }}
                    >
                      Confirm delete
                    </Button>
                  ) : (
                    <Button variant="ghost" size="sm" onClick={() => setConfirming(policy.id)}>
                      Delete
                    </Button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="type-label text-muted-foreground">
        Unlinked policies do not affect members. Editing a linked policy updates every group that
        uses it.
      </p>
    </div>
  );
}

export function NamedPolicyEditorPanel({
  organizationId,
  policyId,
  defaultKind,
  onClose,
}: {
  organizationId: string;
  policyId: string | null;
  defaultKind: NamedPolicyKind;
  onClose: () => void;
}) {
  const { api, list } = useNamedPolicies(organizationId);
  const queryClient = useQueryClient();
  const existing = policyId
    ? list.data?.policies.find(policy => policy.id === policyId)
    : undefined;
  const [name, setName] = useState(existing?.name ?? '');
  const [kind, setKind] = useState<NamedPolicyKind>(existing?.kind ?? defaultKind);
  const [text, setText] = useState(() =>
    existing ? JSON.stringify(existing.document, null, 2) : namedPolicyExamples[defaultKind]
  );
  const [error, setError] = useState<string | null>(null);

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: api.list.pathKey() });
    await queryClient.invalidateQueries({ queryKey: api.diagnostics.pathKey() });
  };
  const create = useMutation(api.create.mutationOptions({ onSuccess: invalidate }));
  const update = useMutation(api.update.mutationOptions({ onSuccess: invalidate }));
  const busy = create.isPending || update.isPending;

  if (list.isError) {
    return (
      <p role="alert" className="type-body text-muted-foreground p-5">
        Unable to load policies.
      </p>
    );
  }
  if (!list.data) {
    return (
      <p role="status" className="type-body text-muted-foreground p-5">
        Loading policy...
      </p>
    );
  }
  if (policyId && !existing) {
    return (
      <p role="alert" className="type-body text-muted-foreground p-5">
        Policy not found.
      </p>
    );
  }

  async function save() {
    setError(null);
    const parsed = parsePlainJsonDocument(text);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    const validated = NamedPolicyDocumentSchema.safeParse({ kind, document: parsed.value });
    if (!validated.success) {
      const issue = validated.error.issues[0];
      setError(`${issue.path.join('.') || 'document'}: ${issue.message}`);
      return;
    }
    try {
      if (existing) {
        await update.mutateAsync({
          organizationId,
          policyId: existing.id,
          name,
          document: validated.data.document,
        });
      } else {
        await create.mutateAsync({ organizationId, kind, name, document: validated.data.document });
      }
      toast.success('Policy saved.');
      onClose();
    } catch (mutationError) {
      setError(
        mutationError instanceof Error ? mutationError.message : 'Could not save the policy.'
      );
    }
  }

  return (
    <div className="grid gap-4 p-5">
      <div className="grid gap-1.5">
        <Label htmlFor="named-policy-name">Name</Label>
        <Input
          id="named-policy-name"
          value={name}
          maxLength={80}
          disabled={busy}
          onChange={event => setName(event.target.value)}
        />
      </div>
      <SelectField
        label="Kind"
        value={kind}
        disabled={Boolean(existing) || busy}
        options={namedPolicyKindOptions}
        onChange={setKind}
      />
      <div className="grid gap-1.5">
        <Label htmlFor="named-policy-json">Policy JSON</Label>
        <Textarea
          id="named-policy-json"
          spellCheck={false}
          rows={14}
          className="font-mono"
          value={text}
          disabled={busy}
          onChange={event => setText(event.target.value)}
        />
        <p className="type-label text-muted-foreground">
          Plain JSON only. Name and kind are stored separately; do not include them in the document.
        </p>
      </div>
      {error && (
        <p role="alert" className="type-label text-status-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || !name.trim()} onClick={() => void save()}>
          {existing ? 'Save changes' : 'Create policy'}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
