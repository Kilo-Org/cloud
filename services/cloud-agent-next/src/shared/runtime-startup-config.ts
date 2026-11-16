import { z } from 'zod';

export const runtimeStartupConfigSchema = z
  .object({
    mode: z.literal('downloaded'),
    image: z.literal('runtime-free'),
    /** `*` includes personal accounts; origin and native isolation checks still apply. */
    kilo2: z
      .object({ orgIds: z.union([z.literal('*'), z.array(z.uuid()).min(1)]) })
      .strict()
      .optional(),
  })
  .strict();
export type RuntimeStartupConfig = z.infer<typeof runtimeStartupConfigSchema>;
