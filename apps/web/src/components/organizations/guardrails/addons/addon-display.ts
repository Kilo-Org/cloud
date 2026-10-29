import type {
  OrganizationAddonConfig,
  OrganizationAddonSource,
  OrganizationAddonType,
  OrganizationMcpConnectDecision,
  OrganizationMcpConnectTarget,
} from '@kilocode/db/schema-types';

export const ADDON_TYPE_LABELS = {
  mcp: 'MCP server',
} satisfies Record<OrganizationAddonType, string>;

export const ADDON_TYPE_OPTIONS = (
  Object.entries(ADDON_TYPE_LABELS) as [OrganizationAddonType, string][]
).map(([value, label]) => ({ value, label }));

const SOURCE_LABELS = {
  kilo_marketplace: 'Kilo registry',
  mcp_registry: 'MCP registry',
  custom: 'Custom',
} satisfies Record<OrganizationAddonSource['registry'], string>;

export function sourceLabel(source: OrganizationAddonSource): string {
  return SOURCE_LABELS[source.registry];
}

export function configKindLabel(
  config: OrganizationAddonConfig | OrganizationMcpConnectTarget
): string {
  if (config.kind === 'remote') return 'Remote';
  return config.ecosystem === 'npm' ? 'npm' : 'PyPI';
}

export function configIdentity(
  config: OrganizationAddonConfig | OrganizationMcpConnectTarget
): string {
  return config.kind === 'remote' ? config.url : config.identifier;
}

export function minVersionLabel(config: OrganizationAddonConfig): string {
  if (config.kind === 'remote') return 'Not applicable';
  return config.min_version ?? 'Any version';
}

const CLIENT_LABELS: Record<string, string> = {
  cli: 'CLI',
  cloud_agent: 'Cloud Agents',
  vscode: 'VS Code',
  jetbrains: 'JetBrains',
  other: 'Other',
};

export const CLIENT_FILTER_OPTIONS = Object.entries(CLIENT_LABELS).map(([value, label]) => ({
  value,
  label,
}));

export function clientLabel(client: string): string {
  return CLIENT_LABELS[client] ?? client;
}

export const CONNECT_DECISION_OPTIONS = [
  { value: 'allowed', label: 'Allowed' },
  { value: 'denied', label: 'Denied' },
] satisfies { value: OrganizationMcpConnectDecision; label: string }[];

export function decisionLabel(decision: OrganizationMcpConnectDecision): string {
  return CONNECT_DECISION_OPTIONS.find(option => option.value === decision)?.label ?? decision;
}
