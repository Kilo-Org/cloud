import type { OrganizationGroupModelAccessPolicy } from '@kilocode/db/schema-types';
import * as z from 'zod';

export const ORGANIZATION_GROUP_MODEL_ACCESS_POLICY_TYPE = 'model_access';
export const MAX_ORGANIZATION_GROUP_MODEL_IDS = 500;
export const MAX_ORGANIZATION_GROUP_PROVIDER_SLUGS = 500;

export const OrganizationGroupModelAccessPolicyDataSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('all') }).strict(),
  z.object({ mode: z.literal('none') }).strict(),
  z
    .object({
      mode: z.literal('selected'),
      model_allow_list: z.array(z.string().trim().min(1)).max(MAX_ORGANIZATION_GROUP_MODEL_IDS),
      provider_allow_list: z
        .array(z.string().trim().min(1))
        .max(MAX_ORGANIZATION_GROUP_PROVIDER_SLUGS),
    })
    .strict(),
]);

export const OrganizationGroupModelAccessPolicySchema = z
  .object({
    type: z.literal(ORGANIZATION_GROUP_MODEL_ACCESS_POLICY_TYPE),
    data: OrganizationGroupModelAccessPolicyDataSchema,
  })
  .strict();

// Assert the runtime schema stays structurally compatible with the persisted
// database shape defined in `@kilocode/db`.
export type _AssertModelAccessMatchesDb =
  z.infer<
    typeof OrganizationGroupModelAccessPolicySchema
  > extends OrganizationGroupModelAccessPolicy
    ? OrganizationGroupModelAccessPolicy extends z.infer<
        typeof OrganizationGroupModelAccessPolicySchema
      >
      ? true
      : never
    : never;

export const DEFAULT_GROUP_MODEL_ACCESS_POLICY = {
  type: ORGANIZATION_GROUP_MODEL_ACCESS_POLICY_TYPE,
  data: { mode: 'none' },
} satisfies OrganizationGroupModelAccessPolicy;

export const DEFAULT_ORGANIZATION_MODEL_ACCESS_POLICY = {
  type: ORGANIZATION_GROUP_MODEL_ACCESS_POLICY_TYPE,
  data: { mode: 'all' },
} satisfies OrganizationGroupModelAccessPolicy;
