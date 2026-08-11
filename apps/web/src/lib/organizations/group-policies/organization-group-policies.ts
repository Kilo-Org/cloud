import type {
  OrganizationGroupPolicies,
  OrganizationGroupPolicy,
  OrganizationGroupPolicyType,
} from '@kilocode/db/schema-types';
import * as z from 'zod';
import {
  ORGANIZATION_GROUP_MODEL_ACCESS_POLICY_TYPE,
  OrganizationGroupModelAccessPolicySchema,
} from './model-access/model-access.schema';

export * from './model-access/model-access.schema';

// Re-export the persisted policy types from the database package so app code
// has a single import site for both the runtime schemas and the shapes.
export type {
  OrganizationGroupModelAccessPolicy,
  OrganizationGroupPolicies,
  OrganizationGroupPolicy,
  OrganizationGroupPolicyType,
} from '@kilocode/db/schema-types';

export const MAX_ORGANIZATION_GROUP_POLICIES = 20;

export const OrganizationGroupPolicyTypeSchema = z.enum([
  ORGANIZATION_GROUP_MODEL_ACCESS_POLICY_TYPE,
]);

export const OrganizationGroupPolicyTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('group'), groupId: z.uuid() }).strict(),
  z.object({ kind: z.literal('default') }).strict(),
]);

export type OrganizationGroupPolicyTarget = z.infer<typeof OrganizationGroupPolicyTargetSchema>;

export const OrganizationGroupPolicySchema = z.discriminatedUnion('type', [
  OrganizationGroupModelAccessPolicySchema,
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
