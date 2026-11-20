import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useOrganizationWithMembers } from '@/app/api/organizations/hooks';
import { Badge } from '@/components/ui/badge';
import { useTRPC } from '@/lib/trpc/utils';
import type {
  AgentPermissionsPolicy,
  OrganizationPermissionPolicy,
  PermissionPolicyExecutionOs,
} from '@kilocode/web-shared/lib/organizations/group-policies/permission-policy/permission-policy.schema';
import {
  agentPermissionSummary,
  allOsPermissions,
  permissionSetLabels,
  permissionSetOptions,
  policyJson,
  PolicySelect,
  policySummary,
} from './permission-policy-ui';

const executionOsOptions = [...permissionSetOptions, { value: 'other', label: 'Other' }] as const;

export function PermissionPolicyDiagnostics({ organizationId }: { organizationId: string }) {
  const trpc = useTRPC();
  const [userId, setUserId] = useState('');
  const [os, setOs] = useState<PermissionPolicyExecutionOs | 'all'>('all');
  const executionOs = os === 'all' ? undefined : os;
  const organization = useOrganizationWithMembers(organizationId);
  const groups = useQuery(trpc.organizations.groups.list.queryOptions({ organizationId }));
  const members =
    organization.data?.members.flatMap(member =>
      member.status === 'active'
        ? [
            {
              value: member.id,
              label:
                member.name && member.name !== member.email
                  ? `${member.name} (${member.email})`
                  : member.email,
            },
          ]
        : []
    ) ?? [];
  const selectedMember = members.find(member => member.value === userId);
  const diagnostics = useQuery({
    ...trpc.organizations.groups.adminPermissionPolicy.diagnostics.queryOptions({
      organizationId,
      userId,
      ...(executionOs && { executionOs }),
    }),
    enabled: Boolean(selectedMember),
  });
  const groupNames = new Map(groups.data?.groups.map(group => [group.id, group.name]));
  const inspection = diagnostics.data;
  const policy = inspection?.response.managed ? inspection.response.policy : undefined;
  const autoApproveBlocked = policy?.agent_permissions?.layers.some(
    layer => layer.auto_approve === 'deny'
  );

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4 p-5">
      <p className="type-body text-muted-foreground">
        Inspect the organization policy Cloud delivers to a direct member. Local and device
        restrictions are not available here and can still be stricter.
      </p>
      {organization.isError ? (
        <p role="alert" className="type-body text-status-destructive">
          Unable to load organization members.
        </p>
      ) : (
        <PolicySelect
          label="Member"
          value={selectedMember?.value ?? ''}
          disabled={organization.isLoading || members.length === 0}
          options={[
            {
              value: '',
              label: organization.isLoading
                ? 'Loading members…'
                : members.length
                  ? 'Choose a direct member'
                  : 'No direct members',
              disabled: true,
            },
            ...members,
          ]}
          onChange={setUserId}
        />
      )}
      <PolicySelect
        label="Execution OS"
        value={os}
        options={executionOsOptions}
        description="All OS and Other show the baseline only. A named OS also includes its additions."
        onChange={setOs}
      />
      {selectedMember &&
        (diagnostics.isError ? (
          <p role="alert" className="type-body text-status-destructive">
            {diagnostics.error.message || 'Unable to load this member’s policy.'}
          </p>
        ) : !inspection ? (
          <p role="status" className="type-body text-muted-foreground">
            Loading member policy...
          </p>
        ) : !inspection.response.managed ? (
          <p className="type-body text-muted-foreground">
            Permission policies are not enabled for this organization.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 border-t pt-4">
              <h3 className="type-body mr-auto font-medium">Effective organization policy</h3>
              <Badge variant="outline">Revision {inspection.response.revision}</Badge>
            </div>
            <p className="type-label text-muted-foreground">
              The strictest applicable tool or shell decision wins.
            </p>
            <dl className="type-label flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2">
              <dt className="font-medium">Auto-approve for managed actions</dt>
              <dd className="text-muted-foreground">
                {autoApproveBlocked ? 'Disabled' : 'No organization restriction'}
              </dd>
            </dl>
            <dl className="type-label flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2">
              <dt className="font-medium">Session dollar visibility</dt>
              <dd className="text-muted-foreground">
                {policy?.client_configuration?.show_session_dollar_values === false
                  ? 'Hidden'
                  : 'Visible'}
              </dd>
            </dl>
            <PolicySource
              name="Organization default"
              policies={inspection.sources.defaultPolicies}
              executionOs={executionOs}
            />
            {inspection.sources.groups.length === 0 ? (
              <p className="type-label text-muted-foreground">No group policy contributions.</p>
            ) : (
              inspection.sources.groups.map(source => (
                <PolicySource
                  key={source.groupId}
                  name={groupNames.get(source.groupId) ?? `Group ${source.groupId}`}
                  policies={source.policies}
                  executionOs={executionOs}
                />
              ))
            )}
            <details className="min-w-0 rounded-md border p-3">
              <summary className="type-body cursor-pointer font-medium">
                Effective policy JSON
              </summary>
              <pre className="type-label bg-background mt-3 max-h-72 overflow-auto rounded border p-3">
                {JSON.stringify(inspection.response.policy, null, 2)}
              </pre>
            </details>
          </>
        ))}
    </div>
  );
}

function PolicySource({
  name,
  policies,
  executionOs,
}: {
  name: string;
  policies: OrganizationPermissionPolicy[];
  executionOs?: PermissionPolicyExecutionOs;
}) {
  return (
    <section className="grid grid-cols-[minmax(0,1fr)] gap-2 rounded-md border p-3">
      <h4 className="type-body font-medium break-words">{name}</h4>
      {policies.length ? (
        policies.map(policy =>
          policy.type === 'agent_permissions' ? (
            <AgentPolicySource key={policy.type} policy={policy} executionOs={executionOs} />
          ) : (
            <PolicySourceDetails
              key={policy.type}
              name="Client Configuration"
              summary={policySummary(policy)}
              policy={policy}
            />
          )
        )
      ) : (
        <p className="type-label text-muted-foreground">No permission policies at this scope.</p>
      )}
    </section>
  );
}

function AgentPolicySource({
  policy,
  executionOs,
}: {
  policy: AgentPermissionsPolicy;
  executionOs?: PermissionPolicyExecutionOs;
}) {
  const allOs = allOsPermissions(policy.data);
  const additionOs = executionOs === 'other' ? undefined : executionOs;
  const addition = additionOs ? policy.data.by_os?.[additionOs] : undefined;
  return (
    <>
      <PolicySourceDetails
        name="Agent permissions"
        summary={`${additionOs ? 'All OS · ' : ''}${agentPermissionSummary(allOs)}`}
        policy={{ ...policy, data: { schema_version: 1, ...allOs } }}
      />
      {additionOs && addition && (
        <PolicySourceDetails
          name={`${permissionSetLabels[additionOs]} permissions`}
          summary={agentPermissionSummary(addition)}
          policy={{ ...policy, data: { schema_version: 1, by_os: { [additionOs]: addition } } }}
        />
      )}
    </>
  );
}

function PolicySourceDetails({
  name,
  summary,
  policy,
}: {
  name: string;
  summary: string;
  policy: OrganizationPermissionPolicy;
}) {
  return (
    <details className="type-label rounded border px-3 py-2">
      <summary className="cursor-pointer">
        <span className="font-medium">{name}</span>
        <span className="text-muted-foreground"> · {summary}</span>
      </summary>
      <pre className="bg-background mt-2 max-h-56 overflow-auto rounded border p-2">
        {policyJson(policy)}
      </pre>
    </details>
  );
}
