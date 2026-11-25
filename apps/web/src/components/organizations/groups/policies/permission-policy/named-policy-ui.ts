export const namedPolicyKindLabels = {
  agent_permissions: 'Agent permissions',
  client_configuration: 'Client configuration',
} as const;

export type NamedPolicyKind = keyof typeof namedPolicyKindLabels;

export const namedPolicyKindOptions = [
  { value: 'agent_permissions', label: namedPolicyKindLabels.agent_permissions },
  { value: 'client_configuration', label: namedPolicyKindLabels.client_configuration },
] as const;

export const namedPolicyExamples: Record<NamedPolicyKind, string> = {
  agent_permissions: JSON.stringify(
    { tools: { browser_open: 'ask' }, by_os: { windows: { tools: { browser_open: 'deny' } } } },
    null,
    2
  ),
  client_configuration: JSON.stringify(
    {
      disable_auto_approve: true,
      disable_telemetry: false,
      hide_session_dollar_values: true,
    },
    null,
    2
  ),
};
