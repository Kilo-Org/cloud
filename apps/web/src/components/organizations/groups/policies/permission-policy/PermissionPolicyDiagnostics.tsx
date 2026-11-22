import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useOrganizationWithMembers } from '@/app/api/organizations/hooks';
import { Badge } from '@/components/ui/badge';
import { useTRPC } from '@/lib/trpc/utils';
import type { PermissionPolicyExecutionOs } from '@kilocode/web-shared/lib/organizations/group-policies/permission-policy/permission-policy.schema';
import { namedPolicyKindLabels } from './named-policy-ui';

const executionOsOptions = [
  { value: 'all', label: 'All OS' },
  { value: 'linux', label: 'Linux' },
  { value: 'macos', label: 'macOS' },
  { value: 'windows', label: 'Windows' },
  { value: 'other', label: 'Other' },
] as const;

type ExecutionOsChoice = (typeof executionOsOptions)[number]['value'];

const flagLabels = {
  disable_auto_approve: 'Auto-approval',
  disable_telemetry: 'Telemetry',
  hide_session_dollar_values: 'Session dollar values',
} as const;

function flagText(key: keyof typeof flagLabels, value: boolean | undefined) {
  if (value) return key === 'hide_session_dollar_values' ? 'Hidden' : 'Disabled';
  return key === 'hide_session_dollar_values' ? 'Visible' : 'Allowed';
}

export function PermissionPolicyDiagnostics({ organizationId }: { organizationId: string }) {
  const trpc = useTRPC();
  const [userId, setUserId] = useState('');
  const [os, setOs] = useState<ExecutionOsChoice>('all');
  const executionOs = os === 'all' ? undefined : (os as PermissionPolicyExecutionOs);
  const organization = useOrganizationWithMembers(organizationId);
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
      executionOs,
    }),
    enabled: Boolean(selectedMember),
  });
  const inspection = diagnostics.data;

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4 p-5">
      <p className="type-body text-muted-foreground">
        Inspect the named policies Cloud resolves for a direct member on a chosen execution OS.
        Local restrictions are not available here and can still be stricter.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid min-w-0 gap-1.5">
          <span className="type-label font-medium">Member</span>
          <select
            aria-label="Member"
            value={userId}
            disabled={organization.isLoading || members.length === 0}
            onChange={event => setUserId(event.target.value)}
            className="border-input bg-background text-foreground h-9 w-full rounded-md border px-2 text-sm pointer-coarse:h-11"
          >
            <option value="" disabled>
              {organization.isLoading ? 'Loading members…' : 'Choose a direct member'}
            </option>
            {members.map(member => (
              <option key={member.value} value={member.value}>
                {member.label}
              </option>
            ))}
          </select>
        </label>
        <label className="grid min-w-0 gap-1.5">
          <span className="type-label font-medium">Execution OS</span>
          <select
            aria-label="Execution OS"
            value={os}
            onChange={event => setOs(event.target.value as ExecutionOsChoice)}
            className="border-input bg-background text-foreground h-9 w-full rounded-md border px-2 text-sm pointer-coarse:h-11"
          >
            {executionOsOptions.map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {organization.isError && (
        <p role="alert" className="type-body text-status-destructive">
          Unable to load organization members.
        </p>
      )}
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
              The strictest applicable tool or shell decision wins. Each Client Configuration flag
              is independent; a true value from any applicable policy applies.
            </p>
            <dl className="type-label grid gap-1 rounded-md border px-3 py-2 sm:grid-cols-[minmax(0,1fr)_auto]">
              {(Object.keys(flagLabels) as (keyof typeof flagLabels)[]).map(key => (
                <div key={key} className="flex items-center justify-between gap-2">
                  <dt className="font-medium">{flagLabels[key]}</dt>
                  <dd className="text-muted-foreground">
                    {flagText(key, inspection.response.policy.client_configuration?.[key])}
                  </dd>
                </div>
              ))}
            </dl>
            <PolicySource
              name="Organization default"
              policies={inspection.sources.defaultPolicies}
            />
            {inspection.sources.groups.length === 0 ? (
              <p className="type-label text-muted-foreground">No group policy contributions.</p>
            ) : (
              inspection.sources.groups.map(source => (
                <PolicySource
                  key={source.groupId}
                  name={source.groupName}
                  policies={source.policies}
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
}: {
  name: string;
  policies: { id: string; name: string; kind: keyof typeof namedPolicyKindLabels }[];
}) {
  return (
    <section className="grid grid-cols-[minmax(0,1fr)] gap-2 rounded-md border p-3">
      <h4 className="type-body font-medium break-words">{name}</h4>
      {policies.length ? (
        <ul className="type-label grid gap-1">
          {policies.map(policy => (
            <li key={`${policy.id}-${policy.kind}`}>
              <span className="font-medium">{policy.name}</span>
              <span className="text-muted-foreground"> · {namedPolicyKindLabels[policy.kind]}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="type-label text-muted-foreground">No policies at this scope.</p>
      )}
    </section>
  );
}
