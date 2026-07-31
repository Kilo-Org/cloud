'use client';

import {
  DEFAULT_GROUP_MCP_SERVER_ACCESS_POLICY,
  DEFAULT_ORGANIZATION_MCP_SERVER_ACCESS_POLICY,
} from '@/lib/organizations/group-policies/organization-group-policies';
import { Cable } from 'lucide-react';
import type { OrganizationGroupPolicyClientDefinition } from '@/components/organizations/groups/policies/types';
import { McpServerAccessPolicyEditor } from './McpServerAccessPolicyEditor';
import {
  McpServerAccessPolicyListItem,
  summarizeMcpServerAccessPolicy,
} from './McpServerAccessPolicyListItem';

export const mcpServerAccessPolicyClientDefinition = {
  type: 'mcp_server_access',
  label: 'MCP server access',
  description: 'Grant all, none, or selected organization MCP servers to members.',
  // Matches the "MCP Gateway" navigation icon.
  Icon: Cable,
  summarize: summarizeMcpServerAccessPolicy,
  createInitialPolicy(target) {
    return target.kind === 'default'
      ? DEFAULT_ORGANIZATION_MCP_SERVER_ACCESS_POLICY
      : DEFAULT_GROUP_MCP_SERVER_ACCESS_POLICY;
  },
  ListItem: McpServerAccessPolicyListItem,
  Editor: McpServerAccessPolicyEditor,
} satisfies OrganizationGroupPolicyClientDefinition<'mcp_server_access'>;
