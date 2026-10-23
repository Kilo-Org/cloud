import { z } from 'zod';

/** Startup mode and image are independent, except runtime-free requires downloaded. */
export const runtimeStartupConfigSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('preinstalled'), image: z.literal('all-in-one') }).strict(),
  z
    .object({ mode: z.literal('downloaded'), image: z.enum(['all-in-one', 'runtime-free']) })
    .strict(),
]);
export type RuntimeStartupConfig = z.infer<typeof runtimeStartupConfigSchema>;
