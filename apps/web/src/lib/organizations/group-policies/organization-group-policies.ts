import type {
  OrganizationGroupPolicies,
  OrganizationGroupPolicy,
  OrganizationGroupPolicyType,
} from '@kilocode/db/schema-types';
import * as z from 'zod';
import {
  ORGANIZATION_GROUP_MCP_SERVER_ACCESS_POLICY_TYPE,
  OrganizationGroupMcpServerAccessPolicySchema,
} from './mcp-server-access/mcp-server-access.schema';
import {
  ORGANIZATION_GROUP_MODEL_ACCESS_POLICY_TYPE,
  OrganizationGroupModelAccessPolicySchema,
} from './model-access/model-access.schema';

export * from './mcp-server-access/mcp-server-access.schema';
export * from './model-access/model-access.schema';

// Re-export the persisted policy types from the database package so app code
// has a single import site for both the runtime schemas and the shapes.
export type {
  OrganizationGroupMcpServerAccessPolicy,
  OrganizationGroupModelAccessPolicy,
  OrganizationGroupPolicies,
  OrganizationGroupPolicy,
  OrganizationGroupPolicyType,
} from '@kilocode/db/schema-types';

export const MAX_ORGANIZATION_GROUP_POLICIES = 20;

export const OrganizationGroupPolicyTypeSchema = z.enum([
  ORGANIZATION_GROUP_MODEL_ACCESS_POLICY_TYPE,
  ORGANIZATION_GROUP_MCP_SERVER_ACCESS_POLICY_TYPE,
]);

export const OrganizationGroupPolicySchema = z.discriminatedUnion('type', [
  OrganizationGroupModelAccessPolicySchema,
  OrganizationGroupMcpServerAccessPolicySchema,
]);

export const OrganizationGroupPoliciesSchema = z
  .array(OrganizationGroupPolicySchema)
  .max(MAX_ORGANIZATION_GROUP_POLICIES)
  .superRefine((policies, ctx) => {
    const seen = new Set<string>();
    policies.forEach((policy, index) => {
      if (seen.has(policy.type)) {
        ctx.addIssue({
          code: 'custom',
          message: `Duplicate organization group policy type: ${policy.type}`,
          path: [index, 'type'],
        });
      }
      seen.add(policy.type);
    });
  });

export const OrganizationGroupMetadataSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().max(500).nullable().optional(),
  })
  .strict();

export const OrganizationGroupInputSchema = OrganizationGroupMetadataSchema.extend({
  policies: OrganizationGroupPoliciesSchema,
}).strict();

export type OrganizationGroupInput = z.infer<typeof OrganizationGroupInputSchema>;

export type OrganizationGroupPolicyOf<T extends OrganizationGroupPolicyType> = Extract<
  OrganizationGroupPolicy,
  { type: T }
>;

export function findOrganizationGroupPolicy<T extends OrganizationGroupPolicyType>(
  policies: OrganizationGroupPolicies,
  type: T
): OrganizationGroupPolicyOf<T> | undefined {
  return policies.find((policy): policy is OrganizationGroupPolicyOf<T> => policy.type === type);
}
