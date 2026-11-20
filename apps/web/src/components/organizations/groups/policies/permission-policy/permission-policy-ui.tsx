import { useId, type ComponentProps } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  PERMISSION_POLICY_OS_ADDITIONS,
  type AgentPermissionSet,
  type AgentPermissionsPolicy,
  type OrganizationPermissionPolicy,
} from '@kilocode/web-shared/lib/organizations/group-policies/permission-policy/permission-policy.schema';
import { PolicyEditorFooter } from '../PolicyEditorFooter';

export type ShellKind = keyof NonNullable<AgentPermissionSet['shell']>;
export type ShellProfile = NonNullable<NonNullable<AgentPermissionSet['shell']>[ShellKind]>;
export type PolicyRule = ShellProfile['rules'][number];
export type PolicyAction = PolicyRule['action'];
export type ToolDecision = NonNullable<AgentPermissionSet['tools']>[string];
export type AgentDraft = Omit<AgentPermissionSet, 'shell'> & {
  shell?: Partial<
    Record<ShellKind, Omit<ShellProfile, 'fallback'> & { fallback?: ShellProfile['fallback'] }>
  >;
};
export type PermissionSetOs = (typeof PERMISSION_POLICY_OS_ADDITIONS)[number];
export type PermissionSetSelection = 'all' | PermissionSetOs;
export type PolicyDraft = {
  type: 'agent_permissions';
  data: AgentDraft & { schema_version: 1; by_os?: Partial<Record<PermissionSetOs, AgentDraft>> };
};
export type AgentPermissionSource = { name: string; permissions: AgentDraft };

export const emptyAgentPolicy = {
  type: 'agent_permissions',
  data: { schema_version: 1 },
} satisfies AgentPermissionsPolicy;

export const permissionSetLabels = {
  all: 'All OS',
  linux: 'Linux',
  macos: 'macOS',
  windows: 'Windows',
} satisfies Record<PermissionSetSelection, string>;

export const permissionSetOptions = (['all', ...PERMISSION_POLICY_OS_ADDITIONS] as const).map(
  value => ({ value, label: permissionSetLabels[value] })
);

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

export function allOsPermissions<T extends PolicyDraft['data']>({
  schema_version: _version,
  by_os: _additions,
  ...permissions
}: T) {
  return permissions;
}

export function policyJson(policy: OrganizationPermissionPolicy | PolicyDraft) {
  return JSON.stringify(policy, null, 2);
}

export function policySummary(policy: OrganizationPermissionPolicy) {
  if (policy.type === 'client_configuration') {
    return `Session dollar values ${policy.data.show_session_dollar_values ? 'visible' : 'hidden'}`;
  }
  const osCount = Object.keys(policy.data.by_os ?? {}).length;
  return [
    agentPermissionSummary(policy.data),
    ...(osCount ? [`${osCount} OS ${osCount === 1 ? 'addition' : 'additions'}`] : []),
  ].join(' · ');
}

export function agentPermissionSummary({
  tools,
  shell,
  unrestricted_mode,
  auto_approve,
}: AgentDraft) {
  const toolCount = Object.keys(tools ?? {}).length;
  return [
    `${toolCount} ${toolCount === 1 ? 'tool' : 'tools'}`,
    shell === undefined
      ? 'Shell profiles inherited'
      : Object.keys(shell).length
        ? `${Object.keys(shell).length} shell ${Object.keys(shell).length === 1 ? 'profile' : 'profiles'}`
        : 'All shell kinds blocked',
    ...(unrestricted_mode === 'deny' ? ['Unrestricted mode blocked'] : []),
    ...(auto_approve === 'deny' ? ['Auto-approve disabled for managed actions'] : []),
  ].join(' · ');
}

export function PermissionPolicyEditorActions({
  canEdit,
  ...actions
}: ComponentProps<typeof PolicyEditorFooter> & { canEdit: boolean }) {
  return canEdit ? (
    <PolicyEditorFooter {...actions} />
  ) : (
    <div className="sticky bottom-0 flex justify-end border-t bg-surface-raised px-5 py-3">
      <Button variant="outline" onClick={actions.onCancel}>
        Close
      </Button>
    </div>
  );
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
