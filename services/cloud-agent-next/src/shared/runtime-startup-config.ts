import { z } from 'zod';

const orgScopeSchema = z.union([z.literal('*'), z.array(z.uuid()).min(1)]);

export const runtimeStartupConfigSchema = z
  .object({
    mode: z.literal('downloaded'),
    image: z.literal('runtime-free'),
    kilo2: z
      .object({
        /** `*` includes personal accounts; origin and native isolation checks still apply. */
        orgIds: orgScopeSchema,
        /**
         * Accounts that select v2 from every preparing-route origin, not only
         * `cloud-agent-web`. Native isolation checks still apply.
         */
        allSessionOrgIds: orgScopeSchema.optional(),
      })
      .strict()
      .superRefine((value, context) => {
        const allSessionOrgIds = value.allSessionOrgIds;
        if (allSessionOrgIds === undefined || value.orgIds === '*') return;
        const outsideScope =
          allSessionOrgIds === '*'
            ? true
            : allSessionOrgIds.some(orgId => !value.orgIds.includes(orgId));
        if (outsideScope)
          context.addIssue({
            code: 'custom',
            message: 'All-session organizations must be inside the Kilo v2 organization scope',
            path: ['allSessionOrgIds'],
          });
      })
      .optional(),
  })
  .strict();
export type RuntimeStartupConfig = z.infer<typeof runtimeStartupConfigSchema>;
