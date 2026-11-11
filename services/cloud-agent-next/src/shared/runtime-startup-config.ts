import { z } from 'zod';

export const runtimeStartupConfigSchema = z
  .object({
    mode: z.literal('downloaded'),
    image: z.literal('runtime-free'),
    /** New cloud-agent-web sandboxes of these orgs run the Kilo v2 release. */
    kilo2: z
      .object({ orgIds: z.array(z.uuid()).min(1) })
      .strict()
      .optional(),
  })
  .strict();
export type RuntimeStartupConfig = z.infer<typeof runtimeStartupConfigSchema>;
