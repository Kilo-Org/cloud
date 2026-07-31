import type { OrganizationGroupMcpServerAccessPolicy } from '@kilocode/db/schema-types';
import * as z from 'zod';

export const ORGANIZATION_GROUP_MCP_SERVER_ACCESS_POLICY_TYPE = 'mcp_server_access';
export const MAX_ORGANIZATION_GROUP_MCP_SERVER_CONFIG_IDS = 200;

export const OrganizationGroupMcpServerAccessPolicyDataSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('all') }).strict(),
  z.object({ mode: z.literal('none') }).strict(),
  z
    .object({
      mode: z.literal('selected'),
      config_ids: z.array(z.uuid()).max(MAX_ORGANIZATION_GROUP_MCP_SERVER_CONFIG_IDS),
    })
    .strict(),
]);

export const OrganizationGroupMcpServerAccessPolicySchema = z
  .object({
    type: z.literal(ORGANIZATION_GROUP_MCP_SERVER_ACCESS_POLICY_TYPE),
    data: OrganizationGroupMcpServerAccessPolicyDataSchema,
  })
  .strict();

// Assert the runtime schema stays structurally compatible with the persisted
// database shape defined in `@kilocode/db`. `AssertTrue` is what makes drift a
// build error: a bare conditional type may legally resolve to `false`, and
// `never` would even satisfy `extends true`, so neither fails typecheck alone.
type AssertTrue<T extends true> = T;

export type _AssertMcpServerAccessMatchesDb = AssertTrue<
  z.infer<
    typeof OrganizationGroupMcpServerAccessPolicySchema
  > extends OrganizationGroupMcpServerAccessPolicy
    ? OrganizationGroupMcpServerAccessPolicy extends z.infer<
        typeof OrganizationGroupMcpServerAccessPolicySchema
      >
      ? true
      : false
    : false
>;

export const DEFAULT_GROUP_MCP_SERVER_ACCESS_POLICY = {
  type: ORGANIZATION_GROUP_MCP_SERVER_ACCESS_POLICY_TYPE,
  data: { mode: 'none' },
} satisfies OrganizationGroupMcpServerAccessPolicy;

export const DEFAULT_ORGANIZATION_MCP_SERVER_ACCESS_POLICY = {
  type: ORGANIZATION_GROUP_MCP_SERVER_ACCESS_POLICY_TYPE,
  data: { mode: 'all' },
} satisfies OrganizationGroupMcpServerAccessPolicy;
