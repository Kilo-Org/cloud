import 'server-only';

import type { OrganizationGroupMcpServerAccessPolicy } from '@/lib/organizations/group-policies/organization-group-policies';
import { mcp_gateway_configs, organizations } from '@kilocode/db/schema';
import { MCPGatewayOwnerScope } from '@kilocode/db/schema-types';
import { TRPCError } from '@trpc/server';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from '@/lib/drizzle';

/**
 * NOTE: this policy is configuration only for now. The MCP Gateway still
 * resolves access from per-user `mcp_gateway_assignments`, so nothing consumes
 * these grants at request time yet. Wiring gateway enforcement is a follow-up;
 * until then the editor tells owners that saving records intended access.
 */
export function normalizeMcpServerAccessPolicy(
  policy: OrganizationGroupMcpServerAccessPolicy
): OrganizationGroupMcpServerAccessPolicy {
  if (policy.data.mode !== 'selected') return policy;
  return {
    type: 'mcp_server_access',
    data: {
      mode: 'selected',
      config_ids: [
        ...new Set(policy.data.config_ids.map(configId => configId.trim().toLowerCase())),
      ].sort(),
    },
  };
}

export async function getMcpServerAccessPolicyEditorData(organizationId: string) {
  const [[organization], servers] = await Promise.all([
    db
      .select({ plan: organizations.plan })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1),
    db
      .select({
        configId: mcp_gateway_configs.config_id,
        name: mcp_gateway_configs.name,
        remoteUrl: mcp_gateway_configs.remote_url,
        sharingMode: mcp_gateway_configs.sharing_mode,
        enabled: mcp_gateway_configs.enabled,
      })
      .from(mcp_gateway_configs)
      .where(
        and(
          eq(mcp_gateway_configs.owner_scope, MCPGatewayOwnerScope.Organization),
          eq(mcp_gateway_configs.owner_id, organizationId),
          isNull(mcp_gateway_configs.deleted_at)
        )
      )
      .orderBy(asc(mcp_gateway_configs.name)),
  ]);
  if (!organization || organization.plan !== 'enterprise') {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Enterprise organization not found' });
  }
  return {
    policyType: 'mcp_server_access' as const,
    servers,
  };
}
