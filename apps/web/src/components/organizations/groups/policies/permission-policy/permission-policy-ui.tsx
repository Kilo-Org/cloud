import { useId } from 'react';
import { Label } from '@/components/ui/label';
import type { OrganizationGroupPolicy } from '@kilocode/web-shared/lib/organizations/group-policies/organization-group-policies';
import type { OrganizationPermissionPolicy } from '@kilocode/web-shared/lib/organizations/group-policies/permission-policy/permission-policy.schema';

export type AgentPolicy = Extract<OrganizationPermissionPolicy, { type: 'agent_permissions' }>;
export type ClientPolicy = Extract<OrganizationPermissionPolicy, { type: 'client_access' }>;
export type PolicyType = OrganizationPermissionPolicy['type'];
export type StoredPermissionPolicy = Extract<OrganizationGroupPolicy, { type: PolicyType }>;
export type ShellKind = keyof NonNullable<AgentPolicy['data']['shell']>;
export type ShellProfile = NonNullable<NonNullable<AgentPolicy['data']['shell']>[ShellKind]>;
export type PolicyRule = ShellProfile['rules'][number];
export type PolicyAction = PolicyRule['action'];
export type ToolDecision = NonNullable<AgentPolicy['data']['tools']>[string];
export type AgentDraft = Omit<AgentPolicy['data'], 'shell'> & {
  shell?: Partial<
    Record<ShellKind, Omit<ShellProfile, 'fallback'> & { fallback?: ShellProfile['fallback'] }>
  >;
};
export type ClientDraft = {
  schema_version: 1;
  mode?: ClientPolicy['data']['mode'];
  clients: Partial<Extract<ClientPolicy['data'], { mode: 'allowlist' }>['clients'][number]>[];
};
export type PolicyDraft =
  | { type: 'agent_permissions'; data: AgentDraft }
  | { type: 'client_access'; data: ClientDraft };

export const permissionPolicyLabels = {
  agent_permissions: 'Agent permissions',
  client_access: 'Client access',
} satisfies Record<PolicyType, string>;

export const actionLabels = {
  allow: 'Allow',
  ask: 'Require approval',
  deny: 'Block',
} satisfies Record<PolicyAction, string>;

export const actionOptions = [
  { value: 'allow', label: actionLabels.allow },
  { value: 'ask', label: actionLabels.ask },
  { value: 'deny', label: actionLabels.deny },
] as const;
export const shellKinds = ['bash', 'powershell'] as const;
export const shellLabels = { bash: 'Bash', powershell: 'PowerShell' };
export const shellOptions = [actionOptions[1], actionOptions[2]] as const;

export function policyJson(policy: PolicyDraft | StoredPermissionPolicy) {
  return JSON.stringify(policy, null, 2);
}

export function policySummary(policy: StoredPermissionPolicy) {
  if (policy.type === 'client_access') {
    const { mode, clients } = policy.data;
    return `${mode === 'allowlist' ? 'Allowlist' : 'Blocklist'} · ${clients.length} listed ${clients.length === 1 ? 'client' : 'clients'}`;
  }
  const { tools, shell, unrestricted_mode } = policy.data;
  const toolCount = Object.keys(tools ?? {}).length;
  return [
    `${toolCount} ${toolCount === 1 ? 'tool' : 'tools'}`,
    shell === undefined
      ? 'Shell profiles inherited'
      : Object.keys(shell).length
        ? `${Object.keys(shell).length} shell ${Object.keys(shell).length === 1 ? 'profile' : 'profiles'}`
        : 'All shell kinds blocked',
    ...(unrestricted_mode === 'deny' ? ['Unrestricted mode blocked'] : []),
  ].join(' · ');
}

export function PolicySelect<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  description,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string; disabled?: boolean }[];
  onChange: (next: T) => void;
  disabled?: boolean;
  description?: string;
}) {
  const id = useId();
  return (
    <div className="grid min-w-0 gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        aria-describedby={description ? `${id}-description` : undefined}
        value={value}
        disabled={disabled}
        onChange={event => {
          const option = options.find(option => option.value === event.target.value);
          if (option) onChange(option.value);
        }}
        className="border-input bg-background text-foreground focus-visible:border-ring focus-visible:ring-ring/50 h-9 w-full rounded-md border px-2 text-sm focus-visible:ring-[3px] disabled:opacity-50 pointer-coarse:h-11"
      >
        {options.map(option => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      {description && (
        <p id={`${id}-description`} className="type-label text-muted-foreground">
          {description}
        </p>
      )}
    </div>
  );
}
