import { useId } from 'react';
import { Label } from '@/components/ui/label';
import type { OrganizationPermissionPolicy } from '@kilocode/web-shared/lib/organizations/group-policies/permission-policy/permission-policy.schema';

export type AgentPermissions = OrganizationPermissionPolicy['data'];
export type ShellKind = keyof NonNullable<AgentPermissions['shell']>;
export type ShellProfile = NonNullable<NonNullable<AgentPermissions['shell']>[ShellKind]>;
export type PolicyRule = ShellProfile['rules'][number];
export type PolicyAction = PolicyRule['action'];
export type ToolDecision = NonNullable<AgentPermissions['tools']>[string];
export type AgentDraft = Omit<AgentPermissions, 'shell'> & {
  shell?: Partial<
    Record<ShellKind, Omit<ShellProfile, 'fallback'> & { fallback?: ShellProfile['fallback'] }>
  >;
};
export type PolicyDraft = { type: OrganizationPermissionPolicy['type']; data: AgentDraft };

export const emptyAgentPolicy = {
  type: 'agent_permissions',
  data: { schema_version: 1 },
} satisfies OrganizationPermissionPolicy;

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

export function policyJson(policy: PolicyDraft) {
  return JSON.stringify(policy, null, 2);
}

export function policySummary(policy: OrganizationPermissionPolicy) {
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
          if (option && !option.disabled) onChange(option.value);
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
