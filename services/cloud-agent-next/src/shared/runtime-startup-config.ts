import { z } from 'zod';

/** Startup mode and image are independent, except runtime-free requires downloaded. */
export const runtimeStartupConfigSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('preinstalled'), image: z.literal('all-in-one') }).strict(),
  z
    .object({
      mode: z.literal('downloaded'),
      image: z.enum(['all-in-one', 'runtime-free']),
      interactiveOrgIds: z.array(z.uuid()).min(1).optional(),
      /** New cloud-agent-web sandboxes of these orgs run the Kilo v2 release. */
      kilo2: z
        .object({ orgIds: z.array(z.uuid()).min(1) })
        .strict()
        .optional(),
    })
    .strict(),
]);
export type RuntimeStartupConfig = z.infer<typeof runtimeStartupConfigSchema>;
