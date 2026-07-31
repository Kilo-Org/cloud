import type { OrganizationGroupPolicyListItemProps } from '@/components/organizations/groups/policies/types';

export function summarizeMcpServerAccessPolicy(
  policy: OrganizationGroupPolicyListItemProps<'mcp_server_access'>['policy']
) {
  if (policy.data.mode === 'all') return 'All organization MCP servers';
  if (policy.data.mode === 'none') return 'No MCP server access';
  const servers = policy.data.config_ids.length;
  return `${servers} ${servers === 1 ? 'server' : 'servers'}`;
}

export function McpServerAccessPolicyListItem({
  policy,
}: OrganizationGroupPolicyListItemProps<'mcp_server_access'>) {
  return (
    <span className="min-w-0">
      <span className="type-body block font-medium">MCP server access</span>
      <span className="type-label text-muted-foreground block">
        {summarizeMcpServerAccessPolicy(policy)}
      </span>
    </span>
  );
}
